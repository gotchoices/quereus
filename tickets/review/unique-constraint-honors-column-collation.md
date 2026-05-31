description: UNIQUE enforcement now honors the column's declared collation (e.g. `col text collate NOCASE`) on every path — memory auto-index, memory MV validator, memory cold scan, store scan, store MV validator, AND the isolation-layer merge scan — instead of comparing BINARY. Ready for adversarial review.
prereq:
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/102.2-unique-collation.sqllogic, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/covering-structure.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts
----

## Summary

A non-PK `unique(col)` over a column with a non-binary declared collation (e.g.
`col text collate NOCASE`) was enforced with BINARY comparison, so `'abc'` and `'ABC'`
were stored as distinct — a soundness gap. Root cause: the auto-built UNIQUE index dropped
the column's collation, and every direct conflict validator defaulted `compareSqlValues`
to BINARY. `compareSqlValues(a, b, collationName)` and `ColumnSchema.collation` already
carry what's needed; the fix threads the column's declared collation into the index spec
and each comparison.

### What changed (6 enforcement sites + tests)

**Memory** (`manager.ts`):
- `ensureUniqueConstraintIndexes` — auto-index columns now carry
  `collation: this.tableSchema.columns[colIdx]?.collation`, so the `checkUniqueViaIndex`
  path (which builds key functions off `specCol.collation`) enforces the column collation.
  This mirrors what `SchemaManager.buildIndexSchema` already does for explicit
  `create unique index` (the ticket's working "control" case C).
- `checkUniqueViaMaterializedView` (row-time covering-MV validator) — pass
  `schema.columns[col].collation`.
- `checkUniqueByScanning` (cold primary-tree fallback) — pass
  `schema.columns[colIdx].collation`.

**Store** (`store-table.ts`):
- `findUniqueConflict` (per-scan source search) — bound `schema = this.tableSchema!`, pass
  `schema.columns[idx].collation`.
- `findUniqueConflictViaCoveringMv` (covering-MV validator) — pass
  `this.tableSchema!.columns[c].collation`.

**Isolation** (`isolated-table.ts`) — *not in the original ticket scope; see "Scope
expansion" below*:
- `findMergedUniqueConflict` (the merged underlying-vs-new scan) — pass
  `this.tableSchema!.columns[idx].collation`.

**Tests / docs:**
- New `test/logic/102.2-unique-collation.sqllogic` (runs under both `yarn test` and
  `yarn test:store`): table-level + inline NOCASE unique, OR IGNORE / OR REPLACE on a
  NOCASE dup, an explicit row-time covering MV variant, a non-NOCASE-equal control that
  still inserts, and an RTRIM trailing-space case.
- New `describe('collation-aware UNIQUE …')` in
  `packages/quereus-store/test/unique-constraints.spec.ts` (direct StoreModule, **no
  isolation**) — this is the only suite that exercises the two `store-table.ts` changes
  (the logic sweep goes through isolation): plain scan, covering-MV path, RTRIM.
- Corrected the misleading `102.1` §1 prose (the lowercase-`nocase` rejection is a
  collation-name case-sensitivity quirk, NOT "UNIQUE doesn't support collation"; uppercase
  `NOCASE` UNIQUE now enforces case-insensitively). Kept the lowercase `-- error: not
  supported` blocks — they still reflect current behavior.
- Updated the now-stale note in `covering-structure.spec.ts` ('non-binary collation
  bypasses the prefix fast path') that previously said end-to-end enforcement "still nets
  to BINARY … tracked by unique-constraint-honors-column-collation".

## Scope expansion the reviewer should scrutinize

The ticket enumerated 5 sites (2 memory validators + auto-index, 2 store validators). It
did **not** list the **isolation layer**, but `yarn test:store` wraps every table with
`createIsolatedStoreModule`, and the isolation layer enforces non-PK UNIQUE through its
**own** merge scan (`IsolatedTable.findMergedUniqueConflict`), not through
`store-table.ts`. With only the ticket's 5 sites fixed, store-mode §1 of `102.2` (plain
NOCASE unique, no covering MV) still failed — both rows inserted. Adding the isolation
site fixed it. (The parent ticket `covering-structure-mv-rowtime-enforcement`'s review
already noted the isolation layer is a distinct enforcement path — its follow-up #2.)

Consequence for coverage: **`yarn test:store` exercises the isolation site, not the two
`store-table.ts` sites.** Those are covered only by the direct-StoreModule tests in
`packages/quereus-store/test/unique-constraints.spec.ts`. Reviewer: confirm you're happy
with that split, and that no other isolation/store entry point compares UNIQUE values
BINARY (I checked the other `compareSqlValues` calls in `isolated-table.ts` — lines 548,
571, 993 are PK / index-sort-key comparators, out of scope; left BINARY).

## Validation (all green except one documented pre-existing failure)

- `yarn workspace @quereus/quereus run build` / `@quereus/store` / `@quereus/isolation`
  build — clean (typecheck).
- `yarn workspace @quereus/quereus run lint` — clean.
- Full memory suite (`yarn test`) — **4088 passing, 9 pending, 0 failing**.
- Full store suite (`yarn test:store`, run with `--no-bail`) — **4083 passing, 13 pending,
  1 failing**; the single failure is `51-lens-foundation.sqllogic` ("lens: logical table
  'appcar.Car' has no basis backing"), which is **pre-existing** lens-WIP on this branch:
  reproduced identically after `git stash` of all this ticket's changes. Documented in
  `tickets/.pre-existing-error.md` for the runner's triage pass.
- `@quereus/store` package suite — **279 passing** (+3 new). `@quereus/isolation` package
  suite — **68 passing**.
- Targeted `--grep "102\.2|102\.1|54-covering"` passes under BOTH memory and store mode.

## Use cases to probe (reviewer's starting points, not a ceiling)

- **NOCASE, no covering MV** — `create table t (id integer primary key, x text collate
  NOCASE, unique(x))`; insert `'abc'` then `'ABC'` ⇒ must ABORT; `'abd'` still inserts.
  (memory: `checkUniqueViaIndex`; store-direct: `findUniqueConflict`; store-isolated:
  `findMergedUniqueConflict`.)
- **NOCASE + explicit row-time covering MV** (`create materialized view … as select x, id
  from t order by x`) ⇒ routes through the MV validators
  (`checkUniqueViaMaterializedView` / `findUniqueConflictViaCoveringMv`). OR REPLACE must
  evict the recovered source row.
- **Composite UNIQUE with a mix of BINARY + NOCASE members** — I did NOT add an explicit
  composite-mixed-collation regression; the per-column threading makes it correct by
  construction, but it's an untested combination worth a probe.
- **UPDATE onto a NOCASE-equal value**, and **PK-changing UPDATE**, under NOCASE — the
  store-package suite covers BINARY UPDATE/PK-change but my new collation block covers
  INSERT paths only; UPDATE-under-collation is correct-by-construction but not directly
  asserted.
- **`collate RTRIM`** trailing-space dup (covered, both files) — a second collation to
  prove generality beyond NOCASE.

## Known gaps / honest caveats

- **`checkUniqueByScanning` (memory cold scan) is not directly covered.** The auto-index
  always services a declared UNIQUE, so this fallback only fires for "pathological schemas"
  with no covering structure — I could not drive it from SQL. The one-line change is
  correct-by-construction (same `schema.columns[colIdx].collation` thread) but unverified
  by an executing test. Flagged for the reviewer to decide if a white-box test is warranted.
- **UPDATE-under-collation** not directly asserted (see use cases) — INSERT paths are.
- **Out of scope (intentional):** lowercase `collate nocase` is still rejected at DDL by a
  collation-name case-sensitivity quirk in `validateColumnSchema` (case-sensitive
  `supportedCollations.includes`). Filed as
  `tickets/backlog/unique-collation-name-case-insensitive-normalization.md`. Not required
  for this fix; the `102.1` prose was corrected to explain it.
- **Binary columns are unchanged:** `compareSqlValues` defaults the collation arg to
  BINARY, `ColumnSchema.collation` defaults to `'BINARY'`, and
  `createTypedComparator(t, undefined)` already resolves to `BINARY_COLLATION` — so passing
  an explicit `'BINARY'` is identical to the prior `undefined`. The full memory suite
  (4088) corroborates no binary-path regression.

## Notes

- Pre-existing soundness gap discovered while reviewing
  `covering-structure-mv-rowtime-enforcement`; broader than the covering-MV feature.
- Do **not** "fix" the lowercase-`nocase` normalization here (see backlog ticket).
