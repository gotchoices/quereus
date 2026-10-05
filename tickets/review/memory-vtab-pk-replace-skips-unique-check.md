description: On the built-in in-memory tables (and, inside transactions, on store-backed tables), a write that replaced an existing row by primary key skipped the other UNIQUE columns' checks, so two rows could share a value declared unique. Now every UNIQUE constraint is still checked under its own conflict action, as SQLite does.
architecture: docs/runtime.md
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # performInsert, performUpdateWithPrimaryKeyChange, resolvePkConflict, UniqueCheckSelf + isSelfKey, the five UNIQUE-check helpers
  - packages/quereus-isolation/src/isolated-table.ts                   # insert arm, live overlay row at the PK + REPLACE → checkMergedUniqueConstraints
  - packages/quereus/src/common/types.ts                               # UpdateResult doc comment
  - docs/runtime.md                                                    # new paragraph after the replacedRow/evictedRows bullets
  - docs/module-authoring.md                                           # module-author contract sentence (~L1119)
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic   # cases A–L
  - packages/quereus-isolation/test/isolation-layer.spec.ts            # two new tests next to the tombstone-revival UNIQUE tests
----

# Review: PK-conflict REPLACE no longer skips secondary UNIQUE checks

## What changed

**Memory table (`MemoryTableManager`).**

- `performInsert`: a PK collision resolved by REPLACE no longer writes and returns early. It falls through to the same `checkUniqueConstraints` the non-colliding insert runs (statement OR > each constraint's own default > ABORT), then `recordUpsert(pk, new, existingRow)` and returns `replacedRow` **and** `evictedRows`. PK-conflict resolution is factored into `resolvePkConflict` (shared by insert and key-changing update).
- `performUpdateWithPrimaryKeyChange`: the UNIQUE check now runs **before any mutation**, excluding both the new PK (the displaced row) and the old PK (the moving row itself). This needed the check helpers to exclude two keys, so their `newPrimaryKey: BTreeKeyForPrimary` parameter became `self: UniqueCheckSelf` (`{ key, vacated? }`) with an `isSelfKey` helper. An object rather than an array of keys because a composite PK is itself an array — an array-of-keys parameter would silently accept an unwrapped key. On success the journal order is: secondary-UNIQUE evictions, delete row at new PK, delete old row, insert new row — matching the store backend and the pinned data-event contract (`test/data-event-key-contract.spec.ts`: evict-delete, move-delete, move-insert). The old "delete old row, check, re-insert old row on failure" dance is gone; a side effect is that a UNIQUE IGNORE on a key-changing update no longer journals a spurious delete+insert of the unchanged old row.

**Isolation layer (`IsolatedTable.update`, insert arm).** When the target PK already holds a live row in the transaction's overlay and the action is REPLACE, it now runs `checkMergedUniqueConstraints` (overlay + committed rows, original `args.onConflict`) before writing. Previously it went straight to the overlay, whose memory module sees only overlay rows, and the commit flush writes trusted (no store re-check) — so a duplicate against a committed row was committed. Found via case I in store mode; same defect class as the ticket, adjacent site.

**Docs.** `UpdateResult` doc comment (types.ts), `docs/runtime.md`, `docs/module-authoring.md`: `replacedRow` and `evictedRows` now co-occur; module authors must check every secondary UNIQUE after a PK REPLACE.

## Test coverage

`47.2.1-pk-replace-secondary-unique.sqllogic` (all expected results cross-checked against SQLite in the fix stage for A–F):

- A: `insert or replace` — PK and UNIQUE conflicts both evicted; FK `on delete cascade` child of the UNIQUE-evicted row is removed (proves the executor eviction pipeline runs).
- B: PK `on conflict replace` + plain `unique` → UNIQUE error, table unchanged.
- C: key-changing UPDATE, PK replace + UNIQUE abort → error, table unchanged.
- D / E: both constraints REPLACE (update / insert) → single surviving row.
- F: PK replace + UNIQUE `on conflict ignore` → whole insert skipped.
- G: PK replace where the new UNIQUE value equals the replaced row's own value → no self-conflict.
- H–K: inside explicit transactions, with the replaced row and/or the UNIQUE-colliding row staged in the transaction vs committed (I and K exercise the isolation fix in store mode).
- L: key-changing UPDATEs in a transaction over transaction-staged rows (abort and replace).

Before the fix, memory mode failed at case A; store mode failed at case I until the isolation fix. Two isolation-package specs (run under plain `yarn test`) pin the isolation fix; I confirmed the first fails with the fix disabled (commit-time flush error).

Runs: `yarn workspace @quereus/quereus test` 10765 passing; `yarn workspace @quereus/quereus run test:store` 10757 passing (after `tsc -b tsconfig.build.json` — store mode consumes built `dist`); `@quereus/isolation` test 429 passing + typecheck clean; `@quereus/store` test 1958 passing; `@quereus/quereus` lint clean.

## Known gaps / for the reviewer

- **Not fixed here, filed:** `fix/isolation-overlay-same-pk-update-skips-unique-check` — a same-PK UPDATE of a row already staged in the transaction overlay never runs the merged UNIQUE check; store mode commits a duplicate (verified). Needs a changed-columns gate to avoid an O(N²) overlay scan on bulk updates, so it was not bolted on here.
- The isolation layer still hands the overlay the PK-resolved action (`effectiveOR`, which folds in a PK-level `on conflict` default) as if it were a statement OR clause, so the overlay's memory module now applies that action to secondary UNIQUEs too. Every arm that reaches the overlay with a possible conflict runs the merged check first (using the original `args.onConflict`), which resolves or rejects overlay-side conflicts before the overlay sees them, so I found no observable effect — but it is a latent mismatch worth a look.
- Pre-existing, untouched: if one UNIQUE constraint REPLACE-evicts and a later one ABORTs, the evictions are already journaled; the statement-scope savepoint is what unwinds them.
- No direct data-event test for the ordering when a key-changing PK-REPLACE update *also* evicts on a secondary UNIQUE (memory journals the UNIQUE evictions first, like the store; the executor's non-native auto-event path emits the PK-displaced row's delete first). Both orders are evict-before-write; not pinned.
