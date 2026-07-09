description: The persistent store now reads its secondary indexes — a query filtered on an indexed column seeks the index instead of scanning the whole table.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts        # index entry value now the data key (~1540); resolveIndexFromIdxStr (~886); analyzeIndexAccess (~916); buildIndexRangeBounds (~993); scanIndex (~1035); indexColumnCollations (~1121); matchesFilters collation override (~1069); query() index arm (~656)
  - packages/quereus-store/src/common/store-module.ts        # buildIndexEntries writes data key (~974); computeBestAccessPlan secondary-index branch (~1860); tryIndexAccessPlan (~1916)
  - packages/quereus-store/test/pushdown.spec.ts             # secondary-index scan describe (plan + handled + collation guard + partial + DESC + composite)
  - packages/quereus-store/test/index-persistence.spec.ts    # reattached index seek after reopen
  - packages/quereus-store/test/store-ryow.spec.ts           # pending index put/delete visible to a seek
  - packages/quereus-store/test/isolated-store.spec.ts       # overlay merge over an index scan
----

# Review: Store secondary-index scan read arm + access-plan surface

## What was built

Before this change the store maintained secondary indexes on every write but no
code ever read one — a predicate on an indexed column fell back to a full table
scan. This adds the read primitive and wires the planner to it.

Three moving parts:

1. **Index entries now carry the row's encoded data key as their value**
   (previously an empty `Uint8Array`). Both write paths changed:
   `StoreTable.updateSecondaryIndexes` (store-table.ts ~1540) and
   `StoreModule.buildIndexEntries` (store-module.ts ~974). An index scan resolves
   each entry to its base row by reading the data store at this stored key — the
   index-entry key's PK suffix is not losslessly recoverable to SqlValues, so the
   value-carries-the-data-key approach is used instead of decoding the suffix.

2. **The scan arm in `StoreTable.query`** (store-table.ts ~656): when the planner
   chose a secondary index (idxStr `idx=<name>(…)`), the store parses it
   (`resolveIndexFromIdxStr`), derives an encoded byte window over the index
   (`analyzeIndexAccess` → leading-prefix EQ *point* or leading-column LT/LE/GT/GE
   *range* via `buildIndexRangeBounds`, mirroring the PK arms), iterates it merged
   with pending ops (`iterateEffective(indexStore, …)` — read-your-own-writes over
   the index), resolves each entry to its row, and re-filters with `matchesFilters`.
   Emission stays in index-key byte order (load-bearing for the isolation overlay
   merge — see below).

3. **`getBestAccessPlan` now advertises the index** (store-module.ts
   `tryIndexAccessPlan` ~1916): sets `indexName` + `seekColumns` and marks the
   covered filters handled, so the planner emits the `idx=<name>(…)` idxStr and
   drops the residual Filter — *subject to a collation-safety guard* (below).

## How to exercise / validate

- **EQ + range on an indexed column** now plan as `INDEXSEEK` (was a SeqScan +
  residual). See `pushdown.spec.ts` → `secondary-index scan`. Quick SQL check:
  ```sql
  create table t (id integer primary key, age integer) using store;
  create index ix_age on t (age);
  insert into t values (1,30),(2,25),(3,30);
  select id from t where age = 30;     -- index seek → [1,3]
  select id from t where age > 25;     -- index range → [1,3]
  ```
- **Composite / DESC / leading-prefix** windows: composite `(a,b)` full-prefix EQ
  and leading-only EQ; a `v desc` index range. Covered in the same describe.
- **Read-your-own-writes over the index**: within a txn, a seek sees pending
  index puts/deletes (`store-ryow.spec.ts` → "secondary-index seek reads its own
  pending index puts and deletes").
- **Reopen**: entries written pre-close carry the data key, so after
  `closeAll()`→reopen an index seek resolves them without a rebuild
  (`index-persistence.spec.ts`).
- **Isolation overlay merge**: a secondary-index query under the isolation layer
  merges overlay-pending inserts/deletes over the committed index scan
  (`isolated-store.spec.ts` → "secondary-index scan under an open transaction").

## Collation safety — the subtle part; review here first

The index-column bytes are physically encoded under the **table key collation K**
(`config.collation`, default NOCASE), NOT the index's declared per-column
collation. `matchesFilters` re-checks under a comparison collation. Two guards
keep this correct:

- **Re-filter collation (store-table.ts `matchesFilters` + `indexColumnCollations`
  ~1069/1121).** For an index scan, `matchesFilters` compares an index column
  under the **index column's effective collation** (`indexCol.collate ?? column
  declared`), NOT the table column's declared collation. This is what the planner
  matched to decide whether to drop the residual. A store SQL-logic test caught
  the original omission: `create index ix on t(name collate NOCASE)` on a
  BINARY-declared `name` column, `where name = 'bob' collate NOCASE` returned 0
  rows (re-filtered under BINARY) instead of the NOCASE matches. Now fixed and
  covered by `06.4.2-collation-extras.sqllogic` in store mode.

- **Handled-marking guard (store-module.ts `tryIndexAccessPlan` `safeToHandle`).**
  A covered filter is marked handled (residual dropped) only when the K-window is a
  guaranteed **superset** of the index column's effective collation C: column
  non-text, OR C == K, OR (K == NOCASE while C == BINARY, i.e. K strictly coarser).
  Otherwise a **cost-only** plan is returned (cheaper cost, filters unhandled,
  residual retained — correct, just not sped up). A K with no registered byte
  encoder also degrades to cost-only. Covered by the `collation-unsafe index
  (K=BINARY over a NOCASE column)` test.

**Reviewer focus:** confirm the `safeToHandle` direction is right (K must be
coarser-or-equal to C, never finer) and that no reachable DDL produces a
finer-K/coarser-C combination that slips through as handled. The physical
K-vs-declared-index-collation encoding mismatch is a **pre-existing store quirk**
(the store never honored an index's per-column COLLATE in its physical bytes,
only K); this ticket does not fix it, only avoids under-fetch through it.

## Known gaps / things I deliberately did NOT do (treat my tests as a floor)

- **Legacy on-disk index stores are silently wrong until rebuilt — sharpest edge.**
  An index store written by an older build holds *empty* values. `scanIndex`
  skips an empty-value entry (`entry.value.length === 0 → continue`), but because
  the plan marked the filter handled and dropped the residual, an indexed query
  over such a store returns **nothing** rather than the matching rows — a silent
  wrong result, not an error. Backwards-compat is explicitly waived per AGENTS.md,
  and there is no on-disk data in the test providers, so no test exercises a real
  legacy store. If any persisted store predates this change, its indexes must be
  dropped + recreated (or the table rebuilt). A durable fix (version-stamp the
  index store and rebuild-on-open, or fall back to full-scan when any empty value
  is seen) is **not** done here. I recorded this as a `// NOTE:` at the empty-value
  guard in `scanIndex`; it is a tripwire, not a filed ticket — promote it to a
  `debt-`/`bug-` ticket if real persisted data is in play.

- **Partial indexes are never used for a seek.** `tryIndexAccessPlan` returns null
  for any index with a predicate (mirrors `MemoryTableModule.getAvailableIndexes`)
  because nothing checks that the query's WHERE implies the index predicate —
  seeking one would drop the rows it omits. They remain uniqueness enforcers only;
  queries full-scan + residual (correct, not sped up). A future optimization could
  add predicate-implication analysis. Covered by the partial-index pushdown test
  and `10.5.1-partial-indexes.sqllogic`.

- **No ordering advertised for index scans.** `providesOrdering` is left unset, so
  an `ORDER BY` over an indexed column keeps a Sort above the scan (correct, not
  elided). Advertising leading-index-column ordering is deferred.

- **One extra data-store `get` per matched index entry** (the row lives in the data
  store; the index value carries only the data key, no covering payload). `// NOTE:`
  tripwire at the resolution site in `scanIndex`. A covering payload would cost an
  index rewrite on *every* column change — deliberately not done.

- **UNIQUE enforcement untouched.** This ticket is the read primitive only. The
  follow-on `store-unique-check-via-index` (queued in `implement/` with
  `prereq: store-index-scan-read-primitive`) builds its point lookup on this arm.

- **Bigint-PK index seek at |int| ≥ 2^53** through SQL is not separately tested
  here (the PK-side analogue is tracked in
  `backlog/debt-bigint-pk-store-range-seek-test`); the encoding is proven at the
  unit level in `encoding.spec.ts`.

## Validation run (all green)

- `@quereus/store` unit suite: **702 passing** (`yarn workspace @quereus/store test`).
- Store-path SQL logic suite: **6546 passing, 14 pending, 0 failing**
  (`packages/quereus && node test-runner.mjs --store`). This is what caught the two
  collation / partial-index bugs above — reviewer should re-run it after any change
  to the guard.
- `@quereus/isolation` suite: **146 passing** (the index-key-order emission contract
  its overlay merge depends on).
- `yarn lint`: clean.
- Not run: default memory-mode `yarn test` — it does not exercise the store module;
  deferred to CI.

## Review-findings seed (for the complete/ writeup)

- Legacy empty-value index entries → silent-empty results with residual dropped;
  parked as a `// NOTE:` tripwire in `scanIndex` (store-table.ts). Decide whether
  real persisted data makes this a ticket.
- Extra per-entry data-store `get`; `// NOTE:` tripwire at the `scanIndex`
  resolution site.
- Physical index-column bytes use K, not the index's declared per-column collation
  — pre-existing store quirk the collation guard routes around (does not fix).
