description: Review the `declare schema { ... }` partial-index grammar fix — `declareIndexItem` now parses an optional WHERE predicate so partial indexes round-trip through declarative apply.
prereq:
files:
  - packages/quereus/src/parser/parser.ts                   # declareIndexItem (~L3485-3516): added WHERE parse + threaded `where`
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # new "declare schema: index WHERE-clause grammar" describe (parse tests)
  - packages/quereus/test/declarative-equivalence.spec.ts   # two new end-to-end cases in the "indexes" describe
  - packages/quereus/src/parser/ast.ts                       # CreateIndexStmt.where (pre-existing, unchanged — confirmed)
  - packages/quereus/src/emit/ast-stringify.ts               # createIndexToString emits WHERE (pre-existing, unchanged)
  - packages/quereus/src/schema/ddl-generator.ts             # generateIndexDDL emits WHERE (pre-existing, unchanged)
----

# Review: `declare schema` index WHERE-clause grammar gap

## What changed

The declare-schema index item (`declareIndexItem`, parser.ts ~L3485) previously
parsed `<name> ON <table> (<cols>)` then jumped straight to optional `WITH TAGS`,
so a partial index could not be expressed inside `declare schema { ... }`.

The fix lifts the four-line WHERE parse from `parseCreateIndex`
(`createIndexStatement`, parser.ts ~L2612) into `declareIndexItem`, placed **after**
the `RPAREN` closing the column list and **before** the `WITH TAGS` block, then
threads `where` onto the constructed `indexStmt` literal:

```ts
// Parse optional WHERE <predicate> (partial index), before WITH TAGS
let where: AST.Expression | undefined;
if (this.matchKeyword('WHERE')) {
  where = this.expression();
}
```

No AST change was needed — `AST.CreateIndexStmt.where` already exists (read by
`createIndexToString`). Per the ticket's guidance, the snippet was mirrored inline
rather than extracted into a shared helper (the two call sites build different
surrounding structures — a bare `CreateIndexStmt` with `loc` vs. a `DeclaredIndex`
wrapper without `loc`).

## Why it matters

`createIndexToString` and `generateIndexDDL` already emit `where`, and the
declarative differ round-trips actual-side index DDL — so once parsing populates
`where`, a declared partial index round-trips through emit/import/apply unchanged.
This unblocks end-to-end testing of partial-predicate body drift in the follow-on
differ work.

## Verification performed

All green on this branch:

- `index-ddl-roundtrip.spec.ts` — 19 passing (14 pre-existing + 5 new parse tests).
- `declarative-equivalence.spec.ts` + `schema-differ.spec.ts` +
  `schema-manager.spec.ts` — 176 passing, exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0, no findings.
- `yarn workspace @quereus/quereus run typecheck` — exit 0, no findings.

Run a focused subset with:
```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/index-ddl-roundtrip.spec.ts" \
  "packages/quereus/test/declarative-equivalence.spec.ts" --colors
```

## Test coverage (the floor — extend if you see gaps)

Parse-level (`index-ddl-roundtrip.spec.ts`, new describe
"declare schema: index WHERE-clause grammar", via a `declaredIndexes(body)` helper
that parses `declare schema main { ... }` and returns each `CreateIndexStmt`):

- plain partial index → `where` set, `isUnique` false, `tags` undefined.
- `unique index ... where ...` → `isUnique` true **and** `where` set.
- partial index + `with tags` → both `where` and `tags` populated (clause order
  WHERE-before-WITH-TAGS).
- non-partial declared indexes (plain, tag-only, and a tag-only index **followed
  by another item**) → `where` stays `undefined`; the trailing item parses cleanly
  (guards the `WITH`-keyword backtrack `this.current--` is not stranded).
- non-trivial predicate `active = 1 and id > 0` → emits via `createIndexToString`,
  re-parses, and is a fixed point on re-emit (predicate fidelity).

End-to-end (`declarative-equivalence.spec.ts`, "indexes" describe) — these prove
the declared partial index flows parse → apply → catalog and matches the direct
`create index ... where` path (the harness compares the index `predicate` via
`eqExpr`, line ~194 of `test/util/schema-equivalence.ts`):

- partial index round-trips its WHERE predicate through declarative apply.
- unique partial index round-trips and enforces uniqueness within its predicate.

## Known gaps / things to scrutinize

- **Partial-exclusion semantics not asserted.** The unique-partial probe inserts
  two duplicates that **both** match `active = 1`. It does *not* assert that a
  duplicate where one row falls **outside** the predicate (`active = 0`) is
  *allowed* — i.e. that the unique check truly excludes non-matching rows. This was
  left out deliberately: it tests runtime partial-index enforcement semantics, not
  the parser gap this ticket closes, and I did not want to assert behavior I had
  not separately confirmed. If the reviewer wants the true partial-uniqueness
  guarantee pinned, add a probe and verify enforcement first (or file a follow-up).
- **Predicate variety is narrow.** Fidelity is tested with `active = 1 and id > 0`.
  `this.expression()` parses full expressions (subqueries, function calls, etc.),
  but no subquery/qualified-ref predicate is exercised in a declared index.
- **DRY duplication.** The WHERE-parse snippet now exists in two places
  (`createIndexStatement` and `declareIndexItem`). This was an explicit ticket
  call (inline mirror over a shared helper). Confirm you agree with that tradeoff.
- **`loc` on the declared `indexStmt`.** The declare-path `CreateIndexStmt` still
  carries no `loc` (pre-existing — the bare literal never set it). Unchanged by
  this fix; flag only if the differ/emit path ever needs index source positions.
