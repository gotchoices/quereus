import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, PhysicalProperties, FunctionalDependency, DomainConstraint, ConstantBinding, UpdateSite } from './plan-node.js';
import type { RelationType, ColumnDef, CollationSource, ScalarType } from '../../common/datatype.js';
import type { Expression } from '../../parser/ast.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError, QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { EXISTENCE_FLAG_TYPE } from './join-utils.js';
import { superkeyToFd } from '../util/fd-utils.js';
import { resolveSetOpColumnCollation, collationConflictError } from '../analysis/comparison-collation.js';

/** A data column's cross-input-resolved collation (override over the left base type). */
interface ResolvedDataCollation {
  readonly collationName?: string;
  readonly collationSource?: CollationSource;
}

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

/**
 * Recursive DATA (non-flag) arity of a set-operation operand. Flags are always
 * appended after the data columns at every depth, so a `SetOperationNode`'s data
 * arity is its left operand's data arity — bottoming out at the left-most non-set-op
 * leaf. A plain operand's data arity is simply its column count.
 */
function dataArity(node: RelationalPlanNode): number {
  return node instanceof SetOperationNode ? node.dataColumnCount() : node.getType().columns.length;
}

/**
 * Count of an operand's surfaced flag columns — everything beyond its data arity.
 * Zero for an unflagged leaf or a flag-less set-op; the recursive total of surfaced
 * flags for a (possibly nested) flagged set-op operand.
 */
function flagCount(node: RelationalPlanNode): number {
  return node.getType().columns.length - dataArity(node);
}

export class SetOperationNode extends PlanNode implements BinaryRelationalNode {
  readonly nodeType = PlanNodeType.SetOperation;
  private attributesCache: Cached<readonly Attribute[]>;
  /**
   * Per-data-column collation resolved across BOTH inputs through the shared
   * comparison lattice (`set-operation-cross-input-collation-merge`). Cached so
   * `buildAttributes` and `getType` read ONE result and cannot drift — the dedup
   * comparator (which keys off the output attribute collation) and an enclosing
   * ORDER BY (which keys off the output column collation) thus stay in lockstep.
   */
  private dataCollationsCache: Cached<readonly ResolvedDataCollation[]>;

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
    // Validate DATA column counts only. Alignment / the union schema / dedup / set
    // identity are all on data columns (model (b), `nestable-flagged-set-ops`): an
    // operand may itself be a (flagged) `SetOperationNode` whose flag columns inflate
    // its total arity but NOT its data arity, so comparing totals would spuriously
    // reject `A union[…] (B union[…] C)`. `dataArity` recurses to the left-most
    // non-set-op leaf, so an inner operand's surfaced flags never enter the check.
    const leftData = dataArity(left);
    const rightData = dataArity(right);
    if (leftData !== rightData) {
      throw new QuereusError(`SET operation column count mismatch: left has ${leftData}, right has ${rightData}`, StatusCode.ERROR);
    }
    // TODO: optionally check type compatibility (affinity)
    this.attributesCache = new Cached(() => this.buildAttributes());
    this.dataCollationsCache = new Cached(() => this.resolveDataCollations());
  }

  /**
   * Resolve each DATA column's dedup/compare collation across both inputs through
   * the shared comparison lattice (`resolveSetOpColumnCollation`). The conflict
   * policy is keyed on set-ness:
   *  - DISTINCT operators (`union`/`intersect`/`except`, `op !== 'unionAll'`) DO
   *    dedup, so a same-rank explicit/declared name conflict is a plan-time error
   *    — the same one a spelled-out `l.c = r.c` would throw. Forced at build time
   *    by `createSetOperationScope` (and, for DIFF, by the outer union forcing the
   *    nested except nodes transitively).
   *  - `union all` does NO dedup, so a conflict must NOT throw — it propagates no
   *    collation forward (BINARY-equivalent), exactly as `mergePropagatedCollation`
   *    swallows conflicts for `||` / CASE. Rows pass through unchanged (bag).
   * Only the first `dataColumnCount()` columns are resolved; flag columns (appended
   * after, `EXISTENCE_FLAG_TYPE`, no collation) are never touched.
   */
  private resolveDataCollations(): readonly ResolvedDataCollation[] {
    const isSet = this.op !== 'unionAll';
    const leftColumns = this.left.getType().columns;
    const rightColumns = this.right.getType().columns;
    const dataCount = this.dataColumnCount();
    const resolved: ResolvedDataCollation[] = [];
    for (let i = 0; i < dataCount; i++) {
      const res = resolveSetOpColumnCollation(leftColumns[i].type, rightColumns[i].type);
      if (res.kind === 'conflict') {
        if (isSet) throw collationConflictError(res);
        resolved.push({}); // union all: no comparison, carry no collation forward
      } else {
        resolved.push({ collationName: res.collationName, collationSource: res.collationSource });
      }
    }
    return resolved;
  }

  /**
   * Data column `i`'s `ScalarType` rebased onto the cross-input-resolved collation:
   * the left operand's type stays the base (logicalType, nullable, affinity —
   * cross-branch type merge stays out of scope) and ONLY `collationName`/
   * `collationSource` are overridden (both possibly `undefined` for the BINARY
   * floor). Callers map this over the first `dataColumnCount()` attrs/columns,
   * preserving attribute ids (only the type's collation changes) so ORDER BY / an
   * enclosing view still resolve and a `withChildren` rebuild yields the same ids.
   */
  private resolvedDataType(baseType: ScalarType, i: number): ScalarType {
    const c = this.dataCollationsCache.value[i];
    return { ...baseType, collationName: c.collationName, collationSource: c.collationSource };
  }

  /** True when this set operation exposes its OWN membership flags. */
  get hasMembershipColumns(): boolean {
    return !!this.membership && this.membership.length > 0;
  }

  /**
   * True when this node surfaces ANY flag column — its own membership flags OR an
   * operand's surfaced flags (a flag-less outer over a flagged operand still surfaces
   * the inner flags). The runtime read half selects the buffering surfacing runner on
   * this, not on `hasMembershipColumns` alone.
   */
  get hasSurfacedFlags(): boolean {
    return this.hasMembershipColumns || this.leftFlagCount > 0 || this.rightFlagCount > 0;
  }

  /**
   * Number of DATA (non-flag) columns — recursively the left-most non-set-op leaf's
   * column count (flags are always appended after data, at every depth). Public: the
   * runtime emitter and the write half both need it.
   */
  dataColumnCount(): number {
    return dataArity(this.left);
  }

  /** Count of the LEFT operand's surfaced flag columns (0 for a plain / flag-less operand). */
  private get leftFlagCount(): number {
    return flagCount(this.left);
  }

  /** Count of the RIGHT operand's surfaced flag columns (0 for a plain / flag-less operand). */
  private get rightFlagCount(): number {
    return flagCount(this.right);
  }

  /**
   * Output index where this node's OWN membership flags begin, after the data columns
   * and BOTH operands' surfaced flag columns:
   * `[data] ++ [L flags] ++ [R flags] ++ [own flags]`.
   */
  private get ownFlagBase(): number {
    return this.dataColumnCount() + this.leftFlagCount + this.rightFlagCount;
  }

  /**
   * Output attributes under the defined projection rule
   * `[data] ++ [L flags] ++ [R flags] ++ [own flags]`:
   *  - data: the first `dataColumnCount` attrs taken verbatim from the left child
   *    (preserves data attribute ids so an ORDER BY / enclosing view still resolves);
   *  - L / R flags: each operand's attrs BEYOND its own data arity (their inner spec
   *    ids ride through verbatim, so a surfaced inner flag keeps the inner node's id);
   *  - own flags: the appended `{true,false}` NOT NULL booleans with pre-minted ids.
   */
  private buildAttributes(): readonly Attribute[] {
    const leftAttrs = this.left.getAttributes();
    const dataCount = this.dataColumnCount();
    // Data attrs carry the cross-input-resolved collation (ids preserved); the dedup
    // comparator and any enclosing ORDER BY both read collation from here.
    const dataAttrs: Attribute[] = leftAttrs.slice(0, dataCount).map((attr, i) => ({ ...attr, type: this.resolvedDataType(attr.type, i) }));
    // No flag anywhere → the result IS the (collation-resolved) data attributes;
    // ids unchanged so ORDER BY expressions resolve to the same ids.
    if (!this.hasSurfacedFlags) return dataAttrs;
    // `leftAttrs` is `[data] ++ [L flags]`: keep the L-flag slice verbatim. Append the
    // right operand's surfaced flags (beyond the shared data arity) and own flags.
    const ownFlagAttrs: Attribute[] = (this.membership ?? []).map(spec => ({ id: spec.attrId, name: spec.name, type: EXISTENCE_FLAG_TYPE }));
    return [
      ...dataAttrs,
      ...leftAttrs.slice(dataCount),
      ...this.right.getAttributes().slice(dataCount),
      ...ownFlagAttrs,
    ];
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
    //  - Surfaced flags (own AND inner) are appended AFTER the data columns, so the key
    //    ColRefs (which index data columns) stay valid and a flag is NEVER part of a key
    //    at any depth (Key-Soundness Inv. 1–2).
    const keys = (this.op === 'intersect' || this.op === 'except') ? leftType.keys : [];
    // Data ColumnDefs carry the cross-input-resolved collation (same cached array the
    // output attrs use, so type.collationName and attr.type.collationName cannot drift).
    const dataCount = this.dataColumnCount();
    const dataColumns = leftType.columns.slice(0, dataCount).map((col, i) => ({ ...col, type: this.resolvedDataType(col.type, i) }));
    if (!this.hasSurfacedFlags) {
      return { ...leftType, isSet, keys, columns: dataColumns } as RelationType;
    }
    // Mirror buildAttributes' `[data] ++ [L flags] ++ [R flags] ++ [own flags]` layout.
    // `leftType.columns` is `[data] ++ [L flags]`: keep the L-flag slice verbatim; append
    // the right operand's surfaced flag ColumnDefs (beyond the shared data arity) and own flags.
    const ownFlagColumns: ColumnDef[] = (this.membership ?? []).map(spec => ({ name: spec.name, type: EXISTENCE_FLAG_TYPE }));
    const columns = [
      ...dataColumns,
      ...leftType.columns.slice(dataCount),
      ...this.right.getType().columns.slice(dataCount),
      ...ownFlagColumns,
    ];
    return { ...leftType, isSet, keys, columns } as RelationType;
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
    // Own flags follow the data columns AND both operands' surfaced flags. The
    // all-data superkey determines EVERY surfaced flag (own and inner — each is a
    // function of the data tuple it probes), so `superkeyToFd` over the full width
    // yields `key → {every surfaced flag}`.
    const totalCols = this.ownFlagBase + this.membership!.length;
    const allDataCols = Array.from({ length: dataColCount }, (_, i) => i);
    const keyFd = superkeyToFd(allDataCols, totalCols);
    return keyFd ? [keyFd] : undefined;
  }

  /** `{true,false}` enum domain per OWN appended flag (at its shifted index). */
  private membershipDomains(): ReadonlyArray<DomainConstraint> {
    const ownFlagBase = this.ownFlagBase;
    return this.membership!.map((_spec, i) => ({
      kind: 'enum' as const,
      column: ownFlagBase + i,
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
    const ownFlagBase = this.ownFlagBase;
    const trueCols: number[] = [];
    const falseCols: number[] = [];
    this.membership!.forEach((spec, i) => {
      const col = ownFlagBase + i;
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
