import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarType } from '../../common/datatype.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * The substrate node for view-/materialized-view-mediated DML.
 *
 * A view mutation decomposes into an ordered list of base-table operations
 * (`propagate()` in `planner/mutation/propagate.ts`). Each base op is built into
 * a *fully-formed* base-table DML subtree by the ordinary base-table builder, so
 * every constraint / conflict / FK / mutation-context / RETURNING-rejection rule
 * is reused verbatim — the wrapped subtree for the single-source spine is
 * byte-identical to what the retired AST rewrite re-planned. The `ViewMutation`
 * node sequences those subtrees.
 *
 * For the single-source case the list holds exactly one entry (today's rewrite
 * output, wrapped), and the node degenerates to a passthrough of that one base
 * op. Multi-source ordering rides the same list (sequenced in the order
 * `propagate` emits) and is filled out in the multi-source phase (3.2).
 *
 * Like {@link SinkNode} (the top node this replaces for a view mutation), a view
 * mutation is a side-effect statement reporting the affected-row count, not a
 * relation — RETURNING-through-view is rejected until 3.2. The emitter drains
 * each child base op in list order (the scheduler evaluates them as params) and
 * yields nothing.
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
		 * RETURNING projection over the base ops — reserved for the multi-source /
		 * RETURNING-through-view phase (3.2). Unused while RETURNING-through-view is
		 * rejected; when it lands it must also be threaded through
		 * `getChildren`/`withChildren`.
		 */
		public readonly returning?: RelationalPlanNode,
	) {
		super(scope, baseOps.reduce((cost, op) => cost + op.getTotalCost(), 0.1));
		if (baseOps.length === 0) {
			throw new QuereusError('ViewMutationNode requires at least one base operation', StatusCode.INTERNAL);
		}
	}

	getType(): ScalarType {
		// A view mutation is a side-effect statement: like SinkNode it reports the
		// affected-row count. (RETURNING-through-view, which would make this
		// relational, is rejected until 3.2.)
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			logicalType: INTEGER_TYPE,
			nullable: false,
		};
	}

	getChildren(): readonly PlanNode[] {
		return this.baseOps;
	}

	getRelations(): readonly RelationalPlanNode[] {
		// Mirrors BlockNode: the base ops are Sink-topped DML statements, not
		// relational inputs, so they are excluded here (the optimizer and the
		// change-scope / binding walks descend via getChildren). A relational base
		// op — a future RETURNING op — would surface.
		return this.baseOps.filter(isRelationalNode);
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length === this.baseOps.length &&
			newChildren.every((child, i) => child === this.baseOps[i])) {
			return this;
		}
		return new ViewMutationNode(this.scope, [...newChildren], this.returning);
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
		return `VIEW MUTATION (${this.baseOps.length} base op${this.baseOps.length === 1 ? '' : 's'})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return { baseOps: this.baseOps.length };
	}
}
