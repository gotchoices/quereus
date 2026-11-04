description: Adding a column whose default reads one of the table's declared per-statement context values used to fail with a misleading "column not found" error; the ALTER now behaves like any statement that supplied no context, so a nullable value reads as NULL and a required one is rejected with an error explaining the workaround.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/planner/building/mutation-context.ts  # registerNoEnvelopeContextSymbols, plus registerContextVariable shared with registerMutationContextSymbols
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnBackfill expression-DEFAULT arm; addColumnReadsRequiredContextError
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 26
  - docs/sql-alter.md  # ADD COLUMN restrictions
  - docs/sql-ddl.md  # §2.6.2 "Which variables a statement must supply"
repro: verified
----

# `alter table … add column … default (<context variable>)` no longer reports the variable as an unknown column

## What changed

`ALTER TABLE … ADD COLUMN` compiles a non-literal DEFAULT once to fill the existing rows. That compile now sees the table's declared context variables, treated as if the statement supplied no `with context` clause:

- **Variable declared NULL:** reads as NULL. `default (who)` backfills NULL, `default (coalesce(who, 0))` backfills 0, and later writes that supply `who` store its value.
- **Variable declared NOT NULL and read by the DEFAULT:** rejected at plan time, with or without rows, by an error specific to ALTER that names the two-statement workaround.
- **Declared variable the DEFAULT does not read:** no effect, because the error is raised when the name is resolved, not when it is registered.
- **Name shared by a column and a variable:** the bare name is the variable, `new.<name>` is the column, matching INSERT.

The new helper `registerNoEnvelopeContextSymbols` resolves a nullable variable to a typed NULL `LiteralNode`, so no runtime context row is needed. It takes the error as a parameter so that `bug-alter-check-validation-cannot-reference-mutation-context` (in `tickets/blocked/`) can reuse it with a CHECK-specific message.

## Behaviour change to check

A bare name that is both a column and a context variable used to backfill from the column. It now reads the variable, so it backfills NULL or is rejected. The ticket asked for this, because it makes the backfill agree with what later INSERTs compute from the same DEFAULT. Existing programs that relied on the old result will see different values.

## Test added

Test 26 in `46-mutation-context.sqllogic`, two cases, memory and store legs:

- Nullable variable on a non-empty table: the ALTER is accepted, the existing row holds NULL, and a later `with context who = 7` insert stores 7.
- NOT NULL variable read by the DEFAULT on an **empty** table: rejected, matched on `ALTER TABLE supplies no context` so the old `Column not found` cannot satisfy it. This pins "regardless of rows".

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 10903 passing, 25 pending, 0 failing.
- `yarn test:store --grep 46-mutation-context` (from `packages/quereus`): passing.
- Throwaway script, memory module only, not committed. Every result matched the ticket:
  - `coalesce` default backfills its fallback.
  - `context.who` and `WHO` resolve like `who`.
  - An INTEGER expression into a TEXT column is converted.
  - NOT NULL variable: rejected with rows, without rows, and via `context.who`.
  - NOT NULL variable declared but unread: accepted.
  - The workaround in the error message works when followed literally.
  - NOT NULL column with a nullable variable: rejected on a non-empty table, accepted on an empty one.
  - All three shadowing forms behave as specified.
  - A generated column still reads the bare name as the column.
  - A table with no context still rejects a bare column.
  - An unknown name on a context table still reports `Column not found`.

## Known gaps

- **Inline CHECK still fails.** `add column c … default (who) check (who is null or c > 0)` still reports `Column not found: who`. This is deliberately out of scope and tracked by the blocked ticket named above.
- **Not run:** the whole `yarn test:store` suite, only this one file on that leg. Root `yarn test` across the other workspaces was not run either; the change is confined to the `packages/quereus` planner.
- **Test not run against the old code.** Test 26 was not run on the pre-change source. The ticket's measured reproduction is the same statement.
- **Not exercised:** a declarative schema change (`apply schema`) that produces this ALTER. It goes through the same builder, so it should behave the same, but only by reading the code.
- **Deviation from the ticket's wording:** the workaround in the error message uses the qualified table name (`alter table main.t alter column c set default (…)`) rather than the bare name, so that it stays correct for a table outside the current schema. Only the `main` schema was exercised.
