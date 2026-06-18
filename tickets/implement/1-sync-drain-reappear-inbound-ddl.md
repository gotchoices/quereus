description: When a remote peer re-creates a table that was previously deleted, the sync edits that were being held for it now replay immediately as part of applying that change, instead of waiting up to five minutes for the background sweep to notice.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts                 # applyChanges post-commit hook + shared drainReappearedTables helper
  - packages/quereus-sync/src/sync/protocol.ts                          # SyncConfig.drainOnReappear + DEFAULT_SYNC_CONFIG
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts   # existing drain harness + new "inbound create_table triggers drain" tests
  - docs/migration.md                                                   # § 4 Contract → Revival / drain — low-latency reappearance note
  - docs/sync.md                                                        # § Unknown-Table Disposition → Revival / drain — same note
difficulty: medium
----

# Low-latency scoped drain when an inbound `create_table` revives a held table

## Context

`sync-held-change-drain-on-reappear` (complete) added `SyncManager.drainHeldChanges(schema?, table?)`:
held out-of-basis changes (`quarantine` + forwardable `store-and-forward`) replay into a
table once it is back in the local basis. `sync-drain-host-wiring` (complete) added a
~5-minute periodic sweep in the quoomb-web worker that calls the no-arg form on a cadence.
That makes the feature *correct* but leaves up to one cadence interval of latency between a
table reappearing and its held edits replaying.

This ticket closes that latency for the **highest-value** reappearance path: an inbound
`create_table` for a previously-retired table arriving in an `applyChanges` batch (a remote
peer re-created the table mid-sync). The moment that DDL has committed locally, the held
edits for that table should replay — not on the next tick.

The companion path (a local `apply schema` lens redeploy re-mapping a basis table back) is
`sync-drain-reappear-lens-redeploy`, which builds on the config flag and shared helper this
ticket introduces. The rarer local-`create table` path is parked in
`tickets/backlog/sync-drain-reappear-local-ddl.md`.

## Design

### Where the reappearance is observable

`applyChanges` (`change-applicator.ts`) is the only place an inbound `create_table` is
applied. It already tracks `pendingSchemaMigrations` — the migrations that *won* resolution
and were committed (HLC-dominated duplicates `continue` before being pushed, so this list is
exactly the applied DDL). After the batch's `admitGroup` commits, the applied
`create_table` migrations name precisely the tables that just (re)appeared in the basis.

### Mechanism — a SEPARATE post-commit apply, not an interleave

The drain must run as its own admission unit **after** the admitting batch has fully
committed — never interleaved into it. This is the invariant the drain primitive already
documents (`change-applicator.ts` drain doc-comment): fresh data lands first, then the older
held changes simply LWW-resolve against it. Concretely: after the `await admitGroup(...)`
in `applyChanges` returns, call the new advisory helper for the set of created tables. Each
table goes through `drainHeldChanges(ctx, schema, table)` — itself a fresh `admitGroup`
unit, with no `watermarkHLC` (those HLCs were merged at the original receive).

The library already does reactive, in-`applyChanges` work of this shape (quarantine-on-divert,
`bumpLastDirectlyMappedWrites`, `emitRemoteChanges`). Draining-on-reappear is reactive, not
cadenced — so it belongs here, distinct from the *periodic* sweep, which remains host-owned.
This refines the prior "never drains inline" wording to "never **interleaves** drain into the
admitting batch; may drain as a separate post-commit apply when a held table reappears."

### Advisory — a drain failure must never abort the apply

The post-commit drain is wrapped exactly like `bumpLastDirectlyMappedWrites`: any throw is
logged (`console.warn`, `[Sync] ...`) and swallowed. The `create_table` and its data are
already committed; on a swallowed drain failure the held entries stay held and the periodic
sweep re-drains them next tick (drain is idempotent — a second drain of an already-drained
table returns 0). The drain must NOT propagate out of `applyChanges` and turn a successful
apply into a thrown error.

### Shared helper

Add and export from `change-applicator.ts`:

```ts
/**
 * Best-effort scoped drain of tables that just reappeared in the local basis, run as
 * SEPARATE post-commit apply unit(s) after the re-creating batch committed. Advisory:
 * each table is drained independently and any failure is logged + swallowed (the held
 * entries stay held for the periodic sweep). No-op when drainOnReappear is disabled or
 * the list is empty. Each drainHeldChanges call is cheap when nothing is held (a scoped
 * quarantine.list returning []) and a no-op when the table is still absent (oracle gate).
 */
export async function drainReappearedTables(
  ctx: SyncContext,
  tables: ReadonlyArray<{ schema: string; table: string }>,
): Promise<void>
```

`applyChanges` collects its candidate set (dedup by `schema.table`) from
`pendingSchemaMigrations` where `migration.type === 'create_table'`, then calls
`drainReappearedTables(ctx, created)` after `admitGroup`. The helper early-returns when
`!ctx.config.drainOnReappear` or `tables.length === 0`.

### Config flag

Add to `SyncConfig` (`protocol.ts`) and `DEFAULT_SYNC_CONFIG`:

```ts
/**
 * When true (default), replay a reappeared table's held out-of-basis changes
 * immediately — as a SEPARATE post-commit apply — the moment the table comes back
 * (an inbound create_table, or a lens redeploy re-mapping it into the basis), instead
 * of waiting for the host's periodic drainHeldChanges sweep. Idempotent with the sweep
 * (a second drain returns 0). A no-op on a relay-only peer (no basis oracle ⇒ every
 * group is skipped). Set false to leave all drain timing to the host's periodic sweep.
 */
drainOnReappear: boolean;   // default: true
```

`createSyncModule` already spreads `configOverrides` over `DEFAULT_SYNC_CONFIG`, so a host
opts out with `{ drainOnReappear: false }` — no wiring change needed there.

### No worker changes needed

`drainHeldChanges` fires `onHeldChangesDrained` + `onRemoteChange` as it already does; the
quoomb-web worker already subscribes to both and maps them into `SyncEvent` history. So the
UI surfaces a reappearance-triggered drain identically to a sweep-triggered one — this ticket
touches no quoomb-web code.

## Edge cases & interactions

- **Drain failure is advisory.** A throw from the post-commit drain is logged + swallowed;
  `applyChanges` still returns its `ApplyResult` for the (already-committed) batch. Held
  entries remain held; periodic sweep re-drains. Add a test (extend the harness's existing
  `failApply` hook) asserting a thrown drain leaves the batch's `ApplyResult` intact and the
  held entries still present.
- **Separate unit, correct order.** The drain's `admitGroup` runs strictly after the
  admitting batch's `admitGroup` resolved (sequential `await`), so fresh create+data is in
  storage before held changes LWW-resolve against it. No intra-admission interleave.
- **`create_table` then `drop_table` in the same batch.** The table is absent after commit;
  the oracle gate (`getTableColumnNames` → `undefined`) makes the drain a no-op. Harmless;
  no need to pre-filter, but the implementer may skip `batchDropped` keys to avoid the wasted
  `quarantine.list`.
- **Only applied DDL triggers drain.** An HLC-dominated `create_table` that lost resolution
  (`skipped++`, never pushed to `pendingSchemaMigrations`) must NOT trigger a drain.
- **No held entries / table never retired.** `quarantine.list(schema, table)` returns `[]`
  ⇒ `drainHeldChanges` returns 0 before touching the oracle. Cheap; the common case (a
  first-time `create_table` with nothing held) costs one empty scoped range scan per created
  table.
- **Relay-only / no-oracle peer.** No `getTableSchema` ⇒ `getTableColumnNames` returns
  `undefined` ⇒ drain returns 0. The feature is inert on a coordinator, matching the
  primitive.
- **Idempotency vs the periodic sweep.** Both can run; a race re-resolves the same held
  changes (LWW-idempotent) and the second `quarantine.delete` is a no-op. Convergence-safe —
  this is no-op safety, not a correctness dependency. (No new concurrency hazard beyond the
  periodic-sweep-vs-applyChanges race the host-wiring ticket already introduced; engine-level
  transaction serialization + idempotency cover it.)
- **`drainOnReappear: false`.** No post-commit drain fires; behavior reverts exactly to the
  periodic-sweep-only path. Add a test asserting the flag-off path holds the entries until an
  explicit `drainHeldChanges()`.
- **Self-origin create_table.** Self-origin data changes are skipped before resolution; a
  self-origin `create_table` is HLC-deduped like any migration. Draining for it is still a
  no-op if nothing is held — harmless.

## Key tests (extend `unknown-table-disposition.spec.ts`'s drain block + harness)

- **Inbound `create_table` for a held table drains immediately.** Seed held entries for an
  absent table; apply a batch carrying its `create_table` (+ optionally fresh data); assert
  the held entries are gone, `onHeldChangesDrained` fired once for that table with
  `applied + skipped === drained`, and the row state matches LWW against any fresh data — all
  WITHOUT calling `drainHeldChanges` explicitly.
- **Create+drop in one batch is a no-op drain.** Held entries survive; no drained event.
- **HLC-dominated (skipped) `create_table` does not drain.** Held entries survive.
- **`drainOnReappear: false` defers to the sweep.** Same seed + inbound create_table; held
  entries survive the apply; a later explicit `drainHeldChanges()` clears them.
- **Drain failure is swallowed.** With the harness `failApply` hook armed for the held
  table's drain, the inbound `create_table` apply still succeeds (returns its `ApplyResult`),
  no drained event fires, entries stay held, and a later drain (hook disarmed) succeeds
  without double-apply.

## Docs

- `docs/migration.md` § 4 Contract → Revival / drain and `docs/sync.md` § Unknown-Table
  Disposition → Revival / drain: add a short paragraph that an inbound `create_table` now
  triggers an immediate scoped drain (gated by `drainOnReappear`, default on; runs as a
  separate post-commit apply; idempotent with the periodic sweep), refining the earlier
  "never drains inline" wording to "never interleaves into the admitting batch."

## TODO

- Add `drainOnReappear: boolean` to `SyncConfig` + `DEFAULT_SYNC_CONFIG` (default `true`).
- Add exported `drainReappearedTables(ctx, tables)` advisory helper in `change-applicator.ts`.
- In `applyChanges`, after `admitGroup`, collect applied `create_table` tables (deduped,
  optionally minus `batchDropped`) and call the helper.
- Refine the drain doc-comment in `change-applicator.ts` (inline → separate post-commit).
- Extend the drain test harness + add the five tests above.
- Update `docs/migration.md` and `docs/sync.md`.
- `yarn workspace @quereus/sync typecheck` and `yarn workspace @quereus/sync test` green;
  `tsc -p packages/quereus-sync/tsconfig.test.json` clean.
