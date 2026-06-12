----
description: Non-rename structural ALTERs (add/drop/alter column) on a source table stale every dependent MV, including MVs whose bodies provably never touch the altered column — extend the shape-rederivation restore/recompile discipline to keep those live.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # subscribeToSchemaChanges
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # deriveBackingShape, describeBackingShapeMismatch, tryRecompileMaterializedViewLive (added by mv-staleness-constraint-only-table-modified)
  - packages/quereus/src/runtime/emit/alter-table.ts            # runAddColumn / runDropColumn / runAlterColumn event sites
----

# Keep provably-unaffected MVs live across structural source ALTERs

A `table_modified` whose column list changed (ADD COLUMN, DROP COLUMN, ALTER
COLUMN SET TYPE/NOT NULL/COLLATE) marks every dependent MV stale, even when the
MV body never projects or filters on the touched column — e.g. `create
materialized view mv as select id, u from t` followed by `alter table t add
column w int` or `alter table t drop column v`. The body re-plans to the
identical backing shape, so the MV could stay live.

Two prior pieces cover adjacent shapes and should be generalized rather than
duplicated:

- `restoreUnaffectedMaterializedViews` (rename propagation, statement-local):
  re-derives the backing shape after the statement and restores
  statement-staled MVs whose shape still matches.
- `tryRecompileMaterializedViewLive` (from
  `mv-staleness-constraint-only-table-modified`): the same gate run inline at
  the listener for columns/PK-identical events.

The natural extension: at the listener (or as a statement-local pass after the
ALTER emitters' notify), run the shape-rederivation gate for structural events
too — a dependent whose re-derived shape (columns, types, not-null, collation,
physical PK) and sourceTables still match its live backing recompiles and stays
live; any mismatch keeps today's staleness.

## Considerations / hazards to evaluate

- A `select *` body DOES change shape on add/drop column — must stale (and the
  shape gate catches it).
- ALTER COLUMN SET TYPE / COLLATE on a projected column changes output
  types/collations → shape mismatch → stale; on an UNprojected column the body
  shape is unchanged, but WHERE-referenced columns can change comparison
  semantics under a collation change while the derived output shape stays
  identical — verify the recompile (fresh plan against the new catalog) is
  sufficient, since the backing CONTENT may now disagree with what a fresh
  body evaluation would produce (e.g. a `where`-filtered row set under a new
  collation). Content-affecting changes must stale; shape identity alone may
  not prove content identity here, unlike the constraint-only case.
- DROP COLUMN of a column the body reads fails re-derivation → stale (already
  the right outcome).
- NOT NULL loosening/tightening on a projected column flows into output
  nullability → shape mismatch → stale.

The key open design question (why this is not a trivial follow-on): for
structural ALTERs, "re-derived shape matches" does NOT imply "backing content
still equals a fresh body evaluation" — the constraint-only ticket's soundness
argument (constraints can't change body results) does not carry over. The
restore must additionally prove the altered column is disjoint from everything
the body reads (projection AND predicates AND join keys), e.g. via the body
plan's referenced source-column set, before keeping the backing's content
trusted.
