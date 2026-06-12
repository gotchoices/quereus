description: Make the live exec path of `create table … maintained [(columns)] as` honor the rename-list clause — record `derivation.columns` as authored (the lossless implicit/explicit signal already used by persist + import), positionally rename body outputs when the list is present, and reject a mismatched list — so live exec and catalog import agree on the same canonical DDL text.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # createMaintainedTable, attachMaintainedDerivation (def.columns line ~788), describeAttachShapeMismatch
  - packages/quereus/src/planner/building/ddl.ts                     # raiseCreateMaintainedDiagnostics — build-time rename-list validation
  - packages/quereus/src/parser/parser.ts                            # parseMaintainedClause — reject an empty `maintained () as` list
  - packages/quereus/src/schema/manager.ts                           # maintainedImportFromTableStmt (reference convention — already correct, do not change)
  - packages/quereus/src/schema/ddl-generator.ts                     # generateMaintainedTableDDL (already emits derivation.columns — do not change)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # attach-verb explicit-list pins (must stay green) + new live-exec round-trip tests
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # canonical-DDL fixed-point matrix — add table-form-authored rows
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts           # reshape-on-reopen coverage (extend to the table-form authored channel)
  - docs/materialized-views.md                                       # § create table … maintained as — live-create clause semantics
difficulty: medium
----

# Table-form maintained DDL: live exec honors the `maintained (columns)` clause

Remainder of the `mv-table-form-implicit-columns-roundtrip` plan. The lossless
encoding itself **already landed** (commit `30c59342`): the grammar parses
`maintained [(columns)] as`, `AST.MaintainedClause.columns` exists,
`maintainedClauseToString` emits the list iff present,
`generateMaintainedTableDDL` rides `derivation.columns`, and
`maintainedImportFromTableStmt` restores `derivation.columns` from the clause
(never from the declared column list). Both store residual failures from the
plan ticket pass at HEAD (543/543 store tests green). **Do not re-design any of
that** — the convention is: clause present ⇒ explicit (arity-locked: a source
widened between sessions is a sited error); clause absent ⇒ implicit (a widened
`select *` reshapes on reopen).

What remains is that the **live exec channel** (`createMaintainedTable` →
`attachMaintainedDerivation`, reached by direct SQL and by declarative-differ
migration scripts) ignores `stmt.maintained.columns` entirely and always records
the declared table column names (`materialized-view-helpers.ts` ~line 788:
`columns: table.columns.map(c => c.name)`). Empirically verified at HEAD:

1. **Implicit-authored form loses implicitness live.**
   `create table t (id …, v …) maintained as select * from src` executed live
   records `derivation.columns = ["id","v"]` and persists
   `… maintained (id, v) as select * from src` — permanently arity-locked. The
   SAME text through `importCatalog` records `columns = undefined` with a
   different bodyHash (`UiU2BXMzGf8` live vs `1ki9OufgTiM` import). The two
   consumption channels disagree on identical DDL text.
2. **Canonical DDL of a renamed sugar MV is not live re-consumable.**
   `create table mv ("key_id" …, "val" …) maintained (key_id, val) as select id, v from src`
   (exactly what `generateMaintainedTableDDL` emits for
   `create materialized view mv (key_id, val) as select id, v from src`) errors
   live: `body output column 1 is named 'id' but the table declares 'key_id'`.
   A migration script replaying canonical catalog DDL fails.
3. **A mismatched rename list is silently dropped live.**
   `create table t4 (id …, v …) maintained (x, y) as select id, v from src`
   succeeds live with `derivation.columns = ["id","v"]` — the authored `(x, y)`
   is discarded without a diagnostic, while import would apply it as positional
   renames.

## Design (resolved — implement as specified)

The `maintained [(columns)]` clause is the single source of truth for
`derivation.columns` on **every** consumption channel:

- **No list (implicit).** Strict shape check unchanged (body must derive the
  exact declared shape, names included). Record `derivation.columns =
  undefined`. The canonical DDL then omits the clause, so reopen reshapes —
  matching what import does with the same text, and making
  live-create → persist → reopen → re-persist a byte-identical fixed point.
- **List present (explicit).** Validate at build time
  (`raiseCreateMaintainedDiagnostics`) that the list length equals the declared
  column count AND each entry matches the declared column name positionally
  (case-insensitive); a mismatch is a sited error (kills the silent drop, gap 3).
  In the shape check, the list is the authoritative output-name vector: body
  outputs are renamed positionally to it, so the per-column NAME comparison in
  `describeAttachShapeMismatch` is skipped (types, not-null exact-both-ways,
  collations, and the physical PK stay strict) — this is the same lenient
  positional-rename posture the import path already takes, and it makes the
  canonical renamed-MV DDL live-consumable (gap 2). Record `derivation.columns =
  the declared column names` (declared casing, so the generator's output is
  byte-identical to the sugar-create path's).
- **`alter table … set maintained as` (the attach verb) is unchanged.** It has
  no rename-list syntax and keeps recording the explicit declared names —
  pinned by `maintained-table-attach-detach.spec.ts` ("maintained \(id, v\) as").
  Attach → persist → reopen stays an explicit fixed point (an attached table
  arity-locks; its declared shape was authored). The create-vs-attach parity
  question stays parked in backlog ticket
  `maintained-table-reattach-columns-parity-and-reshape`.
- **Parser:** `parseMaintainedClause` currently accepts `maintained () as`
  yielding `columns = []` (stringify would drop it; import would arity-error).
  Reject the empty list with a parse error (require at least one column inside
  the parens).

Mechanically: thread an optional `explicitColumns` through
`createMaintainedTable` → `attachMaintainedDerivation` (the alter-attach caller
passes the declared names as today; the create caller passes
`stmt.maintained.columns` presence-mapped as above) and use it for both the
shape-check name handling and `def.columns`. `buildTableDerivation` computes
`bodyHash` from `def.columns`, so the hash follows automatically.

Consequences that are safe by existing machinery (verify, don't rebuild):

- The schema-differ's `maintainedBodyMatches` already accepts BOTH hash variants
  for an implicit declared body (`declared.columns === undefined ⇒ [undefined,
  liveColumnNames]`), so differ idempotence holds across the bodyHash flip for
  live-created implicit table-form tables.
- Sugar-create (`materialized-view.ts`) already records as-authored
  (`undefined` for implicit) — unchanged.
- The differ's migration script for a NEW declared maintained table renders via
  `createTableToString` → `maintainedClauseToString`, which carries the clause —
  so the declarative channel inherits this fix through live exec.

## Edge cases & interactions

- **Rename-list arity mismatch** (`maintained (a) as` on a 2-column table, and
  the `maintained () as` empty form): sited error (build-time arity check;
  parser rejects the empty list outright).
- **Rename-list name mismatch** (`maintained (x, y)` vs declared `(id, v)`):
  sited error naming the first mismatching position — no silent drop.
- **List in different casing than declared** (`maintained (ID, V)`): accepted
  (case-insensitive match), recorded in DECLARED casing so the regenerated DDL
  is canonical.
- **List present, body natural names already equal declared**: still recorded
  explicit (arity-locks on reopen) — presence is the contract, not need.
- **No list, body natural names differ from declared**: error, unchanged strict
  check ("alias the body output to match the declared shape").
- **Canonical renamed-MV DDL replayed live** (gap 2's exact text): creates,
  `derivation.columns` equals the rename list, regenerated DDL byte-identical.
- **Implicit live-create → store persist → reopen with widened source**: the
  reopen RESHAPES (no arity error) — the table-form-authored analogue of the
  `mv-rehydrate-adopt.spec.ts` source-shape-change tests, which only cover the
  sugar-created channel today.
- **bodyHash flip for live-created implicit table-form tables**: a backing
  persisted by a PRE-fix session carries `maintained (id, v)` and reopens
  arity-locked. Acceptable (no backwards-compat requirement per project rules) —
  but the POST-fix fixed point must hold from the first persist on.
- **`if not exists` with an existing table**: skips entirely before any
  validation side effect (unchanged posture; keep it that way when adding the
  build-time checks — they run on the planned statement, which is fine since
  diagnostics are pure).
- **`declare schema` declared-table items** parse the same clause through the
  shared `parseMaintainedClause`; the differ compares `declared.columns`
  as-authored (`maintainedBodyMatches`) — confirm a declared explicit list on an
  unchanged live table stays a no-op, and the empty-list parser rejection
  applies there too.
- **Attach-verb pins**: `maintained-table-attach-detach.spec.ts:229` and `:268`
  (explicit list in exported DDL after `set maintained as` / for renamed sugar
  MVs) must stay green untouched.
- **Declared table-level constraints on an implicit table form** (CHECK etc.):
  reshape-on-reopen interaction is owned by backlog ticket
  `maintained-table-declared-constraint-semantics` — do not regress, do not
  solve here.

## TODO

- Parser: reject empty `maintained () as` column list in `parseMaintainedClause`.
- Build-time validation in `raiseCreateMaintainedDiagnostics`: list arity ==
  declared column count; positional case-insensitive name match against
  declared columns; sited errors.
- Thread the authored columns through `createMaintainedTable` →
  `attachMaintainedDerivation`: shape check skips the name component when an
  explicit list is supplied (positional rename); `def.columns` records
  as-authored (undefined ⇒ implicit) for the create path, declared names for
  the alter-attach path (unchanged).
- Tests (quereus): live-exec round-trip — implicit table form records
  `columns === undefined` and regenerates clause-free DDL; canonical renamed-MV
  DDL replays live with byte-identical regeneration; mismatched / wrong-arity /
  empty list error; live exec vs `importCatalog` of the same text agree on
  `derivation.columns` AND `bodyHash`; attach-verb pins stay green.
- Tests (quereus): extend the `view-mv-ddl-persistence.spec.ts` fixed-point
  matrix with table-form-authored implicit and explicit rows.
- Test (store): table-form-authored implicit MV reshapes on reopen after a
  source widening (mirror of `mv-rehydrate-adopt.spec.ts:215` through the
  live-create channel).
- Docs: `docs/materialized-views.md` § "create table … maintained as" — document
  the live-create semantics of the clause (presence ⇒ explicit/arity-lock,
  absence ⇒ implicit/reshape; the list must match the declared column names).
- Run `yarn workspace @quereus/quereus run test`, lint, and
  `yarn workspace @quereus/store run test`.
