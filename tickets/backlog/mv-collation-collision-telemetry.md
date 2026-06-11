description: Runtime collision telemetry for coarsened-key materialized views — the operational complement to the create-time key-coarsening warning (docs/migration.md § Convergence hazards). Parked from ticket collation-weakening-key-claims.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - docs/migration.md
----

# MV key-coarsening collision telemetry

Once a coarsened-key materialized view exists (see implement ticket
`mv-coarsened-backing-key-warning`), in-window collisions are silent by design:
an old peer's colliding source row arrives through the ingest seam and the
keyed upsert last-writer-wins, merging two source rows into one derived row
that oscillates until the source rows are merged.

The create-time warning tells the developer the hazard *exists*; telemetry
should tell the operator it is *happening*:

- During steady-state maintenance (and optionally during refresh/rebuild
  fills), detect when an upsert under the coarsened backing key replaces a row
  whose source identity differs (two distinct source-key tuples mapping to one
  backing key).
- Surface as a counter/event the host application can observe — align with
  whatever notification/statistics surface the backing-host or change-notifier
  layer offers; this must not require a sync layer (the engine has no peer
  concept).
- Expectation: zero overhead for MVs whose backing key is not coarsened
  (detection only armed when the create path flagged coarsening).

Use cases: a migration dashboard answering "are colliding writes still
arriving?", deciding when the flip/contract phases are safe, and post-incident
diagnosis of oscillating derived rows.
