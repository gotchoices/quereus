import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, PhysicalProperties, FunctionalDependency, DomainConstraint, ConstantBinding, UpdateSite } from './plan-node.js';
import type { RelationType, ColumnDef } from '../../common/datatype.js';
import type { Expression } from '../../parser/ast.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError, QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { EXISTENCE_FLAG_TYPE } from './join-utils.js';
import { superkeyToFd } from '../util/fd-utils.js';

/**
 * One `<setop> exists <branch> as <name>` membership-flag column the
 * `SetOperationNode` appends after the data columns. The vertical (row) analogue
 * of the join's `ExistenceColumnSpec`: a clean `{true,false}` NOT NULL boolean
 * **derived at the combinator** by a per-branch semijoin probe (`tuple ∈ branch`),
 * never a stored operand column (which would re-enter the union schema and dedup).
 * The `attrId` is minted once at build time (so it is stable across `withChildren`
 * rebuilds); `branch` is the immediate operand whose membership the flag reifies.
 */
export interface SetOpMembershipSpec {
  readonly attrId: number;
  readonly name: string;
  readonly branch: 'left' | 'right';
}

export class SetOperationNode extends PlanNode implements BinaryRelationalNode {
  readonly nodeType = PlanNodeType.SetOperation;
  private attributesCache: Cached<readonly Attribute[]>;

  constructor(
    scope: Scope,
    public readonly left: RelationalPlanNode,
    public readonly right: RelationalPlanNode,
    public readonly op: 'union' | 'unionAll' | 'intersect' | 'except',
    /**
     * Membership-flag columns appended after the data columns (read half:
     * `set-op-membership-read`). Empty/undefined for an ordinary set operation.
     */
    public readonly membership?: readonly SetOpMembershipSpec[],
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

  /** True when this set operation exposes one or more membership flags. */
  get hasMembershipColumns(): boolean {
    return !!this.membership && this.membership.length > 0;
  }

  /** Number of data (non-flag) columns — the left child's column count. */
  private dataColumnCount(): number {
    return this.left.getType().columns.length;
  }

  private buildAttributes(): readonly Attribute[] {
    const leftAttrs = this.left.getAttributes();
    // Preserve left child's attributes directly to avoid any mapping issues
    // This ensures ORDER BY expressions can resolve to the same attribute IDs.
    if (!this.hasMembershipColumns) return leftAttrs;
    // Membership flags are appended AFTER the data columns — boolean NOT NULL,
    // never marked nullable, with their pre-minted stable ids. Appending (not
    // perturbing the data attributes) keeps set identity / dedup on data columns only.
    const out: Attribute[] = leftAttrs.slice();
    for (const spec of this.membership!) {
      out.push({ id: spec.attrId, name: spec.name, type: EXISTENCE_FLAG_TYPE });
    }
    return out;
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
    //  - Membership flags are appended AFTER the data columns, so the key ColRefs
    //    (which index data columns) stay valid and the flag is NEVER part of a key.
    const keys = (this.op === 'intersect' || this.op === 'except') ? leftType.keys : [];
    if (!this.hasMembershipColumns) {
      return { ...leftType, isSet, keys } as RelationType;
    }
    const flagColumns: ColumnDef[] = this.membership!.map(spec => ({
      name: spec.name,
      type: EXISTENCE_FLAG_TYPE,
    }));
    return { ...leftType, isSet, keys, columns: [...leftType.columns, ...flagColumns] } as RelationType;
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
    // FDs / ECs / constantBindings over the DATA columns are dropped conservatively
    // here (see prior analysis below). The membership flags add their own forward
    // surface — `key → flag`, the `{true,false}` domain, and the read-only existence
    // `UpdateSite` — without touching the data columns' identity.
    //   - UNION ALL / EXCEPT ALL: no row-level FDs can be assumed.
    //   - UNION / INTERSECT: the all-columns FD is already captured by the
    //     `isSet` flag and downstream Distinct-style uniqueness; we do not
    //     materialize per-column FDs.
    //   - Constant bindings cannot survive: even if both sides bound `c = 5`,
    //     a row from the other side may have a different value (UNION of
    //     differing constants is no longer constant).
    if (!this.hasMembershipColumns) {
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

    return {
      monotonicOn: undefined,
      // Invariant 1: `key → flag` for the keyed distinct case (no claim for union all).
      fds: this.membershipFds(),
      equivClasses: undefined,
      // Optional constant-fold (Invariant 2): `except` ⇒ inRight=false, inLeft=true;
      // `intersect` ⇒ all flags true. union/unionAll bind nothing (a row may be in
      // either branch). The runtime probe agrees with these bindings.
      constantBindings: this.membershipConstantBindings(),
      // Domain `{true,false}` per flag — the clean-boolean point.
      domainConstraints: this.membershipDomains(),
      // The read-only `existence` `UpdateSite` per flag (the write half flips routing on).
      updateLineage: this.membershipLineage(),
    };
  }

  /**
   * `key → flag` forward FDs (Invariant 1). A DISTINCT set operation (`isSet`) is
   * keyed on its all-columns combination, so the data columns functionally determine
   * each flag (the flag is `tuple ∈ branch`, a function of the data tuple). A bag
   * (`union all`) has no data-column key, so it makes NO `key → flag` claim.
   */
  private membershipFds(): ReadonlyArray<FunctionalDependency> | undefined {
    if (this.op === 'unionAll') return undefined;
    const dataColCount = this.dataColumnCount();
    const totalCols = dataColCount + this.membership!.length;
    const allDataCols = Array.from({ length: dataColCount }, (_, i) => i);
    const keyFd = superkeyToFd(allDataCols, totalCols);
    return keyFd ? [keyFd] : undefined;
  }

  /** `{true,false}` enum domain per appended flag. */
  private membershipDomains(): ReadonlyArray<DomainConstraint> {
    const dataColCount = this.dataColumnCount();
    return this.membership!.map((_spec, i) => ({
      kind: 'enum' as const,
      column: dataColCount + i,
      values: [true, false],
    }));
  }

  /**
   * Constant-fold the trivially-determined flags (Invariant 2). For `except`
   * (`A except B`) every visible row is in the left and not the right, so a
   * `left` flag is constant-true and a `right` flag constant-false. For
   * `intersect` every visible row is in every branch, so all flags are
   * constant-true. `union` / `union all` fold nothing.
   */
  private membershipConstantBindings(): ReadonlyArray<ConstantBinding> | undefined {
    if (this.op !== 'except' && this.op !== 'intersect') return undefined;
    const dataColCount = this.dataColumnCount();
    const trueCols: number[] = [];
    const falseCols: number[] = [];
    this.membership!.forEach((spec, i) => {
      const col = dataColCount + i;
      const isTrue = this.op === 'intersect' || spec.branch === 'left';
      (isTrue ? trueCols : falseCols).push(col);
    });
    const bindings: ConstantBinding[] = [];
    if (trueCols.length > 0) bindings.push({ attrs: trueCols, value: { kind: 'literal', value: true } });
    if (falseCols.length > 0) bindings.push({ attrs: falseCols, value: { kind: 'literal', value: false } });
    return bindings.length > 0 ? bindings : undefined;
  }

  /**
   * One read-only `existence` `UpdateSite` per membership flag, naming the owning
   * `SetOperationNode` and the immediate operand the flag reifies. Read-only here
   * (`resolveBaseSite` resolves a `set-op-branch` component non-writable in this
   * half); the write half routes a membership-flip to that branch's sub-plan.
   *
   * The `guard` is the branch's accumulated selection predicate. In this read half
   * it is **carried, not consumed** (the write half computes the real conjunction of
   * σ predicates down to the branch's base for predicate-honest leaf addressing), so
   * a `true` literal placeholder is sufficient and honest about the read-half scope.
   */
  private membershipLineage(): ReadonlyMap<number, UpdateSite> | undefined {
    const lineage = new Map<number, UpdateSite>();
    const guard: Expression = { type: 'literal', value: true };
    const setOp = Number(this.id);
    for (const spec of this.membership!) {
      lineage.set(spec.attrId, {
        kind: 'existence',
        component: { kind: 'set-op-branch', setOp, branch: spec.branch },
        guard,
      });
    }
    return lineage.size > 0 ? lineage : undefined;
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

    // Create new instance preserving attributes (set operation preserves left child's
    // attributes). The membership specs carry pre-minted stable attribute ids, so they
    // are threaded verbatim (the appended flag columns survive the rebuild).
    return new SetOperationNode(
      this.scope,
      newLeft as RelationalPlanNode,
      newRight as RelationalPlanNode,
      this.op,
      this.membership,
    );
  }

  override toString(): string {
    return `${this.op.toUpperCase()}(${this.left.id}, ${this.right.id})`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const base: Record<string, unknown> = { op: this.op };
    if (this.hasMembershipColumns) {
      base.membership = this.membership!.map(m => `exists ${m.branch} as ${m.name}`);
    }
    return base;
  }
}
