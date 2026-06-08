---
description: IsolatedTable.update now surfaces displaced underlying-store rows as `replacedRow` so INSERT/UPDATE OR REPLACE fire ON DELETE cascades when the conflict lives only in the underlying store.  41-foreign-keys.sqllogic now runs in store mode.
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
---

## Outcome

`IsolatedTable.checkMergedPKConflict` was reshaped from `UpdateResult | null` to
a discriminated outcome:

```ts
{ terminating?: UpdateResult; replacedUnderlyingRow?: Row }
```

- `terminating` — short-circuit (IGNORE / constraint error), as before.
- `replacedUnderlyingRow` — set when REPLACE displaces an underlying-only row;
  the caller threads it through via `attachReplacedUnderlying` so the final
  `UpdateResult.replacedRow` carries the displaced parent. The DML executor
  (`dml-executor.ts` `processInsertRow` / `runUpdate`) then fires
  `executeForeignKeyActions(..., 'delete', replacedRow)`, driving CASCADE /
  SET NULL / SET DEFAULT on children of the displaced row.

Three call sites consume the new outcome: INSERT-OR-REPLACE; UPDATE with
existing overlay row + PK change; UPDATE with no existing overlay row + PK
change.

`41-foreign-keys.sqllogic` was removed from `MEMORY_ONLY_FILES`, so it now
runs in store mode.

## Review findings

### Code structure / DRY / readability — minor, fixed inline
`stripTombstoneFromResult` was widened by the implement step to forward
`replacedRow: result.replacedRow`, but the overlay's memory module (via
`LayerManager.insertIntoTable` / `updateRowWithPrimaryKeyChange`) emits the
overlay-schema row, which appends a tombstone column. The line propagated the
tombstone-bearing row to consumers verbatim.

The FK cascade path tolerated it (it uses column indices < tableSchema.columns.length,
so the trailing tombstone is ignored), but `emitAutoDataEvent`
(`dml-executor.ts` line ~556) spreads `[...replacedRow]` into the change
event — that would have leaked the tombstone flag as a trailing column to any
subscriber, plus made the row length mismatch user-facing schema.

Fix: slice `replacedRow` in `stripTombstoneFromResult`:

```ts
const replacedRow = result.replacedRow
    ? (result.replacedRow.slice(0, tombstoneIndex) as Row)
    : undefined;
return { status: 'ok', row: result.row.slice(0, tombstoneIndex), replacedRow };
```

This is exclusive with `attachReplacedUnderlying`: the underlying-store
displacement only fires when `checkMergedPKConflict` saw no overlay row at the
new PK, so the overlay's own `replacedRow` is `undefined` in that branch and
nothing needs to override.

### Discriminated outcome — looks good
`checkMergedPKConflict`'s `{ terminating?, replacedUnderlyingRow? }` pattern
is clear, exhaustive across the three resolutions (IGNORE, REPLACE,
ABORT/FAIL/ROLLBACK), and the JSDoc spells out the contract. The three callers
all check `terminating` before reading `replacedUnderlyingRow` and short-circuit
correctly.

### Tombstone / displaced-row shape — verified
`getUnderlyingRow` queries `this.underlyingTable` (NOT the overlay), so
`replacedUnderlyingRow` does not carry a tombstone column. The override on
`replacedRow` in `attachReplacedUnderlying` is safe — same row length as the
user-facing schema, matching memory-mode `LayerManager` behavior.

### Tests — adequate
- `41-foreign-keys.sqllogic` exercises ON DELETE CASCADE and SET NULL on a
  parent via `INSERT OR REPLACE`. Now runs in both memory and store modes
  (3098 passing memory; 651/652 passing store excluding the pre-existing
  41.4 alter-add-column issue).
- The implementer flagged two gaps: (1) ON DELETE SET DEFAULT not separately
  covered, and (2) non-PK UC-conflict REPLACE still doesn't emit `replacedRow`.
  Both are out of scope for this ticket; the cascade wiring is shared between
  CASCADE/SET NULL/SET DEFAULT in `executeForeignKeyActions`, so existing
  coverage is reasonable evidence the SET DEFAULT path works once `replacedRow`
  is populated. UC-REPLACE follow-up should land as a separate fix.

### Cross-file consistency — verified
- `dml-executor.ts:417-457` (`processInsertRow`) and `:513-552` (`runUpdate`)
  both consume `result.replacedRow` the same way: `_recordUpdate`/`_recordDelete`,
  `executeForeignKeyActions(...'delete'...)`, optional auto-event emission.
  No callers depend on `replacedRow` being absent — both paths handle
  `replacedRow ?? undefined`.
- Memory mode's `LayerManager` already surfaces `replacedRow` for the same
  REPLACE-against-existing-row scenario (manager.ts lines ~545-584 and
  ~641-683), so the isolation layer now matches.

### Error handling / resource cleanup — ok
- No new async resources introduced.
- IGNORE outcomes return early before any mutating overlay writes.
- REPLACE outcomes still let the overlay write proceed normally; flush-time
  same-PK collision becomes an UPDATE on the underlying as documented.

### Lint / typecheck — clean
- `packages/quereus-isolation` builds (`yarn run build`) without errors.
- `packages/quereus`'s lint script only covers that package; the isolation
  package has no separate lint script. Type-stripping at test time succeeds.

### Pre-existing store-mode failure — flagged, not addressed
`41.4-alter-add-column-constraints.sqllogic` ("Cannot add NOT NULL column ...
to non-empty table") fails in store mode independent of this change.
Reviewer confirms it predates `fd` and is unrelated; tracked separately.

## Categories not flagged

- **Performance**: no hot-path change beyond an extra `?:` object construction
  per write. The `getUnderlyingRow` lookup already happened in the prior code
  for non-REPLACE paths; REPLACE just keeps the row instead of discarding it.
- **Type safety**: discriminated outcome uses optional fields without `any`.
- **Documentation**: JSDoc on `checkMergedPKConflict` and `attachReplacedUnderlying`
  accurately describes the new behavior. No top-level doc (`docs/architecture.md`,
  `docs/schema.md`) describes the per-isolation-layer cascade mechanism, and the
  change doesn't introduce a new mechanism worth documenting — it brings the
  isolation layer in line with the memory module that's already there.
