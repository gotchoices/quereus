description: A method that was supposed to return the SQL text of a statement instead returned the useless string "[object Object]"; now fixed to render real SQL.
files:
  - packages/quereus/src/core/statement.ts (getBlockSql, originalSql reconstruction — lines ~79, ~133)
  - packages/quereus/src/emit/ast-stringify.ts (astToString — existing AST-to-SQL renderer, unchanged)
  - packages/quereus/test/statement-sql-text.spec.ts (new — regression coverage)
difficulty: easy
----

## What was wrong

`core/statement.ts` had two sites that coerced an AST statement node directly
to a string via JS's default `Object.prototype.toString()`, which yields
`"[object Object]"`:

- the `originalSql` reconstruction in the constructor (used when `Statement`
  is built from a pre-parsed AST batch rather than a raw SQL string) — was
  `this.astBatch.map(s => s.toString()).join('; ')`
- the public `getBlockSql()` accessor — was `this.getAstStatement().toString()`

A third suspected site, the planning/debug log line (`log("Planning current
statement (new runtime): %s", this.getBlockSql().substring(0, 100))`),
already called `getBlockSql()` rather than `.toString()` directly, so fixing
`getBlockSql()` fixed that log line transitively — no separate edit was
needed there.

## Fix

Both sites now route through `astToString()` from
`emit/ast-stringify.ts` (already imported project-wide as the canonical
AST-to-SQL renderer, used for e.g. schema-diff canonicalization and view
definitions):

```ts
// constructor
this.originalSql = this.astBatch.map(s => astToString(s)).join('; ');

// getBlockSql()
return astToString(this.getAstStatement());
```

## Coverage verification

Checked `astToString`'s switch in `ast-stringify.ts` against the full
`Statement` AST union in `parser/ast.ts` (27 variants: select, insert,
update, delete, values, createTable, createIndex, createView,
createMaterializedView, refreshMaterializedView, createAssertion, drop,
alterTable, alterView, alterMaterializedView, alterIndex, begin, commit,
rollback, savepoint, release, pragma, analyze, declareSchema, declareLens,
diffSchema, applySchema, explainSchema). Every variant has an explicit case
— none fall through to the `default: return \`[${node.type}]\`;` fallback.
So every statement kind `getBlockSql()`/`originalSql` can receive is
handled; nothing new needed to be added.

Note: that `default` fallback in `astToString` still silently returns
`[nodeType]` rather than throwing (it's a leftover from before this fix, and
is reachable in principle if a new `Statement` variant is ever added to the
AST without a matching case — the switch isn't compiler-enforced
exhaustive). Left as-is since it's outside the two sites this ticket
targets and changing it touches a function used by many other unrelated
callers (schema-diff, view-definition canonicalization, etc.) — flagging as
a tripwire rather than fixing here.

## Tests

Added `packages/quereus/test/statement-sql-text.spec.ts`:

- `getBlockSql()` on a statement prepared from a SQL string returns the
  exact rendered SQL (`select a, b from t where a > 1`), not
  `"[object Object]"`.
- `originalSql` on a `Statement` constructed directly from a pre-parsed AST
  batch (the code path that skips the raw-string branch and exercises the
  constructor's reconstruction line) also renders real SQL for a
  multi-statement batch, not `"[object Object]"`.

Full suite run: `node test-runner.mjs` from `packages/quereus` — 6434
passing, 9 pending (pre-existing skips, unrelated), 0 failing.
`yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) clean.

## Known gaps for reviewer

- Only round-tripped simple SELECT text exactly (`astToString` normalizes
  case, whitespace, and quoting — e.g. input `SELECT * FROM t` renders as
  `select * from t`). Did not add exhaustive round-trip tests per statement
  kind here since `ast-stringify.ts` already has its own dedicated
  round-trip test suite (`test/emit-roundtrip-*.spec.ts` per that file's
  header comment) — this ticket only needed to confirm the two call sites
  are wired up, not re-verify the renderer itself.
- Did not audit the rest of the codebase for other stray `<astNode>.toString()`
  call sites outside `core/statement.ts` — ticket scope was limited to the
  three sites named in the original ticket (two direct + one transitive).
