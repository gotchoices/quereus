----
description: Expose per-column updateability (`information_schema.columns.is_updatable` per `docs/view-updateability.md` § Information Schema Surface) for every view and base table — the column-granular companion to the view-level `view_info()` surface.
prereq: view-mutation-physical-lineage
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/update-lineage.ts, docs/view-updateability.md
----

## Why this is separate

Split out of `view-information-schema-surface` (which ships the four **view-level**
columns as `view_info()`). Per-column updateability is independently shippable and
touches the **base-table** introspection surface as well as views, so it deserves its
own pass rather than bloating the view-level ticket.

## What the doc asks for

`docs/view-updateability.md` § Information Schema Surface:

> `information_schema.columns.is_updatable` reports per-column updateability for every
> view (and base table) in the catalog. Values are computed at schema-attachment time
> and refreshed when the underlying schema changes.

So for **every column of every view and base table**, report whether a write to that
column propagates to a base column (`base` `UpdateSite`) vs. is read-only (`computed`
/ generated / null-extended-without-materialization).

## Surface shape (to decide at plan time)

Consistent with the engine's TVF-only introspection convention (there is no
`information_schema` namespace — see the view-level ticket's surface decision), the
likely realization is **either**:

- extend `table_info(name)` with an `is_updatable` column (it already reports
  per-column flags: `notnull`, `pk`, `generated`, `collation`), **or**
- a dedicated `column_info(name)` TVF if extending `table_info` is too coupling.

Pick one at plan time; prefer extending `table_info` if the goldens churn is
acceptable, since it already is the per-column surface.

## Source data

Per-column lineage comes from the `updateLineage` threaded onto `PhysicalProperties`
by `view-mutation-physical-lineage` (for views: plan the body, read root
`updateLineage`; for base tables: every non-generated column is trivially `base`).
The doc's "computed at schema-attachment time" caching is an optimization — lazy
per-call computation (matching the other `*_info` TVFs) is the simpler v1.

## Out of scope

- The view-level columns (`is_insertable_into` / `is_updatable` / `is_deletable` /
  `effective_targets`) — shipped by `view-information-schema-surface` as `view_info()`.
