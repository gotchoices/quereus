description: Make held sync edits replay the instant a deleted table comes back (e.g. right after it is re-created), instead of waiting up to one maintenance cycle for the periodic sweep to notice.
prereq: sync-drain-host-wiring
files:
  - packages/quoomb-web/src/worker/quereus.worker.ts          # host that applies inbound changes / lens redeploys
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager.drainHeldChanges(schema, table) scoped form
  - packages/quereus-sync/src/sync/change-applicator.ts       # inbound create_table application path
difficulty: medium
----

# Low-latency scoped drain when a retired table reappears

## Context

`sync-drain-host-wiring` adds a periodic sync-maintenance loop (default ~5 min) in the
quoomb-web worker that calls `SyncManager.drainHeldChanges()` (no-arg sweep) on a cadence.
That guarantees held out-of-basis changes for a reappeared table eventually replay, but with
up to one cadence interval of latency.

The drain primitive also has a **scoped** form — `drainHeldChanges(schema, table)` — meant
to be called the moment a specific table comes back, dropping the latency from "next tick"
to "immediately." See `docs/migration.md` § 4 Contract → Revival / drain ("…or right after
the host re-creates a table").

## What this is about

A retired table can reappear in the local basis through a few paths; this enhancement hooks
them to fire a scoped drain right then:

- An inbound `create_table` for a previously-retired table arrives in an `applyChanges`
  batch (remote peer re-created it).
- A local `apply schema` lens redeploy re-maps a basis table back into the basis
  (`recordLensDeployment` / store-module deploy path).
- The app issues a local `create table` for a name that had held changes.

For each, after the re-creating change has fully committed, call
`drainHeldChanges(schema, table)` for the reappeared table so its held edits replay without
waiting for the periodic sweep.

## Why it's backlog, not part of the host-wiring ticket

The periodic sweep already makes the feature correct; this is a latency optimization.
Identifying and hooking the reappearance points (inbound DDL application, lens redeploy,
local DDL) is a separate, more invasive change spanning the apply path and/or store-module
deploy callbacks — out of scope for the single-subsystem worker-loop ticket. Pick it up once
the periodic loop has landed (`prereq: sync-drain-host-wiring`).

## Notes / open questions for the planner who picks this up

- Decide which reappearance path(s) are worth hooking — the inbound `create_table` case is
  the highest-value (a re-created table mid-sync); local DDL may be rarer.
- Drain must run as a *separate* apply **after** the re-creating batch commits (same
  invariant the primitive already documents) — do not interleave it into the admitting
  batch.
- Guard against double work with the periodic sweep (both are idempotent — a second drain of
  an already-drained table returns 0 — so this is a no-op-safety check, not a correctness
  risk).
