description: DDL-time bind-param / column-ref validation for DEFAULT and CHECK expressions
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/46-mutation-context.sqllogic
  docs/runtime.md
----

## What was built

`SchemaManager` now rejects illegal references in DEFAULT and CHECK
expressions at `CREATE TABLE` time, before storage is touched. Previously
these errors either bubbled up much later (as opaque "column not found"
or runtime failures) or slipped through entirely.

Concrete changes in `packages/quereus/src/schema/manager.ts`:

- **New `rejectIllegalReferences(expr, options)` helper** (`manager.ts:936-964`)
  walks an AST via `traverseAst` and throws on the first `parameter`
  node, and optionally the first `column` node. Short-circuits on the
  first match. Single source of truth for both validators.
- **`validateDefaultDeterminism`** (`manager.ts:980-1046`) now takes a
  `hasMutationContext` parameter:
  - Always rejects `ParameterExpr` in DEFAULT
    ("may not reference bind parameters").
  - Rejects `ColumnExpr` in DEFAULT only when the table has no mutation
    context ("use a generated column instead").
  - Build-time errors (e.g. unresolved identifiers) now propagate as
    "DEFAULT for column '...' in table '...' is invalid: ..." when no
    mutation context exists. With mutation context the build error is
    swallowed (debug-logged); column-style identifiers may resolve to
    context vars at INSERT time and the row scope is not yet
    established at CREATE TABLE time.
- **`validateCheckConstraintDeterminism`** (`manager.ts:1056-1093`) adds
  a parameter-rejection pre-walk before the existing function-determinism
  walk. Error names the constraint and table.
- **`createTable`** (`manager.ts:1387-1389`) computes
  `hasMutationContext` from the built table schema and passes it
  through.

## Key files

- `packages/quereus/src/schema/manager.ts` — the validators and the
  `createTable` call site.
- `packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic` —
  `t_param` (bind param in DEFAULT) and `t_colref` (column ref in
  DEFAULT) reproductions, both rejected with specific messages.
- `packages/quereus/test/logic/40.2-check-extras.sqllogic` — `t_p`
  (positional `?`) and `t_p2` (named `:foo`) CHECK reproductions, both
  rejected with the bind-parameter message.
- `packages/quereus/test/logic/46-mutation-context.sqllogic` — exercises
  the design decision (DEFAULT referencing column + context var works
  when mutation context is declared).
- `docs/runtime.md` § "Validation Timing" — describes the new DDL-time
  guards and notes the ALTER coverage gap.

## Testing notes

- `yarn lint` (in `packages/quereus`) — clean.
- The four new negative cases (`t_param`, `t_colref`, `t_p`, `t_p2`) all
  fire at `create table`, with specific error messages naming the
  column/constraint and table.
- All positive cases in `03.4.1-default-edge-cases`, `40.2-check-extras`,
  and `46-mutation-context` continue to pass — verified by running each
  logic file individually.
- Full quereus test sweep: 2518 passing, 2 pending, 6 failing. The 6
  failures are pre-existing on `main` (5 in `Predicate normalizer`, 1 in
  `Extended constraint pushdown / OR predicates`) — verified by running
  the suite on a clean tree before any review changes; all are in
  optimizer code unrelated to schema/DDL validation.

## Design decision (settled)

The original ticket asked to reject `ColumnExpr` "anywhere" in DEFAULT,
but `46-mutation-context.sqllogic` Test 1 establishes a working pattern:
`final_price INTEGER DEFAULT base_price + markup` with
`WITH CONTEXT (markup INTEGER)` — `markup` and `base_price` are both
parsed as `column` AST nodes. The AST cannot tell a context variable
from a row-column reference; the distinction is made at INSERT time
when the row scope is established.

Banning `ColumnExpr` outright would break that feature and the test.
The implementer chose the defensible middle ground: ban column refs in
DEFAULT only when the table has no mutation context. This satisfies
both the `t_colref` reproduction and the mutation-context tests.

A potential future hardening — banning `ColumnExpr` in DEFAULT
unconditionally and introducing a dedicated context-variable AST node
so the parser/scope can distinguish the two — would require parser and
scope changes and is out of scope here.

## Out of scope / follow-ups

- The new validators run only from `createTable`. ALTER TABLE paths
  (`addColumn`, `addConstraint`, `alterColumn(setDefault)`) do not yet
  route through them. Documented in `docs/runtime.md` § "Validation
  Timing" as a known follow-up.
- The unconditional column-ref ban (with a dedicated context-var AST
  node) is plausible future work if/when the team wants to harden the
  rule beyond what mutation context allows today.
