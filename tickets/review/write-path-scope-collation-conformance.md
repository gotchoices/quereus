description: Remaining hand-built write-path scope/attribute types omit collationName — comparisons inside DEFAULT expressions and RETURNING projections may resolve BINARY against declared-collation columns, diverging from the read path. Conformance gap only; no fact-soundness impact.
difficulty: easy
files:
  - packages/quereus/src/planner/building/constraint-builder.ts   # buildNotNullDefaults colType (~line 279) omits collationName
  - packages/quereus/src/planner/building/insert.ts               # OLD/NEW attribute types (~line 298) omit collationName
  - packages/quereus/src/planner/building/delete.ts               # OLD/NEW attribute types (~lines 138/150) omit collationName
  - packages/quereus/src/planner/building/update.ts               # check for the same pattern
----

# Write-path scope collation conformance (defaults / RETURNING)

Follow-up observed during `check-extraction-collation-blind-fds` (Part A
threaded declared column collations into the CHECK enforcement scope types in
`buildConstraintChecks`, matching the read path, ALTER backfill validation,
and the ADD COLUMN backfill hook).

The remaining hand-built scalar types on the write path still omit
`collationName`:

- `buildNotNullDefaults` (constraint-builder.ts) registers per-column scope
  types without collation — a comparison inside a column DEFAULT expression
  that references a declared-collation sibling column resolves BINARY instead
  of the declared collation.
- The OLD/NEW *attribute* types built in planner/building/insert.ts and
  delete.ts (and possibly update.ts) also omit it — RETURNING expressions
  comparing against a declared-collation column may diverge from the same
  expression in a query.

## Expectation

Any expression compiled over a table's row image (defaults, RETURNING,
mutation context) should resolve declared column collations identically to a
read-path query over the same schema. Either thread `collationName:
column.collation` into each remaining site (mirroring constraint-builder /
alter-table), or factor a shared scalar-type-from-ColumnSchema helper so new
sites cannot drift — survey first whether one already exists.

This is purely behavioral conformance: none of these expressions feed
plan-time fact extraction, so there is no optimizer-soundness urgency. Pin
with sqllogic cases mirroring the 40.2-check-extras collation section (a
DEFAULT containing a `case when c = 'abc' ...` over a NOCASE-declared `c`; a
RETURNING comparison) once behavior is decided.

## Implement handoff (2026-06-12)

Implemented via shared helper `columnSchemaToScalarType` in `src/planner/type-utils.ts` (always carries `collationName`); `columnSchemaToDef` / `relationTypeFromTableSchema` delegate to it. Threaded through: constraint-builder `buildNotNullDefaults`, insert/update/delete OLD/NEW attribute types, upsert existingAttributes, UPDATE RETURNING scope (four additional hand-built collation-blind types found there), `default-scope.ts` (`new.<col>` now resolves to the declared column type), and deduplicated local `columnScalarType` helpers in mutation/decomposition.ts + multi-source.ts. Tests: new `test/logic/06.4.3-write-path-collation.sqllogic` (DEFAULT with `new.c` NOCASE comparison, or-replace NOT NULL substitution, RETURNING on all three DML kinds, upsert DO UPDATE SET) — note bare-column refs in DEFAULTs are rejected at DDL time, so cases use `new.` spelling. Pre-existing gap left open: `MutationContextVar` has no collation field at all. Full suite 5909 passing.

NOTE for reviewer: the implement diff for this ticket is NOT under its own commit — a concurrent runner commit (c04e512e, "ticket(implement): maintained-table-attach-detach-verbs") swept these changes in along with ticket 6.2's work. Review the files named above within that commit.
