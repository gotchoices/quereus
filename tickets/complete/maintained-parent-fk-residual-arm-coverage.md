description: Test additions for join-residual, prefix-delete, and cross-schema FK parent-side enforcement coverage on maintained tables.
files:
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts                  # 5 new test cases
  - packages/quereus/test/logic/51.85-maintained-table-parent-fk.sqllogic        # new; store-backend coverage
----

# Complete: maintained-parent-fk-residual-arm-coverage

## What was implemented

Pure test-coverage ticket. No engine changes. Extended parent-side FK
enforcement coverage for maintained tables across two previously-uncovered
maintenance arms plus a cross-schema variant, and added a LevelDB store-backend
sqllogic file.

### `maintained-parent-fk.spec.ts` — 5 new cases
- **join-residual arm** (1:1 inner join `t.fk not null → p.id pk`): CASCADE +
  RESTRICT. White-box asserts `registeredPlanKind('main.m') === 'join-residual'`.
- **prefix-delete arm** (lateral TVF fan-out via `generate_series`): CASCADE +
  RESTRICT. White-box asserts `'prefix-delete'`.
- **cross-schema**: maintained table `s2.m` (derived from `main.src`) and child
  `s2.c` both in `s2`; RESTRICT enforcement + clean unreferenced delete.
  White-box asserts `'inverse-projection'`.

### `51.85-maintained-table-parent-fk.sqllogic` — new
Store-backend coverage of all four declared FK actions (RESTRICT, CASCADE, SET
NULL, SET DEFAULT) via the inverse-projection arm — enforcement is arm-agnostic,
so one arm exercises the shared action engine on the store code path.

## Review findings

### Scope checked
Read the full implement diff (commit `8201bb39`) with fresh eyes before the
handoff, then the entire `maintained-parent-fk.spec.ts` file, the engine's
maintenance-arm registration (`database-materialized-views.ts`), the reverse-FK
index (`schema/manager.ts`), FK construction (`constraint-builder.ts`), and the
FK parser (`parser.ts`). Ran in-memory tests, the store-backend sqllogic, and lint.

### Correctness / SPP / DRY / maintainability — clean
- New tests follow the established file conventions (shared `readAll`/`count`/
  `expectError` helpers, `registeredPlanKind` white-box probe, per-arm
  `seedX(childFk)` factories). No duplication, no drift.
- The white-box arm assertions are **meaningful, not vacuous**: all five arm
  kinds (`join-residual`, `prefix-delete`, `inverse-projection`,
  `residual-recompute`, `full-rebuild`) are real `kind` discriminants in
  `database-materialized-views.ts`; a routing change would fail the assertion
  rather than silently test the wrong path.
- Per-arm coverage is CASCADE + RESTRICT only (not all four actions). This is a
  deliberate, file-documented design: enforcement is arm-agnostic, so once an arm
  is proven to realize a backing delete-key, the shared action engine is already
  exercised by the inverse-projection arm's full 4-action suite. Not a gap.
- The join/fan-out seeds are sound — `t` is a valid FK child of `p` (deleting `t`
  is unconstrained), the join is provably 1:1 (NOT NULL → PK) so `m` keys by
  `t.id`, and the fan-out references a specific interior row `(1,2)`. RESTRICT
  cases assert full rollback with specific surviving-row images.

### Cross-schema redesign — verified honest, not test-masking
The handoff redesigned the cross-schema case (both child and parent in `s2`
rather than child in `s2` / parent in `main`) and called the original scenario a
"known engine limitation." **Independently confirmed this is real**, not a
worked-around bug:
- `parser.ts:4534` `foreignKeyClause()` consumes a single unqualified identifier
  for the parent table — `references main.m(id)` is inexpressible.
- `constraint-builder.ts:96` hardcodes `referencedSchema: childSchemaName`; the
  engine resolves parents as `fk.referencedSchema ?? childSchema` across ~12
  sites (reverse-FK index, validators, multi-source planner, ALTER).
So a child in `s2` can never reference a parent in `main`. The redesigned test is
a valid enforcement test; the handoff's documentation is accurate.

### Disposition of findings
- **Minor (fixed inline):** none required — implementation and tests are clean.
- **Major (filed):** `tickets/backlog/cross-schema-fk-references.md` — the
  confirmed cross-schema FK limitation (parser + schema layers) is a genuine
  capability gap. Filed so the maintained-table-in-`main` / child-in-`s2`
  parent-side case (and ordinary cross-schema FKs) can be covered once supported.
- **Pre-existing, out of scope (documented, not actioned):** the SET DEFAULT
  transitive-recursion caveat (nested SET DEFAULT → RESTRICT) remains untested;
  it is a status-quo gap noted in the original ticket, not introduced here.

### Docs
No engine behavior changed, so no doc updates were warranted. The new tests are
self-documenting via their arm-routing comments; the cross-schema limitation is
now captured in the backlog ticket rather than only in test comments.

## Test results
- `node test-runner.mjs --grep "Parent-side referential enforcement for maintained-table maintenance writes"`: **25 passing**
- `node test-runner.mjs --store --grep "51.85"`: **1 passing** (LevelDB store backend)
- `yarn lint`: **clean** (eslint + `tsc -p tsconfig.test.json --noEmit`)
