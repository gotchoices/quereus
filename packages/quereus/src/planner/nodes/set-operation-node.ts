import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError, QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export class SetOperationNode extends PlanNode implements BinaryRelationalNode {
  readonly nodeType = PlanNodeType.SetOperation;
  private attributesCache: Cached<readonly Attribute[]>;

  constructor(
    scope: Scope,
    public readonly left: RelationalPlanNode,
    public readonly right: RelationalPlanNode,
    public readonly op: 'union' | 'unionAll' | 'intersect' | 'except'
  ) {
    super(scope, left.getTotalCost() + right.getTotalCost());
    // Validate column counts
    const leftCols = left.getType().columns;
    const rightCols = right.getType().columns;
    if (leftCols.length !== rightCols.length) {
      throw new QuereusError(`SET operation column count mismatch: left has ${leftCols.length}, right has ${rightCols.length}`, StatusCode.ERROR);
    }
    // TODO: optionally check type compatibility (affinity)
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  private buildAttributes(): readonly Attribute[] {
    const leftAttrs = this.left.getAttributes();
    // Preserve left child's attributes directly to avoid any mapping issues
    // This ensures ORDER BY expressions can resolve to the same attribute IDs
    return leftAttrs;
  }

  getAttributes(): readonly Attribute[] {
    return this.attributesCache.value;
  }

  getType(): RelationType {
    const leftType = this.left.getType();
    const isSet = this.op !== 'unionAll';
    // Key survival across set operations:
    //  - intersect / except: the result is a subset of the left rows, so every
    //    left key still holds on the result.
    //  - union / unionAll: the right side can reintroduce a value the left key
    //    made unique (and UNION ALL duplicates rows outright), so left keys do
    //    NOT survive. Set-ness of UNION/INTERSECT/EXCEPT is carried by `isSet`
    //    (the all-columns key) instead — copying `leftType.keys` here would
    //    over-claim (e.g. `select a,… from ta union select d,… from tb` has a
    //    non-unique first column).
    const keys = (this.op === 'intersect' || this.op === 'except') ? leftType.keys : [];
    return { ...leftType, isSet, keys } as RelationType;
  }

  getChildren(): readonly PlanNode[] {
    return [this.left, this.right];
  }

  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
    return [this.left, this.right];
  }

  computePhysical(_childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    // All set operations drop monotonicOn in this pass.
    // TODO: UNION ALL with disjoint X-ranges on both sides could preserve
    // MonotonicOn(X); see ticket 1-monotonic-on-characteristic for the deferred
    // range-bound reasoning.
    //
    // FDs / ECs / constantBindings are dropped conservatively here:
    //   - UNION ALL / EXCEPT ALL: no row-level FDs can be assumed.
    //   - UNION / INTERSECT: the all-columns FD is already captured by the
    //     `isSet` flag and downstream Distinct-style uniqueness; we do not
    //     materialize per-column FDs.
    //   - Constant bindings cannot survive: even if both sides bound `c = 5`,
    //     a row from the other side may have a different value (UNION of
    //     differing constants is no longer constant).
    return {
      monotonicOn: undefined,
      fds: undefined,
      equivClasses: undefined,
      constantBindings: undefined,
      // Domains can't be assumed across set operations either: a UNION of
      // [a in (1,2)] with [a in (3)] would land outside both source domains.
      domainConstraints: undefined,
    };
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 2) {
      quereusError(`SetOperationNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newLeft, newRight] = newChildren;

    // Type check
    if (!isRelationalNode(newLeft)) {
      quereusError('SetOperationNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }
    if (!isRelationalNode(newRight)) {
      quereusError('SetOperationNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Return same instance if nothing changed
    if (newLeft === this.left && newRight === this.right) {
      return this;
    }

    // Create new instance preserving attributes (set operation preserves left child's attributes)
    return new SetOperationNode(
      this.scope,
      newLeft as RelationalPlanNode,
      newRight as RelationalPlanNode,
      this.op
    );
  }

  override toString(): string {
    return `${this.op.toUpperCase()}(${this.left.id}, ${this.right.id})`;
  }
}
