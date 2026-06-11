----
description: The MV staleness listener marks every dependent MV stale (and detaches its row-time plan) on ANY table_modified, including changes that only touch constraint metadata (CHECK/FK/index-predicate rewrites) — needlessly de-livening MVs outside renames, e.g. declarative migrations that only retarget FKs.
difficulty: hard
files:
  - packages/quereus/src/core/database-materialized-views.ts   # subscribeToSchemaChanges
  - packages/quereus/src/runtime/emit/alter-table.ts            # constraint-only table_modified emitters: rewriteTableForTableRename/rewriteTableForColumnRename, runDropConstraint, runRenameConstraint
----

# Distinguish constraint-only `table_modified` in the MV staleness listener

`subscribeToSchemaChanges` in `database-materialized-views.ts` treats every
`table_modified` on a source table as potentially body-invalidating: it marks each
dependent MV stale, detaches the compiled row-time plan, and invalidates cached
backing reads. But a `table_modified` whose old/new `TableSchema` differ **only in
constraint metadata** (CHECK expressions, FK `referencedTable`/columns,
index predicates, constraint names/tags) — with columns (names, types, not-null,
collation, generated) and `primaryKeyDefinition` identical — cannot change what an
MV body **evaluates to**: bodies reference columns, never constraints.

Today these events arise from:
- rename propagation rewriting another table's CHECK/FK/index-predicate ASTs
  (`rewriteTableForTableRename` / `rewriteTableForColumnRename`) — the rename-local
  fallout is fixed statement-locally by `mv-rename-restore-unaffected-stale`;
- `DROP CONSTRAINT` / `RENAME CONSTRAINT` / declarative migrations that only
  retarget FKs — these still needlessly stale every dependent MV, with no
  statement-local restoration to catch them.

## Expected behavior

On a `table_modified` whose column list and PK are unchanged between
`event.oldObject` and `event.newObject`, dependent MVs should stay **live** rather
than going silently stale.

## Soundness caveats (why "just skip the event" is not enough)

Constraint metadata cannot change body *results*, but it can feed the **compiled
row-time maintenance plan** and the backing **shape derivation**:

- `proveOneToOneJoin` (the join-residual arm) relies on NOT-NULL FK→PK referential
  integrity — dropping that FK makes the bounded-delta arm unsound for future
  writes.
- UNIQUE constraints feed `keysOf`, which chose the backing PK at create; dropping
  one could make the recorded backing PK collide on future data.
- CHECK constraints seed optimizer domain facts (`ruleFilterContradiction`) that a
  compiled body/residual scheduler may have folded against.

So the safe shape is likely: **recompile instead of stale** — on a
columns/PK-identical `table_modified`, re-register the MV's row-time plan
(`registerMaterializedView`, which re-runs eligibility/cost gating against the new
catalog) without setting `stale`; fall back to today's mark-stale on any
recompile failure. Whether a pure semantics-preserving *rewrite* (rename
propagation) can skip even the recompile, and whether a dropped UNIQUE that backed
the recorded backing PK must instead force staleness, are the design questions to
settle.

A related generalization worth considering at the same layer: non-rename ALTERs
(add/drop/alter column) also stale provably-unaffected MVs (body doesn't project
the touched column); the shape-rederivation restore used by the rename fix could
apply there too.
