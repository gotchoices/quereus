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

## Implement handoff (2026-06-12)

Implemented. `schemaPathClauseToString` helper in `src/emit/ast-stringify.ts`; selectToString emits after HAVING / before compound chain (matches parseSchemaPath binding; compound legs carrying a schemaPath are parenthesized); DML emits among trailing WITH clauses after `with tags` (shields INSERT's bare-SELECT-source greediness). Tests: 13 deterministic round-trip cases in `test/emit-roundtrip.spec.ts` asserting first-parse survival; `schemaPathArb` wired into select/compound/insert/update/delete arbitraries in `test/emit-roundtrip-property.spec.ts`. Known corner (pre-existing parser ambiguity, unreachable from parse): INSERT-level schemaPath over a bare SELECT source with no intervening trailing clause cannot re-bind to the INSERT; nets stay inside parser-reachable shapes. Full suite 5909 passing.

NOTE for reviewer: the implement diff for this ticket is NOT under its own commit — a concurrent runner commit (c04e512e, "ticket(implement): maintained-table-attach-detach-verbs") swept these changes in along with ticket 6.2's work. Review the files named above within that commit.
