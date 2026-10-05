description: On the built-in in-memory tables (and, inside transactions, on store-backed tables), a write that replaced an existing row by primary key skipped the other UNIQUE columns' checks, so two rows could share a value declared unique. Now every UNIQUE constraint is still checked under its own conflict action.
architecture: docs/runtime.md
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus/src/common/types.ts
  - docs/runtime.md
  - docs/module-authoring.md
  - docs/sql-dml.md
  - docs/sql.md
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic
  - packages/quereus-isolation/test/isolation-layer.spec.ts
----

# PK-conflict REPLACE no longer skips secondary UNIQUE checks

## What landed

- `MemoryTableManager.performInsert`: a PK collision resolved by REPLACE falls through to the same secondary-UNIQUE check as a non-colliding insert, then writes and reports both `replacedRow` and `evictedRows`. PK-conflict resolution shared via `resolvePkConflict`.
- `performUpdateWithPrimaryKeyChange`: UNIQUE check runs before any mutation, excluding both the new PK (displaced row) and the old PK (the mover) via `UniqueCheckSelf { key, vacated? }` / `isSelfKey`. Journal order evict-delete, move-delete, move-insert (matches store and the data-event contract). The old delete/check/re-insert rollback dance is gone.
- `IsolatedTable.update` insert arm: a REPLACE over a live overlay row now runs `checkMergedUniqueConstraints` (overlay + committed rows) before writing.
- Docs: `UpdateResult` comment, runtime.md, module-authoring.md (implement); sql-dml.md + sql.md SQLite-divergence note (review).

## Review findings

**Checked:** implement diff (manager.ts, isolated-table.ts, types.ts, docs, tests) read first; store backend (`store-table.ts` insert path) confirmed already checks secondary UNIQUEs after a PK REPLACE with `[pk]` excluded, so memory/store/isolation now agree; self-exclusion correct on all three covering paths (memory index, materialized view, scan) and the deferred commit-time check; no mutation precedes a failing check on either memory path; data-event ordering comment references (`docs/usage.md § Subscribing to Data Changes`, `data-event-key-contract.spec.ts`) resolve.

**Found and fixed inline:**
- *False claim in tests / undocumented SQLite divergence.* The test header said all expectations were SQLite-confirmed; I ran case G against SQLite 3.53.2 (better-sqlite3) and it errors (`UNIQUE constraint failed`) — SQLite defers the PK REPLACE until after other constraint checks, so the soon-to-be-displaced row still counts as a UNIQUE conflict when that constraint's action is not REPLACE. Quereus treats the displaced row as gone. This is pre-existing and consistent across all three backends (store/isolation already excluded `[pk]`; memory previously skipped the check entirely), and arguably the saner semantics, so I kept it and documented it as a deliberate divergence: `docs/sql-dml.md` § Conflict Resolution and a row in `docs/sql.md` § 11 comparison table; test header and case G comments corrected. A human who prefers strict SQLite parity would flip it by removing the PK-displaced key from the self-exclusion set on all three backends.
- *Coverage gaps.* Added cases M (key-changing UPDATE onto an occupied PK keeping the mover's own UNIQUE value — exercises the `vacated` exclusion; M2 takes the displaced row's value, also a pinned SQLite divergence), N (composite primary key: insert-or-replace with secondary eviction, key-changing update onto occupied composite PK, key-changing update to a free composite PK), O (one write producing both `replacedRow` and `evictedRows`, each cascading to its own FK children). M, N, O cross-checked against SQLite except M2 (divergence above). Pass in memory and store mode.

**Found, filed (appended as an arm, not a new ticket):** `fix/isolation-overlay-same-pk-update-skips-unique-check` — same site already claimed. Verified with a scratch isolation spec: `id integer primary key on conflict replace, v text unique`; in one transaction insert (1,'a'),(2,'b') then `update t set v = 'b' where id = 1` → isolation silently deletes row 2 (the PK's REPLACE default is handed to the overlay as a statement OR and applied to the UNIQUE), where memory/SQLite raise a UNIQUE error. Pre-existing; this is the "latent mismatch" the implementer flagged, now shown observable on that arm only (every other arm runs the merged check first).

**Tripwires:** none new. The implementer's two notes (eviction already journaled before a later UNIQUE ABORT — unwound by the statement savepoint; combined key-change + secondary-eviction event order not pinned, both evict-before-write) are pre-existing/benign and left as handoff notes; no code site warranted a NOTE.

**Other categories:** resource cleanup / error handling — no new resources or catch sites. Type safety — `UniqueCheckSelf` object (rather than key array) correctly prevents an unwrapped composite key from type-checking. File size — manager.ts is large but this change net-shrank the touched functions; no split warranted here. Performance — key-changing update now does one extra PK comparison per candidate; insert-over-PK now runs the UNIQUE check it always owed (index-backed in the default case).

**Validation:** `yarn workspace @quereus/quereus test` 10765 passing; `@quereus/isolation` test 429 passing; `@quereus/quereus` lint clean; `tsc -b tsconfig.build.json` then store-mode `test:single logic.spec.ts --grep 47.2` 2 passing.
