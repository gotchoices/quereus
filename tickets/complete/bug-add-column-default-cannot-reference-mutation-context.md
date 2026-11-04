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

## What was built

`ALTER TABLE … ADD COLUMN` compiles a non-literal DEFAULT once to fill the existing rows. That compile now sees the table's declared context variables, treated as if the statement supplied no `with context` clause:

- **Variable declared NULL:** reads as NULL. `default (who)` backfills NULL, `default (coalesce(who, 0))` backfills 0, and later writes that supply `who` store its value.
- **Variable declared NOT NULL and read by the DEFAULT:** rejected at plan time, with or without rows, by an error specific to ALTER that names the two-statement workaround.
- **Declared variable the DEFAULT does not read:** no effect, because the error is raised when the name is resolved, not when it is registered.
- **Name shared by a column and a variable:** the bare name is the variable and `new.<name>` is the column, matching INSERT. This changes behaviour: such a DEFAULT used to backfill from the column.

The helper `registerNoEnvelopeContextSymbols` resolves a nullable variable to a typed NULL `LiteralNode`, so no runtime context row is needed. It takes the error as a parameter so that `bug-alter-check-validation-cannot-reference-mutation-context` can reuse it with a CHECK-specific message.

## Review findings

Reviewed from the implement diff (`ticket(implement): bug-add-column-default-cannot-reference-mutation-context`) with the surrounding builder, INSERT's DEFAULT scope, and the docs.

### Found and fixed in this pass

- **The workaround in the error was not valid SQL for a name that needs quoting.** On `"my t"` / `"my c"` the message said `alter table main.my t alter column my c set default (…)`, which fails to parse. Reserved-word table names were affected the same way. The snippet now goes through `quoteIdentifier`. Re-run: the message reads `alter table main."my t" alter column "my c" set default (…)`, and `"order"` comes out quoted. The quoted statements, run by hand, succeed and a later write stores the supplied value. No test added, since this is message text only.
- **Unused parameter on the helper.** After that fix the only caller ignored the `tableLabel` argument of the `missingNotNull` callback, so it was removed along with the label computed for it. The caller already holds the table schema, and so will the CHECK-side reuse. This narrows the signature the implement ticket suggested.

### Filed against an existing ticket

- **ALTER validates a different CHECK from the one writes enforce when a bare name is both a column and a variable.** ADD CONSTRAINT and both ADD COLUMN paths read it as the column, while writes read the variable, so a CHECK `CREATE TABLE` accepts can be rejected by ALTER. This predates the ticket and sits at the sites `bug-alter-check-validation-cannot-reference-mutation-context` already claims, so the measured table was appended to that ticket as a second symptom rather than filed separately.

### Checked, no defect

- **Happy path and rule cases, run on the memory module:** typed NULL through a text, JSON and integer variable into differently typed columns; `coalesce` and concatenation over a NULL variable; NOT NULL variable rejected through a scalar subquery; inline CHECK on the new column enforced against the backfilled value, both pass and fail; new column named like a variable.
- **Gaps left by the implement handoff, now closed:**
  - Declarative `apply schema`: a nullable variable backfills NULL and a later supplied write stores its value. A NOT NULL variable fails with the ALTER error, wrapped in `Failed to execute DDL`.
  - Non-`main` schema: the error names `s.t`, the workaround works when followed, and an unqualified relation in a DEFAULT subquery resolves against the altered table's schema.
- **Later structural changes:** `alter column set default`, `drop column` and `rename column` after the ADD COLUMN all keep the context default working.
- **Scoping:** the generated-column arm and `buildAddColumnChecks` are untouched, as the ticket required. The doc note at `docs/sql-ddl.md` that a generated expression's bare name always means the column is still accurate.
- **Static type parity with INSERT:** the literal's logical type and nullability match the context attribute's for a nullable variable, so `buildCellCoercion` makes the same decision on both paths.
- **Docs:** `docs/sql-alter.md` and `docs/sql-ddl.md` §2.6.2 match observed behaviour. No other doc states a rule this change contradicts.
- **Tests:** Test 26's two cases both meet the bar, one reproducing the bug and one pinning "rejected regardless of rows" on a message the old error cannot satisfy. Nothing cut, nothing added.
- **Source hygiene:** `alter-table.ts` is 448 lines and `mutation-context.ts` 220 (`wc -l`, after the edits above), so neither needs splitting. Comments state constraints rather than narrate. The small duplication of the lower-cased name set across `insert.ts`, `mutation-context.ts` and this helper was left alone as not worth a shared abstraction over three one-line expressions.

### Empty categories

- **Tripwires:** none. Nothing found is conditional on future growth; the backfill compiles the expression once per ALTER.
- **Accepted-tradeoff notes:** none at these sites.
- **New tickets:** none. The one finding beyond this pass went to the existing blocked ticket.

### Not run

- The whole `yarn test:store` suite. The store leg ran `--grep "alter|46-mutation-context"`, 236 passing.
- Root `yarn test` across the other workspaces. The change is confined to the `packages/quereus` planner.
- Test 26 against the pre-change source. The ticket's measured reproduction is the same statement.
- A store reopen after this ALTER. The later write in Test 26 passing on the store leg shows the module's answer keeps the context declaration during the session; persistence across a reopen was not exercised for this path.
- `addColumnReadsRequiredContextError` on the store leg with a quoted name. The message is built in the planner, independent of the module.

### Validation

- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn workspace @quereus/quereus run test`: 10903 passing, 25 pending, 0 failing.
- `yarn test:store --grep "alter|46-mutation-context"` from `packages/quereus`: 236 passing.
