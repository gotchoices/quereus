import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type PhysicalProperties, type TableDescriptor, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarType } from '../../common/datatype.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * The **shared-surrogate mutation envelope** for a multi-source view INSERT.
 *
 * `source` is the per-row augmented source (the supplied view columns) — built
 * once and materialized by the emitter *before* the base ops run. Each base op
 * reads it back through an `EnvelopeScanNode` carrying the same {@link descriptor},
 * so the fan-out shares one set of rows.
 *
 * When `mint` is present the emitter appends a generated shared key as the last
 * envelope column: a per-row surrogate `seed + ordinal` where `seed` is evaluated
 * exactly once (pre-fan-out) — the `integer-auto` / `per-row` cadence of
 * `docs/view-updateability.md` § Mutation Context. The single captured value is
 * threaded into every base insert of that row, so the branches cannot diverge.
 */
export interface MutationEnvelope {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
	readonly mint?: {
		/** Surrogate base, evaluated once before fan-out; minted value = seed + 1-based ordinal. */
		readonly seed: ScalarPlanNode;
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
 * Like {@link SinkNode}, a view mutation is a side-effect statement reporting the
 * affected-row count, not a relation — RETURNING-through-view is rejected. The
 * emitter drains each child base op in list order and yields nothing.
 */
export class ViewMutationNode extends PlanNode {
	override readonly nodeType = PlanNodeType.ViewMutation;

	constructor(
		scope: Scope,
		/**
		 * Ordered base-table DML subtrees the view/MV mutation decomposes into.
		 * Single-source = exactly one (the retired-rewrite output, wrapped).
		 */
		public readonly baseOps: readonly PlanNode[],
		/**
		 * RETURNING projection over the base ops — reserved for the
		 * RETURNING-through-view phase. Unused while RETURNING-through-view is
		 * rejected; when it lands it must also be threaded through
		 * `getChildren`/`withChildren`.
		 */
		public readonly returning?: RelationalPlanNode,
		/**
		 * The shared-surrogate envelope for a multi-source insert (undefined for
		 * single-source spines and multi-source update/delete).
		 */
		public readonly envelope?: MutationEnvelope,
	) {
		super(scope, baseOps.reduce((cost, op) => cost + op.getTotalCost(), 0.1));
		if (baseOps.length === 0) {
			throw new QuereusError('ViewMutationNode requires at least one base operation', StatusCode.INTERNAL);
		}
	}

	getType(): ScalarType {
		// A view mutation is a side-effect statement: like SinkNode it reports the
		// affected-row count. (RETURNING-through-view, which would make this
		// relational, is rejected.)
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			logicalType: INTEGER_TYPE,
			nullable: false,
		};
	}

	/** Extra (non-base-op) plan children: the envelope source + optional surrogate seed. */
	private envelopeChildren(): PlanNode[] {
		if (!this.envelope) return [];
		return this.envelope.mint
			? [this.envelope.source, this.envelope.mint.seed]
			: [this.envelope.source];
	}

	getChildren(): readonly PlanNode[] {
		return [...this.baseOps, ...this.envelopeChildren()];
	}

	getRelations(): readonly RelationalPlanNode[] {
		// Mirrors BlockNode: the base ops are Sink-topped DML statements, not
		// relational inputs, so they are excluded here (the optimizer and the
		// change-scope / binding walks descend via getChildren). A relational base
		// op — a future RETURNING op — would surface.
		return this.baseOps.filter(isRelationalNode);
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const n = this.baseOps.length;
		const newBaseOps = newChildren.slice(0, n);
		const newEnvChildren = newChildren.slice(n);

		let newEnvelope = this.envelope;
		if (this.envelope) {
			const [newSource, newSeed] = newEnvChildren;
			newEnvelope = {
				source: newSource as RelationalPlanNode,
				descriptor: this.envelope.descriptor,
				mint: this.envelope.mint ? { seed: newSeed as ScalarPlanNode } : undefined,
			};
		}

		const unchanged = newChildren.length === this.getChildren().length
			&& newBaseOps.every((child, i) => child === this.baseOps[i])
			&& (!this.envelope || (newEnvelope!.source === this.envelope.source
				&& newEnvelope!.mint?.seed === this.envelope.mint?.seed));
		if (unchanged) {
			return this;
		}
		return new ViewMutationNode(this.scope, newBaseOps, this.returning, newEnvelope);
	}

	get estimatedRows(): number | undefined {
		return 1;
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
		return `VIEW MUTATION (${this.baseOps.length} base op${this.baseOps.length === 1 ? '' : 's'}${env})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return { baseOps: this.baseOps.length, envelope: this.envelope ? (this.envelope.mint ? 'mint' : 'shared') : undefined };
	}
}
