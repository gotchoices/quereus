description: Review the added goldens coverage for non-identity / non-invertible columnar decomposition mappings (the lineage-driven `computed-mapping` route in `classifyColumn`). Implement added 5 tests to `lens-put-fanout.spec.ts`; verify they actually pin the writable/read-only boundary and that no cheaper/clearer fixture would cover the same ground.
files: packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/schema/lens-compiler.ts

## What landed

A new describe block in `test/lens-put-fanout.spec.ts`:
**`lens decomposition put: non-identity columnar mappings (computed-mapping route)`** (5 tests).

It advertises a single-member columnar split over `main.N_core` whose anchor maps two
logical columns through **non-column** `LogicalColumnMapping.basisExpr` values — the
first such fixture in the suite (every other advertisement uses identity
`colMap('a','a')`):

- `bumped`  = `a + 1`   — an **invertible transform**. The forward pass threads a `base`
  `UpdateSite` *with* an `inverse`; `resolveBaseSite` surfaces `baseColumn:'a'` + `inverse`.
  `classifyColumn`'s identity gate (`col.inverse === undefined`) therefore **fails**, and the
  column falls through to the `member.columns` loop → `computed-mapping` (read-only).
- `combined` = `a || b`  — a **non-invertible composite**. Concat is not arithmetic, so
  `traceInvertibleColumn` returns null → a `computed` site (no base column) → first gate
  fails on `baseColumn === undefined` → `member.columns` loop → `computed-mapping`.
- `a` (identity) and `id` (identity PK) on the **same member** — the control that must
  stay writable/insertable.

This is the lineage-driven replacement for the retired
`mapping.basisExpr.type !== 'column'` AST check. Before this, the equivalence was asserted
only in prose in `decomposition.ts`; both branches of `classifyColumn`'s `computed-mapping`
fallback (inverse-defeated identity gate, and no-base-column) are now exercised.

### Assertions per the ticket
1. **read-back / forward transform intact** — `select * from x.N` returns `bumped=11`,
   `combined='1020'` for `(id=1,a=10,b=20)`.
2. **UPDATE rejects** — both `set bumped=…` and `set combined=…` raise
   `no-inverse` / "computed (non-invertible) … read-only"; base rows verified untouched.
3. **INSERT rejects** — `(id,bumped)` and `(id,combined)` both raise
   "computed (non-invertible) … cannot receive an inserted value"; no anchor row materialized.
4. **identity sibling stays writable** — `update x.N set a=42` writes through; computed
   columns recompute on read-back (`bumped=43`, `combined='4220'`); `insert (id,a)` materializes.

## Validation done

- `node test-runner.mjs --grep "non-identity columnar mappings"` → 5 passing.
- `--grep "lens decomposition put|lens advertisement"` → 59 passing (no regression).
- `yarn typecheck` (tsc --noEmit) → exit 0.
- `yarn lint 'test/lens-put-fanout.spec.ts'` → exit 0.

## Reviewer notes / honest gaps (treat tests as a floor)

- **Quereus columns default to NOT NULL** (verified: a plain `b integer` rejects a null
  insert). Because `b` backs only the *non-invertible* composite — it has no insertable
  logical column of its own — the logical table is uninsertable unless `b` is nullable.
  The fixture therefore declares `b integer null` *and* `combined text null` (a `lens.
  nullability-mismatch` deploy error fires otherwise, since `a||b` is nullable). This is a
  fixture constraint, not a code change — but worth a sanity check that it isn't masking a
  more interesting case. A reviewer might add an all-NOT-NULL variant to confirm the
  computed-mapping *rejection* (assertions 2/3) still fires before the NOT-NULL check
  (it does — `routeInsertColumn` throws `computed-mapping` before `assertNoMissingNotNull`).

- **NOT carried over from the ticket (explicitly flagged non-blocking there, and still
  open):**
  - `classifyColumn`'s `member.columns` fallback matches by `logicalColumn` name only; it
    does not re-confirm the basis is non-identity. The ticket suggested asserting that an
    identity mapping the lineage *fails* to resolve (e.g. a `memberByTableId` schema+name
    miss) does not silently degrade to read-only. No such test was added — constructing a
    lineage-resolution miss without tripping an earlier validation is non-trivial and was
    deemed out of scope for the core coverage. **Candidate fix/backlog ticket if the
    reviewer wants the robustness pinned.**
  - **Self-decomposition** (two members over the same physical base table) would match
    `memberByTableId` ambiguously. Structurally unsupported today (multi-source rejects
    self-joins), so no defensive reject + test was added. An unguarded assumption — a
    reviewer may want a defensive reject filed.

- Only `bumped`/`combined` live on the **anchor** member. The same `computed-mapping`
  route on a *non-anchor* mandatory member is untested; the routing code path is identical
  (member lookup by `baseTableId`/name), but a reviewer wanting belt-and-suspenders could
  add a non-anchor variant.
