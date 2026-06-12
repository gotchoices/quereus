description: COMPLETE — StoreTable/StoreModule external row-write entry point (committed put/delete + secondary-index + stats, no events/validation; returns effective BackingRowChange[]). Implemented, reviewed, tests pass (10/10 in the new spec).
files:
  - packages/quereus-store/src/common/store-table.ts            # ExternalRowOp; applyExternalRowChanges + readRowByPk
  - packages/quereus-store/src/common/store-module.ts           # getTableForExternalWrite + shared resolveOwnedTable helper
  - packages/quereus-store/src/common/index.ts                  # exports ExternalRowOp
  - packages/quereus-store/README.md                            # External Row-Write Entry Point section + core-exports rows
  - packages/quereus-store/test/external-row-write.spec.ts      # 10 tests, all passing
----

# Complete: store external row-write entry point

The module-side entry point for trusted, externally-applied writes (inbound
replication) to **source** tables — the index-maintaining sibling of
`StoreBackingHost`. Three public surfaces + one exported type:
`StoreTable.applyExternalRowChanges(ops): Promise<BackingRowChange[]>`,
`StoreTable.readRowByPk(pk)`, `StoreModule.getTableForExternalWrite(db, schema,
table)`, and `ExternalRowOp`. Per op the path pre-reads the effective
before-image, writes committed storage directly (`store.put`/`store.delete`,
never the coordinator), maintains secondary indexes and stats, suppresses
no-ops, and returns the effective change. No module events, no coordinator
transaction, no constraint validation — origin trusted, mirroring the
backing-host posture. The downstream `sync-adapter-ingest-via-seam` ticket
migrates the raw-KV adapter onto this seam (not in this ticket's scope).

## Review findings

### What was checked

- **Implement diff read first, fresh eyes** (`git show 37dcc06e`) before the
  handoff summary: store-table.ts, store-module.ts, index.ts, README, spec.
- **Parity against the established pattern.** Side-by-side with
  `StoreBackingHost.applyMaintenance` (`backing-host.ts`) and the table's own DML
  arms (`update`/`delete`/insert in `store-table.ts:847-1112`): key encoding
  (`encodeDataKey` == `buildDataKey` with the same `pkDirections`/
  `pkKeyCollations`), `updateSecondaryIndexes` call shape (`oldPk === newPk`
  always, since the upsert PK derives from the row — no relocation possible),
  `trackMutation(±1, false)` (committed-path stats, immediate cachedStats update
  + lazy flush), effective before-image reads, and the `rowsValueIdentical`
  byte-faithful no-op suppression. All consistent.
- **Coercion (gap 1, the flagged main risk):** confirmed `applyExternalRowChanges`
  intentionally does NOT `coerceRow` upsert rows — **identical to**
  `StoreBackingHost`, which also serializes `op.row` raw. This is the deliberate
  trusted-origin posture, documented on the method. The only current/planned
  caller (the sync adapter) feeds `deserializeRow`-canonical rows, so no real
  divergence arises today. Verdict: acceptable as-designed, not a bug.
- **Pending-local-txn asymmetry (gap 2):** reviewed the effective-read /
  committed-write reasoning. Real but inherent to "external writes hit committed
  storage"; documented as last-writer-wins, matching the prior raw-KV adapter.
  No code change.
- **Ownership resolution:** `getTableForExternalWrite` vs `getBackingHost` —
  identical pre-check + `getOrReconnectTable` fallback (the DRY finding below).
- **Docs:** README "External Row-Write Entry Point" section + core-exports rows
  read in full against the new surface — accurate and current.
- **Tests:** ran the new spec and the full store suite; verified the 2 residual
  failures are pre-existing on the base (`git stash` repro).

### Found / done — minor (fixed inline this pass)

- **DRY (gap 4): duplicated ownership pre-check.** `getTableForExternalWrite`
  copied `getBackingHost`'s 7-line registration/wrapper-isolation ownership check
  verbatim. Extracted a shared `private resolveOwnedTable(db, schema, table):
  StoreTable | undefined`; both callers now delegate to it (each layers its own
  coordinator/pending-state policy on top). Typecheck + build clean.
- **Test floor lifted (gap 3).** Added two byte-match-vs-DML cases to
  `external-row-write.spec.ts`:
  - **multi-column / DESC-direction PK** (`primary key (a, b desc)`) — exercises
    composite-PK `extractPK` ordering and per-column DESC key direction through
    upsert→update→delete; data store byte-matches DML and a composite point read
    resolves under the DESC encoding.
  - **NULL indexed-column transitions** (NULL→non-NULL and non-NULL→NULL on an
    indexed column) — data store AND secondary-index bytes match DML, confirming
    NULL is maintained as a distinct indexable key, not absence. (Note: this
    engine treats columns as NOT NULL by default — the column needs an explicit
    `null` declaration to hold NULLs; orthogonal to this ticket.)

  Spec now **10/10 passing**.

### Found — major (filed as new ticket(s))

None. Gaps 1 and 2 are deliberate, documented architectural decisions consistent
with the sibling `StoreBackingHost`, not defects; both have a single trusted
caller (the sync adapter) feeding canonical rows. No new fix/plan ticket
warranted. If a future external caller needs to pass non-canonical
integer/JSON values and have them byte-match DML, that is a coercion-policy
decision that should be made together with the sync-adapter contract — captured
here as the documented tradeoff, not as open work.

### Aspect sweep (explicitly checked, nothing to do)

- **SRP / modular / DRY:** good after the `resolveOwnedTable` extraction; methods
  are small and single-purpose.
- **Type safety:** `ExternalRowOp` is a discriminated union with a `never`
  exhaustiveness guard in the switch default; no `any` (the wrapper cast is the
  same narrow `{ underlying?: unknown }` pattern `getBackingHost` uses).
- **Error handling:** no swallowed exceptions; the unknown-op default throws
  `QuereusError(INTERNAL)`.
- **Resource cleanup:** no new resources held; routes through `ensureStore()`
  like every other write path (fires lazy `saveTableDDL`).
- **Performance:** one O(log n) effective point read per op (unavoidable — the
  before-image IS the cascade contract), no full scans on the point arms.

### Test status at handoff

- `yarn workspace @quereus/store run typecheck` → clean.
- `yarn workspace @quereus/store run build` → exit 0.
- `external-row-write.spec.ts` → **10/10 passing.**
- Full store suite → **533 passing / 2 failing.** The 2 failures are in
  `mv-rehydrate-adopt.spec.ts` (MV table-form implicit-vs-explicit column
  round-trip on rehydrate — "got 'THIS'" DDL parse), reproduced identically with
  this ticket's changes `git stash`-ed away, and **already triaged** by commit
  `364e227f` which fixed 20 of the original 22 and filed
  `tickets/backlog/mv-table-form-implicit-columns-roundtrip.md` naming these
  exact residuals. Outside this diff (no MV/rehydration/schema-manager/parser
  code touched here); `.pre-existing-error.md` deliberately NOT re-filed since the
  failure is already tracked.
- quereus-store has no lint script (only `packages/quereus` does); N/A here.
