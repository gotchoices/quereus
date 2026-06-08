description: Review of DML plan builders (INSERT, UPDATE, DELETE, constraint-builder, foreign-key-builder)
files:
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
----
## Findings

### defect: DML builders use wrong planning context for schema path resolution
file: packages/quereus/src/planner/building/insert.ts:528, update.ts:68
insert.ts passes `ctx` instead of `contextWithSchemaPath` to `createRowExpansionProjection`;
update.ts passes `ctx` instead of `contextWithSchemaPath` for the source scan's `buildTableReference`.
Default expressions or table resolution can fail when `stmt.schemaPath` is set.
Ticket: tickets/fix/dml-schema-path-context.md

### defect: Parent-side FK check matches by table name only, ignoring schema
file: packages/quereus/src/planner/building/foreign-key-builder.ts:249
`buildParentSideFKChecks` compares `fk.referencedTable` against `tableSchema.name` but does not
check `fk.referencedSchema` against `tableSchema.schemaName`. In multi-schema setups with
identically-named tables, this can produce incorrect constraint checks.
Ticket: tickets/fix/fk-parent-side-missing-schema-check.md

### smell: Repeated DML boilerplate across builders
file: insert.ts, update.ts, delete.ts (various)
OLD/NEW attribute creation, contextDescriptor construction (`undefined as any` pattern),
mutation context processing, and RETURNING scope registration are near-identical across
all three builders. Extraction into shared helpers would reduce maintenance burden.
Ticket: (noted, not filed — lower priority refactor)

### smell: Update RETURNING/non-RETURNING path duplication
file: packages/quereus/src/planner/building/update.ts:289-374
Both code paths create UpdateNode → ConstraintCheckNode → DmlExecutorNode with
nearly identical constructor calls. Could be unified.
Ticket: (noted, not filed — lower priority refactor)

## Trivial Fixes Applied
- delete.ts:87,99,186,194 — Removed unnecessary `any` casts on `col`, `attr`, `columnIndex` parameters
- constraint-builder.ts:3,99,120 — Changed `RowOpFlag` from type-only to value import; replaced magic numbers `1`, `2`, `4` with `RowOpFlag.INSERT`, `RowOpFlag.UPDATE`, `RowOpFlag.DELETE`
- update.ts:185-191 — Removed dead `oldColumnAttributeIds` array (populated but never read)
- insert.ts:677-686 — Fixed incorrect indentation in RETURNING alias inference block

## No Issues Found
- insert.ts column mapping logic (explicit vs implicit, DEFAULT, generated columns) — correct
- INSERT...SELECT type coercion via `checkColumnsAssignable` — correct
- ON CONFLICT target detection and DO UPDATE SET bindings — correct scope registration with NEW/excluded/existing
- DELETE WHERE clause binding — correct
- Constraint builder CHECK evaluation with proper OLD/NEW scope and schema switching — correct
- Foreign key builder child-side EXISTS check synthesis — correct
- Foreign key builder RESTRICT vs NO ACTION deferral semantics — correct
- RETURNING clause NEW/OLD scope registration per operation type — correct
- validateReturningExpression for INSERT — correct (blocks OLD references)
- Generated column handling (two-pass projection, determinism validation) — correct
- Resource cleanup: no open handles or unfinished iterators in plan building — clean
