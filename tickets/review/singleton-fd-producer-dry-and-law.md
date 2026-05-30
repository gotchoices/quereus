description: Review the singleton/≤1-row producer DRY + property-law consolidation. A behavior-neutral refactor: five `computePhysical` producer sites now fold the `∅ → all_cols` singleton through one named helper (`addSingletonFd`), the node-level at-most-one-row predicate has one spelling (`isAtMostOneRow` = `isUnique([])`), and a new "Singleton equivalence" property law pins the three ≤1-row channels (empty key in `keysOf`, the singleton FD, `isAtMostOneRow`) to agree. No semantic change intended; full quereus suite green (3949 passing).
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md
----

## What landed

Pure DRY + invariant-pinning over the already-shipped ≤1-row (singleton/unit) machinery. No `keysOf`/`isUnique` semantics changed; no new type; no behavior change intended.

### Phase A — producer DRY: `addSingletonFd(fds, columnCount)`

New helper in `fd-utils.ts` (placed right after `singletonFd`):

```ts
export function addSingletonFd(
  fds: ReadonlyArray<FunctionalDependency>,
  columnCount: number,
): FunctionalDependency[] {
  const singleton = singletonFd(columnCount);
  return singleton ? addFd(fds, singleton) : fds.slice();
}
```

Folds `singletonFd(columnCount)` into `fds` via `addFd`; a no-op returning a copy when `columnCount === 0` (since `singletonFd(0)` is `undefined`). Replaced the open-coded `const s = singletonFd(n); if (s) fds = addFd(fds, s)` block at the **five** producer sites:

- `aggregate-node.ts` `propagateAggregateFds` (scalar/no-GROUP-BY branch) — was `singleton ? [singleton] : undefined`; now `const fds = addSingletonFd([], outputColumnCount); return { fds: fds.length > 0 ? fds : undefined }`.
- `filter.ts` `computePhysical` (covered-key ⇒ ≤1-row) — `fds = addSingletonFd(fds, sourceAttrs.length)`.
- `limit-offset.ts` `computePhysical` (constant LIMIT ≤ 1) — was `mergeFds(src ?? [], [singleton])`; now `addSingletonFd(src ?? [], colCount)`. Equivalent because `mergeFds(a, [s]) === addFd(a, s)`.
- `table-access-nodes.ts` `computePhysical` (full-PK equality seek).
- `values-node.ts` `computePhysical` (rows ≤ 1).

### Phase B — predicate alias: `isAtMostOneRow(rel)`

New helper in `fd-utils.ts` (after `isUnique`), defined as `isUnique([], rel)`. Migrated the node-level ≤1-row spellings:

- `key-utils.ts` `analyzeJoinKeyCoverage` — `leftIsSingleton` / `rightIsSingleton` now call `isAtMostOneRow(side)` (these two consts feed the three `leftIsSingleton && rightIsSingleton` sites for inner/cross, left, right).
- `rule-orderby-fd-pruning.ts` — the top-of-rule whole-Sort-elimination guard now uses `isAtMostOneRow(node.source)`. The trailing-key superkey check (`isUnique(leadingCols, source)`) stays on `isUnique` — it is not the empty-key case.

Deliberately **not** migrated (out of scope, and `isAtMostOneRow` can't express them): `rule-join-greedy-commute.ts`'s local `isSingleton` and `characteristics.guaranteesUniqueRows` both have a zero-column `estimatedRows === 1` fallback that `isUnique([])` does not capture (a zero-column relation has no representable empty key). The `isAtMostOneRow` JSDoc documents this gap explicitly.

### Phase C — "Singleton equivalence" property law

Added to the `Key Soundness` describe block in `test/property.spec.ts`. For every relational node in the optimized plan over the existing node-zoo query set, asserts both implications:

- `isAtMostOneRow(node)` ⇒ `keysOf(node)` contains the empty key `[]`.
- `hasSingletonFd(node.physical?.fds, colCount)` ⇒ `isAtMostOneRow(node)`.

This catches a future producer that emits `isSet`/an empty key without the matching FD, or the converse. Implemented as a **pure static walk** (no row materialization) — the implications are plan-level facts, so it covers *all* relational nodes, not just the emittable ones Tier-2 isolates (strictly broader than the ticket's "same envelope as Tier-2" suggestion).

### Phase D — docs

`docs/optimizer.md`: added `addSingletonFd` / `isAtMostOneRow` to the FD helper catalog; rewrote the previously-"planned" Singleton-equivalence paragraph to shipped state with the two law implications; updated the two stale `isUnique([], …)` doc mentions (`rule-orderby-fd-pruning` guard, join key-coverage) to `isAtMostOneRow(…)`.

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` → exit 0.
- `eslint` on all 9 changed source/test files → exit 0.
- Focused suites (`property.spec`, `optimizer/keys-propagation.spec`, `optimizer/keysof-isunique.spec`, `optimizer/rule-orderby-fd-pruning.spec`) → 147 passing, incl. the new `singleton equivalence: the ≤1-row channels never disagree`.
- Full quereus suite (`yarn workspace @quereus/quereus run test`) → **3949 passing, 9 pending**, exit 0.
- Did **not** run `test:store` (LevelDB path) — this diff is planner-only and touches no storage code path.

## What the reviewer should scrutinize (tests are a floor)

1. **FD-byte-identity claim vs the zero-column edge.** The migration is byte-identical for every real (column-count ≥ 1) relation. For the *theoretical* zero-column case the helper diverges slightly from the old guards:
   - `limit-offset.ts` and `table-access-nodes.ts` would now produce `fds: []` where the old `singleton ? … : base.fds` left `fds: undefined`/`base.fds`.
   - `aggregate-node.ts` and `values-node.ts` preserve `undefined` via the explicit `fds.length > 0 ? fds : undefined` guard I kept.
   This is behaviorally inert (every consumer treats `[]` and `undefined` identically: `fds ?? []`, `.length` checks, `hasSingletonFd` returns false for both). Zero-column LIMIT / zero-column table seeks do not occur in practice, so no test exercises it. Confirm this is acceptable, or ask for the two divergent sites to re-guard with `colCount > 0 ? addSingletonFd(...) : base.fds` for strict structural parity.

2. **The new law is green by construction.** Given today's `keysOf`/`isUnique`/`hasSingletonFd`, both implications provably hold (isolated reasoning: `isUnique([])` true ⟹ either an empty key is in `keysOf` or `isSuperkey(∅,…)` holds, and the latter requires an empty-determinant FD ⟹ `hasSingletonFd` ⟹ `keysOf` pushes `[]`). So the law is a **regression guard for future producers**, not a check that can fail on the current tree. **Known gap:** unlike the sibling `the soundness check fails loudly on an injected over-claim` self-test, I did **not** add a negative self-test proving `checkSingletonEquivalence` throws on a constructed channel-disagreement. A reviewer who wants the law's teeth demonstrated should add one (a `makeRel`-style stub with a singleton FD but `isSet`/keys suppressed — see `test/optimizer/keysof-isunique.spec.ts` for the stub pattern). I judged a fake-`RelationalPlanNode` stub more rot-prone than valuable here, but it's a defensible add.

3. **`mergeFds` → `addFd` equivalence in limit-offset.** I rely on `mergeFds(a, [s]) === addFd(a, s)`. Worth a second look, though the LIMIT-1 keys-propagation tests (singleton FD present, OFFSET-still-singleton, parameterized-LIMIT negative control) all pass.

4. **Scope boundary.** Verify the two intentionally-unmigrated zero-column-aware singleton checks (`rule-join-greedy-commute.isSingleton`, `characteristics.guaranteesUniqueRows`) were correctly left alone — the ticket named only key-utils + rule-orderby-fd-pruning for Phase B.

## Non-goals (unchanged, as specified)

No new `Singleton` type; no change to `keysOf`/`isUnique` semantics; lens `primary key ()` path untouched; no `TableLiteralNode` singleton work.
