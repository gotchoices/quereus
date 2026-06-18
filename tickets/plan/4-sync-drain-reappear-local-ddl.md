description: When the app itself re-creates a deleted table with a local CREATE TABLE, make its held sync edits replay right away instead of waiting for the background sweep.
prereq:
files:
  - packages/quoomb-web/src/worker/quereus.worker.ts        # executeSQL path that runs local DDL
  - packages/quereus-sync/src/sync/change-applicator.ts     # drainReappearedTables helper (reused)
  - packages/quereus-sync/src/sync/manager.ts               # SyncManager.drainHeldChanges(schema, table)
difficulty: medium
----

# Low-latency scoped drain when the app issues a local `create table`

## Context

The scoped-drain-on-reappear work (`sync-drain-reappear-inbound-ddl`,
`sync-drain-reappear-lens-redeploy`) closed the latency gap for the two highest-value
reappearance paths — an inbound `create_table` from a remote peer, and a lens redeploy
re-mapping a basis table back into the basis. Both are observable inside the sync library, so
both fire an immediate scoped `drainHeldChanges(schema, table)` as a separate post-commit
apply (gated by the `drainOnReappear` config flag, default on).

The third path named in the original plan (`1-sync-drain-scoped-on-reappear`) is the **local**
one: the application issues its own `create table` for a name that had held out-of-basis
changes. This was deferred as lower-value — a locally-driven re-create of a previously-retired
table is rarer than a remote peer doing it mid-sync, and the periodic sweep (~5 min) already
covers correctness.

## Why it's separate / deferred

Unlike the other two paths, a local `create table` is not processed inside the sync library's
apply path — it runs through the engine via the quoomb-web worker's `executeSQL`. Hooking it
requires host-side detection that a just-committed local statement was a `create table` (and
extracting the schema + table name), then calling `syncManager.drainHeldChanges(schema,
table)` after the statement commits. That is a different subsystem (worker DDL execution) and
a different detection mechanism (inspecting executed statements / engine schema-change
notifications) than the library-internal hooks, so it was kept out of the library tickets.

## What this is about

When the local app re-creates a table that had held edits, replay those edits immediately
rather than on the next periodic sweep — the same end-user behavior the other two paths now
deliver, for the locally-driven case.

## Open questions for the planner who picks this up

- **Detection mechanism.** Decide how the worker learns a local `create table` committed for a
  given `(schema, table)`: parse/inspect the executed statement, or subscribe to an engine
  schema-change / catalog-change notification (preferred if one exists — check
  `schemaManager` / store-module catalog events). Avoid a janky bespoke SQL sniffer.
- **Where to drain.** After the statement's transaction commits, call
  `syncManager.drainHeldChanges(schema, table)` as a separate apply (same invariant as the
  other paths — never interleave into the creating transaction). Fire-and-forget with `void`
  + error logging is acceptable since drain is advisory/idempotent.
- **Reuse.** Consider whether the library's `drainReappearedTables` helper / `drainOnReappear`
  flag should also gate this host-side path, or whether the host simply calls the public
  `drainHeldChanges` directly (the flag is a library-internal gate; the host calling the
  public method is independent of it).
- **Value check.** Confirm this path is worth wiring at all, or whether the periodic sweep is
  sufficient for the local case given its rarity.

## Edge cases to carry into the eventual implement ticket

- Drain must run as a separate post-commit apply; never interleave into the creating txn.
- Idempotent with the periodic sweep and with any library-internal drain (LWW-idempotent
  re-resolve; second `quarantine.delete` is a no-op).
- No-op when nothing is held for the created table (cheap scoped `quarantine.list`).
- Advisory: a drain failure must never surface as a failure of the user's `create table`.
- `create table` followed quickly by `drop table` locally → oracle gate makes the drain a
  no-op; harmless.
