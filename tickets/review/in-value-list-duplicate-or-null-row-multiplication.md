description: Review the fix for `WHERE col IN (<value-list>)` returning duplicated / spurious rows when the list has a duplicate literal or a NULL. Fix landed in the memory-vtab IN multi-seek (plan=5) runtime choke point: skip NULL/NULL-containing seek keys and dedup yielded rows by primary key.
prereq:
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts (THE FIX — multi-seek branch + new `seekKeyHasNull` helper + BTree import), packages/quereus/test/logic/07.9-in-value-list.sqllogic (new regression, dual-mode), packages/quereus/test/optimizer/secondary-index-access.spec.ts (new "IN multi-seek set membership (dup/NULL regression)" describe block), packages/quereus/src/vtab/memory/layer/scan-plan.ts (where equalityKeys is built, plan=5), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (emits the multi-seek IndexSeekNode — NOT modified; see deferral), packages/quereus/test/fuzz.spec.ts (distinct-elimination differential property — touched only to bump numRuns during validation, reverted)
----

## What was wrong (confirmed root cause)

`WHERE col IN (v1..vn)` on an **indexed** memory-vtab column compiles to a multi-seek
`IndexSeekNode` (`plan=5`), and the memory `xBestIndex` marks the IN filter *handled*,
dropping the residual `col IN (...)` FilterNode. The multi-seek thus had to be
set-membership-exact, but `scanLayer`'s multi-seek branch had two faults:

- **Fault A — duplicate literal multiplied rows.** `equalityKeys = [5, 5]` → two point
  seeks → the matching row yielded twice (bag, not set).
- **Fault B — NULL element triggered a full scan.** `in (5, null)` → a `null` seek key;
  both point-seek branches gate on `if (plan.equalityKey != null)` (loose `!=`), and
  `null != null` is false, so execution fell through to the unbounded range/full-index
  walk → every row yielded.

Specific to the memory-vtab indexed path: with no index the IN stays a residual scalar
`InNode` (correct), and the store module never marks IN handled (also keeps the residual
filter). `select distinct *` masked the bug because DISTINCT collapsed the bag back to a
set; `distinct-elimination` then correctly removed a now-redundant DISTINCT over a
PK/UNIQUE-backed set, exposing the already-violated set invariant (this is the fuzz
divergence the source ticket caught).

## What was done (the fix)

Single runtime choke point: **`scanLayer`'s multi-seek branch**
(`packages/quereus/src/vtab/memory/layer/scan-layer.ts`). This covers single-column,
composite, PK, secondary-index, and literal **and** dynamic seek keys (values are
concrete at this point). Two changes inside the branch:

- **NULL-skip:** a new module-level `seekKeyHasNull(key)` helper skips any seek key that
  is `null` (scalar) or contains a `null` component (composite tuple) before recursing.
  `x IN (…, NULL)` is TRUE on a non-null equal element else NULL ⇒ the WHERE excludes the
  row; a tuple with a NULL component makes the row-value comparison NULL ⇒ no match. This
  also closes Fault B's fallthrough (a non-null key always satisfies `equalityKey != null`).
- **Dedup-by-PK:** a `BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>` keyed by
  `primaryKeyComparator` accumulates the PKs of yielded rows across the whole multi-seek;
  `if (!seen.insert(pk).on) continue;` drops a row already yielded by an earlier seek.
  Keying on physical row identity (the PK) is **collation-agnostic**, so two case-variant
  literals (`'A'`,`'a'`) hitting the same NOCASE index entry collapse correctly — a naive
  key-compare would not.

Dedup scope is correct across MVCC layers: `MemoryTable.query()` calls
`manager.scanLayer(startLayer, plan)` on a **single** layer whose inherited BTrees already
present the full merged view, so the whole `equalityKeys` list is processed (and deduped)
within one `scanLayer` call.

## How to validate

- `yarn workspace @quereus/quereus test` — full memory suite. **4426 passing, 9 pending,
  0 failing** as handed off.
- `yarn workspace @quereus/quereus test --grep "in-value-list"` — the new dual-mode
  regression file.
- `yarn workspace @quereus/quereus test --grep "Secondary index access path selection"`
  — 17 passing, incl. the 5 new dup/NULL multi-seek tests that **assert the `INDEXSEEK`
  plan is chosen** (so they prove the fixed path runs, not the residual fallback).
- `yarn workspace @quereus/quereus test:store --grep "in-value-list"` — confirms the new
  file also passes via the store module's residual-filter path (set-membership identical).
- Fuzz: `yarn workspace @quereus/quereus test --grep "distinct elimination produces
  identical results"`. Validated green at **numRuns 300 × 4 runs** (the file is back at
  its default 25). The harness is **not seed-reproducible** (pre-existing, see source
  ticket) — re-running a few times is the only confidence lever.

### Live behavior (memory, post-fix) — the source ticket's acceptance
```
select * from t where v in (5)        → [{k:1,v:5}]            (1 row)
select * from t where v in (5, 5)     → [{k:1,v:5}]            (1 row, was 2)
select * from t where v in (5, null)  → [{k:1,v:5}]            (1 row, was 3)
select * from t where v in (5, 5, 9)  → [{k:1,v:5}]            (1 row, was 2)
select id, c_real2 from t1 where c_real2 in (0, null, 0, 820)  → {0, 820} once each
```
(`create table t (k integer primary key, v integer unique); insert into t values (1,5),(2,7)`)

## Test coverage map (the floor — extend, don't trust as exhaustive)

`07.9-in-value-list.sqllogic` (result-set assertions only, so it runs in BOTH memory and
store mode) covers: (a) duplicate literal, (b) NULL element, (c) both, plus an
empty-result dup `in (9,9,null)` and a two-distinct-values-each-duplicated case;
(d) IN on PRIMARY KEY; (e) composite-index cross-product with duplicate + NULL (collapse
to 1 row, to a 2-row subset, and a no-collapse 4-row case); (f) every case with and
without DISTINCT; the REAL-UNIQUE fuzz-shape `c_real2 in (0,null,0,820)`; and a
non-indexed column exercising the residual-filter path.

`secondary-index-access.spec.ts` adds plan-shape-pinned cases (UNIQUE dup, UNIQUE NULL,
non-unique secondary index dup+NULL with two distinct matches, PK dup+NULL, composite
cross-product dup+NULL) — these assert `INDEXSEEK` so a future regression that silently
drops back to a residual filter would still be caught by the .sqllogic but the *path*
itself is locked here.

## Known gaps / deliberate decisions (reviewer should weigh these)

- **Optional planner cleanup NOT done** (intentional). The source ticket's optional item —
  dedup/NULL-drop of *literal* values in `rule-select-access-path.ts`'s single-column
  (~line 338) and composite (~line 374) multi-seek builders — was skipped. It is
  perf/clarity only and **cannot replace** the runtime fix (dynamic/parameter seek values
  are unknown at plan time). Consequence: EXPLAIN's `inCount` still reflects the raw list
  length including NULL/duplicate literals (e.g. `in (5, null, 5, 9)` reports
  `inCount=4`). Purely cosmetic. If the reviewer wants honest `inCount`/EXPLAIN, file a
  follow-up `plan/` ticket — keep it a pure subset of the runtime behavior and don't
  regress the dynamic path. No existing plan-shape test asserts `inCount`, so nothing
  needed updating.
- **Memory cost of dedup.** The `seen` BTree holds one PK per *matched* row for the
  duration of the multi-seek — O(matched rows) memory. Necessary for correct dedup and
  bounded by result size; flagged for awareness, not a concern at expected scales.
- **No white-box layer-level unit test** for the multi-seek (the
  `scan-layer-descending.spec.ts` exists and is the natural home if the reviewer wants
  one). Coverage is end-to-end (sqllogic) + plan-pinned (optimizer spec) instead.
- **Transaction overlay + IN-dup not separately unit-tested.** The dedup is provably
  within one `scanLayer` call on the merged view, and the full suite (which includes
  transaction scenarios) is green, but there is no explicit `BEGIN; … IN (5,5) … ROLLBACK`
  regression. Cheap to add if the reviewer wants belt-and-suspenders.

## Suggested adversarial probes for review

- Re-run the fuzz property several times (not seed-reproducible) — confirm no IN-related
  divergence resurfaces.
- A NOCASE/custom-collation UNIQUE index with two case-variant IN literals
  (`v in ('A','a')`) on a single stored row → must yield that row exactly once (the
  collation-agnostic PK dedup is the reason a naive key-compare was rejected).
- IN on a **non-unique** secondary index where one seek key legitimately matches multiple
  distinct rows interleaved with a duplicate seek key → distinct rows must all survive
  while the duplicate collapses (covered by the "two distinct matches" optimizer test;
  worth poking with larger fan-out).
- Composite IN where the cross-product is large and partially NULL-bearing → confirm only
  the fully-non-null tuples seek and rows dedup correctly.
