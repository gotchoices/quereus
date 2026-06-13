description: Set operations (UNION/INTERSECT/EXCEPT) resolve each output column's dedup/compare collation across BOTH inputs through the shared provenance-ranked comparison-collation lattice (explicit > declared > default > BINARY, symmetric, plan-time error on same-rank explicit/declared conflicts), and write the resolved collation into the node's output column/attribute types so the runtime comparator and ORDER BY stay in lockstep automatically. Previously the dedup comparator used the left input's collations only.
prereq: comparison-collation-provenance-and-precedence, join-key-collation-resolution-alignment
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts        # add exported pairwise set-op resolver (reuses private mergeContributions + SOURCE_BY_RANK)
  - packages/quereus/src/planner/nodes/set-operation-node.ts             # resolve per-data-column collation across left+right; write into output attrs (buildAttributes) AND columns (getType)
  - packages/quereus/src/runtime/emit/set-operation.ts                   # NO change expected — already reads attr.type.collationName; verify it picks up resolved collation
  - packages/quereus/src/planner/building/select-compound.ts             # forces getAttributes/getType at build time via createSetOperationScope (where the conflict error surfaces)
  - packages/quereus/test/logic/09-set_operations.sqllogic               # extend, or add 09.1-set-op-cross-collation.sqllogic
  - packages/quereus/test/planner/comparison-collation.spec.ts           # add rank/conflict cases for the new pairwise set-op resolver
  - docs/types.md                                                        # § Comparison collation resolution — add set-operation cross-input subsection
difficulty: medium
----

# Set-operation cross-input collation merge

Set operations are the last row-comparison surface that pairs two relations'
columns without consulting both sides. `emit/set-operation.ts` builds its dedup
/ probe comparators from the combined output attributes (`plan.getAttributes()`),
which are the **left** input's. So `select c_nocase from t1 union select c_plain
from t2` dedups NOCASE; swap the branches and it dedups BINARY — the exact
branch-order asymmetry the comparison lattice (ticket
`comparison-collation-provenance-and-precedence`, complete) was introduced to
remove for ordinary comparisons, and that `join-key-collation-resolution-alignment`
(complete) removed for the four pairwise join-key surfaces.

This ticket aligns set operations with that lattice.

## The shape of the fix (single source of truth)

The runtime emitter at `set-operation.ts:21-23` already derives each data
column's comparator collation from its **output attribute type**:

```ts
const dataComparator = createCollationRowComparator(
  attributes.slice(0, dataColCount).map(attr =>
    attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION)
);
```

Therefore the fix is **not** in the emitter. It is to make `SetOperationNode`
resolve each data column's collation across *both* operands through the lattice
and write that resolved collation into the node's **output column/attribute
types**. Then:

- the dedup / intersect / except / membership comparators pick up the resolved
  collation with **no emitter change** (they read `attr.type.collationName`);
- the output attribute's `collationName` is correct — what an enclosing
  `ORDER BY` over the union sees (the `SortNode` wrapper added by
  `applyOuterOrderBy` keys its comparator off each output column's own
  collation, per the `join-key-collation-resolution-alignment` review: "the
  actual sort comparators all key off each column's OWN declared collation");
- nested set operations re-resolve against the inner node's now-correct output
  column collation **and rank** (forward propagation), so divergence surfaces at
  every level.

One place computes the resolved collation (the node's output type); the
comparator and ORDER BY both read it from there. Lockstep is structural, not
maintained by hand.

## The resolver (reuse, don't reinvent)

`planner/analysis/comparison-collation.ts` already contains the exact symmetric
pairwise resolution, privately, as `mergeContributions([a, b])`:

- highest rank present wins;
- same rank, same name → that name;
- same rank, different names: rank 1 → no contribution (silent BINARY floor —
  defaults are preferences, not declarations); rank ≥ 2 → conflict;
- it returns the **winning `CollationContribution` (name + rank)**, which
  `resolveContributions` discards — and the rank is needed so the output
  column's `collationSource` propagates correctly into nested set-ops / outer
  comparisons.

Add ONE exported wrapper (private `mergeContributions` + existing private
`SOURCE_BY_RANK` stay private; the wrapper is the public surface):

```ts
export type SetOpColumnCollation =
  | { kind: 'resolved'; collationName?: string; collationSource?: CollationSource }
  | { kind: 'conflict'; level: 'explicit' | 'declared'; left: string; right: string };

/**
 * Per-output-column collation of a set operation, merged symmetrically from the
 * two inputs' corresponding column types through the comparison lattice. Mirrors
 * a comparison: a same-rank explicit/declared name conflict is returned for the
 * caller to surface as a plan-time error (DISTINCT operators); rank-1 default
 * conflicts resolve to the BINARY floor (no contribution). The winning rank
 * propagates as `collationSource` so the output column carries forward correctly.
 */
export function resolveSetOpColumnCollation(left: ScalarType, right: ScalarType): SetOpColumnCollation {
  const merged = mergeContributions([collationContribution(left), collationContribution(right)]);
  if (merged.kind === 'conflict') return { kind: 'conflict', level: merged.level, left: merged.left, right: merged.right };
  const c = merged.contribution;
  return c
    ? { kind: 'resolved', collationName: c.name, collationSource: SOURCE_BY_RANK[c.rank] }
    : { kind: 'resolved' };  // BINARY floor — no collationName/collationSource
}
```

(`mergeContributions([a, b])` is semantically `resolveContributions(a, b)`
except it keeps the contribution object instead of collapsing to a bare name —
verify this equivalence in the rank table when adding tests.)

## Conflict policy: DISTINCT errors, bag does not

Dedup is a comparison; UNION ALL does no comparison. So:

- **`union` / `intersect` / `except`** (`op !== 'unionAll'`, i.e. `isSet`): a
  `conflict` result → throw `collationConflictError(...)` at plan-build time
  (the same error a spelled-out `l.c = r.c` would throw, and that
  `validateUsingCollations` throws for USING pairs). Mirrors the comparison
  lattice's prepare-time rejection.
- **`unionAll`**: no dedup, so a `conflict` must **not** throw — propagate no
  collation forward (BINARY-equivalent), exactly as `mergePropagatedCollation`
  swallows conflicts for `||` / CASE (those combiners don't compare either).
  The output column just carries no collation in that case.

Both policies run the same `resolveSetOpColumnCollation` per column; only the
handling of a `conflict` result differs (throw vs. treat-as-no-collation). The
DIFF operator desugars to nested `except`/`union` nodes (all `isSet`), so the
error policy applies to each nested node automatically.

## Node changes (`set-operation-node.ts`)

The data columns are the first `dataColumnCount()` columns; flag columns
(membership `exists … as`, and surfaced inner flags) are appended **after** and
carry `EXISTENCE_FLAG_TYPE` (boolean, no collation) — they are never touched by
this resolution. Resolve only `0 .. dataColumnCount()`.

- Add a cached per-data-column resolution computed from
  `this.left.getType().columns[i].type` and `this.right.getType().columns[i].type`
  for `i in [0, dataColumnCount())`, applying the conflict policy above
  (`isSet = op !== 'unionAll'`). Cache it (mirror the existing
  `attributesCache: Cached`) so `buildAttributes` and `getType` share one
  result and cannot drift.
- In `buildAttributes()`: for the first `dataColumnCount` left attrs, produce
  `{ ...leftAttr, type: { ...leftAttr.type, collationName, collationSource } }`
  using the resolved values (both fields set, possibly to `undefined` for the
  BINARY floor — `collationContribution` keys off `collationName === undefined`).
  **Keep each attr's `id`** (only the type's collation changes) so ORDER BY /
  the enclosing view still resolve. The right-flag attrs and own-flag attrs are
  appended unchanged. Note: the current early-return `if (!this.hasSurfacedFlags)
  return leftAttrs;` must now still apply the resolved collation to the data
  attrs rather than returning `leftAttrs` verbatim.
- In `getType()`: for the first `dataColumnCount` columns of `leftType.columns`,
  produce ColumnDefs with the resolved collation on `type` (same resolved array).
  Flag columns appended unchanged. Same caveat for the no-flags early return.
- Keep left's `ScalarType` as the **base** for each data column (logicalType,
  nullable, etc.) and override only `collationName` / `collationSource`.
  Cross-branch *type/affinity* merge is explicitly out of scope (the existing
  `// TODO: optionally check type compatibility (affinity)` stays).

The conflict error surfaces at plan-build time because
`createSetOperationScope(setNode)` in `select-compound.ts` immediately calls
`setNode.getAttributes()` and `setNode.getType().columns`, forcing the cached
resolution; for DIFF the outer union's `buildAttributes` forces the nested
except nodes transitively. No extra forcing call is needed — but confirm the
error actually fires at prepare (a `.sqllogic` `-- error:` case is the check).

## Edge cases & interactions

- **Branch-order symmetry (the headline fix).** `A union B` and `B union A`
  must dedup under the identical collation. The resolver is symmetric; assert
  both orders produce the same result set for case-variant rows (NOCASE folds
  'Bob'/'bob' regardless of which branch declares NOCASE).
- **Declared-vs-default per column.** `c_nocase` (declared NOCASE, rank 2) UNION
  `c_plain` (default BINARY, contributes nothing) → NOCASE governs dedup, both
  orders. Reverse declared side → still NOCASE.
- **Explicit COLLATE both sides.** Same name → resolves, dedups under it.
  Different names (rank 3) → plan-time conflict error.
- **Declared both sides, different names** (rank 2) → plan-time conflict error.
  Same declared name → resolves.
- **Default conflict** (rank 1, e.g. session-defaulted NOCASE on one side vs
  defaulted RTRIM on the other) → resolves to BINARY **silently**, no error.
- **UNION ALL never errors.** `c_nocase collate nocase union all c_x collate
  rtrim` (two explicit, divergent) must NOT throw — output column carries no
  collation, rows pass through unchanged (bag, no dedup). Explicit regression
  case (it would be the easiest place to wrongly throw).
- **INTERSECT / EXCEPT consistency.** Membership tests must follow the *same*
  resolved collation as UNION over the same inputs. Assert
  `c_nocase intersect c_plain` and `c_nocase except c_plain` fold case the same
  way UNION does. `runIntersect` yields the LEFT row (preserves left values) but
  keys on the resolved collation — verify the yielded row's column still reports
  the resolved `collationName` downstream (it does: the output type is the
  node's, not the row's).
- **Nested set operations / forward propagation.** `(select c_nocase from t1
  union select c_plain from t2) union select c_rtrim_declared from t3`: the
  inner output column resolves to NOCASE at rank 2 (declared), so the outer
  union resolves NOCASE(2) vs RTRIM(2) → **conflict error**. Demoting the inner
  rank to 1 would instead let RTRIM silently win — assert the error fires, which
  pins the rank propagation.
- **Multi-column alignment.** Each column resolves independently; a conflict in
  any one column errors the whole statement even when others resolve. Add a
  two-column case where column 2 conflicts.
- **Membership-flag set-ops** (`union exists left as inL …`). Data columns
  resolve; flag columns (appended after `dataColumnCount`) are untouched. Verify
  the resolution slice is `[0, dataColumnCount())` and a flagged set-op with
  divergent data-column collations still resolves/erros on the data columns only.
- **DIFF.** Expands to `(A except B) union (B except A)`; each nested node is
  `isSet`, so a divergent-explicit-collation DIFF surfaces the conflict error.
- **ORDER BY lockstep.** `select c_nocase from t1 union select c_plain from t2
  order by 1` (or by column name) must sort case-insensitively (NOCASE), proving
  the `SortNode` wrapper reads the resolved output-column collation, not left's
  raw type. This is the end-to-end lockstep assertion.
- **Attribute-id stability under rebuild.** `withChildren` reconstructs the node;
  resolution is deterministic from child types, so the rebuilt node yields the
  same resolved collation and the same data-attr ids. No fixture needed but keep
  the ids stable (override type only).
- **Non-textual columns.** INTEGER/REAL data columns typically carry no
  `collationName` → BINARY floor; resolution is a harmless no-op. No special
  casing.

## Out of scope / forward note

- **No sort-based set-op strategy exists today.** The set-op runtime is BTree
  in-memory dedup; the only other path is the parallel `rule-async-gather-union-all`
  (UNION ALL, no dedup). So there is currently no set-op *ordering requirement*
  on children to keep in lockstep — the ORDER BY wrapper is the sole ordering
  surface, and it reads the resolved output-column collation. If a future
  sort-merge set-op strategy is added, it MUST derive its key collation from the
  resolved output column collation (this same source of truth); call that out to
  its implementer.
- **Cross-branch type/affinity merge** stays deferred (existing TODO in the
  node constructor). This ticket touches collation only.

## Tests

- **`comparison-collation.spec.ts`** (planner unit): add a small rank/conflict
  table for `resolveSetOpColumnCollation` — explicit/explicit (same → name,
  diff → conflict), declared/declared (same → name, diff → conflict),
  declared/default (declared wins, name + 'declared' source), default/default
  diff (→ no collation), one-sided contribution, both-absent (→ no collation),
  and symmetry (swap args → same outcome). Confirms the rank is preserved
  (`collationSource`).
- **`.sqllogic`** (extend `09-set_operations.sqllogic` or add
  `09.1-set-op-cross-collation.sqllogic`): branch-order symmetry; declared-vs-
  default both orders; INTERSECT/EXCEPT consistency with UNION; UNION ALL
  no-error with divergent explicit collations; ORDER BY lockstep (NOCASE union
  sorts case-insensitively); conflict errors via `-- error:` for explicit/explicit
  and declared/declared divergence; a nested-set-op conflict case; a two-column
  case with a conflict in the second column. Run against memory; if any case is
  store-path sensitive (declared collations persist through DDL), note it and
  spot-check `yarn test:store --grep "09"`.

## Validation

- `yarn build` clean.
- `yarn test` (memory) green — streaming: `yarn test 2>&1 | tee /tmp/test.log;
  tail -n 80 /tmp/test.log`.
- `yarn workspace @quereus/quereus run lint` clean (single-quote globs on Windows).
- Spot-check `yarn test:store --grep "09"` if any declared-collation case
  depends on the store reconcile path.

## Docs

- `docs/types.md` § Comparison collation resolution: add a set-operation
  subsection — per output column the two inputs merge symmetrically through the
  same lattice; DISTINCT operators error on same-rank explicit/declared
  conflict; UNION ALL propagates without erroring; the resolved collation
  governs dedup/membership AND the output column's `collationName` (what ORDER
  BY sees) in lockstep. Cross-reference the join-key alignment as the sibling
  surface.

## TODO

- Add `resolveSetOpColumnCollation` (+ `SetOpColumnCollation` type) to
  `comparison-collation.ts`, reusing private `mergeContributions` /
  `SOURCE_BY_RANK`.
- In `SetOperationNode`: add a cached per-data-column collation resolution
  (conflict policy keyed on `isSet`); apply it in `buildAttributes()` and
  `getType()` (override `collationName`/`collationSource` on the first
  `dataColumnCount` columns only, preserving ids and base types).
- Confirm `emit/set-operation.ts` needs no change (it already reads
  `attr.type.collationName`); add a comment there pointing at the node as the
  resolution site if helpful.
- Add the planner unit rank/conflict cases and the `.sqllogic` behavior matrix
  (incl. `-- error:` conflict cases and the ORDER BY lockstep case).
- Run build / test / lint; spot-check store for declared-collation cases.
- Update `docs/types.md`.
