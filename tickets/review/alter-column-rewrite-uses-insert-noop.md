description: Fixed a bug where changing a column's type or tightening it to NOT NULL on an in-memory table silently failed to update the rows already stored — the fix makes those rewrites actually stick, keeps any index on the column in sync, and along the way fixes a stale test/doc pair that had accidentally pinned the old broken behavior as "by design."
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn: setDataType branch (~2095-2124), setNotNull backfill (~2045-2081), rebuild gate (~2181-2199)
  - packages/quereus/test/logic/41.2-alter-column.sqllogic  # new cases 7 & 8
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # updated pinned expectations (see below)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts       # updated stale comment
  - docs/materialized-views.md  # updated "Known limitation — type-sensitive CHECK on the reshape arm" paragraph
difficulty: easy
----

## What landed

`MemoryTableManager.alterColumn` had two loops that rewrote already-stored rows via `tree.insert(newRow)` — the SET DATA TYPE physical-conversion loop and the SET NOT NULL NULL-backfill loop. `inheritree`'s `BTree.insert` is a no-op when the key already exists, and every rewritten row keeps its PK, so **neither loop ever actually wrote anything**: converted/backfilled values were computed and discarded. `SET NOT NULL` was the worse case — it reported success while leaving real NULLs in a column now declared NOT NULL.

Fix, both in `manager.ts`:
1. `tree.insert(newRow)` → `tree.upsert(newRow)` in both loops (`upsert` overwrites the entry at an existing key in place; the loops already snapshot all rows before mutating, so iterating a possibly-different-in-place tree mid-loop is safe).
2. A new `valuesRewritten` flag, set by either loop when it actually rewrote ≥1 row, gates a new `else if (valuesRewritten) this.baseLayer.rebuildAllSecondaryIndexes();` alongside the existing `if (collationChanged)` rebuild — so a secondary index on the altered column reflects the new values instead of stale keys extracted from the old ones. A metadata-only SET DATA TYPE (same physical type) or a SET NOT NULL with zero NULL rows sets no flag and pays no rebuild cost.

## Use cases for testing / validation

New sqllogic cases in `41.2-alter-column.sqllogic` (§7, §8):
- **§7**: `text → integer` SET DATA TYPE on a table with an index on the converted column. Confirms the converted values are real integers (`typeof(v) = 'integer'`), a numeric-equality lookup (`where v = 9`) finds the row (this is the index-backed-lookup regression the bug caused — previously the index still held old keys), and the plain column read shows the converted values.
- **§8**: SET NOT NULL with a nullable-column `default 7`, backfilling 2 pre-existing NULL rows plus one already-non-NULL row untouched. Confirms `count(*) where v is null` is 0 after the ALTER (the crux of the NOT NULL half of the bug: previously the ALTER "succeeded" while NULLs survived).

Run: `yarn workspace @quereus/quereus test` — **6902 passing / 13 pending / 0 failing** at handoff (full monorepo `yarn test` also green: quereus-store, sync, sync-client, etc. all pass). `yarn workspace @quereus/quereus run lint` clean (eslint + test-file type-check).

## A real regression this fix surfaced and I fixed inline

`yarn test` initially had **1 failing** test after the core fix: `maintained-table-refresh-revalidation.spec.ts` § *reshape arm: type-sensitive CHECK (documented limitation)*. That suite pins a materialized-view refresh corner where a `retype`-during-reshape commits a row that violates its own CHECK under the final column type. Its pinned assertions and the matching paragraph in `docs/materialized-views.md` explicitly depended on the *old, buggy* behavior — they asserted `set data type` was "metadata-only" (`typeof(v)` stays `'text'` after a `TEXT → INTEGER` retype). That was literally describing the bug this ticket fixes.

I re-derived the corrected behavior with a standalone repro (not committed) rather than guessing, and confirmed: the CHECK-violation corner is **not** closed by this fix — the row still commits and still violates its CHECK after refresh — but the stored representation genuinely changes now (`v` becomes integer `10`, not text `'10'`), because the retype-during-reshape is a raw backing rewrite, not a revalidating one (it never re-runs the CHECK against the freshly-converted value). I updated:
- the 3 affected `it()` blocks in that spec (assertions + explanatory comments) to expect the physically-converted value,
- the sibling comment in `materialized-view-refresh-reshape.spec.ts` (same stale "metadata-only" claim, didn't break an assertion since that test's check was a relative comparison, but was misleading),
- the "Known limitation — type-sensitive CHECK on the reshape arm" paragraph in `docs/materialized-views.md` to match.

**Reviewer: please double check my re-derivation of that corner**, since I'm the one who both changed the underlying mechanism and rewrote the pins for it — an independent read is more valuable here than usual. The standalone repro output I based the rewrite on:
```
after refresh: [ { id: 1, v: 10 } ]   // was v: '10' (text) before this fix
lt: [ { lt: false } ]                  // CHECK still violated — corner still open
```
plus the 3 follow-on assertions in that `it()` block (no-delta touch stays frozen, a genuine re-derivation is rejected, a fresh offending insert is rejected) — all unchanged in shape from before, just `v: 10` instead of `v: '10'`.

## Known gaps / things to probe (your tests are a floor, not a ceiling)

- **SET DATA TYPE on a PRIMARY KEY column is already rejected** (`Cannot SET DATA TYPE on PRIMARY KEY column '<name>'`) — I verified this with a throwaway repro before writing this handoff, because `upsert(newRow)` would silently orphan the old key if the PK's own extracted key changed under conversion (upsert looks up the *new* row's key, which would differ from the old one, and land as a fresh insert rather than an in-place overwrite). Since the engine already blocks this path, it's not a live risk — flagging only so a reviewer doesn't have to re-derive it.
- **Store backend (`quereus-store`) SET NOT NULL backfill already uses the correct mechanism** — I checked `alterColumnSetNotNull` in `packages/quereus-store/src/common/store-module.ts` (~line 1934): it calls `table.mapRowsAtIndex(colIndex, ...)` after flushing pending ops, not the buggy `tree.insert` pattern. No change needed, confirmed rather than assumed per the ticket's "worth a quick sanity check" note.
- **Open-transaction case is explicitly out of scope** here (per the original ticket) — covered separately by ticket `bug-alter-column-set-data-type-sees-transaction-rows`. This fix is scoped to the autocommit path where `alterColumn` mutates the base layer directly.
- I did not add a dedicated regression test for the materialized-view-reshape interaction (the spec-file fixes above are corrections to existing pins, not new coverage) — the underlying `41.2-alter-column.sqllogic` cases are the direct coverage for this ticket's own fix.
