description: A column default that names a sibling column through its own table name, such as `default (t.b)`, used to be accepted when the table was created or altered and then broke every insert that used it. It is now refused when the default is declared, with a message pointing at `new.<column>`.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/manager.ts  # rejectUnresolvableQualifiedDefaultRefs, declaresMutationContext, rejectIllegalReferences, validateOneDefault and the ALTER DEFAULT validators (now take TableSchema)
  - packages/quereus/src/schema/generated-column-refs.ts  # classifier reused unchanged
  - packages/quereus/src/planner/building/alter-table.ts  # ADD COLUMN call site
  - packages/quereus/src/runtime/emit/alter-table.ts  # SET DEFAULT call site
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 31
  - packages/quereus/test/logic/03.4-defaults.sqllogic  # t_corr case
  - docs/sql-ddl.md
  - docs/determinism.md
repro: verified
----

## What landed

At INSERT time a column DEFAULT can read only `new.<column>`, the table's mutation-context variables (bare `who` or `context.who`), and columns of a source that a FROM inside the DEFAULT selects from. The declaration-time gate used to miss qualified references on tables with a mutation context, and every qualified reference inside a subquery, so such defaults were stored and then failed every insert.

`validateOneDefault` (`packages/quereus/src/schema/manager.ts`) now runs a second pre-walk, `rejectUnresolvableQualifiedDefaultRefs`, which reuses the scope-aware classifier generated columns use (`collectGeneratedColumnRefs`). For each qualified column reference: `context.<declared variable>` is allowed (checked first, because on a table named `context` the classifier calls it an own-row reference); `new.<column>` is allowed; any other own-row spelling (`t.b`, `main.t.b`) is refused with a `may not reference 't.b'; use 'new.<column>' …` message; a qualifier nothing binds (`zz.x`, `old.b`, undeclared `context.x`) is refused with a `… which binds nothing` message; references bound by an inner FROM, or undecidable because an opaque source intervenes, are left for INSERT. `rejectIllegalReferences` now rejects only bare names. The DEFAULT validators take the owning `TableSchema`, so both ALTER call sites dropped their duplicated context-flag computation.

The implementer narrowed "`context.<name>` allowed on a context table" to declared variable names only. Confirmed: an undeclared `context.<name>` fails every insert, context variables cannot change after CREATE, and the check sits at the same site.

Tests: `46-mutation-context.sqllogic` Test 31 (own-row, schema-qualified own-row, unbound, undeclared `context.`, ALTER SET DEFAULT, and the table-named-`context` cases) and `03.4-defaults.sqllogic` `t_corr` (correlated subquery on a no-context table).

## Review findings

Read the `ticket(implement): bug-self-qualified-default-accepted-until-first-write` diff first, then the classifier (`generated-column-refs.ts`), the scope walk (`expr-scope/walk.ts`), and the INSERT-time DEFAULT scopes (`planner/building/insert.ts`, `default-scope.ts`, `constraint-builder.ts` `buildNotNullDefaults`).

- **Correctness — checked, no defects.** Confirmed no INSERT-time scope can resolve a qualifier the new gate refuses: the row-expansion, NOT NULL / REPLACE default, and shared-key view-write envelope scopes all expose the row only as `new.<col>` (plus bare names and context variables); statement CTEs are relation names, not column scopes. Ran a temporary probe (deleted) against source: `new.b`, `NEW.b`, `CONTEXT.Who` with `WHO` declared, bare `who`, `(select max(b2.k) from b2)` allocator, `new.b` inside a correlated subquery, and an aliased inner FROM all accept and produce the expected values; `old.b`, `context.x` on a no-context table, `r3.b` inside a derived-table subquery, `main.other.b`, `exists (… where a2.k = r8.b)`, and `ADD COLUMN … default (t.b)` on tables with and without context all refuse at declaration with the right message.
- **Nested DML inside a DEFAULT** (`(select … from (delete from t returning t.b))`) — the walk puts DML bodies behind an opaque frame, but `classifyQualified` returns `'own'` for the owning table name before consulting the opaque flag, so `t.b` there would be refused. Only reachable by a DEFAULT on `t` that writes to `t` itself; contrived, and the generated-column path has made the same call. No action.
- **Implementer's "quoted dot" gap — not real.** `originalQualifier` contains a dot whenever a schema is present, so it can never equal `new` or `context`; an unschema'd quoted `"new"` / `"context"` is the same identifier as the unquoted one. No action.
- **Implementer's other gaps** (bare unknown names on context tables still deferred to INSERT; references behind an opaque CTE / derived table / table-valued function still deferred; catalog reload skips the gate) — confirmed as described; all predate this ticket and are the documented conservative residual. No ticket: no current-release anchor beyond what the docs already state.
- **Docs — fixed.** `docs/determinism.md` § Validation Timing described the CREATE and ALTER DEFAULT pre-walks without the new qualified-reference gate; added it to both paragraphs. `docs/sql-ddl.md` changes read correctly.
- **Hygiene — fixed.** Reflowed an over-long line in the `rejectUnresolvableQualifiedDefaultRefs` doc comment; imported `ResolveColumnInSource` from `./rename/shared.js` (its source, as `table.ts` and `generated-column-refs.ts` do) instead of the `./rename-rewriter.js` re-export.
- **Types / DRY / modularity** — passing `TableSchema` instead of name + flag removed two duplicated context computations; the gate is a small module-level function; the classifier is reused, not copied. Nothing to change.
- **Performance / resources** — one extra AST walk per DEFAULT at DDL time only; nothing allocated beyond the reference list. Nothing to change.
- **Tests** — each Test 31 line and the `t_corr` case covers a distinct branch of the gate or a distinct call site; the `context`-named-table insert pins the "check `context.` before the binding" ordering. None restate the implementation; none cut, none added.
- **Validation** — `yarn workspace @quereus/quereus test`: 11187 passing, 23 pending (before the comment/import edits; the two affected logic files re-run green after). `yarn workspace @quereus/quereus lint`: clean after edits. `test:store` not run — the gate is engine-side, before any module call.
- **Tripwires / tickets filed** — none.
