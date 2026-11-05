description: Let "alter table" accept a "with context" clause, so a new column can be backfilled from a supplied value and a rule that reads a required context value can be added to an existing table. Today the statement has no way to supply one.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/parser/parser.ts # with context is parsed on insert, update and delete only
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/planner/building/mutation-context.ts
  - packages/quereus-sync/src/sync/migration-ddl.ts # replayed schema changes
tradeoffs: The no-context rule already gives a clear error and a workaround, and a value supplied once says little about rows written under other values, so this may only be worth doing for column backfill.
----

Raised by the maintainer while deciding `bug-alter-check-validation-cannot-reference-mutation-context`, which settles what `alter` does when no context is supplied. This is the additive follow-up, allowing what that rule refuses.

The two uses are not equally useful:

- **Backfilling a new column.** `alter table t add column created_by text default (who) with context who = 'migration'` supplies a real value that nothing can provide today.
- **Validating a CHECK.** Existing rows were written under context values that aren't stored, so there is no true value for them. Passing with `who = 5` only shows the rows satisfy the rule for 5. The optimizer treats a declared CHECK as a proven fact about stored rows (`test/logic/10.1.8-alter-add-check-existing-rows.sqllogic`), so it must not rely on one validated this way.

Questions a plan has to settle:

- **Sync.** A context-supplied backfill value has to reach other devices, or each backfills differently. `migration-ddl.ts` replays migrations; how it would carry this has not been traced.
- **`apply schema`.** It generates its own `alter` statements, so it needs its own way to supply values, or it stays limited to the no-context rule.
- **Which statements.** `create index` and other `alter` forms may not need this. Limit it to statements that compile row expressions.
