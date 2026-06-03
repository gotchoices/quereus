description: Fixed `WHERE col = null` / single-value `WHERE col IN (null)` / `col = ?` (param NULL) on a unique-or-PK (point-seek, plan=2) column returning ALL rows. Now correctly returns zero rows (SQL `col = NULL` is UNKNOWN). Reviewed and completed.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9-in-value-list.sqllogic, packages/quereus/test/optimizer/in-multiseek-incount.spec.ts, docs/memory-table.md
----

## What changed (as implemented)

### Part A — runtime guard (`scan-layer.ts`, authoritative)
Both point-seek branches (primary ~line 81; secondary ~line 173) gated on `if (plan.equalityKey != null)`. `!= null` is false for both `undefined` (no key → walk) **and** `null` (a NULL equality key), so a NULL key fell through to the unbounded full-index walk and yielded every row. Changed the gate to `!== undefined` and short-circuit a NULL-bearing key to zero rows via the existing `seekKeyHasNull` helper (handles scalar `null` and composite tuples). This is the **only** part that covers the dynamic-parameter NULL case (`col = ?` bound to NULL), where the value is unknown at plan time.

### Part B — plan-time EmptyResult (`rule-select-access-path.ts`, honest EXPLAIN)
New shared helper `isLiteralNullEquality(c)`: true when a constraint is `=`/single-value-`IN` whose effective literal value is `null` and which carries no dynamic single `valueExpr` (dynamic params deliberately excluded — left to Part A). Emits `createEmptyResultNode(tableRef)` at three sites, mirroring the existing plan=5 all-NULL-IN reduction:
- Standard equality seek (`selectPhysicalNodeFromPlan`, ~line 481)
- Prefix-range builder (`selectPhysicalNodeFromPlan`, ~line 549) — the path Part A does **not** cover
- Legacy PK builder (`selectPhysicalNodeLegacy`, ~line 780) — unreachable for in-tree modules; defensive only

## Review findings

Adversarial pass over commit `bca07b1c`. Read the full diff with fresh eyes before the handoff, traced every NULL/seek code path, checked SPP/DRY/type-safety/correctness, and exercised the new + adjacent behaviors.

### Correctness — checked, no defects
- **`IS NULL` / `IS NOT NULL` are NOT broken (the headline regression risk).** Verified in `constraint-extractor.ts`: `IS NULL`/`IS NOT NULL` are extracted as their own ops (`'IS NULL'`, value `undefined`), never as `=`/`IN` with a null value, so `isLiteralNullEquality` can never fire on them. The NULL-safe binary `IS` operator is likewise not mapped by `mapOperatorToConstraint` (falls to residual). Existing regression guard `test/logic/10.5-indexes.sqllogic:69` (`optional_field IS NULL` on an indexed nullable column → rows 2,4) passes. The scan-layer change (`!= null` → `!== undefined`) does not touch the `equalityKey === undefined` walk path that `IS NULL` uses.
- **Dynamic param `col = ?` bound NULL** correctly preserves a real point-seek at plan time and zeroes out at runtime via Part A — covered by spec tests.
- **`isLiteralNullEquality` discrimination** is sound: it returns false for a non-array `valueExpr` (scalar param) and for dynamic single-value `IN (?)` (array `valueExpr`, `undefined` placeholder value). It is only ever called from sites already filtered to `=`/single-value `IN`.
- **All seek-emitting sites are covered.** Single/composite multi-value IN already drop NULLs (`reduceLiteralSeekValues`/`reduceLiteralSeekTuples`, pre-existing). The three new literal-NULL guards plus Part A's runtime guard close the equality and prefix-range sites. Non-indexed `col = null` returns `[]` via the pre-existing residual filter.

### Test coverage — gap found and fixed inline (minor)
The implementer's tests covered single-column literal NULL (plan=2), dynamic-param NULL, and composite multi-value IN (plan=5), but **two newly-added code paths had no automated coverage**:
- **Prefix-range NULL** (`rule-select-access-path.ts:549`) — the path the code comment explicitly states Part A does *not* cover, making the plan-time EmptyResult the **sole** correctness guarantee. Claimed "verified" manually in the handoff but had no regression test.
- **Multi-column pure-equality** with a NULL component (`:481` with >1 seek col) — a distinct builder from the tested plan=5 cross-product.

Added two cases to `test/optimizer/in-multiseek-incount.spec.ts` (composite `c`/`idx_ab` fixture): `a = 1 AND b = null` and `a = null AND b > 5`, each asserting 0 IndexSeek / 1 EmptyResult / `[]` rows. Both pass and confirm line 549 is reachable (not dead).

### Legacy PK builder branch — investigated, accepted as-is (no ticket)
The implementer flagged the legacy-path NULL guard as unexercised. Confirmed: the memory module always calls `setIndexName` + `setSeekColumns` for any equality/range seek (`vtab/memory/module.ts:404-454`), so equality access always routes through `selectPhysicalNodeFromPlan`; the legacy path is reached only for full scans, which never satisfy the guard's `hasEqualityConstraints && coversPk` precondition. The branch is dead for all in-tree modules but is logically consistent with the index-aware sites, typechecks, and is harmless defensive insurance for external adapters using the legacy heuristic. Not worth a follow-up ticket.

### DRY — noted, not actioned
The `.find(...)` constraint-matching predicate (`op === '=' || single-value IN && handledByCol.has(...)`) is repeated at three points in the prefix-range block (`:524`, `:544`, `:560`). The new guard adds one more copy. This duplication predates the change and matches the surrounding file idiom; refactoring it is out of scope for this fix and would touch untested lines.

### Docs — updated
`docs/memory-table.md` documented the `IS NULL` EmptyResult optimization but not literal NULL-equality. Added a concise "NULL-equality short-circuit" bullet beside it describing the literal `col = NULL` / `IN (NULL)` / composite-prefix → EmptyResult behavior, the dynamic-param runtime path, and the contrast with `col IS NULL`. The optimizer.md hash/merge-join "NULL keys never match" lines are unrelated (join key handling) and correct as-is; no other doc described the broken behavior, so nothing required correction.

### Validation (all green, run during review)
- `node test-runner.mjs` (memory) → **4448 passing, 9 pending, 0 failing** (4446 + 2 new tests)
- `node test-runner.mjs --store --grep "07.9"` → **1 passing** (store path for the NULL cases)
- `yarn typecheck` → clean
- `yarn lint` → clean (re-run after test additions)

No `tickets/.pre-existing-error.md` written — the full memory suite is green at this SHA.
