description: `WHERE col = null` / single-value `WHERE col IN (null)` / `WHERE col = ?` (param bound NULL) on a unique-or-PK (point-seek, plan=2) column return ALL rows instead of none. SQL `col = NULL` is UNKNOWN ⇒ zero rows. Two complementary fixes: a runtime guard in scanLayer (authoritative; also covers dynamic-param NULL) and a plan-time EmptyResult for literal NULL equality (honest non-degraded EXPLAIN), mirroring the existing plan=5 all-NULL-IN treatment.
prereq:
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9-in-value-list.sqllogic, packages/quereus/test/optimizer/in-multiseek-incount.spec.ts
----

## Confirmed reproduction

Setup: `create table u (id integer primary key, v integer unique) using memory; insert into u values (1,5),(2,7),(3,9);`

| Query | Current (WRONG) | Expected |
|---|---|---|
| `select id from u where v = null`    | `[1,2,3]` | `[]` |
| `select id from u where v in (null)` | `[1,2,3]` | `[]` |
| `select id from u where id = null`   | `[1,2,3]` | `[]` (primary-key point seek) |
| `select id from u where v = ?` bind `[null]`  | `[1,2,3]` | `[]` (**dynamic param**) |
| `select id from u where id = ?` bind `[null]` | `[1,2,3]` | `[]` (**dynamic param**) |

Already correct (verified, do not regress):
- `where v in (null, null)` → `[]`  (plan=5 multi-seek; all-NULL → EmptyResult)
- `where v in (5, null)`    → `[1]` (plan=5 multi-seek; NULL key skipped)
- `where a = null and b > 5` on a **non-unique** composite index `(a,b)` → `[]` (falls to seqscan + residual filter, or prefix-range walk breaks on the comparison)
- `where a = null` on a **non-unique** leading index column → `[]` (seqscan + residual filter)

The bug is specific to columns whose NULL equality is **"handled" by a point-seek (plan=2)** — i.e. unique columns and the primary key. Non-unique columns degrade to a seqscan whose residual scalar filter correctly rejects every row, so they are unaffected.

## Root cause

A NULL-literal (or single-element NULL-IN) equality is extracted as a *handled* `=` constraint and compiled to a point-seek (`plan=2`) whose materialized `equalityKey` is SQL `null` (see `buildEqualityKey` / `buildCompositeEqualityKey` in `scan-plan.ts` — both return the literal `null`).

In `scanLayer` (`scan-layer.ts`) both point-seek branches gate on:

```ts
if (plan.equalityKey != null) { /* seek; return */ }
```

`!= null` is true for neither `undefined` (no equality key — range/full scan) **nor** `null` (a NULL equality key). So a NULL key falls through past the seek into the **unbounded full-index walk** that yields every row. Because the constraint was reported handled, the planner attached no residual predicate to re-filter, and the spurious rows survive.

This is the single-value (plan=2) analogue of the already-fixed multi-seek (plan=5) NULL bug (`complete/in-value-list-duplicate-or-null-row-multiplication`). That fix special-cased NULL seek keys only in the multi-seek branch (`seekKeyHasNull`, line ~18, used at line ~47). The point-seek branches never got the same treatment.

## Fix design (two complementary parts)

### Part A — Runtime guard in `scan-layer.ts` (REQUIRED; authoritative)

This is the correctness fix and the **only** part that handles the dynamic-parameter NULL case (`col = ?` bound to NULL), where the value is unknown at plan time.

Both point-seek branches (primary, line ~81; secondary, line ~168) must distinguish "NULL equality key ⇒ zero rows" from "no equality key ⇒ walk". Change the gate from `!= null` to `!== undefined`, then short-circuit a NULL key to zero rows using the existing `seekKeyHasNull` helper (which already handles both a scalar `null` and a composite tuple containing a `null` component):

```ts
if (plan.equalityKey !== undefined) {
    if (seekKeyHasNull(plan.equalityKey)) return; // NULL equality is UNKNOWN ⇒ no rows
    const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
    ...
    return;
}
```

Notes / why this is safe:
- For a genuine range/ordering/full scan, `equalityKey` is left `undefined` by `buildScanPlanFromFilterInfo`, so `!== undefined` is false and control reaches the walk exactly as before.
- For a NULL equality (literal or dynamic), `buildEqualityKey` returns the literal `null`, so the branch is entered and short-circuited. Do **not** rely on `tree.get(null)` finding nothing — that would incorrectly match a stored NULL index entry for a composite key like `[1, null]`. The explicit `seekKeyHasNull` return is what guarantees three-valued-logic correctness.
- `seekKeyHasNull` is already defined and imported in this file; reuse it, do not duplicate.

### Part B — Plan-time EmptyResult for literal NULL equality in `rule-select-access-path.ts` (honest EXPLAIN)

For **literal** NULL equality, emit `createEmptyResultNode(tableRef)` instead of a doomed point-seek, mirroring the existing plan=5 treatment (the all-NULL IN list at line ~336 and the composite all-NULL cross-product at line ~401 already do this). This gives a non-degraded EXPLAIN plan (EmptyResult, not a full IndexSeek/SeqScan) and lets the regression assert the chosen plan is not a degraded scan.

Sites to handle (all build a `plan=2` seek from constraint values):
- **Standard equality seek** — `selectPhysicalNodeFromPlan`, the `allEquality && eqBySeekCol.size === seekCols.length` block, line ~477. Before materializing `seekKeys`, if any equality constraint resolves to a **literal** NULL, return `createEmptyResultNode(tableRef)`. A constraint is a literal NULL when it has no dynamic `valueExpr` and its effective value is `null` — i.e. (`c.op === '='` with `c.value === null`) or (`c.op === 'IN'` with `c.value === [null]`), and `c.valueExpr` is undefined/array-only. Reuse the same literal-vs-dynamic discrimination already used a few lines down when building `seekKeys` (`c.valueExpr && !Array.isArray(c.valueExpr)` ⇒ dynamic, keep; otherwise literal). Do **not** emit EmptyResult for a dynamic `valueExpr` — Part A's runtime guard covers that.
- **Legacy PK builder** — `selectPhysicalNodeLegacy`, the PK equality-seek block, line ~746. Same literal-NULL check before building `seekKeys` from `eqByCol`.
- **Prefix-range builder** — `selectPhysicalNodeFromPlan`, line ~528 (`prefixEqCols`/`trailingRangeCol`). Empirically `a = null and b > 5` already returns `[]` today, but that relies on the runtime prefix-comparison breaking on the first row rather than on an explicit NULL check. For robustness, if any prefix equality value is a literal NULL, return `createEmptyResultNode`. Lower priority than the first two; if it complicates the change, leave the existing (already-correct) behavior and note it — Part A does not touch the prefix path (it uses `equalityPrefix`, not `equalityKey`), so any prefix coverage here is plan-time only.

Consider factoring the literal-NULL test into a small shared helper next to `reduceLiteralSeekValues` (line ~962) to keep the three sites DRY.

## Store module

The store path applies a residual scalar filter (see the header of `07.9-in-value-list.sqllogic`), so it is expected to already return `[]` for NULL equality — verify, don't assume. Part B lives in the module-agnostic planner and benefits any module that routes through `selectPhysicalNode`; Part A is memory-module-local. The `07.9` sqllogic file already runs against both the memory and store modules in CI, so adding the result-correctness cases there covers the store path automatically. If a store case still fails after the fix, capture it per the pre-existing-error protocol rather than expanding scope.

## Regression tests

- `test/logic/07.9-in-value-list.sqllogic` — extend the "Single-value baseline" section (after line ~21) with the zero-row NULL-equality cases on the unique column and the PK, e.g.:
  ```
  select k, v from t where v in (null);   → []
  select k, v from t where v = null;      → []
  select k, v from t where k = null;      → []
  ```
  (runs on both memory + store modules — covers the store path).
- `test/optimizer/in-multiseek-incount.spec.ts` (or a sibling spec) — add a plan-shape assertion mirroring the existing all-NULL-IN test (line ~84) for the **single-column plan=2** equality: `SELECT id FROM u WHERE v = null` and `... WHERE v IN (null)` must produce **zero** `IndexSeekNode` and **one** `EmptyResultNode`, and eval to `[]`. Update the comment at line ~135–138 ("Unlike the single-column plan=2 equality path (tracked in fix/in-null-equality-returns-all-rows)…") since that path is now fixed too.
- Optionally add a dynamic-param case in a spec (sqllogic can't bind params): `db.eval('select id from u where v = ?', [null])` ⇒ `[]`, asserting Part A independently of Part B.

## How to run the repro during implement

No build needed — run TS straight through the loader from the repo root:
```
node --import ./packages/quereus/register.mjs <script.mjs>
```
(import `./src/index.js` from a script placed inside `packages/quereus/`). Delete any scratch script before finishing.

## TODO

### Phase 1 — Runtime correctness (Part A)
- [ ] In `scan-layer.ts` primary point-seek branch (~line 81): change `plan.equalityKey != null` → `plan.equalityKey !== undefined`, add `if (seekKeyHasNull(plan.equalityKey)) return;` as the first statement inside.
- [ ] Same change in the secondary-index point-seek branch (~line 168).
- [ ] Verify `seekKeyHasNull` covers the composite-tuple-with-null case (it does — line ~18); reuse, don't duplicate.

### Phase 2 — Plan-time EmptyResult (Part B)
- [ ] Add a literal-NULL-equality check at the standard equality-seek site (~line 477) → `createEmptyResultNode`.
- [ ] Add the same check at the legacy PK equality-seek site (~line 746).
- [ ] (Lower priority) Add the prefix-equality literal-NULL check (~line 528); or document leaving the already-correct behavior.
- [ ] Factor the literal-NULL test into a shared helper near `reduceLiteralSeekValues` to stay DRY.

### Phase 3 — Tests & validation
- [ ] Add the zero-row sqllogic cases to `07.9-in-value-list.sqllogic` (memory + store coverage).
- [ ] Add the plan-shape (EmptyResult, no IndexSeek) + eval-`[]` spec assertions for single-column plan=2 NULL equality; update the stale comment in `in-multiseek-incount.spec.ts`.
- [ ] Add a dynamic-param `v = ?`/`id = ?` bound-NULL spec asserting `[]`.
- [ ] Run `yarn test` (from `packages/quereus` or via `yarn workspace @quereus/quereus run test`) and confirm green; stream output with `2>&1 | tee` per AGENTS.md. Run `yarn lint` (single-quoted globs on Windows).
- [ ] Sanity-check the original 5 repro queries above all now return the expected rows.
