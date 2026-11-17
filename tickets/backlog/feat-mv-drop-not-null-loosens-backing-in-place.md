description: Allowing blanks in a source column currently stops every materialized view that reads it from updating until someone refreshes it; such a view could instead relax its own stored column and keep updating.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # tryRecompileMaterializedViewLive (~2320), describeBackingShapeMismatch, classifyBackingReshape loosenNotNull op
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # §16a-e currently pin the stale behaviour
tradeoffs: Refresh already recovers the view correctly, so this only removes a manual step after a rare schema change, at the cost of a schema write (an ALTER on the backing table) inside the schema-change listener, which today only recompiles or marks stale.
----

# Keep a materialized view live when a column it reads drops NOT NULL

When a source column a materialized view projects goes from NOT NULL to nullable (`alter table t alter column x drop not null`), the view's re-derived backing shape says that column is now nullable while the stored backing table still declares it NOT NULL. `tryRecompileMaterializedViewLive` treats that as a shape mismatch and marks the view **stale**: row-time maintenance stops, and the view serves its pre-alter contents until `refresh materialized view` runs, which then reshapes the backing with a metadata-only `loosenNotNull`. This applies to every backing column, including primary-key columns (once `debt-mv-ordering-seed-to-materialized-index` lands).

A NOT NULL → nullable change never invalidates stored rows, and the backing-side `drop not null` is metadata-only on both backends (including key columns — `docs/schema.md` § Primary-key nullability). So when the *only* difference between the live backing and the re-derived shape is one or more loosenings, the live-recompile path could apply those loosenings to the backing in place and keep the view live, with no refresh needed.

Expected behaviour: after `drop not null` on a column a view reads, the view stays live, its backing column reads nullable, and a following NULL insert into the source is maintained into the view immediately. Any other shape difference still marks the view stale as today.

Considerations: the loosening is a backing `alterTable` call made from inside the schema-change listener (which currently does no backing writes), so it has to fit that listener's transaction and event-ordering rules and must emit the usual change event for the backing; a store-hosted backing persists the change. `53-materialized-views-rowtime.sqllogic` §16a-e use `drop not null` specifically to force staleness and would need a different trigger.
