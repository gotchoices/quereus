----
description: Relax tryRecompileMaterializedViewLive's strict positional backing-PK equality to a superkey check, so an ADD CONSTRAINT UNIQUE that merely reorders `keysOf`'s first proved key no longer forces the stale fallback.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # tryRecompileMaterializedViewLive, describeBackingShapeMismatch
difficulty: easy
----

# Relax the recompile gate's backing-PK equality to a superkey check

`tryRecompileMaterializedViewLive` (from `mv-staleness-constraint-only-table-modified`)
gates the in-place recompile on `describeBackingShapeMismatch`, which requires the
re-derived backing PK to equal the live backing's PK **positionally and exactly**.
That strictness is what correctly forces staleness when a dropped UNIQUE un-proves
the recorded key — but it also stales a dependent MV when an `ADD CONSTRAINT
UNIQUE` (or `CREATE UNIQUE INDEX`) merely changes which proved key `keysOf` returns
*first*, even though the recorded backing key is still a valid unique key of the
re-planned body.

Expected behavior: when the re-derived shape's columns match and the **recorded**
backing PK is still provably a (super)key of the re-planned body root — any proved
key, not necessarily the first — the MV should recompile in place and stay live.
The backing's physical key need not change just because the optimizer would now
*prefer* a different key for a fresh create.

This is a pure conservatism today ("no worse than before the recompile carve-out":
previously every constraint DDL staled dependents), so it is an optimization, not a
bug. The dropped-UNIQUE-that-backed-the-key case must keep forcing staleness — the
relaxation is only sound in the direction where the recorded key remains proved.

Covered conservative outcomes are pinned in
`test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic` (§6, §9, §11) and
documented in `docs/materialized-views.md` § Schema-change staleness (fallback
causes list); update both alongside the relaxation.
