description: COMPLETE — `declare schema { ... }` now parses an optional WHERE predicate on index items, so partial indexes round-trip through declarative apply. Reviewed: parser mirror verified, partial-exclusion runtime semantics now asserted, grammar doc updated.
prereq:
files:
  - packages/quereus/src/parser/parser.ts                   # declareIndexItem (~L3493-3516): WHERE parse + threaded `where`
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # "declare schema: index WHERE-clause grammar" parse tests
  - packages/quereus/test/declarative-equivalence.spec.ts   # "indexes" describe: partial + unique-partial e2e (exclusion probes added in review)
  - docs/sql.md                                             # declare-schema grammar example: partial index form added in review
  - packages/quereus/src/emit/ast-stringify.ts              # createIndexToString emits WHERE (pre-existing, unchanged)
  - packages/quereus/src/schema/ddl-generator.ts            # generateIndexDDL emits WHERE (pre-existing, unchanged)
----

# Complete: `declare schema` index WHERE-clause grammar gap

## What landed

`declareIndexItem` (parser.ts ~L3493) now parses an optional `WHERE <predicate>`
between the column list's `RPAREN` and the `WITH TAGS` block — a four-line mirror
of the standalone `createIndexStatement` path — and threads `where` onto the
constructed `CreateIndexStmt`. No AST change was needed (`CreateIndexStmt.where`
pre-existed and is already read by `createIndexToString` / `generateIndexDDL`).
A partial index can now be expressed inside `declare schema { ... }` and
round-trips through parse → emit → apply unchanged.

This unblocks end-to-end testing of partial-predicate body drift in the
follow-on `schema-differ-ignores-index-body-drift` differ work.

## Review findings

Adversarial pass over commit `5d61ef2e`. Read the full diff before the handoff
summary; scrutinized parser correctness, the test floor, runtime semantics, DRY,
type safety, and docs.

**Checked — parser correctness (no finding).** The lifted WHERE snippet is a
byte-faithful mirror of `createIndexStatement` (parser.ts L2612-2615), placed in
the correct grammar position (after columns, before `WITH TAGS`). The `WITH`
backtrack (`this.current--`) is unaffected; `this.expression()` cannot greedily
consume a trailing `WITH`. A regression test (tag-only index *followed by another
item*) confirms the cursor is not stranded.

**Fixed inline — partial-exclusion runtime semantics now asserted (was the
implementer's chief flagged gap).** The unique-partial e2e case previously
inserted only two *in-scope* (`active = 1`) duplicates, so it could not
distinguish a partial unique index from a full one at runtime — a dropped WHERE
would still have failed identically (the schema-level `eqExpr` predicate compare
in `schema-equivalence.ts:194` did already guard predicate *fidelity*, but not
*enforcement scope*). I first confirmed the runtime honors the predicate
(memory: `vtab/memory/layer/manager.ts` short-circuits out-of-scope rows to "no
conflict"; `base.ts populateNewIndex` skips them; store: `store-module.ts`
`validateUniqueOverExistingRows` / `buildIndexEntries`), then extended the case
with probes proving an OUT-OF-scope duplicate (`active = 0`, same name) is
*admitted* on both the direct and declarative paths, and that the in-scope key
is still enforced afterward. Both new probes pass on both paths.

**Fixed inline — grammar doc updated.** `docs/sql.md` (~L154) showed the
`declare schema` index-item grammar but only the plain `index … on …(…)` form;
the new partial capability was undocumented. Added a `unique index … where …`
example (verified it parses). `docs/schema.md` already documents the partial
`WHERE` round-trip for the direct/import path and needed no change. No other
file the change touches (`ast.ts`, `ast-stringify.ts`, `ddl-generator.ts`) was
modified by the fix, so their docs remain accurate.

**Checked — DRY (no finding; agree with the tradeoff).** The WHERE-parse snippet
is now duplicated in `createIndexStatement` and `declareIndexItem`. This was an
explicit ticket call (inline mirror over a shared helper). I concur: the snippet
is trivial (2 effective lines), the two call sites build structurally different
literals, and the sibling `WITH TAGS` parse is *already* duplicated across the
same declare-item family — extracting only WHERE would be inconsistent. Not worth
a helper.

**Checked — no finding, noted only:**
- `loc` is absent on the declare-path `CreateIndexStmt` (pre-existing; the bare
  literal never set it). Unchanged by this fix; flag only if the differ/emit path
  ever needs index source positions.
- Predicate variety in the parse/e2e tests is modest (`active = 1 and id > 0`,
  `is not null`); `this.expression()` parses arbitrary expressions, so no
  subquery/qualified-ref predicate is exercised in a *declared* index. Low value
  to add — the expression parser is shared with the well-covered direct path.
- The `property.spec.ts` declarative dragnet does not generate partial declared
  indexes. Out of scope here; a fuzz-coverage extension could be filed if desired.

**Major findings filed as new tickets:** none. All findings were minor and fixed
in this pass.

## Verification

All green on branch `view-updates-lens`:

- `index-ddl-roundtrip.spec.ts` + `declarative-equivalence.spec.ts` +
  `schema-differ.spec.ts` + `schema-manager.spec.ts` — **195 passing**, exit 0
  (was 176 + 14 roundtrip; +19 reflects the broader suite set plus the added
  exclusion probes).
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus run typecheck` — exit 0.
- Doc example in `sql.md` confirmed parseable (partial unique index → `where`
  set, `isUnique` true).

## End
