description: Parse the `with inverse (col = expr, ...)` clause on select result columns into a new optional AST field, stringify it, and round-trip it — syntax only; validation and write-path consumption land in `authored-inverse-write-path`.
files:
  - packages/quereus/src/parser/parser.ts            # result-column parsing; contextual keyword
  - packages/quereus/src/parser/ast.ts               # ResultColumnExpr gains optional inverse field
  - packages/quereus/src/emit/ast-stringify.ts       # emit the clause
  - packages/quereus/test/emit-roundtrip.spec.ts     # deterministic round-trip cases
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # arbitrary generates the clause
  - docs/sql.md                                      # §2.1 / §2.9 (already written — verify they match)
  - docs/view-updateability.md                       # § Authored inverses (already written — verify)
----

# Authored inverse clause — parser / AST / round-trip

First step of the authored-inverses feature (design: `docs/view-updateability.md`
§ Authored inverses (`with inverse`), `docs/sql.md` §2.1/§2.9 — both already
written as the normative spec; treat divergence as a doc bug to reconcile in
your handoff).

## Grammar

```
result_column := expr [ as alias ] [ with inverse ( ident = expr { , ident = expr } ) ]
```

- **Named form only** — every assignment names a target column (a FROM-source
  base column, resolved later) and an expression over the written view row
  (referenced via `new.<output-col>`). No bare-expression shorthand exists.
- `inverse` is a **contextual keyword** (like `materialized` / `refresh`) —
  no new reserved word.
- `new.<col>` inside the assignment expressions parses as an ordinary
  qualified column reference with qualifier `new` (the same surface RETURNING
  uses); no parser special-casing needed beyond what exists.
- The clause attaches only to expression result columns — `*` and `t.*`
  cannot carry it (grammar position makes this natural; assert it).
- An empty assignment list `with inverse ()` is a parse error.

## AST

`ResultColumnExpr` (src/parser/ast.ts) gains an optional field:

```ts
export type ResultColumnExpr = {
	type: 'column',
	expr: Expression,
	alias?: string,
	inverse?: ReadonlyArray<{ target: string; expr: Expression }>,
}
```

(Adjust naming to match local conventions; keep it a plain data field — the
clause is inert metadata until the write path consumes it.)

## Stringify / round-trip

- `ast-stringify.ts` emits ` with inverse (t1 = <expr>, t2 = <expr>)` after
  the alias.
- Deterministic round-trip cases in `emit-roundtrip.spec.ts`: single
  assignment, multiple assignments, `case` expression body, `new.`-qualified
  refs, clause coexisting with an alias and with no alias.
- Extend the AST round-trip **property** arbitrary so generated result columns
  sometimes carry the clause — this is the net that catches stealth
  field-drops in stringify.

## Edge cases & interactions

- **`with` lookahead** — after a result-column expression, `with` may begin
  this clause OR belong to an outer construct: statement-trailing
  `with schema …` on a FROM-less select (`select a with schema main`), and a
  view body's trailing `insert defaults` / `with tags (…)`
  (`create view v as select 1 with tags (...)`). Commit to the clause only
  when the token after `with` is `inverse`; otherwise leave `with` for the
  outer parser. Pin each of these neighbors with a parse test.
- **Comma boundary** — `select a + 1 with inverse (b = x - 1), c from t`:
  the parenthesized list bounds the clause; `c` parses as the next result
  column.
- **`inverse` stays usable as an identifier** — `select inverse from t` and
  `select x as inverse from t` must still parse (contextual keyword
  discipline).
- **Everywhere select parses** — the clause must survive in CTE bodies,
  subqueries-in-FROM, view bodies, lens-block view bodies (`declare lens`),
  compound legs, and declarative-schema `view` items; round-trip at least one
  nested position. No positional rejection at parse time — validation is the
  next ticket's job.
- **Parser robustness property** — the existing random-fragment parser
  property test must keep its invariant (valid AST or `QuereusError`, never an
  unhandled throw) with the new production in play.

## TODO

- AST field + parser production (contextual keyword, lookahead discipline)
- ast-stringify emission
- Deterministic round-trip cases + property-arbitrary extension
- Parse tests for the `with`-neighbor ambiguities and identifier reuse
- Verify docs/sql.md + docs/view-updateability.md grammar matches what landed
- `yarn build`, `yarn lint` (quereus), `yarn test`
