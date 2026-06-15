description: Per-table `quereus.sync.replicate` opt-in that records a maintained-table / materialized-view store backing's maintenance writes in the sync change log. The store backing host reads the reserved tag in `applyMaintenance` and queues one local store `DataChangeEvent` per realized `BackingRowChange`. Default off; create-fill/refresh out of scope.
files:
  - packages/quereus/src/schema/reserved-tags.ts                 # SYNC_REPLICATE_TAG const + RESERVED_TAG_SPECS entry (view-ddl + physical-table; boolean)
  - packages/quereus/src/index.ts                                # re-export SYNC_REPLICATE_TAG + getReservedTag
  - packages/quereus-store/src/common/backing-host.ts            # replicates getter + toDataChangeEvent mapper; queue events after UNIQUE enforce
  - packages/quereus-store/test/backing-host.spec.ts             # emit tests (both flavors) + savepoint-discard + pending echo-loop stub
  - packages/quereus/test/schema/reserved-tags.spec.ts           # spec/site/value tests + length 17→18 + seeds include
  - docs/migration.md                                            # § Synced vs. local derived tables / § Current gaps
  - docs/schema.md                                               # § lazy view-tag validation note corrected (view-ddl now has a behavioral key)
----

# Synced derivations: change-log opt-in — COMPLETE

## What shipped

A maintained table / materialized view backed by `using store(...)` opts its
**maintenance writes** into the sync change log via the reserved tag
`quereus.sync.replicate = true` (default **off**). The seam lives entirely in the
store backing host: `StoreBackingHost.applyMaintenance`, after secondary-UNIQUE
enforcement, queues one local (non-`remote`) `DataChangeEvent` per realized
`BackingRowChange` when `getSchema().tags?.[SYNC_REPLICATE_TAG] === true`. The
engine contributes only the reserved-tag registry entry + the exported constant.
Events ride the coordinator (buffered to commit, discarded on rollback /
savepoint-rollback). The value-identical-upsert suppression contract means a
re-derivation that changes nothing emits no change → no event, so the echo loop
closes itself.

See the implement commit `47dc4522` for the full design rationale; this section
is the archive, the next section is the adversarial pass.

## Review findings

Reviewed the implement diff (`git show 47dc4522`) with fresh eyes, then traced
every file it touched and the ones it should have, ran the targeted suites + lint
+ a full store-package type-check.

### Verified correct
- **Echo-safety invariant (load-bearing).** Events are queued only for entries
  already in `changes[]`; a value-identical upsert breaks *before* pushing a
  change (`backing-host.ts:154`), so no change → no event. Pinned by the
  `suppresses a value-identical upsert` unit test. The same holds for replace-all
  (byte-identical paired rows are skipped) — pinned by two replace-all tests.
- **Event shape parity.** `toDataChangeEvent` mirrors `StoreTable`'s own DML
  events: `key` (not `pk`), `changedColumns` omitted (StoreTable's
  insert/update/delete events omit it too — the sync layer recomputes the diff),
  `remote` unset (local derivation). Confirmed against `store-table.ts:1008-1034`.
- **Commit/rollback/savepoint plumbing.** `coordinator.queueEvent` buffers into
  `pendingEvents`, fired on `commit`, cleared on `rollback`/`clearTransaction`,
  truncated by `eventIndex` in `rollbackToSavepoint`. Verified in
  `transaction.ts`.
- **Switch exhaustiveness.** `toDataChangeEvent` lacks the `never` guard that
  `applyMaintenance` has, but `BackingRowChange` is a closed 3-variant union and
  the function's non-`undefined` return type forces the compiler to flag any new
  variant — not a real robustness gap.
- **Default-off / no-regression.** `replicates === false` path queues zero
  events; pinned by the no-tag test and confirmed by the full store suite staying
  green.
- **Reserved-tag registry.** Sites (`view-ddl` + `physical-table`), boolean
  value schema, mis-site / non-boolean / typo diagnostics — all pinned by
  `reserved-tags.spec.ts`; length 17→18 and seeds-include updated.
- **view-ddl tag → backing schema propagation (create-time).** Traced
  `materializeView` → `buildBackingTableSchema(…, def.tags)`
  (`materialized-view-helpers.ts:308,475`): an MV's `with tags (…)` lands on the
  backing `TableSchema.tags`, which the host reads — so the `view-ddl` site is
  NOT a silent no-op at create time. (No end-to-end MV test exists; correct by
  construction + tracing. Covered by the fix ticket's test ask below.)

### Fixed inline (minor)
- **Doc staleness — `docs/schema.md` lazy view-tag-validation note.** The
  parenthetical claimed "no reserved key carries view behavior; the only keys
  legal at `view-ddl` are the inert differ rename hints." `quereus.sync.replicate`
  is now a *behavioral* `view-ddl` key. Corrected to name it, note it is the one
  behavioral view-ddl key, and record that the imperative
  `CREATE MATERIALIZED VIEW … WITH TAGS` path stays un-eagerly-validated (a typo
  is silently inert) while the declarative `diff`/`apply schema` path validates
  it — the authoring path for migration targets.
- **Missing savepoint-discard test (the implementer flagged it as a candidate).**
  Added `rolling back to a savepoint discards only that span's queued maintenance
  events` to `backing-host.spec.ts` (both flavors): a pre-savepoint maintenance
  batch survives, a batch inside the released span is dropped, commit fires only
  the survivor. Pins that maintenance events ride the same `eventIndex`
  truncation as data ops. Suite now 46 passing, 1 pending.

### Filed as follow-up (major)
- **`fix/sync-derivation-mv-alter-replicate-toggle`** — a live
  `alter materialized view … {add,drop} tags ("quereus.sync.replicate")` on a
  *connected* store-hosted MV is a silent no-op until reopen: the store module's
  `materialized_view_modified` handler persists DDL but (unlike `table_modified`)
  never calls `connected.updateSchema(event.newObject)`, so the backing host keeps
  reading the stale cached schema. Pre-dates this ticket but surfaced by it (the
  existing ALTER live-toggle tests pass only because they use a plain
  `create table … using store` backing, which fires `table_modified`). Scoped fix
  + MV-level tests in the ticket.
- **`backlog/sync-derivation-echo-loop-integration-test`** — the real two-peer
  echo-loop quiescence integration test (A writes → A derives+logs → B ingests →
  B's re-derivation is value-identical → B logs nothing). Needs a store +
  `@quereus/sync` two-peer harness that does not exist in this package; the
  implement stage left a bodyless pending mocha test as a breadcrumb. The
  single-host echo seam is unit-pinned; this is the cross-peer end-to-end gap.

### Out of scope (confirmed, not silently closed)
- **Create-fill / refresh (`replaceContents`) stays event-free** — intentional
  (no value-identical suppression → would storm the change log). Parked in
  backlog `sync-derivation-fill-publication`. Agreed; belongs out-of-band.
- **Memory backing host stays event-free** — no consumer subscribes to a memory
  emitter for sync; the tag is engine-global but behaviorally store-only.
  Documented.
- **MV-over-MV cascade** consumes the *returned* `changes[]`; emission is an
  additional commit-time side effect, unaffected. Existing cascade tests stayed
  green.

### Validation run
- `reserved-tags.spec.ts` — 64 passing.
- `backing-host.spec.ts` — 46 passing, 1 pending (the tracked echo-loop stub),
  both registration flavors.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + test type-check).
- `yarn workspace @quereus/store run build` — exit 0 (full tsc type-check of the
  store package incl. the new mapper/getter).
