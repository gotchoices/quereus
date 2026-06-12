description: ast-stringify now emits the `with schema` clause (`schemaPath`) on SELECT and INSERT/UPDATE/DELETE so parse(stringify(ast)) preserves the schema search path.
files:
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/test/emit-roundtrip.spec.ts
  - packages/quereus/test/emit-roundtrip-property.spec.ts
----

# `with schema` clause emission — completed

`schemaPathClauseToString` helper renders `with schema s1, s2` (identifiers
quoted via `quoteIdentifier`). Wired into all four `schemaPath`-bearing
statement emitters:

- `selectToString` — after HAVING, before the compound chain and the trailing
  ORDER BY / LIMIT block, matching the `parseSchemaPath` call site (binds before
  the compound operator and before ORDER BY).
- `compoundLegToString` — a compound leg carrying a `schemaPath` is wrapped in
  parentheses (bare legs parse with `isCompoundSubquery` and never consume one).
- `insertToString` / `updateToString` / `deleteToString` — emitted among the
  trailing WITH clauses, after `with tags`.

## Review findings

Reviewed the implement diff (commit c04e512e, which swept this ticket's changes
in alongside `maintained-table-attach-detach-verbs` — confirmed via the named
files) with fresh eyes against the parser, then the handoff summary.

**Correctness / parser alignment — checked, no issues.**
- Verified emission position against `parser.ts`: `selectStatement` calls
  `parseSchemaPath` after HAVING and before `parseCompoundTail` /
  `parseTrailingOrderLimit`; the SELECT emitter mirrors this exactly. The three
  DML statements parse `schemaPath` via `parseTrailingWithClauses` (after WHERE,
  before RETURNING, any order with context/tags); emitters mirror this, placing
  it after `with tags` and before RETURNING.
- Confirmed `schemaPath` exists on exactly four AST nodes (SelectStmt,
  InsertStmt, UpdateStmt, DeleteStmt) — no fifth carrier the emitter dispatch
  could silently drop. `astToString` routes every SELECT through the same
  emitter, so nested positions (CTE body, view body, subquery source) are
  covered for free.
- `quoteIdentifier` correctly used for schema names (keyword/special-char safe).

**Compound-leg parenthesization — checked, correct.** The `|| schemaPath` arm of
`compoundLegToString` is only reachable for synthetic ASTs (the parser suppresses
leg-level `schemaPath`); the property suite exercises it as a right-leg shape and
it round-trips idempotently.

**Known INSERT corner — verified genuinely unreachable from parse.** An
INSERT-level `schemaPath` over a *bare SELECT source* with no intervening trailing
clause cannot re-bind to the INSERT (the source SELECT's own `parseSchemaPath` is
greedy). Confirmed the parser never *produces* this shape — `insert into t select
a from s with schema s1` binds the path to the inner select (test asserts
`stmt.schemaPath === undefined`, `stmt.source.schemaPath === ['s1']`). So no
parser-produced AST hits the ambiguity; only hand-built ASTs could, and the
property arbitraries deliberately keep the INSERT source VALUES-shaped. The
"emit after tags" placement correctly shields the parser-reachable
select-source-with-tags case (test: tags shield the SELECT source). Acceptable
and well-documented.

**Tests — adequate; happy path + edges + the regression net.**
- 15 deterministic round-trip cases in `emit-roundtrip.spec.ts` (single/multi
  schema, after-HAVING, before-ORDER-BY/LIMIT, compound binding, compound +
  outer ORDER BY, INSERT trailing / ON CONFLICT / tags-shield / source-select,
  UPDATE + RETURNING, DELETE + RETURNING). Each asserts `schemaPath` survives the
  *first* parse→stringify→parse, not just idempotence — this is the net that
  catches a silent drop (a dropped clause re-emits identically and would pass a
  pure-idempotence check).
- `schemaPathArb` wired into the select / compound / insert / update / delete
  property arbitraries — the stealth-drop net that the original property suite
  lacked.

**Lint:** `eslint` clean on the three changed files (exit 0).

**Tests run:** targeted `WITH SCHEMA` deterministic suite + full AST round-trip
property suites (22 + 61 passing); broader Emit / round-trip / stringify / Parser
sweep — 699 passing, no regressions. No pre-existing failures surfaced.

**Docs:** `with schema` has no user-facing entry in `docs/sql.md` (a pre-existing
gap for the clause itself, not introduced or widened here). This ticket is an
internal stringifier-fidelity fix that changes no SQL semantics, so no doc update
is in scope.

**Disposition:** no major findings — no new tickets filed. No minor fixes needed;
the implementation is complete, correct for all parser-reachable shapes, and the
sole corner is genuinely unreachable from parse and documented.
