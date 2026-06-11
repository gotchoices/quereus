description: Review the parser/AST/stringify support for the `with inverse (col = expr, ...)` result-column clause — syntax only; validation + write-path consumption are the follow-on `authored-inverse-write-path` ticket.
files:
  - packages/quereus/src/parser/ast.ts                  # ResultColumnInverse + ResultColumnExpr.inverse
  - packages/quereus/src/parser/parser.ts               # columnList attach + parseInverseClause
  - packages/quereus/src/emit/ast-stringify.ts          # resultColumnToString helper (4 call sites)
  - packages/quereus/test/emit-roundtrip.spec.ts        # 21 deterministic cases (new describe block)
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # inverseClauseArb; simpleSelectArb extension; selectWithInverseArb suite
  - packages/quereus/test/property.spec.ts              # with/inverse/new. fragments in parser-robustness fuzz
----

# Authored inverse clause — parser / AST / round-trip (implemented)

Grammar landed exactly as specced in docs/view-updateability.md § Authored
inverses and docs/sql.md §2.1/§2.9 (both verified against the implementation —
no divergence found, no doc edits needed):

```
result_column := expr [ as alias ] [ with inverse ( ident = expr { , ident = expr } ) ]
```

## What was built

- **AST** (`parser/ast.ts`): new `ResultColumnInverse { column: string; expr: Expression }`;
  `ResultColumnExpr` gains optional `inverse?: ReadonlyArray<ResultColumnInverse>`.
  Field is named `column` (not the source ticket's suggested `target`) to mirror
  the sibling `ViewInsertDefault` shape, per the docs' "deliberately mirrors
  `insert defaults`" note. Plain inert data — nothing downstream consumes it yet.
- **Parser** (`parser.ts`): `columnList()` calls a new `parseInverseClause()`
  after alias handling. Lookahead discipline copies `parseInsertDefaultsClause`:
  consume `WITH`, commit only when the next token is the contextual keyword
  `INVERSE` (a plain IDENTIFIER — no new reserved word, no lexer change),
  otherwise bare-rewind the cursor and leave `WITH` for the outer parser
  (rewind is side-effect-safe for WITH; see comment re parenStack).
  `with inverse ()` is a parse error; a duplicate target **within one clause**
  is a parse error (mirrors INSERT DEFAULTS — note: the write-path ticket lists
  this under build-time validation; only the cross-result-column duplicate
  remains for build time).
- **Stringify** (`ast-stringify.ts`): the four duplicated result-column map
  bodies (select columns + insert/update/delete RETURNING) were factored into
  one `resultColumnToString` helper that now also emits
  ` with inverse (c1 = e1, c2 = e2)` after the alias.
- `new.<col>` parses as an ordinary qualified column ref (`table: 'new'`) —
  `new` is not a lexer keyword; zero parser special-casing, as predicted.

## Validation performed

- `yarn build` (workspace), `yarn lint` (quereus): clean.
- `yarn test` (workspace): all green — quereus 5741 passing / 0 failing.
- Deterministic round-trips (new `result-column WITH INVERSE` describe block in
  emit-roundtrip.spec.ts): single/multiple assignments, case bodies on both
  sides, `new.`-refs, alias and no-alias, comma boundary
  (`… with inverse (b = x - 1), c from t` → 2 columns), structural field
  assertions, parse-error cases (empty list, dup target, `*` / `t.*` carrying
  the clause), `inverse` as identifier (`select inverse from t`,
  `select x as inverse from t`).
- `with`-neighbor pins: FROM-less `select a with schema main` keeps
  `schemaPath` (clause not stolen); clause coexists with trailing
  `with schema`; view-body trailing `with tags` and `insert defaults`
  untouched; combined `… with inverse (…) from t insert defaults (…) with tags (…)`.
- Nested positions: CTE body, subquery-in-FROM, view body, compound legs
  (clause on both legs), lens-block view body (`declare lens … { view … }`),
  declarative-schema view item (`declare schema … { view … }`), and RETURNING
  (shared `columnList` path).
- Property suite: new `inverseClauseArb` (1–3 distinct targets; literal / bare
  ref / `new.`-qualified exprs); `simpleSelectArb` now optionally carries the
  clause, which propagates it through **every** QueryExpr-accepting arbitrary
  (CTE / view / subquery-source / compound / IN / EXISTS) — the stealth-drop
  net; plus a dedicated `selectWithInverseArb` suite (alias ⨯ clause ⨯
  multi-column, 200 runs). Parser-robustness fuzz extended with `with` /
  `inverse` / `new.` fragments — invariant (QuereusError or valid AST, never an
  unhandled throw) holds.

## Known gaps / notes for review

- **Parse-level permissiveness is intentional**: the clause parses in RETURNING
  position and on any select anywhere (no positional rejection) — build-time
  validation is `authored-inverse-write-path`'s job. If RETURNING should be
  rejected *earlier* than the general build-time pass, that's a write-path
  decision; stringify already round-trips it so nothing is silently dropped.
- **`*` + clause error message is suboptimal**: `select * with inverse (a = 1)`
  errors (asserted), but via the leftover-`with`-starts-a-CTE path, so the
  message reads "Expected '(' after CTE column list"-ish rather than naming the
  clause. Cosmetic; fix only if reviewer judges it worth a targeted check.
- **Rename propagation not extended**: `schema/rename-rewriter.ts` walks view
  bodies for ALTER … RENAME; it does not yet descend into `inverse` expressions
  (targets are base columns — exactly what renames touch). Deliberately left
  for the write-path/validation ticket where target resolution lands; flag if
  it should be pulled earlier.
- **Pre-existing, filed separately**: ast-stringify drops `schemaPath`
  (`with schema`) on SELECT/DML — discovered via the neighbor pins; see
  `tickets/backlog/stringify-schema-path-clause.md`. Not a test failure; not
  caused by this work.
- IDE-only TS diagnostics in untouched regions of the two property spec files
  (fast-check generic typings skew) pre-date this work; `yarn build` + `yarn lint`
  + the mocha runs are clean.
