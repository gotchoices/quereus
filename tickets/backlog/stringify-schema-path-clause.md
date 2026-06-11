description: ast-stringify silently drops the `with schema` clause (`schemaPath`) on SELECT and DML statements — parse(stringify(ast)) loses the schema search path.
difficulty: easy
files:
  - packages/quereus/src/emit/ast-stringify.ts          # no `schemaPath` emission anywhere
  - packages/quereus/src/parser/parser.ts               # parseSchemaPath / parseTrailingWithClauses produce it
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # no arbitrary generates schemaPath (why the net never caught it)
----

# `with schema` clause is dropped by the stringifier

`select a with schema main` parses to a `SelectStmt` with `schemaPath: ['main']`,
but `astToString` emits just `select a` — the clause is silently dropped.
`grep schemaPath src/emit/ast-stringify.ts` has zero hits. The same applies to
the trailing `with schema` on INSERT / UPDATE / DELETE (where the sibling
trailing clauses `with context` and `with tags` *are* emitted).

Observed while implementing `authored-inverse-parser-ast` (the `with`-lookahead
neighbor tests); pre-existing — unrelated to the inverse clause.

## Expected

- `selectToString` emits ` with schema s1, s2` in its grammar position (after
  HAVING, before compound / ORDER BY / LIMIT — see `parseSchemaPath` call site
  in `selectStatement`).
- `insertToString` / `updateToString` / `deleteToString` emit it among the
  trailing WITH clauses, matching `parseTrailingWithClauses` order rules.
- Deterministic round-trip cases for each statement kind, and the property
  suite's select/DML arbitraries extended to sometimes generate `schemaPath`
  (the stealth-drop net that would have caught this).

## Notes

- Statement-level compound interaction: on a compound select, `with schema`
  binds before the compound operator (`isCompoundSubquery` suppresses it on
  legs) — emission position must re-parse to the same binding.
