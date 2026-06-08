---
description: `StoreTable.update` now honors column-level / table-level `defaultConflict` for both PK and per-UC unique conflicts (precedence `statement OR > per-constraint default > ABORT`), and the PK-change UPDATE REPLACE path reports `replacedRow` so the executor runs ON DELETE cascade/SET NULL on the evicted row. The reviewer additionally hardened the eviction path to fully delete the evicted row (data + secondary indexes + row-count + delete event) via the existing `deleteRowAt` helper, and filed two follow-up tickets for unrelated pre-existing bugs surfaced during the review.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Final shape (post-review)

### Implement-stage changes (kept as-is)

1. New file-local `resolvePkDefaultConflict(schema)` helper mirroring the two existing copies in `quereus/.../layer/manager.ts:1500` and `quereus-isolation/.../isolated-table.ts:1331`.
2. INSERT branch (`store-table.ts:611-689`): resolves `pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ABORT` and uses it for the IGNORE/REPLACE/ABORT branching at the PK conflict. Passes the *original* `args.onConflict` (not `pkEffective`) into `checkUniqueConstraints` so each UC resolves its own `defaultConflict` independently — this is a deliberate, correct deviation from the ticket's literal wording (cross-checked against MemoryTable's `manager.ts:579` and the per-constraint helper at `manager.ts:957`).
3. UPDATE branch (`store-table.ts:694-797`): same `pkEffective` resolution; captures `replacedAtNewPk` for REPLACE eviction; returns `replacedRow` so `dml-executor.ts:527-538` can drive ON DELETE actions on the evictee.
4. `checkUniqueConstraints` (`store-table.ts:957`): per-loop resolution `effective = onConflict ?? uc.defaultConflict ?? ABORT` for IGNORE/REPLACE/ABORT branching.
5. Test spec `packages/quereus-store/test/column-default-conflict.spec.ts` — 7 cases covering PK-level REPLACE/IGNORE on INSERT, non-PK UC REPLACE on INSERT, PK-change UPDATE with REPLACE/IGNORE, statement-level OR overriding column-level default, and the cascade-on-eviction round-trip via FK ON DELETE CASCADE.

### Review-stage delta (this pass)

`packages/quereus-store/src/common/store-table.ts:754-761`: replaced the implementer's manual delete-event emission block (~14 lines after the put) with a single `await this.deleteRowAt(inTransaction, newPk, replacedAtNewPk)` placed *before* the put. `deleteRowAt` already handles all four cleanup steps in one place: remove data row, remove secondary-index entries, decrement row-count stat, emit delete event. The implementer's manual block only emitted the event — leaving the index entries and the row-count stat behind. Order matters: `deleteRowAt` must run before the put, since both target `newKey`.

The new ordering is:
1. Capture `replacedAtNewPk` from `store.get(newKey)`
2. `checkUniqueConstraints` for non-PK UCs
3. **`deleteRowAt(newPk, replacedAtNewPk)` if eviction is happening** — full evictee cleanup
4. Delete `oldKey` (PK-change only)
5. Put `newKey` with the moved row's data
6. `updateSecondaryIndexes(oldRow, coerced, newPk)` for the moved row
7. Emit `update` event for the moved row
8. Return `{ status: 'ok', row: coerced, replacedRow: replacedAtNewPk ?? undefined }`

This now matches MemoryTable's `recordDelete(newPK, evictee) → recordDelete(oldPK, oldRowData) → recordUpsert(newPK, newRowData, null)` step sequence (`packages/quereus/src/vtab/memory/layer/manager.ts:657-663`) modulo the pre-existing oldRow secondary-index handling (covered separately — see `Review findings`).

## Verification

- `yarn workspace @quereus/store test`: **259 passing**, 0 failing. (The implementer added 7 tests; the eviction-cleanup test the reviewer attempted to add was removed — see findings.)
- `yarn test:store` (LevelDB-overlay logic tests): **577 passing, 1 failing** — same `10.5.1-partial-indexes.sqllogic:49` pre-existing failure as before; `29.1-column-level-conflict-clause.sqllogic` (the file most directly testing this surface) passes in full.
- `yarn test`: **all engine packages pass except** the same 2 pre-existing `@quereus/sample-plugins` failures (`Comprehensive Demo Plugin > supports delete` and `supports update`). Verified pre-existing — same 2 failures appear before this ticket's changes per the implement-stage handoff.
- `yarn lint` (in `packages/quereus`): clean (no warnings).
- Engine rebuild done before the cascade test runs (the eviction `replacedRow` consumption from prereq `dml-executor-update-replaced-row-not-recorded` lives in compiled `packages/quereus/dist`).

## Review findings

### Aspects checked

- **Correctness vs ticket spec.** Implementer's deviation (passing `args.onConflict` not `pkEffective` into `checkUniqueConstraints`) verified correct against MemoryTable's reference implementation (`manager.ts:579` and the per-UC resolver at `manager.ts:957`). The literal wording in the implement ticket would have shadowed per-UC defaults with the PK's resolved action, breaking the `INSERT with UNIQUE ON CONFLICT REPLACE` test case — implementer's call was right.
- **Helper duplication.** `resolvePkDefaultConflict` now exists in three places (manager.ts, isolated-table.ts, store-table.ts). Implementer notes this convention was already established by the existing two copies. Acceptable for now; consolidation would need its own ticket touching all three at once. No action.
- **Precedence rule consistency.** Cross-checked against `constraint-check.ts:39-46` (`pickAction`) and the isolation overlay's `resolveEffective` at `isolated-table.ts:1346` — all four implementations agree on `statement OR ?? per-constraint default ?? ABORT`. ✓
- **Replaced-row reporting contract.** `dml-executor.ts:527-538` reads `result.replacedRow` and emits an engine-level auto-data-event for it. Implementer correctly populates `replacedRow` on the UPDATE return. The cascade test exercises the round-trip through `executeForeignKeyActions`. ✓
- **Event ordering.** Implementer emitted `delete(newPk, evictee) → update(newPk, oldRow, coerced)` to listeners. After the review fix, the sequence becomes `delete(newPk, evictee)` (via `deleteRowAt`) followed by `update(newPk, oldRow, coerced)`. Sequence preserved. The reviewer-fix also additionally calls `trackMutation(-1)` for the evictee (was missing) — sync-client subscribers reading the row-count stat will now be correct.
- **In-transaction read of evictee.** `store.get(newKey)` does not consult the coordinator's pending writes. So an evictee written earlier in the same transaction would not be seen. Pre-existing limitation also present in the INSERT branch's existence check (`store-table.ts:617`). Out of scope for this ticket but flagged in the comment at line 714.
- **Lint / tests / docs.** Lint clean; tests verified above. No documentation references the conflict-resolution path that would need updating in this ticket — the engine-side precedence rule is already documented in `docs/sql.md §11` and the column-level clause is exercised by `29.1-column-level-conflict-clause.sqllogic`.

### Minor (fixed inline this pass)

- **Eviction-path cleanup gap.** The implementer's manual delete-event emission for the evictee left two leaks: (1) the evicted row's secondary-index entries weren't removed, and (2) `trackMutation(-1)` wasn't called, so the cached row-count stat would drift upward by 1 per eviction. **Fixed:** replaced the manual block with a call to the existing `deleteRowAt` helper placed before the put. This is the same helper already used by INSERT REPLACE for non-PK UC eviction (`store-table.ts:962`), so the change is well-trodden.

### Major (filed as new tickets — not fixed inline)

- **`fix/store-table-create-index-schema-not-updated`.** Discovered while writing a regression test for the eviction fix: after `CREATE INDEX` on a `USING store` table, `StoreTable.tableSchema.indexes` is not refreshed, so subsequent INSERT/UPDATE/DELETE never call `updateSecondaryIndexes` for the new index. Initial entries from `buildIndexEntries` exist but never get any siblings. Currently masked because `StoreModule.query()` doesn't consult secondary indexes (per the comment at `store-module.ts:826`). This is a serious correctness latent bug, but pre-existing, unrelated to conflict-resolution, and worth its own focused ticket.
- **`fix/store-table-pk-change-update-leaks-moved-row-index`.** PK-change UPDATE's call to `updateSecondaryIndexes(oldRow, coerced, newPk)` uses `newPk` for *both* the old-key construction and the new-key construction. The "delete old" step constructs a key at `(oldRow_indexvals, newPk)` — but the real entry is at `(oldRow_indexvals, oldPk)`. So the moved row's old secondary-index entry leaks on every PK-change UPDATE. Pre-existing, currently masked by the CREATE INDEX bug above (filed as a `prereq:` of this one).

### Not a finding (intentionally listed)

- **Helper duplication across three locations** — kept consistent with the existing convention; no inline change.
- **Event-sequence parity with MemoryTable for the moved row** — implementer's tradeoff documented in their handoff (engine-level events go through `emitAutoDataEvent` and follow the canonical sequence; only direct `StoreEventEmitter` subscribers see the difference). Acceptable; refactor belongs in its own ticket if sync coherence ever requires the strict triplet.
- **No direct unit test of `result.replacedRow` shape** — the cascade test is the realistic proxy; constructing a `VirtualTable` standalone for a contract-level assertion is hard in the current test harness. Acceptable.

### Test changes this pass

- The reviewer attempted to add a direct index-store inspection test for the eviction cleanup. It surfaced the `CREATE INDEX` schema-update bug above (test couldn't validate the new state because writes after CREATE INDEX never touch the index store). Test removed; the underlying bug is filed as a separate ticket. The implementer's existing 7 tests remain and continue to pass.
