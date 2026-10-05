description: Inside a transaction on an isolated (store-backed) table, changing a UNIQUE column on a row written earlier in the same transaction now gets checked against already-committed rows, and the primary key's own conflict action no longer leaks onto other UNIQUE columns.
architecture: docs/design-isolation-layer.md#cross-layer-constraint-detection
files:
  - packages/quereus-isolation/src/isolated-table.ts                 # update(), 'update' case, same-PK arm under `existingOverlayRow`; private uniqueColumnsChanged next to compileFor
  - packages/quereus/src/schema/unique-enforcement.ts                # shared uniqueColumnsChanged + anyColumnChanged
  - packages/quereus/src/index.ts                                    # re-export
  - packages/quereus-store/src/common/store-table-constraints.ts     # uniqueColumnsChanged delegates
  - packages/quereus/src/vtab/memory/layer/manager.ts                # uniqueColumnsChanged delegates
  - packages/quereus-isolation/test/isolation-layer.spec.ts          # describe 'same-PK UPDATE of a row staged in the same txn runs the merged UNIQUE check'
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic   # sections P–S
  - docs/design-isolation-layer.md                                   # § Cross-Layer Constraint Detection
----

# Isolation overlay: same-PK UPDATE runs the merged UNIQUE check

## What landed

`IsolatedTable.update` stages writes in an in-memory overlay table and flushes them at commit with `trustedWrite`, which skips the underlying table's own UNIQUE re-check. The arm for an UPDATE of a row already in the overlay, with an unchanged primary key, used to write the overlay directly. It never checked committed rows, and it handed the overlay the PK's `on conflict` action as if the statement had specified it. Depending on the backend and the declared actions, that meant a stored duplicate, an internal error at commit, or a row silently deleted or dropped.

That arm now runs `checkMergedUniqueConstraints` (which searches overlay and committed rows) under the statement's own OR whenever a UNIQUE-relevant column changed. It returns REPLACE evictions through `attachEvicted`, so the delete pipeline (FK cascade, change events) runs for them. The "did a UNIQUE-relevant column change" gate is now one shared function in `schema/unique-enforcement.ts`, used by memory, store and isolation.

## Review findings

**Checked:** the implement diff (bf7b26eb4) read in full: the isolation arm, the shared gate, the memory and store delegations, the index re-export, the docs section, and the tests. I traced `checkMergedUniqueConstraints`, `findOverlayUniqueConflict`, `insertTombstoneForPK`, `stripTombstoneFromResult` and `attachEvicted` to confirm overlay-resident evictions are reported once. The overlay's UNIQUE constraints only cover live rows, so a REPLACE-tombstoned evictee doesn't trigger the overlay write's own check.

**Found and fixed inline:**
- **A tombstoned target row could skip the check.** The implementer flagged this as a known gap. A deleted overlay row keeps its values, so a direct API `update` of that PK back to the same values found "no change", skipped the merged check, and revived the row. Any collision then went to the overlay's own UNIQUE, which uses the PK-folded action. Under `primary key on conflict replace` that silently evicted the row holding the value instead of raising the plain UNIQUE's ABORT. Fix: a tombstoned target always runs the check (`reviving || uniqueColumnsChanged(...)`). I added a test for it. A mutation check confirmed it: with the guard forced off the test fails (`'ok'` instead of `'constraint'`), and with the guard on it passes. The docs section now mentions this too.
- **Missing coverage: a statement-level OR overriding the UNIQUE default.** Added a direct-API test covering IGNORE over a plain UNIQUE, ABORT over a UNIQUE declared `on conflict replace`, and REPLACE with the eviction reported. It has to go through the API: the parser rejects `update or …` by design (47.2 §5, docs/sql.md §11), so SQL UPDATEs always reach `update()` with no statement OR.

**Checked, nothing to do:**
- Memory and store delegations behave the same as before. It's the same per-column `compareSqlValues` logic. The dropped `length === 0` early return is covered by the empty loop. Memory's `uc.predicate!` is safe because the shared helper only calls back for constraints that have a predicate.
- Over-triggering on semantic-ordering columns: already a documented `NOTE:` on the shared helper. It's correct, just not minimal. Left as is.
- The comments in the arm explain why (trusted flush, why the statement OR is used, why the check is gated). They don't narrate the code.

**Noticed, not filed:** when one UNIQUE resolves REPLACE and a later one ABORTs, `checkMergedUniqueConstraints` has already written the REPLACE tombstone before returning the error. All write arms do this; it isn't specific to this one. The statement-level rollback appears to restore the overlay: section P and the spec's post-error row checks stay consistent. The class-level guard for write-arm behaviour is still `debt-isolation-write-arm-differential-test` (backlog). Nothing new filed.

**Runs (all green):** `yarn workspace @quereus/isolation test` (439), `yarn workspace @quereus/isolation typecheck`, `yarn workspace @quereus/store test` (1958), and store-mode logic tests `node test-runner.mjs --store --grep "SQL Logic Tests"` (366 passing, 8 pending), run after rebuilding isolation's `dist`. I didn't re-run `@quereus/quereus` test or lint because this pass touched no quereus source. The implementer's runs (10765 passing, lint clean) still apply.
