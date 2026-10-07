description: Adding a column whose default reads one of the table's declared per-statement context values fails with a misleading "column not found" error; the ALTER should behave like any other statement that supplied no context — a nullable value reads as NULL, and a required one is rejected with an error that explains the situation and the workaround.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnBackfill (~:273-340) — the expression-DEFAULT arm builds its row scope with no context symbols
  - packages/quereus/src/planner/building/mutation-context.ts  # registerMutationContextSymbols / missingContextValueError — add the no-envelope sibling here
  - packages/quereus/src/planner/building/default-scope.ts  # buildRowDefaultScope — already takes the optional shadow-name set
  - packages/quereus/src/planner/building/insert.ts  # buildExpressionDefaultProjection (~:190-230) — the INSERT DEFAULT scope this mirrors
  - packages/quereus/src/planner/nodes/scalar.ts  # LiteralNode(scope, expr, explicitType)
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # add the test here
  - docs/sql-alter.md  # ADD COLUMN restrictions (~:59-72)
  - docs/sql-ddl.md  # §2.6.2 "Which variables a statement must supply" (~:505-515)
repro: verified
----

# `alter table … add column … default (<context variable>)` reports the variable as an unknown column

Filed from the lamina board (lamina slug `bug-add-column-default-cannot-reference-mutation-context`). Measured on published `@quereus/quereus` 4.20.2 with a plain `Database`, no Lamina involved:

```sql
create table t (a integer primary key) with context (who integer null);
insert into t values (1);
alter table t add column c integer null default (who);
-- Error: Column not found: who        (same on an empty table, and for `who integer` NOT NULL)
```

The same DEFAULT is accepted by `create table t (…, c integer null default (who)) with context (who integer null)` and by `alter table t alter column c set default (who)`.

## Cause

`buildAddColumnBackfill` compiles a non-foldable DEFAULT once per existing row so it can fill the new column. Its scope (`buildRowDefaultScope(ctx.scope, tableSchema.columns, rowAttrs)`) holds only the table's existing columns. Nothing registers the table's declared context variables, so a name that is only a context variable falls through to the generic unknown-column error. INSERT's DEFAULT scope registers them (`registerMutationContextSymbols` in the parent scope, plus the shadow-name set passed to `buildRowDefaultScope`); the backfill never did.

## Behaviour to implement

`ALTER TABLE … ADD COLUMN` is treated as a statement that **supplied no `with context` envelope**, and the existing per-variable rule in `docs/sql-ddl.md` §2.6.2 applies at the point a variable is read:

- **Variable declared NULL** → reads as NULL. Existing rows are backfilled with whatever the DEFAULT evaluates to with that variable NULL (`default (who)` → NULL, `default (coalesce(who, 0))` → 0). Later INSERTs that supply `who` get its value, as today. If the new column is NOT NULL and the backfill yields NULL for some existing row, the existing post-backfill rule rejects and reverts the ALTER; on an empty table the ALTER is accepted.
- **Variable declared NOT NULL** → the read is an error, raised at plan time, **whether or not the table has rows**. This follows the precedent that ADD COLUMN rejects an unconvertible literal DEFAULT "whether or not the table has any rows" (`docs/sql-alter.md`), and the build runs at plan time where the row count is unknown anyway. The message must not reuse `missingContextValueError`'s advice (`supply it with \`with context …\``) — ALTER has no such clause. Wording (adjust punctuation to taste, keep the content):

  `cannot add column '<col>' to '<schema>.<table>': its DEFAULT reads mutation context variable '<var>', which is NOT NULL, and ALTER TABLE supplies no context to fill existing rows; add the column with a literal DEFAULT or none, then set this default with \`alter table <table> alter column <col> set default (…)\``

  `StatusCode.ERROR`, same as the INSERT-side missing-variable error.
- **A declared variable the DEFAULT does not read** never matters, NOT NULL or not — the error is raised from the symbol's reference callback, never at registration (same reason as INSERT: a table may declare variables a given expression never reads).
- **Shadowing matches INSERT.** A bare name that is both a column and a context variable resolves to the variable (NULL, or the error above); `new.<col>` still reaches the column. Today's backfill resolves such a bare name to the column, which disagrees with what every later INSERT computes from the same DEFAULT — the spec's last §2.6.2 paragraph already says the variable wins "including when the statement supplies no envelope".
- `context.<var>` resolves identically to the bare `<var>`.

Rejected alternative: accept a NOT NULL-variable DEFAULT and backfill existing rows with NULL. That silently reads a NOT NULL variable as NULL, contradicting §2.6.2's per-variable rule. Rejecting is also the reversible choice — loosening it later turns an error into acceptance without changing any accepted program.

## Design constraints

- **Add the no-envelope registration to `mutation-context.ts`**, next to `registerMutationContextSymbols`, not inline in `alter-table.ts`. Suggested shape: `registerNoEnvelopeContextSymbols(scope: RegisteredScope, tableSchema: TableSchema, missingNotNull: (contextVar: MutationContextDefinition, tableLabel: string) => QuereusError): ReadonlySet<string>`, returning the lower-cased names for `buildRowDefaultScope`'s `mutationContextVarNames` argument. Take the error factory as a parameter so the ALTER-specific message lives in `alter-table.ts` and the helper stays reusable by the CHECK-side follow-up (`bug-alter-check-validation-cannot-reference-mutation-context`, `tickets/blocked/`). Factor the "register `<name>` and `context.<name>` to one callback" loop so both registration functions share it rather than duplicating it.
- **A nullable variable resolves to a `LiteralNode` holding NULL with an explicit type** — `{ typeClass: 'scalar', logicalType: contextVar.logicalType, nullable: true, isReadOnly: true }` — so the expression's static type (and therefore `buildCellCoercion`'s decision) is the same as on the INSERT path. Do NOT use `buildMutationContextAttributes` + `registerMutationContextSymbols` here: those emit `ColumnReferenceNode`s that read a runtime context row, and the backfill emitter installs no context row. Do NOT add a context row to the backfill's `rowDescriptor`/emitter to make that work — a constant NULL needs no runtime slot.
- **Layer the scopes like INSERT does:** a `RegisteredScope` over `ctx.scope` carrying the context symbols, then `buildRowDefaultScope(contextScope, tableSchema.columns, rowAttrs, contextVarNames)`. Keep the existing `schemaAuthoredContext` wrapper and the `validateDeterministicDefault` call unchanged.
- **Touch only the expression-DEFAULT arm.** The generated-column arm (`buildGeneratedColumnExpr`) keeps "a bare name always means the column" — deliberate, `docs/sql-ddl.md` ~:385. `buildAddColumnChecks` (inline CHECK on the new column) has the same gap but an unsettled spec question; it is the separate blocked ticket named above — leave it alone here.
- Read the declarations from the same `tableReference.tableSchema` the backfill already uses; no new catalog lookup.

## Edge cases & interactions

- Table declares no context → the helper registers nothing and returns an empty set; behaviour identical to today. *Inspection.*
- Nullable variable, non-empty table, nullable column → accepted, existing rows NULL, later `insert … with context who = 7` stores 7. *Test.*
- NOT NULL variable read by the DEFAULT, **empty** table → rejected with the new message (pins "regardless of rows" and the message). *Test.*
- NOT NULL variable declared but not read (`default (new.a + 1)` on a table with `with context (who integer)`) → accepted. *Inspection* (reference-time throw).
- NOT NULL new column + nullable-variable DEFAULT, non-empty table → existing post-backfill NULL rejection and revert; empty table → accepted. *Inspection* — already-tested rule.
- Column and variable sharing a name → bare name is the variable, `new.<name>` the column. *Inspection* (shadow set passed to `buildRowDefaultScope`).
- Case-insensitive match (`default (WHO)`), `context.who` qualified form. *Inspection* (lower-cased keys, same as INSERT).
- Literal-folding DEFAULT short-circuit (`tryFoldLiteral`) runs before any of this; `default (who)` is not a literal, so it takes the per-row path. *Inspection.*
- Inline CHECK on the same ADD COLUMN that reads a context variable still fails as today — out of scope, tracked by the blocked ticket. *None.*
- Store module: the logic test runs under `yarn test:store` too; the change is planner-only, so both legs must agree. *Test (same file, store leg).*
- Modules advertising `delegatesNotNullBackfill` (Lamina) receive the same backfill node as before, now buildable; no module contract change. *Inspection.*

## Test

One block in `packages/quereus/test/logic/46-mutation-context.sqllogic`, two cases:

```sql
create table AcCtx (a integer primary key) with context (who integer null);
insert into AcCtx values (1);
alter table AcCtx add column c integer null default (who);
insert into AcCtx (a) values (2) with context who = 7;
select a, c from AcCtx order by a;
→ [{"a":1,"c":null},{"a":2,"c":7}]

create table AcCtxReq (a integer primary key) with context (who integer);
alter table AcCtxReq add column c integer null default (who);
-- error: ALTER TABLE supplies no context
```

(Use whatever substring of the final message the harness matches on; keep it specific to the new error so the old `Column not found` cannot satisfy it.)

## TODO

- Add the no-envelope registration helper to `mutation-context.ts`, sharing the two-name registration loop with `registerMutationContextSymbols`.
- Use it in `buildAddColumnBackfill`'s expression-DEFAULT arm with the ALTER-specific error factory; pass the returned names to `buildRowDefaultScope`.
- Add the two-case block to `46-mutation-context.sqllogic`; run `yarn test` (memory) and `yarn test:store` for that file.
- `docs/sql-alter.md` ADD COLUMN restrictions: one bullet stating that an expression DEFAULT may read the table's mutation-context variables, ADD COLUMN supplies no envelope, a NULL-declared variable reads NULL during backfill, a NOT NULL one is rejected (regardless of rows) with the workaround.
- `docs/sql-ddl.md` §2.6.2 "Which variables a statement must supply": one bullet noting `ALTER TABLE … ADD COLUMN`'s DEFAULT backfill is a statement with no envelope and pointing at `sql-alter.md`. Leave the generated-column bullet (~:385) as is.
- `yarn lint` (packages/quereus: eslint + test-file type pass).
