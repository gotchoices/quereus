---
description: |
  On a store-backed table wrapped in the transaction-isolation layer, an "insert … on conflict
  do update/nothing" whose key is written in a different form than it is stored (e.g. the text
  '1' into an integer key holding 1) wrongly throws away the existing row and keeps the
  just-inserted one. Fix: coerce the incoming row to the declared column types before the
  isolation layer probes for a conflict, exactly as the plain store and in-memory engine already do.
prereq:
files:
  - packages/quereus-isolation/src/isolated-table.ts                # update() insert/UNIQUE conflict path — the fix site
  - packages/quereus-store/src/common/store-table.ts                # coerceRow (~:857) — the reference to mirror
  - packages/quereus/src/vtab/memory/layer/manager.ts               # performInsert/performUpdate (~:817) — memory reference
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic  # repro; already encodes all 3 variants
  - packages/quereus/test/logic.spec.ts                             # MEMORY_ONLY_FILES entry to remove (~:45)
difficulty: easy
---

# Fix: isolation overlay must coerce the incoming row before probing for an ON CONFLICT match

## Root cause (confirmed)

`IsolatedTable.update()` (`packages/quereus-isolation/src/isolated-table.ts`, ~line 825) extracts
the primary key and runs all merged-view conflict detection against the **raw, un-coerced**
`args.values`. Both reference backends coerce the whole row to the declared column logical types
*first*, via `validateAndParse`, before extracting the PK / building keys:

- plain store — `StoreTable.coerceRow` (`store-table.ts:857`), called at the top of the insert arm.
- in-memory — `MemoryTableManager.performInsert` / `performUpdate` (`memory/layer/manager.ts:~817`).

Because the isolation layer skips that step, `insert into t values ('1', 0)` (text `'1'`) into an
`integer primary key` holding `1` does this:

1. `pk = ['1' (text)]` — NOT coerced to integer `1`.
2. `checkMergedPKConflict` → `getUnderlyingRow(['1'])` builds a PK point-lookup key from text
   `'1'`. The underlying `StoreTable` encodes that key in the TEXT storage class, which does not
   match the committed row's INTEGER key bytes → the lookup **misses** the existing row → the
   layer reports *no conflict*.
3. The insert proceeds into the overlay memory table, which coerces `'1'` → `1` on its own
   insert and stages the proposed row under integer key `1`.
4. At merge/commit the staged overlay row shadows the committed row at key `1` → the proposed
   row wins and the existing row is lost.

The engine-side `matchUpsertClause` fix (`bug-upsert-conflict-target-collation-match`, already
landed) is what now routes this conflict into the DO UPDATE / DO NOTHING arm and thereby exposes
this latent isolation bug. The engine fix is correct; this is the store-isolation side.

Variant 3 (non-PK `unique` column keyed integer, proposed TEXT `'7'`) fails for the same reason:
`rowMatchesUniqueConstraint` compares the proposed `newRow[idx]` against the stored (coerced)
candidate with `compareSqlValuesFast`, which orders TEXT above INTEGER — so `'7'` never equals a
stored `7` unless the proposed row is coerced first. This is why the fix must coerce the **whole
row**, not merely the PK columns.

## Fix

Coerce `args.values` to the declared column logical types once, at the top of `update()`, and use
the coerced row everywhere below (PK extraction, `getOverlayRow` / `getUnderlyingRow` probes,
`checkMergedPKConflict`, `checkMergedUniqueConstraints`, and the overlay write). This mirrors
`StoreTable.coerceRow` exactly. Double coercion is a non-issue: `validateAndParse` is idempotent
(the overlay memory table re-coerces on its own insert, as does the plain store today), so passing
an already-coerced row through is a no-op.

`oldKeyValues` is left untouched — it already carries coerced PK values read from a stored row
(same as `StoreTable`, which uses `oldKeyValues` directly to build the update/delete key).

## TODO

### Phase 1 — coerce in the isolation layer

- In `packages/quereus-isolation/src/isolated-table.ts`, add `validateAndParse` to the existing
  `import { … } from '@quereus/quereus'` (line 2). It is exported from the package root
  (`packages/quereus/src/index.ts` re-exports it from `types/validation.js`).

- Add a private `coerceRow` method mirroring `StoreTable.coerceRow`:

  ```ts
  /**
   * Coerce each cell to its declared column logical type before PK extraction and
   * conflict detection — the same step StoreTable.coerceRow / MemoryTableManager.performInsert
   * run. Without it, an ON CONFLICT insert whose proposed key is a different storage class than
   * the stored key (TEXT '1' into an INTEGER key holding 1) probes the underlying with the
   * un-coerced key, misses the committed row, and stages the proposed row instead of updating
   * the existing one (bug-store-isolation-upsert-affinity-coerced-pk).
   */
  private coerceRow(row: Row): Row {
    const cols = this.tableSchema!.columns;
    if (row.length > cols.length) {
      throw new QuereusError(
        `Too many values for ${this.schemaName}.${this.tableName}: expected ${cols.length}, got ${row.length}`,
        StatusCode.ERROR,
      );
    }
    return row.map((v, i) => validateAndParse(v, cols[i].logicalType, cols[i].name)) as Row;
  }
  ```

  (`QuereusError` and `StatusCode` are already imported in this file.) Place it near
  `getPrimaryKeyIndices` / the other row helpers.

- In `update()`, after `ensureOverlay()` sets `this.tableSchema`, coerce the incoming values.
  Change the destructure at ~line 839 so the local `values` is the coerced row, e.g.:

  ```ts
  const { operation, oldKeyValues } = args;
  const values = args.values ? this.coerceRow(args.values) : args.values;
  ```

  `this.tableSchema` is guaranteed populated at this point (`ensureOverlay` assigns it from the
  underlying schema and throws if absent). Every downstream reference (`values`, `values!`,
  `pkIndices.map(i => values[i])`, `checkMergedUniqueConstraints(overlay, values!, …)`, the
  `overlayRow = [...(values ?? []), 0]` builds) then uses the coerced row. Note `argsForOverlay`
  (spread of raw `args`) only carries `onConflict` through to the overlay — its `values` field is
  overwritten by `overlayRow` at every use site, so no further change is needed there. Confirm that
  by re-reading each `overlay.update({ ...argsForOverlay, values: … })` call.

### Phase 2 — enable the store-mode test

- Remove the `'47.4-upsert-conflict-target-affinity.sqllogic'` entry (and its trailing comment)
  from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts` (~line 45).

- Update the header comment in
  `packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic` (lines 8–14): it now
  runs in BOTH modes, so drop the "MEMORY-ONLY … separate defect … tracked by
  fix/bug-store-isolation-upsert-affinity-coerced-pk" note and state that the isolation overlay now
  coerces the proposed row (this ticket). Keep the SQL and expected results unchanged.

### Phase 3 — validate

- `yarn workspace @quereus/quereus-isolation build` then `yarn workspace @quereus/quereus build`
  (or `yarn build`) — the isolation package must recompile against the new import.
- `yarn test` (memory mode — must stay green; 47.4 already passed here).
- `yarn test:store 2>&1 | tee /tmp/store.log; tail -n 80 /tmp/store.log` — 47.4 must now pass in
  store mode (all three variants: PK DO UPDATE, PK DO NOTHING, non-PK UNIQUE DO UPDATE), and no
  regression elsewhere. Stream the output (store mode is slow).
- `yarn lint` (only `@quereus/quereus` has a real lint; catches signature drift).

## Acceptance

- Under the isolated store module, `insert into t values ('1', 0) on conflict (id) do nothing`
  into a table holding `(1,100)` leaves `[{"id":1,"n":100}]`; the DO UPDATE and non-PK UNIQUE
  variants update the existing row (matching 47.4's expected results).
- `47.4-upsert-conflict-target-affinity.sqllogic` passes in both `yarn test` and `yarn test:store`.
