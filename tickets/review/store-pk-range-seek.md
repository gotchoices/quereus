description: Review StoreTable.scanPKRange seek + early-termination — buildPKRangeBounds derives encoded-byte gte/lt window from leading-PK LT/LE/GT/GE constraints (DESC swap, custom-collation fallback); matchesFilters stays authoritative.
files:
  - packages/quereus-store/src/common/store-table.ts        # buildPKRangeBounds (new), scanPKRange (rewritten), getCollationEncoder import
  - packages/quereus-store/src/common/store-module.ts        # honorsCollatedRangeBounds doc + range-scan comment (now-accurate seek wording)
  - packages/quereus-store/test/pushdown.spec.ts             # DESC seek, comparator-only fallback (white-box), window-narrowing (counting store), empty window, reads-own-writes
difficulty: medium
----

# Review: store PK range-scan seek + early-termination

## What landed

`StoreTable.scanPKRange` no longer full-scans + post-filters. It now:

1. calls the new `buildPKRangeBounds(access)` to derive ONE `IterateOptions`
   window (`gte`/`lt`) from the leading-PK-column range constraints, then
2. iterates that narrowed window via `iterateEffective`, with `matchesFilters`
   remaining the authoritative collation-aware row filter (the window is a
   guaranteed **superset**, so over-fetch is fine, under-fetch is the bug class
   to watch for).

### `buildPKRangeBounds` (store-table.ts:783)

Per leading-PK constraint, encodes the bound value under the SAME per-column
DESC direction + key collation the data keys use (reuses the existing
`encodePkPrefixBounds([value])`), giving the byte region `[lo, hi)` whose leading
column == value. Op → endpoint mapping, with the lower/upper assignment swapping
under DESC (bit-inversion makes larger value ⇒ smaller bytes):

| op | ASC      | DESC     |
|----|----------|----------|
| GE | gte = lo | lt  = hi |
| GT | gte = hi | lt  = lo |
| LE | lt  = hi | gte = lo |
| LT | lt  = lo | gte = hi |

Combine across constraints: **max** of lower candidates → `gte`, **min** of
upper candidates → `lt` (via `compareBytes`). Skips:
- a `null`/`undefined` bound value (superset-safe; planner never pushes `= NULL`),
- an `hi` that overflowed all-`0xff` (`incrementLastByte` → `undefined`; that side
  stays unbounded).

Custom-collation fallback: if the leading text PK column's key collation has **no
registered byte encoder** (`getCollationEncoder(coll) === undefined`), returns
`buildFullScanBounds()` — because `encodeText` would silently key it under NOCASE
bytes that don't track its logical order (under-fetch risk).

Doc comments updated in `store-module.ts` (`getBestAccessPlan`
`honorsCollatedRangeBounds` block + the range-scan branch comment) to replace the
now-false "visits the full key space / no seek-start" wording.

## Use cases to validate (what the tests pin)

All in `packages/quereus-store/test/pushdown.spec.ts`:

- **ASC seek correctness** — pre-existing `collated PK range seek` block (NOCASE
  `> 'banana'`, BETWEEN, RTRIM `> 'cat'` / `>= 'cat  '`, BINARY control) still
  passes — pins under-/over-fetch under collated bounds.
- **DESC leading PK** (`DESC leading primary key`) — `id > 2` ⇒ correct rows,
  `id between 2 and 3` ⇒ correct rows. Directly pins the lower/upper SWAP (a wrong
  swap that under-fetches shows up as missing rows).
- **Window narrowing** (`window narrowing …`) — a `CountingKVStore` tallies
  entries its `iterate` yields; a selective `id > 95` over 100 rows visits ≤ 5,
  not 100 — distinguishes a real seek from full-scan + filter (both return the
  same rows). Covers ASC and DESC.
- **Empty / contradictory window** — `id > 10 and id < 5` ⇒ `[]`, no throw, 0
  entries visited (`gte > lt`).
- **Reads-own-writes within bounds** — a pending insert (id=200) and a pending
  update (id=97) inside `id > 95` both surface mid-transaction.
- **Comparator-only collation fallback** — white-box: returns full-scan bounds
  (empty `gte`, no `lt`) when `pkKeyCollations[0]` has no byte encoder; positive
  control confirms a NOCASE PK DOES narrow.

## Validation run (all green)

- `yarn workspace @quereus/store run typecheck` — clean.
- pushdown.spec.ts — 21 passing.
- `yarn workspace @quereus/store test` — 554 passing (pushdown + backing-host +
  isolated-store + events; the rollback/rehydrate/"boom" log noise is intentional
  negative-test output).
- `yarn test` — all workspaces green (6077 main logic + others), EXIT 0.
- `yarn test:store` — 6073 passing against the LevelDB store (~2m), EXIT 0 — the
  memory-vs-store correctness pin for range scans holds.

## Honest gaps / reviewer attention

- **The custom-collation fallback branch is unreachable via DDL today.** The
  engine's `validateCollationForType` restricts TEXT column collations to
  BINARY/NOCASE/RTRIM — all of which HAVE byte encoders — so no validated column
  can carry an encoder-less collation. The branch is defensive against
  `encodeText`'s `?? NOCASE_ENCODER` silent fallback (and any future
  custom-collation-column feature). Because it's unreachable through `db.exec`,
  the test exercises it **white-box** by assigning `pkKeyCollations = ['CUSTOMSORT']`
  on a real table via a cast. Reviewer calls: (a) is the defensive branch worth
  keeping vs. an assertion/invariant comment? (b) is the white-box mutation
  acceptable, or would a hand-constructed `TableSchema` be preferred?
- **Contradictory-bounds no-throw is unit-tested only against `InMemoryKVStore`.**
  The ticket asked to also confirm the LevelDB provider tolerates `gte > lt`. That
  isn't a dedicated unit test here; coverage is indirect via `yarn test:store`
  (the full logic suite, incl. range queries, re-run on LevelDB, passing). If a
  reviewer wants belt-and-suspenders, add an explicit LevelDB `gte > lt` iterate
  test in the leveldb plugin package.
- **Window-narrowing threshold (`<= 5` for an expected 4)** carries a 1-entry slack
  and relies on contiguous integer PK key bytes. Robust for the fixture but it's a
  heuristic, not an exact-count assertion.
- **No new cost-model / EXPLAIN assertions.** Plan output is unchanged by design
  (still the range/IndexSeek path the store already advertised); the existing
  `planOps` IndexSeek assertions in the collated block cover that the seek path is
  still chosen. The DESC tests assert rows only (not the plan), since `planOps` is
  scoped to the collated sub-describe.
- **`scanPKRange` only seeks on the LEADING PK column** (matches `analyzePKAccess`,
  which only forms a `range` access for `primaryKeyDefinition[0]`). Multi-column PK
  prefix seeks (e.g. `pk0 = a and pk1 > b`) are out of scope and still scan; the
  legacy planner doesn't forward those bounds anyway.
