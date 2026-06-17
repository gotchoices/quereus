description: Add a SQL function that lets a developer query, from inside SQL, which shared tables the app still uses and which are now legacy candidates for cleanup.
prereq: basis-lifecycle-classification
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts   # getBasisTableLifecycle() — the data source
  - packages/quereus-sync/src/metadata/basis-lifecycle.ts  # BasisTableLifecycleRecord shape
----

# In-SQL introspection of basis-table lifecycle (`quereus_basis_lifecycle()` TVF)

The basis-table lifecycle bookkeeping (`basis-lifecycle-classification`) persists,
per shared (basis) table, whether the app still maps it directly, only uses it as
a derivation source, no longer references it, or has detached it — plus the
`mappedSince` / `unmappedSince` timestamps that tell a developer when a table
became a retirement candidate.

Today those records are reachable only programmatically, via
`SyncManager.getBasisTableLifecycle()` and the `onBasisTableLifecycle` event.

## What this ticket wants

A **table-valued function** — provisionally `quereus_basis_lifecycle()` — that
surfaces the same records from inside SQL, so a developer can write e.g.

```sql
select schema, table, state, unmappedSince
from quereus_basis_lifecycle()
where state = 'derivation-source-only'
order by unmappedSince;
```

to list legacy tables ready to schedule for retirement, without writing host code.

## Expected behavior / specification

- One row per persisted `BasisTableLifecycleRecord`, columns mirroring the record:
  `schema`, `table`, `state`, `mappedBy` (as text — e.g. JSON array or
  comma-joined), `derivationSource`, `inBasis`, `mappedSince`, `unmappedSince`,
  and the reserved `lastDirectlyMappedWriteAt` / `evictPolicy` (populated once
  `basis-eviction-policy` lands).
- Reads the durable records (survives restart), so it reflects the last deploy's
  classification even with no deploy in the current session.
- Registration is a sync-layer concern: the TVF needs a handle to the
  `SyncManager`, so wiring likely mirrors however other sync-aware SQL surface is
  registered against a `Database` (or is exposed as an opt-in the host calls).
  Confirm the registration seam during planning — this is the main open design
  question, since `@quereus/sync` is not itself a vtab module.

## Why parked, not built

The method + event are the contract the static-half ticket shipped; the TVF is a
pure convenience layer over the same records and was explicitly scoped out of
`basis-lifecycle-classification`. No engine change is needed — only a
function-registration seam from the sync layer.
