description: A CHECK constraint added by ALTER TABLE that reads one of the table's per-statement context values fails with "column not found", even though the same CHECK is accepted in CREATE TABLE. The maintainer has decided that this validation should behave like a statement that supplied no context, so a nullable value reads as NULL and a required one is rejected with a clear error.
prereq: bug-check-facts-read-context-variable-as-column
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/constraint-builder.ts  # storedRowPredicate, validateChecksOverExistingRows: the shared existing-row scan
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # requalifyOwnRowRefsInSchemaExpression
  - packages/quereus/src/core/statement.ts  # _schemaPathOverride and its two _buildPlan calls (~:345, ~:1136)
  - packages/quereus/src/core/database.ts  # _buildProbeContext, _buildPlan
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnChecks; the DEFAULT arm of buildAddColumnBackfill is the pattern
  - packages/quereus/src/planner/building/mutation-context.ts  # registerNoEnvelopeContextSymbols
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # add Test 27
  - docs/sql-alter.md  # ADD COLUMN restrictions, ADD CONSTRAINT
  - docs/sql-ddl.md  # §2.6.2
repro: verified
----

## Decided rule

Accepted by the maintainer on 2026-11-04. Add this text to `docs/sql-alter.md`, under the ADD CONSTRAINT and ADD COLUMN inline-constraint validation text:

> Existing-row validation of a CHECK runs as a statement that supplied no `with context` envelope (§2.6.2 of sql-ddl.md). A context variable declared NULL reads as NULL, so a comparison against it is unknown and the row passes, as for any NULL comparison. A CHECK that reads a NOT NULL context variable is rejected — whether or not the table has rows — because ALTER cannot supply a value; declare such a CHECK in `CREATE TABLE`, or declare the variable NULL and write the CHECK to tolerate its absence.

Skipping validation for these CHECKs was rejected, because the optimizer relies on the validated part being true of stored rows. Allowing `with context` on `alter` is a separate follow-up, `feat-alter-accepts-with-context`, and stays out of this ticket.

## Reproduction

Measured on the `dist` build of the current tree, memory module, each with one existing row:

| Statement | Table declares | Today | Required |
|---|---|---|---|
| `alter table t add constraint k check (who is null or a > 0)` | `who integer null` | `Column not found: who` | accepted |
| `alter table t add constraint k check (context.who > 0)` | `who integer null` | `context.who isn't a column` | accepted |
| `alter table t add constraint k check (who is null or exists (select 1 from d where k = who))` | `who integer null` | `Column not found: who` | accepted |
| `alter table t add constraint k check (who > 0)`, with or without rows | `who integer` | `Column not found: who` | rejected, new error |
| `alter table t add column c integer null default 1 check (who is null or c > 0)` | `who integer null` | `Column not found: who` | accepted |
| `alter table t add column c integer null default (new.b) check (who is null or c > 0)` | `who integer null` | `Column not found: who` | accepted |
| `alter table t add constraint k check (who > 0)`, column `who` holding -1 | column and variable `who` | rejected: existing rows violate | accepted |
| `alter table t add column c integer null default 1 check (who > 0)`, same row | column and variable `who` | rejected: backfilled rows violate | accepted |
| `alter table t add column c integer null default (new.who) check (who > 0)`, same row | column and variable `who` | `CHECK constraint failed` | accepted |

The last three are the second symptom. ALTER reads the bare `who` as the column, while every write reads it as the variable.

## Two sites

**Per-row ADD COLUMN (`buildAddColumnChecks`).** This is compiled in a scope the planner builds, so it takes the same layering as the DEFAULT arm of `buildAddColumnBackfill`: a parent `RegisteredScope` filled by `registerNoEnvelopeContextSymbols`, with its returned shadow set passed to `buildRowDefaultScope`.

**The existing-row scan (`validateChecksOverExistingRows`).** ADD CONSTRAINT and literal-DEFAULT ADD COLUMN both end here. It prepares SQL text as its own statement, so it has no scope to pass and needs two changes. Both apply only when `tableSchema.mutationContext` is non-empty, so the scan's SQL is unchanged for every other table, and maintained tables, which cannot declare context, are unaffected.

1. **Variables enter through a seam at the statement's root scope.** Beside `_schemaPathOverride`, add a `Statement` field the scan sets that wraps the root scope in a `RegisteredScope` filled by `registerNoEnvelopeContextSymbols`, passed through `_buildPlan` and `_buildProbeContext`. Resolving through scopes rather than rewriting the AST leaves capture correct at every depth: a bare `who` inside a subquery still binds to that subquery's own source when it has that column, and to the variable otherwise. As with `_schemaPathOverride`, keep one spelling of this, inside the scan.
2. **Shadowed columns are hidden from bare lookup.** A FROM source would otherwise win over the root scope. When a column shares a name with a variable, scan a derived source that exposes it only under an internal name:

   ```sql
   select 1 from (select a, who as "__quereus_shadowed_who" from main.t) as "__quereus_stored_row__"
   where not (who > 0) limit 1
   ```

   The own-row requalification (`new.who`, `t.who`) must also rewrite the column name to the internal one, so `requalifyOwnRowRefsInSchemaExpression` gains an optional name mapping. With the column gone from the source, the bare name falls through to the variable, and `new.who` still reaches the column.

### Prototype results

A throwaway script against `dist`, wrapping `_buildProbeContext` from outside and running hand-written scan SQL, gave these results. This is evidence for the mechanism, and no repository code was changed.

| Case | Result |
|---|---|
| NULL variable, `who is null or a > 0` | passes |
| NULL variable, `who is not null or a > 0`, row with `a = -1` | violation: the part with no variable is still checked |
| `context.who > 0` | passes |
| NOT NULL variable read, with and without rows | raises the supplied error |
| NOT NULL variable declared but not read | passes |
| Subquery reads the variable | passes |
| Subquery source has its own `who` column | binds to the subquery's column |
| Derived source: bare `who` over a shadowed column | variable: passes |
| Derived source: internal name, standing in for `new.who` | column: violation |
| Derived source: column declared `collate nocase` | declared collation preserved |

A `QuereusError` from the reference callback passes through `statement.ts:410` unwrapped. A plain `Error` gets a `Planning error:` prefix.

## Details to get right

- **Error.** Add one `QuereusError` factory for both sites with `StatusCode.ERROR`, naming the table and variable and giving the rule's two workarounds. The scan raises it from inside the module-agnostic validator; on the literal-DEFAULT path that runs inside `runAddColumn`'s `try`, so the existing revert applies.
- **Import direction.** `schema/constraint-builder.ts` already imports from `planner/`, but `mutation-context.ts` pulls in `buildExpression`. If this creates an import cycle, have the factory for the root-scope wrapper live on the planner side and hand it in.
- **Table literally named `context`.** `requalifyOwnRowRef` treats `context.who` as a self-qualified own-row reference. Writes resolve it to the variable. Leave the reference alone when the name is a declared variable. This comes from reading the code and was not measured.
- **New column named like a variable.** `add column who integer default 1 check (who > 0)` must read the variable on both paths. `columnOnlySchema` already holds the new column, so the derived source hides it, and `buildAddColumnChecks` must include it in the columns it shadows.
- **CHECKs the scan does not validate stay accepted, including with a NOT NULL variable.** That covers a partial operation mask (`check on update (who > 0)`), a conjunct containing `old.` (`check (old.a is null or who > 0)`), a module declaring `permitsGrandfatheredCheckViolators`, and a failed `apply schema`'s unwind. The first two were measured as accepted today. The rule's text is about existing-row validation, and these owe stored rows nothing, so rejecting them would refuse legal schemas with no soundness benefit. A mixed `check (old.a > 0 and who > 0)` keeps the `who` conjunct, so it is rejected.
- **Validated is no longer exactly what is lifted.** After the prereq, a conjunct reading a variable is validated but not lifted, which is the safe direction. Update the claims in `storedRowPredicate`'s doc comment, the `isRowInvariantCheck` doc comment, and the ADD CONSTRAINT paragraph of `docs/sql-alter.md`.

## TODO

- Add the NOT NULL error factory beside `registerNoEnvelopeContextSymbols`.
- Wire `buildAddColumnChecks` with the no-envelope scope and shadow set.
- Add the root-scope seam to `Statement`, `_buildPlan` and `_buildProbeContext`, covering both `_buildPlan` calls in `statement.ts`.
- Teach `validateChecksOverExistingRows` and `storedRowPredicate` the seam, the derived source and the name mapping, including the `context`-named table guard.
- Add Test 27 to `46-mutation-context.sqllogic`, which also runs on the store leg: the table above; `who is not null or a > 0` rejecting a row with `a = -1`; a NOT NULL read rejected on an empty table with the new message, and the table unchanged afterwards; the accepted CHECK enforced by a later write that supplies the variable; `check on update (who > 0)` over a NOT NULL variable still accepted.
- Add the rule text to `docs/sql-alter.md`, with one sentence saying CHECKs the scan skips are not rejected, and a bullet to `docs/sql-ddl.md` §2.6.2 next to the ADD COLUMN backfill one. Correct "exactly what the scan validates is what the optimizer lifts".
- Run `yarn workspace @quereus/quereus run lint`, `yarn workspace @quereus/quereus run test`, and `yarn test:store --grep "alter|46-mutation-context"` from `packages/quereus`.
