import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type PhysicalProperties, type TableDescriptor, type Attribute, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** When a separate {@link ViewMutationNode.returning} relation is captured. */
export type ReturningTiming = 'pre' | 'post';

/**
 * The per-row identity-capture side input for a multi-source **update** RETURNING
 * (docs/view-updateability.md § `returning` Clauses).
 *
 * `source` selects each affected view row's base-PK identities `(k0, k1)`; the
 * emitter materializes it **before** the base ops run and stashes the rows in
 * `rctx.tableContexts` under {@link descriptor}. The post-mutation
 * {@link ViewMutationNode.returning} re-query reads them back through an
 * `InternalRecursiveCTERefNode` carrying the same `descriptor`, so it re-projects
 * exactly the updated logical rows by captured identity — even when the update
 * rewrote the column its own WHERE filtered on. Parallel to {@link MutationEnvelope}
 * (the insert surrogate), but on the relational RETURNING branch rather than the
 * void/return-null branch.
 */
export interface ReturningCapture {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
}

/**
 * The **shared-surrogate mutation envelope** for a multi-source view INSERT.
 *
 * `source` is the per-row augmented source (the supplied view columns) — built
 * once and materialized by the emitter *before* the base ops run. Each base op
 * reads it back through an `EnvelopeScanNode` carrying the same {@link descriptor},
 * so the fan-out shares one set of rows.
 *
 * When `mint` is present the emitter appends a generated shared key as the last
 * envelope column. `seed` is evaluated exactly once (pre-fan-out — it observes the
 * pre-mutation state). The minted value depends on the {@link mint.cadence}:
 * `per-row` (default) makes each row distinct (`seed + 1-based ordinal`);
 * `per-statement` binds once for the whole statement (`seed + 1` for every row —
 * `docs/view-updateability.md` § Mutation Context cadences). The single captured
 * value is threaded into every base insert of that row, so the branches cannot
 * diverge.
 */
export interface MutationEnvelope {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
	readonly mint?: {
		/** Surrogate base, evaluated once before fan-out. */
		readonly seed: ScalarPlanNode;
		/**
		 * `per-row` (default) ⇒ minted value = `seed + 1-based ordinal` (distinct per
		 * row); `per-statement` ⇒ `seed + 1` bound once for the statement (stable
		 * across rows). Absent ⇒ `per-row` (the multi-source insert's only cadence).
		 */
		readonly cadence?: 'per-row' | 'per-statement';
	};
}

/**
 * The substrate node for view-/materialized-view-mediated DML.
 *
 * A view mutation decomposes into an ordered list of base-table operations
 * (`propagate()` in `planner/mutation/propagate.ts`, or the multi-source insert
 * builder). Each base op is built into a *fully-formed* base-table DML subtree by
 * the ordinary base-table builder, so every constraint / conflict / FK /
 * mutation-context / RETURNING-rejection rule is reused verbatim. The
 * `ViewMutation` node sequences those subtrees.
 *
 * For the single-source case the list holds exactly one entry (today's rewrite
 * output, wrapped). Multi-source update/delete ordering rides the same list
 * (sequenced in the order `propagate` emits). Multi-source **insert** additionally
 * carries an {@link MutationEnvelope}: the emitter materializes it once and stashes
 * its rows in context, then drives the base ops, each of which reads the shared
 * surrogate back through an `EnvelopeScanNode`.
 *
 * **RETURNING-through-view.** A view mutation with a `returning` clause yields the
 * view-projected post-mutation rows, so the node is **relational** (its row type /
 * attributes are the view's projected columns). There are two shapes:
 *   - *single-source*: the RETURNING clause is rewritten into base terms and
 *     attached to the (sole) base op, which then plans to a relational
 *     `ReturningNode`. No separate {@link returning} child — the emitter surfaces
 *     that base op's rows (NEW for insert/update, OLD for delete — post-mutation by
 *     construction). {@link returning} is undefined; {@link resultRelation} finds
 *     the relational base op.
 *   - *multi-source* update/delete: the view row spans both base tables, so the
 *     rows are produced by a separate {@link returning} relation — a re-query of
 *     the view restricted to the mutation's predicate — evaluated **before** the
 *     base ops for a delete (the rows are about to disappear) or **after** for an
 *     update ({@link returningTiming}).
 *
 * Without a `returning` clause the node is a void side-effect statement (like
 * {@link SinkNode}): the emitter drains each base op in list order and yields
 * nothing, and {@link getType} reports the scalar affected-row shape.
 */
export class ViewMutationNode extends PlanNode {
	override readonly nodeType = PlanNodeType.ViewMutation;

	constructor(
		scope: Scope,
		/**
		 * Ordered base-table DML subtrees the view/MV mutation decomposes into.
		 * Single-source = exactly one (the retired-rewrite output, wrapped). When a
		 * single-source mutation carries RETURNING, that one base op is a relational
		 * `ReturningNode` (the rewritten view-projected clause).
		 */
		public readonly baseOps: readonly PlanNode[],
		/**
		 * Separate RETURNING relation producing the view-projected rows — set only
		 * for a **multi-source** update/delete RETURNING (the view row spans both
		 * base tables, so a re-query of the view supplies it). Single-source
		 * RETURNING leaves this undefined and surfaces the relational base op
		 * instead. When set, it is threaded through `getChildren`/`getRelations`/
		 * `withChildren` and drives `getType`/`getAttributes`.
		 */
		public readonly returning?: RelationalPlanNode,
		/**
		 * The shared-surrogate envelope for a multi-source insert (undefined for
		 * single-source spines and multi-source update/delete).
		 */
		public readonly envelope?: MutationEnvelope,
		/**
		 * When {@link returning} is set, whether it is captured `pre` (before the
		 * base ops — a delete, whose rows vanish) or `post` (after — an update,
		 * whose post-mutation image the re-query reads). Ignored when `returning`
		 * is undefined.
		 */
		public readonly returningTiming?: ReturningTiming,
		/**
		 * The per-row identity-capture side input for a multi-source **update**
		 * RETURNING (timing `post`): its `source` is materialized into context
		 * before the base ops run, and {@link returning} reads it back by
		 * `descriptor` to re-project the updated rows by captured identity. Absent
		 * for single-source, multi-source delete (`pre`), and the void/insert paths.
		 */
		public readonly returningCapture?: ReturningCapture,
	) {
		super(scope, baseOps.reduce((cost, op) => cost + op.getTotalCost(), 0.1));
		if (baseOps.length === 0) {
			throw new QuereusError('ViewMutationNode requires at least one base operation', StatusCode.INTERNAL);
		}
	}

	/**
	 * The relation whose rows this mutation yields, or `undefined` when it is a
	 * void side-effect statement. A separate {@link returning} re-query wins;
	 * otherwise a relational base op (single-source RETURNING rewritten onto the
	 * base op) is surfaced.
	 */
	resultRelation(): RelationalPlanNode | undefined {
		if (this.returning) return this.returning;
		return this.baseOps.find(isRelationalNode);
	}

	getType(): RelationType | ScalarType {
		const result = this.resultRelation();
		if (result) {
			// RETURNING-through-view: the row type is the view's projected columns.
			return result.getType();
		}
		// A void view mutation is a side-effect statement: like SinkNode it reports
		// the affected-row count.
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			logicalType: INTEGER_TYPE,
			nullable: false,
		};
	}

	/** The view-projected RETURNING attributes, or `[]` for a void mutation. */
	getAttributes(): readonly Attribute[] {
		return this.resultRelation()?.getAttributes() ?? [];
	}

	/** Extra (non-base-op) plan children: the envelope source + optional surrogate seed. */
	private envelopeChildren(): PlanNode[] {
		if (!this.envelope) return [];
		return this.envelope.mint
			? [this.envelope.source, this.envelope.mint.seed]
			: [this.envelope.source];
	}

	getChildren(): readonly PlanNode[] {
		// Order: base ops, then the optional RETURNING re-query, then the optional
		// identity-capture source, then the envelope children. `withChildren` slices
		// back in this same order.
		return [
			...this.baseOps,
			...(this.returning ? [this.returning] : []),
			...(this.returningCapture ? [this.returningCapture.source] : []),
			...this.envelopeChildren(),
		];
	}

	getRelations(): readonly RelationalPlanNode[] {
		// Mirrors BlockNode: the base ops are Sink-topped DML statements, not
		// relational inputs, so they are excluded here (the optimizer and the
		// change-scope / binding walks descend via getChildren). A relational base
		// op — a single-source RETURNING op — surfaces, as does the separate
		// multi-source RETURNING re-query, so the attribute-provenance walk treats
		// this node's forwarded RETURNING attributes as forwarded (not originated).
		// The identity-capture source (like the envelope source) is a side input
		// materialized into context, not part of this node's forwarded output, so it
		// is excluded — only reachable via getChildren for optimization/withChildren.
		const rels = this.baseOps.filter(isRelationalNode);
		if (this.returning) rels.push(this.returning);
		return rels;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		let cursor = this.baseOps.length;
		const newBaseOps = newChildren.slice(0, cursor);

		let newReturning = this.returning;
		if (this.returning) {
			newReturning = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
		}

		let newCapture = this.returningCapture;
		if (this.returningCapture) {
			const newCaptureSource = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
			newCapture = { source: newCaptureSource, descriptor: this.returningCapture.descriptor };
		}

		let newEnvelope = this.envelope;
		if (this.envelope) {
			const newSource = newChildren[cursor] as RelationalPlanNode;
			cursor += 1;
			const newSeed = this.envelope.mint ? newChildren[cursor] as ScalarPlanNode : undefined;
			newEnvelope = {
				source: newSource,
				descriptor: this.envelope.descriptor,
				mint: this.envelope.mint ? { seed: newSeed!, cadence: this.envelope.mint.cadence } : undefined,
			};
		}

		const unchanged = newChildren.length === this.getChildren().length
			&& newBaseOps.every((child, i) => child === this.baseOps[i])
			&& newReturning === this.returning
			&& (!this.returningCapture || newCapture!.source === this.returningCapture.source)
			&& (!this.envelope || (newEnvelope!.source === this.envelope.source
				&& newEnvelope!.mint?.seed === this.envelope.mint?.seed));
		if (unchanged) {
			return this;
		}
		return new ViewMutationNode(this.scope, newBaseOps, newReturning, newEnvelope, this.returningTiming, newCapture);
	}

	get estimatedRows(): number | undefined {
		return this.resultRelation()?.estimatedRows ?? 1;
	}

	computePhysical(): Partial<PhysicalProperties> {
		return {
			readonly: false, // drives base-table writes
			idempotent: false,
			deterministic: false,
		};
	}

	override toString(): string {
		const env = this.envelope ? ` +envelope${this.envelope.mint ? '(mint)' : ''}` : '';
		const cap = this.returningCapture ? ' +capture' : '';
		const ret = this.resultRelation() ? ` returning${this.returning ? `(${this.returningTiming})` : ''}` : '';
		return `VIEW MUTATION (${this.baseOps.length} base op${this.baseOps.length === 1 ? '' : 's'}${env}${cap}${ret})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			baseOps: this.baseOps.length,
			envelope: this.envelope ? (this.envelope.mint ? 'mint' : 'shared') : undefined,
			returningCapture: this.returningCapture ? 'identity' : undefined,
			returning: this.resultRelation() ? (this.returning ? `requery(${this.returningTiming})` : 'base-op') : undefined,
		};
	}
}
