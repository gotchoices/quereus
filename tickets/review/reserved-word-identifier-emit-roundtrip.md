description: Review the deterministic reserved-word-through-every-identifier-position round-trip suite plus the emit/parser quoting fixes it drove. Verify the surgical function-name gate, the collate parser fix, and the noted out-of-scope gaps.
files: packages/quereus/test/emit-roundtrip-positions.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/lexer.ts
----

## What this change is

A savepoint named with a reserved word (`release to`) shipped broken because the
emitter wrote the name **bare**. The fix was right (route through
`quoteIdentifier`) but the *test gap* was systemic: the AST round-trip property
test (`emit-roundtrip-property.spec.ts`) deliberately avoids reserved words via a
hand-maintained denylist, so it is structurally blind to "reserved word used as
an identifier" at every emit site.

This work closes that gap with a **deterministic, position-by-position** suite
and fixes every emit site the suite caught.

## Deliverables

### New suite — `test/emit-roundtrip-positions.spec.ts`
- A `POSITIONS` table of **71 identifier positions** (table/column/alias/schema/
  index/view/materialized view/assertion/savepoint/CTE/collation/pragma/function/
  upsert/with-context/declare-lens/declared-items/…), each an SQL template with a
  single `{ID}` hole.
- **Reserved-word round-trip** (one `it` per position): for *every* keyword in the
  lexer `KEYWORDS` table, substitute the **quoted** form, `parse → astToString →
  parse`, and assert structural equality via the existing
  `emit-roundtrip-comparator.ts`. Driven off `Object.keys(KEYWORDS)` so it cannot
  drift from the lexer the way the denylist did. Failures are bucketed as
  *parser gap* (input didn't parse) vs *emit bug* (re-parse failed / mismatch).
- **No over-quoting** (one `it` per position): substitute a plain `foo`, assert the
  emitted SQL contains `foo` but **not** `"foo"` — pins `quoteIdentifier`'s
  "quote only when necessary" policy against a future always-quote regression.
- 142 checks, fully deterministic, ~130ms (no sampling needed; full sweep is cheap).

### Emit fixes — `src/emit/ast-stringify.ts`
Sites that emitted an identifier **bare** and now route through the quoting gate:
- `collate` in three places: scalar expression, indexed-column, column-constraint.
- `diff schema` / `apply schema` / `explain schema` names (were bare; siblings of
  the already-correct `declare schema`).
- **Scalar function name** via a new **surgical** `quoteFunctionName` helper.
- **TVF name** (functionSource identifier branch) via `quoteIdentifier`.

### Parser fix — `src/parser/parser.ts`
- `collateExpression` now reads the collation name via `getIdentifierValue`
  instead of `.lexeme`, so `collate "select"` yields `select` rather than embedding
  the quote characters in the value. Required for the collate round-trip to work.

### Refactor — `src/parser/lexer.ts`
- `CONTEXTUAL_KEYWORDS` moved from `parser.ts` to `lexer.ts` (next to `KEYWORDS`)
  and exported, so the emitter and parser share one source of truth. Avoids a
  heavy emit→parser import while keeping the bare-callable set DRY.

### Folded regression
- The standalone savepoint reserved-word regression block was removed from
  `emit-roundtrip.spec.ts`; the new suite covers savepoint/release/rollback-to
  across **all** keywords (a pointer comment was left behind).

## The subtle bit a reviewer should focus on: the function-name gate

Function name emit serves **two masters**: round-trip SQL *and* the auto-derived
result-column name (`returning-node.ts` and SELECT projection naming call
`expressionToString`). Quoting *all* keyword function names broke
`select like('a%', x)` — its column name became `"like"('a%', x)`
(`06-builtin_functions.sqllogic:13`), because `like` is a contextual keyword the
parser **accepts bare** in a call.

`quoteFunctionName` therefore quotes a scalar function name **only when a bare
emit would not re-parse as a call** — i.e. the lowercased name is a keyword that
is *not* in `[...CONTEXTUAL_KEYWORDS, 'replace']` (the parser's bare-callable
scalar set). So:
- `like(…)`, `replace(…)`, `set(…)` → stay **bare** (column names unchanged).
- `select(…)` (only reachable via an explicit `"select"(x)`) → **quoted**, round-trips.

**Review asks:**
- Confirm `[...CONTEXTUAL_KEYWORDS, 'replace']` exactly matches what the parser's
  scalar function-call path accepts bare (parser.ts ~line 1666:
  `consumeIdentifier([...CONTEXTUAL_KEYWORDS, 'replace'], …)`). If those drift,
  the gate drifts. There is no automated guard tying the two together (the move
  to `lexer.ts` shares the *base* set, but the `+ 'replace'` is duplicated in the
  emitter).
- The **TVF** path uses a *different* bare set (`tableIdentifier` accepts
  `[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']`, **not** `replace`). The
  functionSource emit deliberately uses full `quoteIdentifier` (quote all
  keywords) rather than `quoteFunctionName`, because (a) a quoted TVF name always
  re-parses and (b) TVF names are relation sources, never scalar column names, so
  over-quoting them is cosmetic-only. Verify that reasoning holds.

## Known gaps / honest flags (treat tests as a floor)

- **`using <module>` module names** (CREATE TABLE / CREATE MATERIALIZED VIEW) are
  still emitted **bare** (`ast-stringify.ts` `moduleClauseToString` /
  `mvModuleClauseToString`). Intentionally **not** covered — not in the ticket's
  position list, and module names are validated against registered modules and
  aren't reserved-word-named in practice. This is a real latent gap if a
  keyword-named module is ever registered. Reviewer: decide whether to gate it
  (cheap) or leave documented.
- **`IndexedColumn.collation` field** is effectively unreachable via parsing:
  `CREATE INDEX (a collate x)` routes the collation through the column
  expression's `collate` node, not `col.collation`. The indexed-column collate
  emit fix is therefore **defensive** — only exercised by programmatically-built
  ASTs (e.g. catalog / `@quereus/store` ddl-generator). Not verified that any such
  path populates it.
- **Store emitter not exercised for this class.** Validated with
  `yarn workspace @quereus/quereus run build / lint / test` (memory vtab) — all
  green (4586 passing, 9 pending, 0 failing). **Not** run against `test:store`.
  The changes are parser/emit only and store-independent, BUT `@quereus/store`'s
  `ddl-generator.ts` is a *separate* DDL emitter (per the parser.ts banner) and
  was **not** audited for the same reserved-word-identifier class — a plausible
  place for the same bug to still live.
- **Over-quoting check is shallow** by design: it proves the ordinary name isn't
  quoted, not that it survives (survival is the comparator/property suite's job).
- **`quoteFunctionName` lowercases** before gating, preserving the historical
  lowercase-function-name emit; a mixed-case UDF name is lowercased on emit
  (pre-existing behavior; the comparator case-folds `name`, so round-trip holds).
- **Parser collate fix is a behavior change**: quoted collation names now strip
  their quotes. Low risk (no existing test used quoted collations), but it is a
  semantic change to parsed `collation` values.

## How to validate

```
yarn workspace @quereus/quereus run build
yarn workspace @quereus/quereus run lint
yarn workspace @quereus/quereus run test
# focused:
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/emit-roundtrip-positions.spec.ts" --reporter spec
```

Spot-check cases worth eyeballing: `savepoint "to"` / `release "to"` /
`rollback to "to"`; `select x collate "select"`; `diff schema "select"`;
`select like('a%', x)` (must stay bare); `select "select"(x)` (must quote);
`create index i on t (a collate "select")`.

Pre-existing working-tree context (NOT introduced here): the `release to`
savepoint emit fix and the `hiding`-clause removal were already present.
