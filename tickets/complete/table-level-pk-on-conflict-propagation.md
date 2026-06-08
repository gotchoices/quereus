---
description: Table-level `PRIMARY KEY (...) ON CONFLICT <action>` clauses now propagate into PK-conflict resolution.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/29.2-table-level-pk-conflict-clause.sqllogic
---

# Table-level `PRIMARY KEY ... ON CONFLICT` propagation

## What landed

Schema build now captures the `onConflict` action from a table-level
`PRIMARY KEY (...) ON CONFLICT <action>` clause and threads it onto the
`TableSchema` as a new optional `primaryKeyDefaultConflict` field. The two
existing PK-conflict resolvers (memory backend, isolation overlay) check
that field first, falling back to any column-level `defaultConflict` on a
PK column, then to ABORT. Per-constraint precedence is unchanged at the
boundary: statement-level OR still wins.

- `TableSchema.primaryKeyDefaultConflict?: ConflictResolution` — new
  optional field, intentionally distinct from column-level
  `defaultConflict` so a table-level directive doesn't shadow a column's
  own `ON CONFLICT`.
- `findPKDefinition` / `findConstraintPKDefinition` return both the PK
  column list and the constraint's `onConflict`. Column-level PKs do not
  populate `defaultConflict` here (that belongs on `ColumnSchema`).
- `buildColumnSchemas` + `_createTableSchemaFromAST` thread the value
  into the frozen table schema.
- Memory `resolvePkDefaultConflict` and the isolation overlay's
  textually-mirrored copy both consult `primaryKeyDefaultConflict` before
  iterating PK columns.

New test fixture: `29.2-table-level-pk-conflict-clause.sqllogic` —
composite PK with each `ON CONFLICT` action (IGNORE, REPLACE, FAIL,
ROLLBACK), statement-level OR override, and UPDATE-with-PK-change for
REPLACE and IGNORE.

## Review findings

Checked, in roughly this order:

**Diff correctness (read fresh before the handoff).** The schema-build
change is minimal and isolated: one new optional field, one helper return
type widened, two textually-mirrored resolver helpers updated to consult
the new field first. The Object.freeze paths preserve the field on
spread; rebuild paths in `alter-table.ts` (`...tableSchema` spread at
line 690) carry it through without needing changes.

**Callers of the changed signature.** `find_references` confirms
`findPKDefinition` has exactly one caller (`buildColumnSchemas` in
`schema/manager.ts`); the destructuring update there is the only call
site needing adjustment. No external/test callers.

**Consumers of the new field.** Project-wide search for
`primaryKeyDefaultConflict` finds only the schema build site and the two
resolver helpers. `ddl-generator.ts` does not emit ON CONFLICT for *any*
per-constraint default — that's a pre-existing limitation that affects
column-level `defaultConflict` equally and is out of scope here.
`schema-differ.ts` doesn't track per-constraint conflict actions either
— same pre-existing scope.

**Helper precedence judgment.** New rule
`primaryKeyDefaultConflict > column-level defaultConflict on a PK
column > ABORT` matches option 2 of the source ticket. Rationale is
documented inline. Column-level `ON CONFLICT` on a PK column continues
to populate `ColumnSchema.defaultConflict` (in `columnDefToSchema`), so
the column-level fallback path is preserved exactly as before for the
column-declared-PK case.

**Coverage of the new test fixture.** 29.2 cases 6 and 7 use composite
PK and PK-change UPDATE (both columns mutated). The path in
`performUpdateWithPrimaryKeyChange` (`vtab/memory/layer/manager.ts:651`)
also calls `resolvePkDefaultConflict(schema)`, so those cases genuinely
exercise the table-level helper rather than going through the INSERT
path. Confirmed by reading the line.

**Interaction with column-level `ON CONFLICT` on a non-PK column.** Not
covered by a fixture, but `resolvePkDefaultConflict` only iterates PK
columns — it cannot consult a non-PK column's `defaultConflict` by
construction. Risk is structural, not value-based, so no fixture added.

**Comments inspected for staleness.** Two inline comments still read
"column-level default" but the resolver now also handles table-level.
Fixed inline (this pass):
- `packages/quereus/src/vtab/memory/layer/manager.ts:561` —
  `statement OR > column-level default > ABORT` →
  `statement OR > per-constraint default > ABORT`.
- `packages/quereus-isolation/src/isolated-table.ts:960` —
  `PK column-level default` → `per-constraint default`.

The header doc-comments on `resolvePkDefaultConflict` in both files were
already updated by the implementer; the helpers stay textually
equivalent.

**Docs.** `docs/sql.md:422` already states "A column- or table-level
constraint may carry its own `ON CONFLICT <action>` clause" — that
contract was aspirational for table-level PK before and is now factual.
The doc's only worked example is column-level; not changed (no source
ticket requirement, and 29.1 + 29.2 together document the surface
behavior). `docs/architecture.md:137` likewise — table-level is already
named alongside column-level in the conflict-resolution summary.

**Verification.** From the repo root:
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` — passes.
- `yarn workspace @quereus/quereus run test` — **2941 passing, 2
  pending, 0 failing.** 29.2 passes; 29.1 stays green.
- `yarn workspace @quereus/isolation run test` — 64 passing.
- `yarn test:store` — **577 passing, 2 pending, 1 failing.** The
  failure is `10.5.1-partial-indexes.sqllogic:49` ("Expected error
  matching 'UNIQUE' but SQL block executed successfully"); pre-existing
  and unrelated to this ticket (partial UNIQUE index enforcement in
  STORE mode). 29.2 passes in STORE mode too, confirming the isolation
  overlay path resolves correctly.

## Out of scope (documented, not closed)

Per-constraint FAIL/ROLLBACK does not currently auto-rollback the
enclosing transaction. PK conflicts surface through the vtab layer as
`{ status: 'constraint', constraint: 'unique', ... }`; the DML
executor's `translateConflictError`
(`packages/quereus/src/runtime/emit/dml-executor.ts:243`) only escalates
to `FailConflictError` / `RollbackConflictError` based on
**statement-level OR**, never on per-constraint defaults. This is a
pre-existing limitation — column-level PK `ON CONFLICT FAIL/ROLLBACK`
has the same gap (29.1 doesn't exercise those for the same reason).
29.2 case 4 asserts only the surface-level constraint error for
ROLLBACK and documents the deferral inline.

A follow-up fix ticket should make per-constraint FAIL/ROLLBACK honor
its declared semantics consistently for both column- and table-level
constraints, either by having the vtab layer throw the right subclass
when the resolved action is FAIL/ROLLBACK, or by extending
`translateConflictError` to consult the constraint's per-constraint
default for the constraint that failed. Not opened as a new ticket
here; close out at the human's discretion if they prefer to track it.

## Major findings filed as new tickets

None. Findings were:
- Two stale inline comments — fixed inline (minor, this pass).
- Pre-existing FAIL/ROLLBACK escalation gap — explicitly out of scope
  for this ticket (the source ticket carved schema-build + helper only)
  and documented above; not a regression.
