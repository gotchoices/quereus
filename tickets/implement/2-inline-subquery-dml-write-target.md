description: Make a parenthesized subquery a real inline DML write target — `update (select …) as v set …` and `delete from (select …) as v where …` parse and route the subquery body through the view-mutation substrate, reusing the ephemeral view-like routing from cte-name-dml-write-target. Grammar + AST + stringify change for UPDATE/DELETE; inline-subquery INSERT (`insert into (select …)`) is deliberately rejected in v1.
prereq: cte-name-dml-write-target
files:
  - packages/quereus/src/parser/parser.ts                           # updateStatement ~2295 / deleteStatement ~2354 — accept a leading `(` subquery target + mandatory alias
  - packages/quereus/src/parser/ast.ts                              # UpdateStmt ~243 / DeleteStmt ~264 — add `targetSource?: SubquerySource`; `alias?` already exists
  - packages/quereus/src/planner/building/update.ts                 # route a targetSource through buildViewMutation via the ephemeral view-like
  - packages/quereus/src/planner/building/delete.ts                 # same
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # resolver helper from cte-name ticket — extend to build an ephemeral view-like from a SubquerySource
  - packages/quereus/src/emit/ast-stringify.ts                      # updateToString ~853 / deleteToString ~900 — render a subquery target
  - docs/view-updateability.md                                      # L81, L670 — make the inline-subquery prose true
  - packages/quereus/test/emit/ast-stringify.spec.ts                # round-trip a subquery DML target
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # inline-subquery write-through law block
difficulty: hard
----

# Inline subquery as a DML write target

## What this delivers

```
update (select id, color from base) as v set color = 'x' where v.id = 1
delete from (select id, color from base) as v where v.id = 1
```

parse, plan, and write through to `base` — identically to the equivalent named
view or CTE target. Per docs/view-updateability.md L670, a subquery in `from` is
structurally identical to an inlined CTE, so the routing is the same; this ticket
adds the **grammar + AST + stringify** to reach it, then reuses the ephemeral
view-like routing built by `cte-name-dml-write-target` (its prereq).

## Scope decision (settled): UPDATE/DELETE only; inline-subquery INSERT rejected

`update`/`delete` take a single target with a natural `as v` alias and a `where`
that references view columns via `v.col` — the inline subquery fits cleanly.

`insert into (select …)` is **not admitted in v1.** An INSERT target needs a
column-list mapping, not an aliased relation, and SQLite has no such form; the
CTE-name INSERT (`insert into t …`, delivered by the prereq) already covers the
"insert through a derived relation" use case. The INSERT grammar is left
unchanged, so `insert into (` naturally fails at parse with the existing "Expected
table name" error. Document this boundary in docs/view-updateability.md; do not
add an INSERT branch. (If a future need arises, file a backlog ticket — out of
scope here.)

## Design

### AST

`UpdateStmt` / `DeleteStmt` keep `table: IdentifierExpr` for the ordinary
named-target case (pervasively read as `stmt.table.name` / `.schema`). Add a
parallel optional carrier for the inline subquery rather than widening `table` to
a union (which would churn every call site):

```ts
export interface UpdateStmt extends AstNode {
  // … existing …
  /** Inline parenthesized subquery target: `update (select …) as v set …`.
   *  Mutually exclusive with a named `table`. Its `alias` is the mandatory
   *  correlation name; `columns` carries an optional `as v(a,b)` list. */
  targetSource?: SubquerySource;
}
// same on DeleteStmt
```

When `targetSource` is set, the existing `alias?` field carries the subquery's
correlation name (it already round-trips via stringify's `if (stmt.alias)` branch)
and `table` is a synthetic placeholder identifier equal to the alias (so the few
generic `stmt.table.name` reads — diagnostics, the committed-schema guard — stay
total). Decide and document one convention; the cleanest is: `table = { type:
'identifier', name: alias }`, `alias = <subquery alias>`, `targetSource = the
SubquerySource`.

### Grammar

In `updateStatement` (parser.ts ~2295) and `deleteStatement` (~2354), before
`tableIdentifier()`:

- If the next token is `(` and the token after it is `SELECT` / `VALUES` /
  `WITH` / `INSERT` / `UPDATE` / `DELETE` (the same lookahead `tableSource` uses
  at ~991 for a FROM subquery), parse the target via the existing
  `subquerySource(startToken, withClause)` (parser.ts ~1026). That production
  already requires-RETURNING on a DML body, parses the `as v` / `v` / `v(a,b)`
  alias, and synthesizes a default alias when omitted.
- **Mandate the alias for a write target.** `subquerySource` *synthesizes* a
  default alias (`subquery_<offset>`) when none is written; for a DML target the
  alias is mandatory and user-meaningful (the `where`/`set` reference it). After
  parsing, reject if the user did not write an explicit alias — track this
  (e.g. add a `subquerySourceRequiringAlias` wrapper, or check that an `AS`/bare
  alias token was actually consumed). Do **not** silently accept a generated
  alias: `update (select …) set …` with no `as v` must error clearly
  ("a subquery UPDATE/DELETE target requires an alias: `(select …) as v`").
- Set `targetSource`, `alias`, and the placeholder `table` on the resulting stmt.
- A non-`(` target falls through to the unchanged `tableIdentifier()` path.

Note `deleteStatement` consumes an optional leading `FROM` (~2355) — the `(`
check must come after that match (so `delete from (select …) as v` works).

### Routing

Extend the prereq's resolver so the builders, when `stmt.targetSource` is set,
build an ephemeral `MutableViewLike` directly from the subquery:

```ts
{
  name: stmt.alias!,                                   // the user's `v`
  schemaName: ctx.schemaManager.getCurrentSchemaName(),
  selectAst: stmt.targetSource.subquery,               // the parenthesized body
  columns: stmt.targetSource.columns,                  // `as v(a,b)` list, if any
  ephemeral: true,
  noun: 'derived table',
}
```

and `return buildViewMutation(ctxWithCtes, viewLike, { op, stmt })`. This sits
alongside the CTE-target check; precedence does not matter (a statement has either
a `targetSource` or a named `table`, never both). The user's `where`/`set`
reference view columns by the alias (`v.id`) — the substrate's view-column descend
(`makeViewColumnDescend` in single-source.ts) handles the alias-qualified form the
same way it does for a named view's columns.

### Stringify

`updateToString` (~853) / `deleteToString` (~900): when `stmt.targetSource` is set,
render `(<subqueryToString>) as <alias>[(cols)]` in place of
`expressionToString(stmt.table)`. The existing `if (stmt.alias) parts.push('as',
…)` branch must NOT also fire (it would double-emit the alias) — fold the alias
into the targetSource rendering and skip the standalone alias push when
`targetSource` is present. Reuse the existing `subquerySource` / FROM-subquery
stringify path for the body so a nested DML/RETURNING body round-trips.

## Edge cases & interactions

- **Missing alias** → clear parse error (above). Test `update (select …) set …`
  and `delete from (select …) where …` both reject.
- **`v.col` qualifier resolution** in `set` / `where` — the substrate must bind
  `v.id` to the subquery body's `id` column. Test an update whose WHERE filters on
  `v.<col>` and whose SET assigns `v.<col>` (and the bare `col` form too).
- **`as v(a,b)` column rename list** — the renamed names are what `set`/`where`
  reference; the body's own projection names are hidden. Test a write through a
  renamed column list maps to the right base column.
- **Non-updatable inline body** (aggregate / DISTINCT / LIMIT / recursive via an
  inner `with recursive`) → the same structured `analyzeView` reject as the
  equivalent view/CTE, reached from the subquery target. Reject-parity test
  against the named-view diagnostic `reason`.
- **Join-bodied inline target** (`update (select … from a join b on …) as v set
  v.col = …`) — the multi-source substrate path; per L670 this "works without
  special-casing." One positive correctness test on a key-preserving join.
- **Halloween / self-reference** — `update (select id,color from base) as v set
  color='x' where v.id in (select id from base)`. The inner `from base` and the
  target both touch `base`; the substrate's eager-capture discipline must hold,
  same as the CTE-target ticket. Test.
- **DML body as target** (`update (insert into … returning …) as v …`) —
  `subquerySource` permits a RETURNING DML body in a FROM position, but it is not a
  meaningful *write* target. Reject it with a structured diagnostic (a DML-bodied
  inline target is not updatable) rather than attempting to lower it; the body must
  be a SELECT/VALUES-shaped relation. Decide the reason (`unsupported-body` /
  `no-base-lineage`) and test.
- **`with t as (…) update (select … from t) as v …`** — a leading WITH plus an
  inline subquery target that reads a CTE. The CTEs must be in scope when the
  subquery body is processed (ctxWithCtes from the prereq). Confirm composition;
  if the substrate cannot resolve `t` inside the inline body in v1, document the
  boundary (same multi-level boundary as the CTE-body-references-CTE case).
- **`emit-roundtrip` property nets** — extend the emit round-trip corpus so a
  subquery UPDATE/DELETE target survives parse → stringify → re-parse unchanged
  (ast-stringify.spec.ts plus the property net at emit-roundtrip-property.spec.ts
  if it enumerates statement shapes).
- **`delete from (select …)` with the optional `FROM`** — the grammar's `(`
  detection must run after the optional `FROM` match; also confirm `delete (select
  …) as v` (no FROM) still parses, matching the existing optional-FROM behavior.

## Tests (TDD targets)

- `93.4-view-mutation.sqllogic`: an inline-subquery write-through block — `update
  (select …) as v set …` and `delete from (select …) as v where …` produce the
  same base state as the equivalent view/CTE.
- `ast-stringify.spec.ts`: round-trip a subquery UPDATE target and a subquery
  DELETE target (with and without the `as v(cols)` rename list).
- Reject cases: missing alias, non-updatable body (reason parity with the view),
  inline-subquery INSERT (`insert into (select …)` → "Expected table name").

## TODO

### Phase 1 — AST + grammar
- [ ] Add `targetSource?: SubquerySource` to `UpdateStmt` and `DeleteStmt`.
- [ ] `updateStatement` / `deleteStatement`: detect a leading `(`-subquery target
  (lookahead as in `tableSource`), parse via `subquerySource`, **require an
  explicit alias**, set `targetSource` + `alias` + placeholder `table`. Keep the
  named-target path unchanged.

### Phase 2 — routing
- [ ] Extend the prereq resolver to build an ephemeral view-like from
  `stmt.targetSource`; route through `buildViewMutation` in update.ts / delete.ts.
- [ ] Reject a DML-bodied inline target with a structured diagnostic.

### Phase 3 — stringify
- [ ] `updateToString` / `deleteToString`: render `(body) as alias[(cols)]` for a
  `targetSource`, suppressing the standalone `as alias` push.

### Phase 4 — docs + tests
- [ ] Make docs/view-updateability.md L81 / L670 true for the inline subquery
  target; document the inline-INSERT rejection boundary.
- [ ] Add the write-through, stringify round-trip, and reject-parity tests.
- [ ] `yarn workspace @quereus/quereus test` green; `yarn lint` clean.
