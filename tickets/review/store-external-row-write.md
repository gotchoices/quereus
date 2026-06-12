description: REVIEW — StoreTable/StoreModule external row-write entry point (committed put/delete + secondary-index + stats, no events/validation; returns effective BackingRowChange[]). Implementation landed + tested; review for correctness gaps, esp. row-coercion fidelity and pending-local-txn interaction.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts            # ExternalRowOp type; applyExternalRowChanges + readRowByPk (new public surface)
  - packages/quereus-store/src/common/store-module.ts           # getTableForExternalWrite (new public accessor, after getBackingHost)
  - packages/quereus-store/src/common/index.ts                  # exports ExternalRowOp
  - packages/quereus-store/README.md                            # core-exports row + "External Row-Write Entry Point" section
  - packages/quereus-store/test/external-row-write.spec.ts      # new spec (8 tests, all passing)
  - packages/quereus-store/src/common/backing-host.ts           # reference sibling (MV backing; index-less) — applyMaintenance is the model
  - packages/quereus/src/vtab/backing-host.ts                   # BackingRowChange shape + normative upsert-suppression contract
difficulty: medium
----

# Review: store external row-write entry point

## What landed

The module-side entry point for trusted, externally-applied writes (inbound
replication) to **source** tables — the index-maintaining sibling of
`StoreBackingHost` (which targets index-less MV backings). Closes the
secondary-index/stats gap the old raw-KV sync adapter skipped. The downstream
`sync-adapter-ingest-via-seam` ticket (implement/, prereq'd on this) migrates
the adapter onto it; **not in scope here**.

Three new public surfaces + one exported type:

- `StoreTable.applyExternalRowChanges(ops: readonly ExternalRowOp[]): Promise<BackingRowChange[]>`
  — per op: pre-read effective before-image (`readEffectiveRowByKey`), write the
  **committed** store directly (`store.put`/`store.delete`, NOT the coordinator),
  `updateSecondaryIndexes(false, …)`, `trackMutation(±1, false)`. Returns the
  effective per-op `BackingRowChange[]`. No module data events, no coordinator
  transaction, no constraint validation. No-ops suppressed (absent delete;
  value-identical upsert via `rowsValueIdentical` — byte-faithful, collation-unaware).
- `StoreTable.readRowByPk(pk)` — public effective point read; thin delegate to
  the existing private `readLiveRowByPk` (expose, not duplicate).
- `StoreModule.getTableForExternalWrite(db, schema, table)` — mirrors
  `getBackingHost`'s registration+isolation-wrapper ownership check, then
  `getOrReconnectTable`. Returns `undefined` for a non-owned/unknown table.
  Deliberately does NOT attach a coordinator (external writes hit committed
  storage; the before-image read merges any already-attached coordinator on its own).
- `ExternalRowOp = { op:'upsert'; row } | { op:'delete'; pk }` exported from
  `common/index.ts`; README core-exports row + a new "External Row-Write Entry
  Point" section.

`ExternalRowOp.upsert` derives its PK (and thus data key) from the row, so an
upsert can never relocate a row — `updateSecondaryIndexes` is always called with
`oldPk === newPk`, and the divergent-PK case cannot arise.

## Build / test status

- `yarn workspace @quereus/store run typecheck` → clean.
- `yarn build` → green (full monorepo, exit 0).
- New spec `external-row-write.spec.ts` → **8/8 passing.**
- Full store suite: 511 passing / 22 failing. **All 22 failures are
  pre-existing** MV-rehydration failures in `mv-rehydrate-adopt.spec.ts` +
  `view-mv-persistence.spec.ts` (a `maintained as` backing fails to reconnect via
  the `memory` module on reopen) — reproduced identically with this ticket's
  source `git stash`-ed away. Flagged in `tickets/.pre-existing-error.md`. They
  are outside this diff (no MV/rehydration/catalog/memory-module code touched).

## Test coverage (the floor — treat as a starting point)

`external-row-write.spec.ts` covers:
- effective-change reporting (insert/update/delete with accurate before-images);
  `readRowByPk` round-trip incl. absent → null.
- no-op suppression: absent delete + byte-identical upsert write nothing, report
  nothing, no stats movement.
- stats deltas: effective inserts/deletes only; update net 0; absent delete net 0.
- **no module data events** emitted (subscribed `StoreEventEmitter` stays empty),
  with a sanity check that ordinary engine DML on the same emitter DOES emit.
- **byte-match vs engine DML**: committed data-store entries AND secondary-index
  entries byte-for-byte equal between an externally-written table and a
  DML-written twin, across upsert→update(indexed col)→delete.
- partial-index scope transitions (in→out removes w/o add; out→in adds w/o stale
  delete), byte-matching the DML twin (exactly one entry at the end).
- divergent PK collation (`collate binary` PK on a NOCASE store): distinct
  case-variant keys survive (not collapsed) and byte-match DML; a `delete pk=['apple']`
  removes only the BINARY-matching row.

## Known gaps / things to scrutinize (honest)

1. **Row coercion is intentionally absent — the main thing to verify.**
   `applyExternalRowChanges` does NOT run `coerceRow`/`validateAndParse` on an
   upsert row (matches `StoreBackingHost` and the "origin trusted" mandate). The
   byte-match tests use **all-text** columns to dodge storage-class ambiguity: a
   JS `number` vs `bigint` serializes differently (`1` vs `{"$bigint":"1"}`), and
   a JSON column stored as a string vs a parsed object also differs. So
   "byte-match vs DML" is proven only for text-shaped values. The downstream sync
   adapter feeds rows it `deserializeRow`-ed (already canonical, same
   `serializeRow` round-trip), so in practice values arrive canonical — but a
   reviewer should confirm we're comfortable that an external caller passing a
   non-canonical integer/JSON value would store bytes diverging from the DML
   equivalent (and possibly from how the engine reads it back). If that's a real
   risk for some caller, the fix is to coerce; the ticket chose not to.

2. **Effective-read / committed-write asymmetry under a pending local txn.**
   Before-image is `readEffectiveRowByKey` (pending-over-committed) but the write
   lands in committed storage directly. Documented as last-writer-wins. Edge: if
   a local coordinator transaction is pending on the same instance with a delete
   of key K, an external upsert at K reads "absent" → reports `insert` while
   committed still holds the row; the pending batch may then overwrite at commit.
   `getTableForExternalWrite` doesn't attach a coordinator and a freshly
   reconnected table has none (before-image == committed), but a table previously
   used in a transaction keeps its coordinator on the instance. **Not covered by
   a test** (awkward to stage with the bare module) — review the reasoning.

3. **Untested shapes:** multi-column PK and DESC PK direction through the
   external path (byte-match used a single-column ASC text PK; the collation test
   used single-column BINARY). Index maintenance with a NULL indexed column.
   Non-text data-store value byte-match (see gap 1). These are believed correct
   (same `encodeDataKey`/`updateSecondaryIndexes` the DML path uses) but unpinned.

4. **`getTableForExternalWrite` ownership check** duplicates `getBackingHost`'s
   inline registration/wrapper logic rather than sharing a helper — intentional
   (mirrors the existing pattern) but a candidate for a small extracted helper if
   the reviewer prefers DRY over parallel structure.

## Suggested review actions

- Decide whether gap 1 (no coercion) is acceptable for the intended callers or
  whether `applyExternalRowChanges` should coerce upsert rows; if acceptable,
  consider a one-line note is enough (it's already documented on the method).
- Sanity-check the pending-local-txn reasoning in gap 2; add a test if a clean
  setup is feasible, else confirm the documented LWW posture is sufficient.
- Optionally add multi-column/DESC-PK and NULL-indexed-column cases to lift the
  floor.
- Minor findings → fix inline; anything larger (e.g. a coercion decision that
  ripples into the sync adapter contract) → spawn a fix/plan ticket.
