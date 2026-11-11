import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { formatExpression } from '../../util/plan-formatter.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Two plans for the rows under a LIMIT whose value is known only at run time, of which
 * the emitter runs one per execution:
 *
 *  - `ordered`: the Sort absorbed into the access path. The table is read in the
 *    requested order and the read stops as soon as the LIMIT above stops pulling;
 *  - `sorted`: the original Sort over the original subtree, which reads every row the
 *    WHERE admits before emitting the first.
 *
 * The module priced `ordered` below `sorted` for any row count up to `orderedUpTo`, so
 * the emitter takes `ordered` exactly when the actual `limit + offset` is at most that.
 * Built by `ruleGrowRetrieve` for `order by … limit ?` (see docs/optimizer-retrieve.md,
 * "A placeholder LIMIT: choosing at run time").
 *
 * `limit` and `offset` are the same expression instances as the `LimitOffset` above;
 * both nodes evaluate them, so the rule admits only expressions that pass
 * `safeToEvaluateTwice`.
 *
 * Both branches come from one subtree and return the same rows, so the node reports the
 * attributes, type, ordering and estimates of `sorted`. The constructor checks that the
 * branches still agree on their attributes, which catches a later rewrite that changes
 * one branch and not the other.
 *
 * Rules that look below a `LimitOffset` for a particular node (`rule-monotonic-limit-pushdown`,
 * `rule-fanout-lookup-join`, `rule-join-elimination`, `rule-key-set-seek-row-bound`) do not
 * look through this node. They lose nothing: this node exists only when the limit-free plan
 * is not ordered on the sort key, which the monotonic pushdown needs, and the subtree the
 * absorb walks (Project, Filter and Alias down to a Retrieve) holds no key-set join.
 */
export class LimitChoiceNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.LimitChoice;

	constructor(
		scope: Scope,
		public readonly ordered: RelationalPlanNode,
		public readonly sorted: RelationalPlanNode,
		public readonly limit: ScalarPlanNode,
		public readonly offset: ScalarPlanNode | undefined,
		/** The largest `limit + offset` the `ordered` plan was priced for and may stop at. */
		public readonly orderedUpTo: number,
	) {
		// NOTE: cost additivity counts BOTH branches in this node's total, roughly twice what
		// either costs, since `ordered` priced at `orderedUpTo` costs about what `sorted`
		// does. The node usually sits directly under a top-level LimitOffset where nothing
		// compares its cost. If it is ever seen distorting a join order (as the leaf of a
		// derived-table join), give the framework a way for a node to count one alternative.
		super(scope, 0.01);
		assertSameAttributes(ordered, sorted);
	}

	getType(): RelationType {
		return this.sorted.getType();
	}

	getAttributes(): readonly Attribute[] {
		return this.sorted.getAttributes();
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.ordered, this.sorted, this.limit];
		if (this.offset) children.push(this.offset);
		return children;
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.ordered, this.sorted];
	}

	get estimatedRows(): number | undefined {
		return this.sorted.estimatedRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sortedPhysical = childrenPhysical[1];
		return {
			estimatedRows: physicalSourceRows(sortedPhysical, this.sorted),
			ordering: sortedPhysical?.ordering,
			fds: sortedPhysical?.fds,
			equivClasses: sortedPhysical?.equivClasses,
			constantBindings: sortedPhysical?.constantBindings,
			domainConstraints: sortedPhysical?.domainConstraints,
			inds: sortedPhysical?.inds,
			monotonicOn: sortedPhysical?.monotonicOn,
		};
	}

	override toString(): string {
		return `ORDERED WHEN LIMIT + OFFSET <= ${this.orderedUpTo}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			orderedUpTo: this.orderedUpTo,
			limit: formatExpression(this.limit),
			...(this.offset ? { offset: formatExpression(this.offset) } : {}),
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.offset ? 4 : 3;
		if (newChildren.length !== expectedLength) {
			quereusError(`LimitChoiceNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		const [newOrdered, newSorted, newLimit, newOffset] = newChildren;
		if (!isRelationalNode(newOrdered) || !isRelationalNode(newSorted)) {
			quereusError('LimitChoiceNode: both branches must be RelationalPlanNodes', StatusCode.INTERNAL);
		}
		if (newOrdered === this.ordered && newSorted === this.sorted
			&& newLimit === this.limit && newOffset === this.offset) {
			return this;
		}
		return new LimitChoiceNode(
			this.scope,
			newOrdered,
			newSorted,
			newLimit as ScalarPlanNode,
			newOffset as ScalarPlanNode | undefined,
			this.orderedUpTo,
		);
	}
}

function assertSameAttributes(ordered: RelationalPlanNode, sorted: RelationalPlanNode): void {
	const orderedAttrs = ordered.getAttributes();
	const sortedAttrs = sorted.getAttributes();
	if (orderedAttrs.length !== sortedAttrs.length || orderedAttrs.some((attr, i) => attr.id !== sortedAttrs[i].id)) {
		quereusError(
			`LimitChoiceNode branches disagree on attributes: [${orderedAttrs.map(a => a.id).join(', ')}] vs [${sortedAttrs.map(a => a.id).join(', ')}]`,
			StatusCode.INTERNAL,
		);
	}
}
