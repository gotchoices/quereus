description: Review the live-exec implementation of `create table … maintained [(columns)] as` honoring the rename-list clause — the clause is now the single source of truth for `derivation.columns` on the live-create channel (implicit ⇒ undefined/reshape, explicit ⇒ declared names/arity-lock, mismatched ⇒ sited error), so live exec and catalog import of the same canonical DDL agree on the record and the bodyHash.
files:
  - packages/quereus/src/parser/parser.ts                            # parseMaintainedClause — empty `maintained () as` list now rejected
  - packages/quereus/src/planner/building/ddl.ts                     # raiseCreateMaintainedDiagnostics + new raiseMaintainedColumnListDiagnostics (build-time arity + positional name match)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # describeAttachShapeMismatch(skipNames), attachMaintainedDerivation(recordedColumns, positionalRename), createMaintainedTable
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — attach verb now passes declared names explicitly (unchanged behavior)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # new 'live-exec table-form authored columns' block (8 tests)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # new 'table-form authored' fixed-point matrix (3 rows)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts           # new table-form implicit reshape-on-reopen test
  - docs/materialized-views.md                                       # § CREATE TABLE … MAINTAINED AS — new "The maintained (columns) rename list" subsection
difficulty: medium
----

# Review: table-form maintained DDL live-exec honors the `maintained (columns)` clause

The implement stage landed all five gaps the plan ticket specified. Build + lint
+ full quereus suite (5950 passing, 0 failing) + full store suite (544 passing, 0
failing) are green. **Treat this as a starting point** — the tests below are a
floor, and there is one deliberate, documented deviation from the plan ticket's
literal "Mechanically" wording (see *Deviation* below) that a reviewer should
sanity-check against the plan's intent.

## What changed (and why it's correct)

The `maintained [(columns)]` clause is now the single source of truth for
`derivation.columns` on the live-create channel, matching what persist + import
already did:

- **Parser** (`parseMaintainedClause`): an empty `maintained () as` list throws a
  parse error ("Expected at least one column name…"). Shared by `create table`
  and `declare schema` table items, so both reject it.
- **Build-time** (`raiseMaintainedColumnListDiagnostics`, called from
  `raiseCreateMaintainedDiagnostics`): when a list is present it must have one
  entry per declared column and each entry must match the declared column name at
  the same position (case-insensitive). Wrong-arity → sited error; name mismatch →
  sited error naming the first mismatching position. Kills gap 3's silent drop.
- **Runtime** (`createMaintainedTable` → `attachMaintainedDerivation`): threads
  two signals instead of one (see *Deviation*):
  - `recordedColumns` → recorded verbatim as `derivation.columns`: declared names
    for the explicit forms (attach verb + `maintained (columns)` create),
    `undefined` for the implicit `maintained as` create. `buildTableDerivation`
    hashes it, so `bodyHash` follows automatically.
  - `positionalRename` (true only for `maintained (columns)` create): renames the
    body outputs positionally to `recordedColumns` and skips the per-column NAME
    comparison in `describeAttachShapeMismatch` (new `skipNames` param). Types,
    not-null (both ways), collations, and the physical PK stay strict.
- **Docs**: new subsection documenting implicit (clause-free / reshape) vs
  explicit (clause / arity-lock) live-create semantics.

## Deviation from the plan ticket's "Mechanically" paragraph — REVIEW THIS

The plan said *"thread an optional `explicitColumns` … use it for both the
shape-check name handling and `def.columns`"* with the alter-attach caller passing
declared names "as today". A **single** `explicitColumns` param cannot express all
three required behaviors, because two cases pass declared names but must behave
differently:

| Path | shape name check | `derivation.columns` |
|------|------------------|----------------------|
| `alter table … set maintained as` | **strict** (names must match) | declared names |
| `create table … maintained as` (implicit) | strict | **undefined** |
| `create table … maintained (cols) as` (explicit) | **skipped** (positional rename) | declared names |

A single param keyed on presence would either (a) make the implicit create record
declared names instead of `undefined` (re-breaking gap 1), or (b) make the attach
verb lenient (positional rename), which contradicts the plan's *"the attach verb
is **unchanged** … create-vs-attach parity stays parked in backlog ticket
`maintained-table-reattach-columns-parity-and-reshape`"*. So I split it into
`recordedColumns` + `positionalRename`. The net behavior matches the plan's stated
intent exactly; only the parameter shape differs. **Reviewer: confirm you agree
the attach verb should stay strict** (no existing test pins a name-MISMATCH on the
attach verb — the attach pins all use bodies whose names already match — so the
strictness is intent-driven, not test-pinned).

## Use cases to validate (the test floor)

Added 8 live-exec tests (`maintained-table-attach-detach.spec.ts` →
`live-exec table-form authored columns`) covering all three plan gaps:

1. **Gap 1 (implicit loses implicitness)** — `create table t (id, v) maintained
   as select * from src` records `columns === undefined`, regenerates clause-free
   DDL, and live exec vs `importCatalog` of that DDL agree on `derivation.columns`
   AND `bodyHash`.
2. **Gap 2 (canonical renamed-MV not live-consumable)** — the exact DDL
   `generateMaintainedTableDDL` emits for `create materialized view mv (key_id,
   val) as select id, v from src` replays through **live `db.exec`** (a migration
   script, not import), regenerates byte-identical, and maintains live. Pre-fix
   this errored "body output column 1 is named 'id' but the table declares
   'key_id'".
3. **Gap 3 (mismatched list silently dropped)** — `maintained (x, y)` on a
   `(id, v)` table is a sited name-mismatch error; wrong-arity (`maintained (id)`)
   and empty (`maintained ()`) lists also error; nothing registers.
4. Casing: `maintained (ID, V)` on `(id, v)` accepted, recorded in declared casing.
5. Presence-is-the-contract: `maintained (id, v)` where body names already equal
   declared still arity-locks (records explicit).

`view-mv-ddl-persistence.spec.ts` gains a 3-row table-form-authored fixed-point
matrix (implicit omits the clause; explicit single/multi keep it).

`mv-rehydrate-adopt.spec.ts` gains the store reshape twin: a table-form **implicit**
`select *` MV reshapes (refills to the wider shape) on reopen after a source
widening — the live-create-channel analogue of the existing sugar `select *`
reshape test.

Pins confirmed still green (untouched behavior): the attach-verb explicit-list
round-trip (`maintained (id, v) as`), the MV-sugar-with-renames round-trip, the
store catalog fixed-point, and the import-path arity/eligibility gates.

## Known gaps / things to scrutinize honestly

- **No backwards-compat for pre-fix backings.** A backing persisted by a *pre-fix*
  session carries `maintained (id, v)` for what should now be implicit, and reopens
  arity-locked. Accepted per project rules (no backwards-compat yet); the POST-fix
  fixed point holds from the first persist. No migration was written and none is
  expected — confirm that's acceptable.
- **Coarsened-key naming under positional rename.** When `positionalRename` passes
  `recordedColumns` to `deriveBackingShape`, a coarsened lineage key's
  `CoarsenedKeyInfo.columns` now reports the *declared* names rather than the body's
  natural names (more correct, but not separately unit-tested — no rename+coarsened
  combo in the new tests). Low risk; flag if you want explicit coverage.
- **`declare schema` differ idempotence** is covered only transitively by the green
  full suite (the differ compares `declared.columns` as-authored via
  `maintainedBodyMatches`, which already accepts the implicit/explicit signal). I
  did **not** add a dedicated declare-schema test asserting that a declared explicit
  list on an unchanged live table is a no-op. Recommend a spot-check.
- **Redundant shape check.** `createMaintainedTable` runs the shape check once
  before table creation and the shared attach core runs it again after — both now
  apply the `skipNames`/rename logic, kept consistent by hand. If they ever drift,
  the explicit-create path could behave inconsistently between the early reject and
  the post-registration reject.
- **Store tests need a current quereus `dist`.** The store package imports the
  **built** `@quereus/quereus`; re-running the store suite requires `tsc`/`yarn
  build` in `packages/quereus` first (the implement run rebuilt it). A stale dist
  silently runs the old behavior (this bit me once during implement).

## Validation run

- `packages/quereus`: `npx tsc --noEmit` clean; `yarn lint` clean; full mocha
  suite **5950 passing / 0 failing / 9 pending**.
- `packages/quereus-store`: full mocha suite **544 passing / 0 failing** (was 543;
  +1 new test). The logged "Data change listener error: Error: boom" is an existing
  test's deliberate throw, not a failure.
- Did NOT run `yarn test:store` (LevelDB re-run) or `test:full` — out of scope per
  the plan ticket's "run quereus test, lint, store test".
