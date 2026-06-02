description: Added goldens coverage for non-identity / non-invertible columnar decomposition mappings (the lineage-driven `computed-mapping` route in `classifyColumn`). Reviewed: the 5 added tests pin the writable/read-only boundary correctly across both gate sub-branches; validation green. Two adjacent findings filed (1 fix, 1 backlog).
files: packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts
----

## What landed

A new describe block in `test/lens-put-fanout.spec.ts` —
**`lens decomposition put: non-identity columnar mappings (computed-mapping route)`** (5 tests) —
advertising a single-member columnar split over `main.N_core` whose anchor maps two logical
columns through **non-column** `LogicalColumnMapping.basisExpr` values (the first such fixture
in the suite; every other advertisement uses identity `colMap('a','a')`):

- `bumped`  = `a + 1`  — an **invertible transform**. The forward pass threads a `base`
  `UpdateSite` *with* an `inverse`; `classifyColumn`'s identity gate (`col.inverse === undefined`)
  therefore fails and the column routes to `computed-mapping` (read-only).
- `combined` = `a || b` — a **non-invertible composite**. Concat is `opaque`, so the lineage
  resolves a `computed` site (no base column) → first gate fails on `baseColumn === undefined`
  → `computed-mapping`.
- `a` (identity) and `id` (identity PK) on the **same member** — the writable/insertable control.

This is the lineage-driven replacement for the retired `mapping.basisExpr.type !== 'column'` AST
check. Both sub-branches of `classifyColumn`'s `computed-mapping` fallback (inverse-defeated
identity gate; no-base-column) are now exercised. Assertions cover read-back of the forward
transform, UPDATE rejection, INSERT rejection (each with reason-specific message regexes), atomic
no-write on rejection, and the identity sibling staying writable with computed columns recomputing
on read-back.

## Review findings

**Disposition:** the 5 added tests are well-constructed and pin the boundary the lineage
classification now owns. No inline test changes were warranted (the fixture is minimal and the
message-specific regexes prevent false-positive passes). Two *adjacent* findings surfaced during
the adversarial pass and were filed as separate tickets (neither is a defect in the added tests
themselves). All validation green.

### Checked — test correctness & sufficiency

- **Both gate sub-branches genuinely distinct, both exercised.** Traced the routing against
  `scalar-invertibility.ts` and `update-lineage.ts`: `a + 1` is a constant-integer add →
  `classifyArithmetic` → `inverse` profile → `resolveBaseSite` surfaces `baseColumn:'a'` **with**
  an `inverse`, so the gate fails on `col.inverse === undefined` (not on a missing base column).
  `a || b` is `opaque` → `traceInvertibleColumn` returns null → `computed` site → gate fails on
  `baseColumn === undefined`. The two computed columns are therefore not redundant; a single-column
  fixture would leave one branch uncovered. **The fixture is the minimal shape covering both
  branches + a positive control — no cheaper/clearer fixture covers the same ground.**
- **No false-positive passes.** UPDATE/INSERT rejection tests match
  `/computed \(non-invertible\).*read-only/i` and `/computed \(non-invertible\).*cannot receive an
  inserted value/i` — pinned to the `computed-mapping` diagnostic specifically, so they cannot pass
  via an unrelated earlier rejection.
- **Route-order precedence verified (the implementer's open question).** `routeInsertColumn`
  (decomposition.ts:300, throws `computed-mapping`) runs in the supplied-column `.map` *before*
  `emitMemberInsert` → `assertNoMissingNotNull` (decomposition.ts:445/467). So the computed-mapping
  rejection structurally precedes the NOT-NULL check; the `b integer null` / `combined text null`
  fixture nullability is needed only so the **identity-sibling INSERT** (`insert (id, a)`)
  materializes a row with `b` unset — not to dodge a NOT-NULL/computed ordering issue. The flagged
  all-NOT-NULL variant is therefore redundant (the message regex already disambiguates) and was not
  added.
- **Positive control is strong.** `update x.N set a = 42` writes through and the computed columns
  recompute on read-back (`bumped=43`, `combined='4220'`), proving the presence of computed columns
  on a member does not make the whole member read-only (no collateral over-broad gate).
- **Atomicity** asserted on every rejection (base rows untouched / no anchor row materialized).
- **Resource cleanup / type safety**: each test owns its `Database` in try/finally with
  `db.close()`, matching the rest of the file; local `col`/`lit`/`bin` helpers are correctly typed
  AST constructors (no `any`). Lint clean.

### Found & filed (adjacent — not defects in the added tests)

- **`misleading-non-anchor-diagnostic-on-computed-anchor-column` (fix/)** — *new finding from this
  review.* `assertAnchorScoped` (decomposition.ts:813) classifies each WHERE column via
  `classifyColumn`; a computed-mapping column (`bumped`/`combined`) is `kind !== 'member'`, so a
  `delete/update … where bumped = 11` is rejected as *"the WHERE references a non-anchor
  decomposition member"* — factually wrong, since `bumped` lives on the **anchor** member (it is
  merely computed). Reachable today on both DELETE and UPDATE (both call `anchorPredicate`). Filed
  for an accurate diagnostic (and to consider that the substituted base predicate `a+1 = 11` is in
  fact anchor-scoped and could be supported).

- **`decomposition-column-classification-robustness` (backlog/)** — the two latent concerns the
  implementer flagged as out-of-scope, consolidated: (a) `classifyColumn`'s `member.columns`
  fallback matches by `logicalColumn` name only, so an identity mapping whose lineage *fails* to
  resolve silently degrades to read-only (fail-safe direction, but unasserted); (b)
  self-decomposition (two members over the same physical base table) would make `memberByTableId`
  ambiguous (silent last-write-wins in the build loop) — currently unreachable because multi-source
  rejects self-joins, but an unguarded implicit dependency. Both want a defensive reject + test.

### Not found / empty categories

- **No regressions** in the surrounding suite. The change is test-only; the 59-test
  `lens decomposition put|lens advertisement` set still passes unchanged.
- **No docs to update.** The change adds test coverage only; the computed/read-only equivalence was
  already documented in `decomposition.ts` (the `ColumnRoute` / `classifyColumn` doc-comments) and
  `docs/view-updateability.md` § Scalar Invertibility — both read accurately against the
  implementation. No coverage-tracking doc enumerates per-route tests.

## Validation

- `node test-runner.mjs --grep "non-identity columnar mappings"` → **5 passing**.
- `node test-runner.mjs --grep "lens decomposition put|lens advertisement"` → **59 passing** (no
  regression).
- `yarn workspace @quereus/quereus run typecheck` → **exit 0**.
- `yarn lint 'test/lens-put-fanout.spec.ts'` → **exit 0**.
