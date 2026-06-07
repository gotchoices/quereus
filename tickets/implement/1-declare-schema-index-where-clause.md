description: The `declare schema { ... }` grammar parses no WHERE clause on an index item (`declareIndexItem`), so partial indexes cannot be declared. Close the gap so a declared index round-trips its partial predicate — a prerequisite for end-to-end testing of partial-predicate body drift in schema-differ-index-body-drift.
prereq:
files:
  - packages/quereus/src/parser/parser.ts            # declareIndexItem (~L3484-3513); model: parseCreateIndex WHERE (~L2611-2615)
  - packages/quereus/src/parser/ast.ts               # AST.CreateIndexStmt.where (already present — confirm only)
  - packages/quereus/test/declarative-equivalence.spec.ts  # declare-schema parse coverage (add a partial-index parse case here, or a sibling parser spec)
----

# Close the `declare schema` index WHERE-clause grammar gap

## Problem

The top-level `create index` parser (`parseCreateIndex`, parser.ts ~L2611) parses
an optional `WHERE <predicate>` before the optional `WITH TAGS` clause and stores
it on `AST.CreateIndexStmt.where`. The **declare-schema** variant
(`declareIndexItem`, parser.ts ~L3484-3513) does **not**: it parses the index
name, `ON <table>`, the parenthesized column list, then jumps straight to optional
`WITH TAGS`. The resulting `indexStmt` never carries a `where`, so a partial index
simply cannot be expressed inside `declare schema { ... }`.

Consequently the declarative apply path cannot create a partial index, and the
schema differ has no way to observe a declared partial predicate — which blocks
testing partial-predicate body drift in the follow-on differ ticket.

## Expected behavior

A `declare schema { ... }` index item accepts an optional `WHERE <predicate>`
between the column list and `WITH TAGS`, identical in placement and semantics to
the standalone `create index` form:

```sql
declare schema main {
  table t { id INTEGER PRIMARY KEY, active INTEGER }
  index ix_active on t (active) where active = 1
  unique index uq_a on t (active) where active = 1 with tags (k = 'v')
}
```

The parsed `AST.CreateIndexStmt` for each carries `where` set to the predicate
expression AST, exactly as `parseCreateIndex` produces it. `createIndexToString`
already emits `where` (ast-stringify.ts ~L819), and `generateIndexDDL` already
emits the actual-side `WHERE` (ddl-generator.ts ~L132), so once parsing populates
`where`, the declared partial index round-trips through emit/import unchanged.

## Design

`declareIndexItem` and `parseCreateIndex` share the exact same WHERE shape. Lift
the four-line WHERE parse from `parseCreateIndex` into `declareIndexItem`, placed
**after** the `RPAREN` that closes the column list and **before** the `WITH TAGS`
block (mirroring grammar order `(<cols>) [WHERE …] [WITH TAGS …]`):

```ts
let where: AST.Expression | undefined;
if (this.matchKeyword('WHERE')) {
  where = this.expression();
}
```

Then add `where` to the constructed `indexStmt` literal (alongside `columns`,
`isUnique`, `tags`). `AST.CreateIndexStmt.where` already exists (confirm — it is
read by `createIndexToString`), so no AST type change is needed.

Keep it DRY without over-refactoring: the snippet is small and the two call sites
have different surrounding structure (one builds a `DeclaredIndex` wrapper, the
other a bare `CreateIndexStmt` with `loc`), so an inline mirror is acceptable —
do **not** introduce a shared helper unless it falls out cleanly.

## Edge cases & interactions

- **Clause ordering** — `WHERE` must parse before `WITH TAGS`. A declaration with
  both (`... where active = 1 with tags (k = 'v')`) must populate `where` AND
  `tags`. Add a case covering both together.
- **No WHERE** — the existing tag-only / plain declared-index forms must still
  parse with `where` left `undefined` (no regression). The `WITH` lookahead logic
  (`matchKeyword('WHERE')` is independent of the `WITH`/`TAGS` handling) must not
  consume or mis-step on a following `WITH`.
- **`unique index ... where ...`** — the `isUnique` parameter path must coexist
  with WHERE (unique partial index). Cover a `unique index` + `where` declaration.
- **Predicate expression fidelity** — `this.expression()` parses a full
  expression; confirm a non-trivial predicate (e.g. `active = 1 and id > 0`)
  round-trips through `createIndexToString` to a re-parseable string.
- **WITH-keyword backtrack** — `declareIndexItem`'s existing `WITH` handling does
  `this.current--` when the token after `WITH` is not `TAGS`; ensure the new WHERE
  parse sits before that block so it cannot strand the cursor.

## TODO

- Add the optional WHERE parse to `declareIndexItem` (parser.ts ~L3484-3513),
  before the `WITH TAGS` block; thread `where` onto the returned `indexStmt`.
- Confirm `AST.CreateIndexStmt.where` exists (it does — read by
  `createIndexToString`); no AST change expected.
- Add parse tests (in `declarative-equivalence.spec.ts` or a parser spec):
  - `declare schema` with a plain partial index → `indexStmt.where` is set.
  - `unique index ... where ...` → `isUnique` true AND `where` set.
  - partial index + `with tags` → both `where` and `tags` populated.
  - plain declared index (no WHERE) → `where` is `undefined` (no regression).
- Run `yarn workspace @quereus/quereus test` (or the parser/declarative spec
  subset) and `yarn workspace @quereus/quereus run lint`; stream output with
  `2>&1 | tee /tmp/parser.log; tail -n 80 /tmp/parser.log`.
