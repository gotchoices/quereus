---
description: The check that rejects a table definition containing a random or clock-reading function now looks in every part of the definition, including five less-common places it used to skip; a test fails to compile if the syntax tree gains a new place an expression can hide.
files:
  - packages/quereus/src/parser/visitor.ts           # traverseAst — five new arms, `upsert` arm, exhaustive switch, four helpers
  - packages/quereus/src/schema/expr-scope/walk.ts   # header NOTE: both traversals now have the same reach
  - packages/quereus/src/schema/manager.ts           # rejectIllegalReferences: nested DML counts as a subquery boundary (review fix)
  - packages/quereus/test/visitor.spec.ts            # per-field coverage ledger + one sentinel test
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # Test 8: returning + frame-bound cases
repro: verified
---

# Complete: `traverseAst` descends every expression-bearing field

## What landed

`traverseAst` (`src/parser/visitor.ts`), the generic walk behind four `CREATE TABLE`-time checks in `src/schema/manager.ts` (including the determinism gate on `CHECK` and `GENERATED ALWAYS AS`), used to skip window frame bound expressions, `SelectStmt.defaults`, and a DML statement's `returning`, upsert clauses and `with context` values. A `random()` in any of them was accepted at `CREATE TABLE`. All five are now descended (plus the parser-unused `SelectStmt.union`); `upsert` is entered as its own node.

Guards against recurrence:

- The `switch` in `traverseAst` is exhaustive over `AstNode['type']` (`default` assigns to `never`), so a new node kind does not compile until classified.
- `test/visitor.spec.ts` holds a per-field ledger, typed `Record<keyof Shape minus type/loc, Treatment>`, for every AST shape the traversal descends and each sub-structure that holds an expression. A new field fails `yarn lint` until classified. One test parses a `sentinel()` sample for every field marked `descend` and asserts the traversal reaches it. Against the pre-fix traversal it lists 19 unreached fields.
- `44-determinism-validation.sqllogic` Test 8 covers the end-to-end refusal for a `returning` list and a frame bound.

The implementer replaced the ticket's suggested test-side node-kind record with the exhaustive source `switch`. The review agrees: the compiler enforces the same thing at the place the change must be made.

## Review findings

Read the implement diff (`ticket(implement): bug-ast-traversal-misses-expression-subtrees`) before the handoff.

- **Correctness of the new arms**: checked each against `src/parser/ast.ts` (`UpsertClause`, `InsertStmt`, `UpdateStmt`, `DeleteStmt`, `WindowFrameBound`, `ResultColumnExpr`). All expression fields are reached, and the fields that cannot hold an expression are correctly classified. `walk.ts` was compared field by field (`defaults`, `inverse`, `union`, `returning`, `upsertClauses`, `contextValues`, frame bounds): the two now have the same reach, as both header NOTEs say.
- **Blast radius on the four `manager.ts` callers** (`rejectIllegalReferences`, `defaultEmbedsSubquery`, `defaultReferencesNewRow`, `findNonDeterministicCall`). The determinism gate is the intended beneficiary. `defaultEmbedsSubquery` and `defaultReferencesNewRow` can only change outcome for a DEFAULT holding a DML statement, and that DEFAULT is refused as non-deterministic either way. **Fixed inline:** `rejectIllegalReferences` counted only `select` / `subquery` / `exists` as subquery boundaries. As a result, a nested DML statement's newly reached `returning` columns were checked as bare sibling-column references, and `default (1 in (insert into ds values (5, 5) returning v))` failed with the misleading "may not reference a bare column" error. `insert` / `update` / `delete` are now boundaries too, because their clauses bind their own target table. I probed it: the shape is again refused with the non-deterministic DEFAULT error, and `default (y + 1)` is still refused as a bare column. No test was added because the shape is refused either way and only the message changed.
- **Pre-existing, not touched:** `default (1 in (select y))`, where `y` is a sibling column, is accepted at DDL time. This is by design per the comment at `rejectIllegalReferences` (columns inside a subquery are treated as the subquery's own) and predates this ticket. Not filed.
- **Tests**: the ledger test is a class-level guard and stays. **Cut** the four "DDL node types are handled without error" tests. They only asserted that `enterNode` sees a DDL root, which the control-flow tests already cover, and the exhaustive switch now rules out the unhandled-kind warning they used to guard. The control-flow tests (6) and the undefined-node test stay.
- **Ledger limits** (already documented in the `walk.ts` NOTE): it guards `traverseAst` only, and a field wrongly classified `noExpression` is a human error it cannot catch. Also, a `descend` sample proves the sentinel is reached somewhere, not that it was reached through the named field. Each sample is hand-written to place the sentinel only in that field. Recorded here only. It is a property of the test's design, not a defect.
- **Type safety / hygiene**: the `never` default keeps a runtime `warnLog` fallback. The helpers are small and single-purpose. Comments state why, not what. No `any` was added; the existing `eslint-disable` on the specific-visitor dispatch predates this change.
- **Docs**: `docs/` and the package README do not mention `traverseAst` or its reach. The only documentation is the two header NOTEs, and both are current. No other docs needed updating.
- **Performance / resource cleanup**: no new allocation beyond the walk itself. Nothing to clean up.
- **Related, separate**: `bug-unknown-function-not-caught-at-declaration` (an unresolvable function name skips the same gate) and backlog `debt-expression-scans-stop-at-untyped-container-nodes` (other hand-written scans). This ledger could serve as the model for the latter.

## Validation

- `yarn lint` (packages/quereus): clean, including the test-file type-check.
- `yarn test` (packages/quereus): 11170 passing, 0 failing, 26 pending. That is 11174 at the implement stage minus the 4 cut tests.
