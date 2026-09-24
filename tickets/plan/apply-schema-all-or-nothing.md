description: When `apply schema` fails partway through its migration, the changes it already made stay in place — so changing a constraint's rule can leave the table with no constraint at all. A failed apply should leave the schema exactly as it was.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema — runs the migration plan step by step; its doc comment states there is no catalog rollback
  - packages/quereus/src/schema/schema-differ.ts              # generateMigrationPlan — emits DROP CONSTRAINT then ADD CONSTRAINT for a changed constraint body
  - packages/quereus/src/vtab/module.ts                       # beginSchemaBatch / endSchemaBatch — the existing per-module hook that already discards a module's substrate work on a failed apply
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts      # apply is deliberately exempt from statement-scoped schema events because partial applies are real today
  - docs/sql-alter.md                                          # § after line 142 — documents the non-atomic DROP + ADD
  - docs/schema-rename-detection.md                            # line ~23 — "apply aborts + data survives, not old constraint restored"
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts  # pins today's partially-applied-migration event behaviour
----
# A failed `apply schema` should leave the schema as it was

## What happens today

`apply schema` computes a migration plan (an ordered list of DDL statements) and runs it one statement at a time. If statement N fails, statements 1 to N-1 stay applied, and nothing restores the catalog. The code documents this deliberately: see the doc comment on `emitApplySchema`.

Changing a constraint's body shows it most clearly. The engine has no "redefine constraint" statement, so the differ emits `drop constraint c` then `add constraint c …`. Since `bug-add-check-constraint-skips-existing-rows` landed, a CHECK re-add validates the existing rows. Tightening `check (v > 0)` to `check (v > 10)` against a row where `v = 5` fails on the ADD, after the DROP has already run. The table is left with **no** CHECK, even though it had one before and the user asked for a stricter one. UNIQUE and FOREIGN KEY re-adds behave the same way. The docs call this "apply aborts + data survives, not old constraint restored" (`docs/schema-rename-detection.md`, `docs/sql-alter.md`).

It matters beyond constraints. The optimizer treats a declared CHECK as a fact about every row, and applications re-run `apply schema` at startup expecting it to converge or fail cleanly. A half-applied migration is a schema nobody declared.

## What is wanted

`apply schema` is all-or-nothing from the caller's point of view:

- If any migration statement fails, the catalog (tables, columns, constraints, indexes, views, assertions, tags, lens deployments) is left exactly as it was before the apply, and the original error is rethrown.
- Module-held state is rolled back too. The `beginSchemaBatch` / `endSchemaBatch(error)` hooks already let a module discard its substrate work. The engine-side catalog needs the matching half.
- Row data is never changed by a failed apply. That holds today, and it must keep holding.
- `diff schema` output is unchanged. This is about executing the plan, not about what the plan contains.

## Design questions for the plan stage

The plan stage settles these. They are mechanism choices, not product questions:

- **Whole-apply rollback, or reorder so failures come first.** A narrower fix validates each re-added constraint against existing rows *before* running the matching DROP, so the known failing step fails while nothing has changed. That closes the constraint case cheaply but leaves other mid-plan failures (a module refusing an ALTER, a view body that no longer binds) non-atomic. Prefer the whole-apply guarantee if it is feasible. If it is not feasible for some statement class, say which one and why, and document that residual in the docs.
- **Modules whose DDL is not transactional.** Modules declare `getCapabilities().ddlTransactionality` (`transactional` / `non-transactional` / `auto-commit`). Decide what the guarantee means when a migration touches a module that cannot undo its DDL: refuse up front, compensate, or document a weaker guarantee for that tier.
- **Explicit transactions.** Today an apply inside `begin … commit` can fail partway and the user may still commit. Decide whether a failed apply inside an explicit transaction restores to the pre-apply point (savepoint-like) and leaves the outer transaction open.

## Interactions

- `debt-ddl-event-scope-kept-by-convention` (backlog): apply is exempt from statement-scoped schema events *because* partial applies are real. If apply becomes atomic, the exemption goes away. A failed apply should then announce nothing, and `ddl-schema-event-atomicity.spec.ts`'s partially-applied case changes meaning. Update both together.
- `feat-apply-schema-persisted-catalog-fingerprint` (backlog) wants a record written atomically with the apply. An atomic apply is the ground it would stand on.

## Tests the result must pass

- Constraint tightening, for each of CHECK, UNIQUE and FK, against a violating row: the apply fails with `CONSTRAINT`, and the old constraint is still present and still enforced afterwards. Run on the memory backend and the store backend.
- A multi-step migration (add table, add column, then a failing step): afterwards the catalog compares equal to its pre-apply snapshot, and a re-diff produces the original plan.
- The same cases inside an explicit transaction, with whatever behaviour the plan settles on.
- The existing convergence tests in `declarative-equivalence.spec.ts` still pass.
