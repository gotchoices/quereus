description: Fixed `WHERE col = null` / single-value `WHERE col IN (null)` / `col = ?` (param NULL) on a unique-or-PK (point-seek, plan=2) column returning ALL rows. Now returns zero rows (SQL `col = NULL` is UNKNOWN). Two complementary fixes landed: Part A runtime guard in scanLayer (authoritative; covers dynamic-param NULL), Part B plan-time EmptyResult for literal NULL equality (honest non-degraded EXPLAIN).
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9-in-value-list.sqllogic, packages/quereus/test/optimizer/in-multiseek-incount.spec.ts
----

## What changed

### Part A — runtime guard (`scan-layer.ts`, REQUIRED, authoritative)
Both point-seek branches (primary ~line 81; secondary ~line 168) had `if (plan.equalityKey != null)`. `!= null` is false for both `undefined` (no key → walk) **and** `null` (a NULL equality key), so a NULL key fell through to the unbounded full-index walk and yielded every row.

Changed the gate to `!== undefined`, then short-circuit a NULL-bearing key to zero rows using the **existing** `seekKeyHasNull` helper (handles scalar `null` and composite tuples containing `null`):

```ts
if (plan.equalityKey !== undefined) {
    if (seekKeyHasNull(plan.equalityKey)) return; // NULL equality is UNKNOWN ⇒ no rows
    const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
    ...
    return;
}
```

This is the **only** part that handles the dynamic-parameter NULL case (`col = ?` bound to NULL), where the value is unknown at plan time so the seek node is preserved. The explicit `seekKeyHasNull` return (not relying on `tree.get(null)` missing) is what guarantees three-valued-logic correctness for composite keys like `[1, null]`.

### Part B — plan-time EmptyResult (`rule-select-access-path.ts`, honest EXPLAIN)
Added a small shared helper `isLiteralNullEquality(c)` next to `reduceLiteralSeekValues` (~line 962): true when a constraint is `=`/single-value-`IN` whose effective literal value is `null` and which carries **no dynamic single `valueExpr`**. A dynamic `valueExpr` (parameter) is deliberately excluded — its NULL-ness is unknown at plan time and is left to Part A. (A dynamic single-value `IN (?)` carries an *array* `valueExpr` and an `undefined` placeholder value, so it is also rejected by the effective-value check.)

Emits `createEmptyResultNode(tableRef)` at three sites, mirroring the existing plan=5 all-NULL-IN treatment:
- **Standard equality seek** (`selectPhysicalNodeFromPlan`, ~line 477) — checks all `eqBySeekCol` values. **Exercised** by the memory module (verified: `v = null`, `v IN (null)`, `id = null`, `id IN (null)` → EmptyResult).
- **Prefix-range builder** (`selectPhysicalNodeFromPlan`, ~line 528) — checks `prefixEqCols`. **Exercised** (verified: `a = null and b > 5` on composite index `(a,b)` → EmptyResult; the prior behavior relied on the runtime prefix walk breaking on the first row).
- **Legacy PK builder** (`selectPhysicalNodeLegacy`, ~line 746) — checks `pkCols`. Return type widened to include `EmptyResultNode`. **NOT exercised by any current test** — see Known gaps.

## How to validate / use cases

Setup: `create table u (id integer primary key, v integer unique) using memory; insert into u values (1,5),(2,7),(3,9);`

| Query | Before (WRONG) | Now |
|---|---|---|
| `select id from u where v = null`    | `[1,2,3]` | `[]` |
| `select id from u where v in (null)` | `[1,2,3]` | `[]` |
| `select id from u where id = null`   | `[1,2,3]` | `[]` |
| `select id from u where v = ?` bind `[null]`  | `[1,2,3]` | `[]` (dynamic param, Part A) |
| `select id from u where id = ?` bind `[null]` | `[1,2,3]` | `[]` (dynamic param, Part A) |

Plan shapes (all verified): literal NULL equality → **0 IndexSeekNode, 1 EmptyResultNode**; dynamic `= ?` → **1 IndexSeekNode** (real seek, Part A guards at runtime).

Did NOT regress (verified): `v in (null,null)` → `[]`; `v in (5,null)` → `[{id:1}]`; `v = 7` → `[{id:2}]`; `id = 2` → `[{id:2}]`; `a = 1 and b > 5` → prefix-range seek returns `[{1},{2}]`.

### Tests added
- `test/logic/07.9-in-value-list.sqllogic` — four zero-row cases in the single-value baseline section: `v in (null)`, `v = null`, `k = null`, `k in (null)`. Runs on **both** memory and store modules.
- `test/optimizer/in-multiseek-incount.spec.ts` — 4 plan-shape+eval cases (literal NULL equality → 0 IndexSeek + 1 EmptyResult + `[]`) and 2 dynamic-param cases (`v = ?`/`id = ?` bound NULL → still a point-seek at plan time, evals to `[]`). Updated the now-stale comment at the composite `b = null` test.

### Commands run (all green)
- `node packages/quereus/test-runner.mjs` (memory) → **4446 passing, 9 pending, 0 failing**
- `node packages/quereus/test-runner.mjs --store --grep "07.9"` → **1 passing** (store path for the new NULL cases)
- `yarn lint` (in `packages/quereus`) → clean
- `yarn typecheck` → clean

## Known gaps / reviewer focus

- **Legacy PK builder check is unexercised.** `selectPhysicalNodeLegacy`'s literal-NULL guard is defensive: the memory module always supplies `indexName`/`seekColumnIndexes`, so it routes through `selectPhysicalNodeFromPlan` and never reaches the legacy path. No test covers it. A reviewer may want to confirm whether any in-tree module (or external adapter) actually hits the legacy path, and if so add coverage — or decide the dead branch isn't worth carrying. It is logically consistent with the index-aware sites and compiles/typechecks clean.
- **Store module: only `07.9` was run under `--store`**, not the full `yarn test:store` (slow). The 07.9 NULL cases pass on store; Part A is memory-module-local and Part B is module-agnostic planner code, so store correctness rides on the residual scalar filter that already existed. If the full store suite surfaces anything, treat per the pre-existing-error protocol.
- **`isLiteralNullEquality` plan-time literal discrimination** mirrors the seekKeys builders' `c.valueExpr && !Array.isArray(c.valueExpr)` test. Worth a second look that no constraint shape slips through as a false literal-NULL (would wrongly emit EmptyResult) — the dynamic-param specs guard the most likely such shape (`= ?`), and the composite/IN paths are covered by the existing plan=5 tests.
- No `tickets/.pre-existing-error.md` was written — the full memory suite was green at this SHA.
