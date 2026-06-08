---
description: OR-conflict resolution and column-level ON CONFLICT directives now match SQLite semantics across all constraint classes.
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/core/database.ts
  packages/quereus/src/core/statement.ts
  packages/quereus/src/util/async-iterator.ts
  packages/quereus/src/common/errors.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic
  packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
  packages/quereus/test/logic/47.3-engine-or-fail.sqllogic
  docs/sql.md
  docs/architecture.md
---

## Summary

`INSERT OR {IGNORE,REPLACE,FAIL,ABORT,ROLLBACK}` now behaves like SQLite for every constraint class — NOT NULL, CHECK, FK existence, and UNIQUE/PK — instead of just UNIQUE/PK. Column- and table-level `ON CONFLICT <action>` directives are persisted as the per-constraint default and applied when no statement-level OR clause is present. Statement-level OR always wins.

## Behavior matrix

| Class | IGNORE | REPLACE | FAIL | ABORT | ROLLBACK |
|---|---|---|---|---|---|
| NOT NULL (with DEFAULT) | skip row | substitute DEFAULT | abort stmt | abort stmt | abort stmt + rollback tx |
| NOT NULL (no DEFAULT) | skip row | abort stmt | abort stmt | abort stmt | abort stmt + rollback tx |
| CHECK | skip row | abort stmt (REPLACE does not mask CHECK) | abort stmt (commit prior rows) | abort stmt | abort stmt + rollback tx |
| FK existence (child→parent) | skip row | abort stmt | abort stmt (commit prior rows) | abort stmt | abort stmt + rollback tx |
| UNIQUE / PK | skip row | replace existing | abort stmt (commit prior rows) | abort stmt | abort stmt + rollback tx |

FAIL keeps prior rows of the same statement that already succeeded; the iterator-level transaction-finalization branches on `FailConflictError` to commit instead of rolling back. ROLLBACK throws `RollbackConflictError`, which the same finalization recognizes and unconditionally rolls back the active transaction (implicit or explicit).

## Tests

All ticket-specific sqllogic fixtures pass (5 files, all green):

- `test/logic/29.1-column-level-conflict-clause.sqllogic` — column-level directives applied as defaults; cases 1-5 cover PK/UNIQUE/NOT NULL/CHECK with REPLACE / IGNORE; case 6 confirms statement-level OR ABORT overrides the column-level IGNORE.
- `test/logic/43.1-notnull-or-conflict.sqllogic` — NOT NULL with OR variants (case 1: OR IGNORE skips; case 2: OR REPLACE without DEFAULT errors; case 3: OR REPLACE substitutes DEFAULT; case 5: NOT NULL violation in INSERT…SELECT aborts).
- `test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic` — FK existence with OR IGNORE in case 1.
- `test/logic/47.2-replace-and-or-clauses.sqllogic` — OR FAIL preserves prior rows (case 7); OR ROLLBACK auto-rolls-back enclosing tx (case 8); OR IGNORE skips CHECK (case 9); REPLACE does NOT mask CHECK (case 10).
- `test/logic/47.3-engine-or-fail.sqllogic` — targeted OR FAIL coverage on engine-level NOT NULL & CHECK plus OR ROLLBACK on engine-level CHECK.

## Validation

- `yarn lint` — clean.
- `yarn tsc --noEmit` — clean.
- `yarn test` — all OR-conflict-clause tests pass. One unrelated pre-existing failure in `Extended constraint pushdown / OR predicates / handles OR with range predicate as residual correctly` (introduced by commit `8c9e5686 ticket(review): allow-aggregates-in-order-by`, after this implement commit) — out of scope here.

## Code-level entry points

- Parser: `parser.ts` column-level CHECK now consumes `ON CONFLICT` (line ~3506-3516); same for table-level CHECK (line ~3596-3608).
- Schema: `ColumnSchema.defaultConflict`, `RowConstraintSchema.defaultConflict`, `UniqueConstraintSchema.defaultConflict`, `ForeignKeyConstraintSchema.defaultConflict` populated by `columnDefToSchema` / `extractCheckConstraints` / `extractUniqueConstraints` (FK is plumbing-only — parser doesn't accept a conflict clause on FK references).
- Plan: `ConstraintCheckNode` carries `onConflict` and `notNullDefaults`. `building/insert.ts` and `building/update.ts` both thread `stmt.onConflict` through. `building/constraint-builder.ts` exports `buildNotNullDefaults`.
- Runtime: `runtime/emit/constraint-check.ts` resolves `pickAction(stmtOR, constraint.defaultConflict)` per row and applies IGNORE / REPLACE-with-DEFAULT / FAIL / ROLLBACK / ABORT. Subquery-deferred CHECK and FK existence checks are forced to evaluate at row time when the effective action is non-default (so IGNORE/REPLACE can drop or pass the row).
- Errors: `FailConflictError` and `RollbackConflictError` (subclasses of `ConstraintError`) signal which finalization branch to take.
- Iterator cleanup: `wrapAsyncIterator` passes the terminating error to the cleanup handler. `Database._finalizeImplicitTransaction(success, error?)` branches on the error type. Memory vtab (`vtab/memory/layer/manager.ts`) honors per-constraint `defaultConflict` for UNIQUE/PK.
- DML executor: `runtime/emit/dml-executor.ts` opens a per-row savepoint in OR FAIL mode (`runInsert`, lines ~289-328) so a later row's failure doesn't disturb prior rows. Constraint errors are re-thrown via `translateConflictError` so iterator-level cleanup picks the right finalization branch.

## Code-quality review notes

- DRY: `pickAction()` shared across all constraint classes; `translateConflictError()` shared across INSERT/UPDATE/DELETE.
- Single-purpose error subclasses (`FailConflictError`, `RollbackConflictError`) cleanly carry intent across the iterator boundary.
- Resource cleanup: `wrapAsyncIterator` calls the cleanup handler at most once and forwards the error; per-row savepoint in OR FAIL is rolled back on failure and released on success.
- Per-row cost: `pickAction` is a 3-way nullish-coalesce; the "must evaluate now" decision is a single boolean test.
- Docs (`docs/architecture.md` 134-146, `docs/sql.md` 398-421) accurately reflect both the matrix and the precedence rules.

## Out of scope (follow-up)

- UPDATE OR is intentionally deferred — the parser does not yet accept it. Tests pin "not supported" in `47.2` (case 5), `41` (case 2), `43.1` (case 4).
- REPLACE on FK with `ON DELETE CASCADE/SET NULL` cascading the parent row's deletion (an SQLite quirk) is not implemented; FK + REPLACE behaves like ABORT.
