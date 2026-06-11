description: Parser/AST/stringify support for the `with inverse (col = expr, ...)` result-column clause — syntax only; validation + write-path consumption follow in `authored-inverse-write-path`. Reviewed and complete.
files:
  - packages/quereus/src/parser/ast.ts                  # ResultColumnInverse + ResultColumnExpr.inverse
  - packages/quereus/src/parser/parser.ts               # columnList attach + parseInverseClause + rejectInverseClauseOnStar
  - packages/quereus/src/parser/visitor.ts              # traverseAst descends into inverse exprs (review fix)
  - packages/quereus/src/emit/ast-stringify.ts          # resultColumnToString helper (4 call sites)
  - packages/quereus/test/emit-roundtrip.spec.ts        # deterministic cases incl. star-diagnostic + with-schema pins
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # inverseClauseArb; simpleSelectArb extension; selectWithInverseArb
  - packages/quereus/test/visitor.spec.ts               # inverse-expr traversal test (review fix)
  - packages/quereus/test/property.spec.ts              # with/inverse/new. fragments in parser-robustness fuzz
  - docs/sql.md                                         # formal grammar appendix: with_inverse_clause (review fix)
----

# Authored inverse clause — parser / AST / round-trip (complete)

Grammar per docs/view-updateability.md § Authored inverses and docs/sql.md §2.1/§2.9:

```
result_column := expr [ as alias ] [ with inverse ( ident = expr { , ident = expr } ) ]
```

## What landed (implement stage)

- **AST**: `ResultColumnInverse { column, expr }`; `ResultColumnExpr.inverse?: ReadonlyArray<ResultColumnInverse>`. Inert metadata — nothing downstream consumes it yet. Shape mirrors `ViewInsertDefault`.
- **Parser**: `columnList()` → `parseInverseClause()` after alias handling. `inverse` is contextual (plain IDENTIFIER lookahead after WITH — no lexer change); non-matching WITH is bare-rewound to the outer parser. Empty list and within-clause duplicate target are parse errors (mirrors INSERT DEFAULTS).
- **Stringify**: four duplicated result-column map bodies (SELECT + 3× RETURNING) factored into one `resultColumnToString` helper that emits the clause after the alias.
- `new.<col>` parses as an ordinary qualified column ref — zero special-casing.
- Tests: deterministic round-trips (clause shapes, comma boundary, parse errors, `inverse`-as-identifier, `with`-neighbor pins, nested positions incl. CTE/subquery/view/lens/declarative-schema/compound/RETURNING); property suite (`inverseClauseArb`, clause threaded through every QueryExpr-accepting arbitrary, dedicated alias⨯clause⨯multi-column suite); parser-robustness fuzz fragments.

## Review findings

Reviewed against the implement diff (`ticket(implement): authored-inverse-parser-ast`, 17a18dac) with fresh eyes; all source, docs, and test files read.

**Checked, confirmed sound (no action):**
- Lookahead/rewind discipline: verified `advance()` has exactly one non-cursor side effect (LPAREN/RPAREN parenStack), so the bare `this.current--` rewind of WITH is safe — the comment's claim holds. Faithful mirror of `parseInsertDefaultsClause`.
- `peekKeyword('INVERSE')` correctly takes the IDENTIFIER-lexeme fallback (verified `INVERSE` absent from the lexer); a quoted `"inverse"` does not commit the clause (lexeme includes quotes) — correct, quoted identifiers shouldn't act as keywords.
- All four result-column stringify sites use the shared helper; no other `.columns.map` site in ast-stringify handles result columns. Round-trip quoting via `quoteIdentifier` on targets.
- Duplicate detection is case-insensitive (`toLowerCase`), matching INSERT DEFAULTS; case-folded dup covered by the shared discipline.
- Implicit-alias interaction (`select a inverse from t`, `select x as inverse`) — clause cannot steal aliases since WITH is reserved; pinned by tests.
- docs/view-updateability.md § Authored inverses and docs/sql.md §2.1/§2.9 prose match the implementation.
- Declarative differ / bodyHash correctness: stringify now carries the clause, so definitions differing only in inverse compare correctly.
- Build, lint, full workspace tests: clean (quereus 5743 passing / 0 failing after review fixes).

**Minor — fixed in this pass:**
- `parser/visitor.ts` `traverseAst` traversed result-column forward exprs but silently skipped the new `inverse` assignment exprs — a stealth-miss for any generic AST walk (current consumers start from scalar exprs, so reachable only via subquery-embedded selects, but the gap compounds as consumers grow). Fixed; test added in visitor.spec.ts.
- `select * with inverse (…)` errored through the leftover-WITH/CTE path with a misleading message (flagged by the implementer as reviewer's choice). Added `rejectInverseClauseOnStar()` — the diagnostic now names the clause ("WITH INVERSE cannot apply to a '*' result column"); reuses `parseInverseClause` so `select * with schema main` is untouched (pinned by a new test).
- docs/sql.md **formal grammar appendix** still defined `result_column` without the clause (the implementer verified the prose sections but missed the EBNF). Added `with_inverse_clause` production.
- `authored-inverse-write-path` ticket drift: its validation list still claimed within-clause duplicate targets for build time (now a parse error) — amended to scope build time to the cross-result-column duplicate only.

**Major — routed to existing ticket (no new ticket needed):**
- ALTER … RENAME propagation into inverse targets/exprs (`schema/rename-rewriter.ts` does not descend into `ResultColumnExpr.inverse`; targets are base columns — exactly what renames touch) was deferred by the implementer but **tracked nowhere**. Added an explicit requirement + TODO + files entry to `authored-inverse-write-path`, where target resolution lands. Until then the only observable artifact is stale regenerated DDL after a rename, since nothing consumes the clause.

**Noted, intentionally not acted on:**
- Parse-level permissiveness (clause accepted in RETURNING and any select position) is by design; build-time validation is the write-path ticket's scope. §2.5 RETURNING prose deliberately not extended — documenting RETURNING-position semantics would overpromise ahead of that decision.
- `traverseAst` also skips RETURNING lists entirely (pre-existing, unreachable from current consumers — all start from scalar CHECK/generated-column exprs); not worth a ticket until a consumer traverses statements.
- Pre-existing `with schema` stringify drop already filed as `tickets/backlog/stringify-schema-path-clause.md`.
- No performance, resource-cleanup, or error-handling concerns: the clause adds O(1) lookahead per result column and pure data to the AST.
