---
description: The check that rejects a table definition containing a random or clock-reading function now looks in every part of the definition, including the five less-common places it used to skip; a test now fails to compile if the syntax tree gains a new place an expression can hide.
files:
  - packages/quereus/src/parser/visitor.ts           # traverseAst — five new arms, an `upsert` arm, exhaustive switch, four small helpers, rewritten header NOTE
  - packages/quereus/src/schema/expr-scope/walk.ts   # header NOTE only: the two traversals now have the same reach
  - packages/quereus/test/visitor.spec.ts            # field coverage ledger + one data-driven sentinel test; subsumed per-kind cases removed
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # Test 8: end-to-end returning + frame-bound cases
  - packages/quereus/src/schema/manager.ts           # the four traverseAst callers — unchanged, read for blast radius
repro: verified
---

# Review: `traverseAst` now descends every expression-bearing field

## What changed

`traverseAst` (`src/parser/visitor.ts`) is the generic "visit every node" helper. Four `CREATE TABLE`-time checks in `src/schema/manager.ts` walk with it, including the gate that refuses a non-deterministic function in a `CHECK` or `GENERATED ALWAYS AS` body. It used to skip five places, so `random()` hidden in any of them was accepted. It now descends all five:

- window frame bound expressions (`rows between <expr> preceding …`), through the new `traverseFrameBound` helper. A frame and its bounds are not `AstNode`s, so the bound's `value` is descended directly.
- `SelectStmt.defaults` (the trailing `with defaults (col = expr, …)`).
- `returning` on insert, update and delete, through the new `traverseResultColumns` helper, which the select-columns arm now shares (it includes `with inverse (…)`).
- an insert's `upsertClauses`. Each clause is now entered as a node (new `case 'upsert'`), which descends `assignments[].value` and `where`. **Callbacks now see `upsert` nodes in `enterNode`.** None of the four `manager.ts` callbacks reacts to that type.
- `contextValues` on insert, update and delete (`with context x = expr`).

`SelectStmt.union` is descended too. The parser never sets it (compound queries are stored on `compound`), but `walk.ts` and several planner readers handle it, and descending it costs one line.

Two other changes:

- **The `switch` in `traverseAst` is now exhaustive over `AstNode['type']`.** `default` assigns `node.type` to `never`, so adding a node kind fails to compile until someone gives it a case. The previously unlisted kinds (constraint kinds, window-frame kinds, the newer DDL and declare-schema statements) are now listed explicitly as "not descended", with a comment for each group. The runtime `warnLog` stays as a fallback for a malformed node.
- `traverseCteBodies` replaces four copies of the `withClause?.ctes.forEach(…)` line, and `traverseDmlOutputs` handles `returning` and `with context` for all three DML statements.

The header `NOTE:` in `visitor.ts` and in `walk.ts` now says the two traversals have the same reach and points at the ledger. The sentences that said this ticket owned the gap are gone.

## Deviation from the ticket: no node-kind ledger in the test

The ticket asked for a test-side `Record<AST.AstNode['type'], 'descend' | 'leaf' | 'not-traversed'>`. I made the source `switch` exhaustive instead (see above). That gives the same guarantee — a new node kind cannot land unclassified — at the place the change has to be made, and a test-side copy would only repeat what the compiler already enforces. If the reviewer wants the test-side record anyway, it is about 70 lines.

## The field ledger (`test/visitor.spec.ts`, `describe('field coverage ledger')`)

There is one record per AST shape that `traverseAst` descends or enters as a leaf, plus every sub-structure such a shape holds an expression through: `OrderByClause`, `WithClause`, `CommonTableExpr`, `ResultColumnExpr`, `ResultColumnInverse`, `ViewInsertDefault`, `ContextAssignment`, `CaseExprWhenThenClause`, the anonymous assignment elements of update and upsert, `SelectStmt['compound']`, `WindowFrame`, and the `WindowFrameBound` kinds. Each record goes through `ledger<T>(…)`, whose parameter type is `Record<keyof T minus type/loc, Treatment>`. As a result:

- a new field on any of these shapes fails `yarn lint`, which type-checks test files, until someone classifies it. I checked that both a missing field and a stale extra field are compile errors.
- `Treatment` is one of three things:
  - `{ descend: sample }`, where the sample is SQL, or a builder for `union`, which the parser never sets
  - `{ noExpression: reason }`
  - `{ notDescended: reason }`, used only for `SelectStmt.storedBodyEnv`. That is write-through lowering metadata which the parser never sets, so no schema-time caller can meet it.

**One test** (`reaches a sentinel placed in every field marked descend`) parses every `descend` sample, runs `traverseAst`, and asserts that a `function` node named `sentinel` was entered. If any are missed, it fails with the full list. Against the pre-fix `visitor.ts` it fails with exactly 19 entries: the five gaps, their sub-structure fields, and `union`. With the fix it passes. This is the reproduction at the lowest layer.

**Removed:** six `describe` blocks of per-kind cases (30 tests: CASE/IN/EXISTS/BETWEEN, CTE, inverse, INSERT/UPDATE/DELETE/VALUES, inline `targetSource`, JOIN/function/subquery sources, CAST/COLLATE/function/subquery/unary/leaf/clauses/UNION). The ledger subsumes all of them field by field, and the ticket permitted removing them. Kept: control flow (6), DDL entered without error (4), undefined node (1).

**Limit of the guard:** the ledger covers `traverseAst` only. `walk.ts` is not checked by it. Its NOTE tells the reader to check that walk by hand when the ledger forces a decision. A field classified `noExpression` that actually can hold an expression is a human error the ledger cannot catch.

## End-to-end test (`44-determinism-validation.sqllogic`, Test 8)

- `t_det_returning`: a `GENERATED ALWAYS AS` body with `random()` in an inner `insert … returning`. Expects `Non-deterministic expression not allowed in GENERATED ALWAYS AS`.
- `t_det_frame_bound`: a `CHECK` with `random()` in a window frame bound. Expects `… in CHECK`.

Both were accepted with the pre-fix traversal (I swapped the HEAD `visitor.ts` in temporarily: the file fails at line 175) and are refused now.

## Validation

- `yarn lint` (packages/quereus): clean, including the test-file type-check.
- `yarn test` (packages/quereus): **11174 passing, 0 failing, 26 pending**. The fix stage saw 11202 with the same arms. The difference is the 30 removed per-kind tests minus the one new ledger test, give or take fuzz variance.

## Blast radius: one finding the fix stage did not cover

`rejectIllegalReferences` (`manager.ts` ~2157) counts only `select` / `subquery` / `exists` as subquery boundaries, not `in`. So a DML statement under `x in (insert … returning …)` in a `DEFAULT` sits at depth 0, and its `returning` columns are now checked as bare sibling-column references. I probed this directly:

- `default (1 in (insert into ds values (5, 5) returning v))` was **refused before and after**. Before, it failed with "Non-deterministic expression not allowed in DEFAULT". Now it fails earlier with "may not reference a bare column".
- `… returning 1)` gets the same non-deterministic refusal before and after.

So no DDL is newly rejected. One shape gets a different, earlier error message. Not filed: a DML statement in a `DEFAULT` is refused either way.

## For the reviewer to weigh

- Whether `upsert` being entered as a node, rather than having its fields descended from the insert arm, is the right call. I chose the node because `UpsertClause` is an `AstNode` with its own `type`, the same as `join` and `subquerySource`.
- Whether the sub-structure ledgers (`OrderByClause`, assignment elements, `CaseExprWhenThenClause`, …) are worth their lines. They go beyond the ticket's list. The argument for them is that a new expression field on, say, `OrderByClause` would otherwise slip past the guard.
- `with defaults` is descended even though it is never evaluated inside a scalar subquery. That was the ticket's decision, and the arm has a comment explaining it.
- Related but separate: `bug-unknown-function-not-caught-at-declaration` (a function name the registry cannot resolve skips the same gate) and backlog `debt-expression-scans-stop-at-untyped-container-nodes` (other hand-written scans in `planner/mutation/decomposition.ts`). The ledger pattern here could serve as a model for the latter.
