description: SQL-level / tooling surface for the coarsened-backing-key stamp (warning is debug-channel-only today)
files:
  - packages/quereus/src/schema/view.ts                            # CoarsenedKeyInfo + MaterializedViewSchema.coarsenedKey (the record stamp)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # warnKeyCoarsening (logger warn channel)
  - docs/materialized-views.md                                     # § Coarsened backing keys
  - docs/migration.md                                              # § Convergence hazards
----

# Surface the coarsened-backing-key fact to users and tooling

The `mv-coarsened-backing-key-warning` work detects the collation-weakening
parallel-migration MV shape at create and (a) stamps
`MaterializedViewSchema.coarsenedKey` (columns + per-column source→output
collations) and (b) emits the key-coarsening warning on the structured logger's
`runtime:emit:materialized-view:warn` channel. The stamp is programmatic-only
and the warning is invisible unless `DEBUG` is enabled — there is no SQL-level
or tooling-level surface today.

## Use cases / expectations

- **Operator introspection.** A developer inspecting a deployed schema should
  be able to discover that an MV runs under a coarsened (LWW-merging) backing
  key without attaching a debugger or enabling DEBUG: e.g. a column on the
  schema/materialized-view introspection TVF(s) (or a pragma) exposing the
  `coarsenedKey` stamp (key columns + weakened collation pairs), NULL/absent
  for ordinary MVs.
- **Declarative deploy report.** When a declarative `apply schema` (or the lens
  deploy pipeline) creates or re-creates a coarsened-key MV, the deploy
  report/advisory surface should carry the same fact, so migration tooling can
  show it at the moment the operator is making the deploy decision — the
  natural home per docs/migration.md § Convergence hazards. (Imperative MV
  create does not flow through the lens prover/deploy-report pipeline today;
  this item is about the declarative path that does.)
- **Refresh/adopt parity (lesser).** Today only `materializeView`
  (create + import-refill) emits the warning; a refresh shape-rebuild and the
  adopt-without-refill import path re-stamp the record silently. Once a real
  surface exists, decide whether those paths should also report (likely yes for
  the deploy report, irrelevant for the logger).

## Notes

- The stamp is informational and recomputed wherever the backing shape is
  re-derived; it must remain non-serialized (no DDL round-trip, no differ
  churn). Any SQL surface should read the live record, not persist anything.
- Runtime collision telemetry is tracked separately
  (`mv-collation-collision-telemetry`) — this ticket is the *static* surfacing
  complement.
