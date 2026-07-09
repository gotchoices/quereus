----
description: The persistent store now reads its secondary indexes — a query filtered on an indexed column seeks the index instead of scanning the whole table.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts        # index entry value = data key (~1540); resolveIndexFromIdxStr (~886); analyzeIndexAccess (~916); buildIndexRangeBounds (~993); scanIndex (~1035); indexColumnCollations (~1121); matchesFilters collation override (~1075)
  - packages/quereus-store/src/common/store-module.ts        # op-group consts (~113); buildIndexEntries writes data key (~974); computeBestAccessPlan secondary-index branch (~1870); tryIndexAccessPlan (~1926)
  - packages/quereus-store/README.md                         # index-value format documented
  - packages/quereus-store/test/pushdown.spec.ts             # index scan, collation guard, redundant-bound regressions, range-bound matrix
  - packages/quereus-store/test/index-persistence.spec.ts    # reattached index seek after reopen
  - packages/quereus-store/test/store-ryow.spec.ts           # pending index put/delete visible to a seek
  - packages/quereus-store/test/isolated-store.spec.ts       # overlay merge over an index scan
----

# Complete: Store secondary-index scan read arm + access-plan surface

## What shipped

Before this work the store maintained secondary indexes on every write but never
read one — a predicate on an indexed column fell back to a full table scan. The
read primitive now exists and the planner is wired to it.

1. **Index entries carry the row's encoded data key as their value** (previously an
   empty `Uint8Array`), written by both index-writing paths:
   `StoreTable.updateSecondaryIndexes` and `StoreModule.buildIndexEntries`. A scan
   resolves each entry to its base row through that stored key rather than decoding
   the index key's PK suffix, which is encoded lossily for a NOCASE/RTRIM PK column
   and so is not recoverable to SQL values.

2. **`StoreTable.query` gained a secondary-index scan arm.** When the planner chose
   an index, the store parses the plan string, derives an encoded byte window over
   the index (leading-prefix equality → point/prefix; leading-column `<`/`<=`/`>`/`>=`
   → range, with the lower/upper swap a DESC column requires), iterates it merged
   with the transaction's pending index operations, resolves each entry to its row,
   and re-filters. Emission stays in index-key byte order, which the isolation
   layer's overlay merge depends on.

3. **`getBestAccessPlan` advertises the index** (`tryIndexAccessPlan`), setting the
   index name and seek columns and marking the covered filters handled — subject to
   the collation-safety guard below. When no index yields a safe seek it falls back
   to a cost-only advertisement (cheaper cost, filters unhandled, residual retained).

## Review findings

### Checked

Read the implement-stage diff (`ed3a6558`) before the handoff summary. Verified by
hand: the ASC/DESC × `<`/`<=`/`>`/`>=` bound-assignment table in
`buildIndexRangeBounds` against the byte-inversion semantics of a DESC column; the
prefix-window property for composite and DESC index columns; that both index-writing
sites now store the data key and none still writes an empty value; that the table key
collation the planner reasons about is the same one the encoder uses (they differ
only in letter case, and encoder lookup is case-insensitive); that `iterateEffective`
over the index store gives read-your-own-writes; and that the engine forwards only
*handled* constraints to the store, which is what makes the collation override safe
to scope to index columns.

Ran: store build (typecheck — the store's `lint` script is a no-op, so `build` is the
only type check it gets), store unit suite, isolation suite, the store-path SQL logic
suite, and `yarn lint`. All green; see *Validation* below.

### Found and fixed in this pass

- **Wrong results from redundant same-column constraints — a regression this ticket
  introduced.** `tryIndexAccessPlan` marked *every* matching filter on a seek column
  handled. But `rule-select-access-path` consumes only the **first** `=` per seek
  column, and the **first** lower and **first** upper bound, chosen by position. It
  also collapses the per-filter handled flags into a per-*column* set, while the
  residual predicate is rebuilt per-*filter*. So a redundant same-side constraint got
  marked handled, was never turned into a seek bound, and was never kept as a residual
  — its predicate silently vanished:

  | Query (on an indexed `v`) | Expected | Was |
  |---|---|---|
  | `where v > 10 and v > 30` | `4` | `2, 3, 4` |
  | `where v < 40 and v < 20` | `1` | `1, 2, 3` |
  | `where v > 10 and v >= 30` | `3, 4` | `2, 3, 4` |
  | `where v = 20 and v = 30` | *(none)* | `2` |

  Before this ticket the index branch marked all filters unhandled, so the bug did not
  exist. Fixed by claiming filters **positionally** — the first match per side, mirroring
  the rule's own `find`. Claiming the *tighter but later* duplicate instead would be
  actively wrong: the rule would still seek on the earlier bound, and the tighter one,
  marked handled, would never be applied anywhere. That subtlety is now a comment at the
  site. Six regression tests added.

  The implementer's tests only ever exercised single-bound ranges, which is why this
  survived a 702-test suite and a 6546-test SQL logic suite.

- **Untagged tripwire.** The handoff said the legacy-empty-value hazard was recorded as
  a `// NOTE:`, but the comment carried no `NOTE:` tag and so would not surface in the
  `grep NOTE:` sweep the tag exists to support. It also deferred to "the review handoff"
  — a document being archived by this very ticket. Retagged and made self-contained.

- **Missing documentation.** `packages/quereus-store/README.md` documented index *key*
  format but never index *values* — which this change made load-bearing. Added.

- **Indentation.** The new reopen test in `index-persistence.spec.ts` was indented one
  tab deep and dragged the following test with it. Corrected.

### Found and filed as a new ticket

- **`fix/1-redundant-range-bound-silently-dropped`** — the *same* wrong-result class as
  the regression above, but in code this ticket never touched, and pre-existing. It
  reproduces with **no store code at all**: `create table t (id integer primary key)`
  then `select id from t where id > 10 and id > 30` returns `20, 30, 40` on a plain
  in-memory table. Also broken for memory tables with a secondary index, and for the
  store's own primary-key range branch. Root cause is the module/planner contract
  described above; the ticket lays out the two candidate fixes (tighten every module, or
  harden the planner so an over-claiming module cannot lose a predicate) and recommends
  the latter, since a module author has no way to discover that constraint *order*
  decides which bound survives. Filed into `fix/` rather than `backlog/` because it is a
  reachable silent-wrong-answer bug, and the store's now-corrected secondary-index arm is
  a working reference for the module-side approach.

### Recorded as tripwires, not tickets

- **Legacy on-disk index stores return nothing instead of erroring.** An index store
  written by an older build holds empty values; `scanIndex` skips them, and since the
  plan dropped the residual, an indexed query returns no rows rather than the matching
  ones. Genuinely conditional — backwards compatibility is waived project-wide per
  `AGENTS.md`, and no test provider carries on-disk data, so no reachable path hits it
  today. Parked as a `// NOTE:` at the empty-value guard in `scanIndex`
  (`store-table.ts`), now stating the durable fix (version-stamp the index store and
  rebuild on open, or fall back to a full scan on the first empty value seen). Promote to
  a ticket only if real persisted stores predating this format come into play.

- **One extra data-store read per matched index entry.** The index value carries only the
  data key, not a covering payload. A covering payload would cost an index rewrite on
  *every* column change, not just indexed ones. Parked as a `// NOTE:` at the resolution
  site in `scanIndex`.

### Checked and deliberately left alone

- **The collation-safety guard direction is correct.** The reviewer focus asked to confirm
  that the table key collation K must be coarser-or-equal to the index column's effective
  collation C, never finer. Verified: for an equality predicate the byte window is
  `{rows equal under K}` while the row filter compares under C, so correctness needs
  `{equal under C} ⊆ {equal under K}` — which holds exactly when K is coarser. The guard
  admits only non-text columns, `C == K`, and (K = NOCASE, C = BINARY). Each is a genuine
  superset. Every rejected combination (K = BINARY over C = NOCASE, K = NOCASE over
  C = RTRIM, K = RTRIM over C = NOCASE) is a real under-fetch and is correctly declined
  to a cost-only plan. The guard is *conservative* — K = RTRIM over C = BINARY is provably
  safe but declined — which costs a missed optimization, never correctness. Left as is;
  the simpler rule is worth more than the extra case.

- **The DESC bound-swap table is correct** in all eight arms. It was only tested in three,
  so a full ASC/DESC × four-operator matrix is now in `pushdown.spec.ts`, along with NULL
  handling, two-sided windows, empty windows, text ranges, and a composite `(a asc, b desc)`
  index. All passed unmodified — the implementation was right, the coverage was not.

- **`buildIndexEntries` re-derives the data key** via `buildDataKey(pkValues, …)` when
  `entry.key` from the data-store iteration already *is* that key. Byte-identical in
  practice (verified: encoder lookup is case-insensitive, so the uppercased key collation
  passed here and the raw one on the table agree). Using `entry.key` directly would be
  simpler and remove a class of encoding-drift risk, but it is a cosmetic simplification
  with no behavioral difference — not worth churning a correct, tested write path in a
  review pass.

- **Partial indexes are never seeked**, no ordering is advertised for index scans, and
  UNIQUE enforcement is untouched. All three are deliberate, documented, and correct
  (just not optimized). The follow-on `implement/2-store-unique-check-via-index` builds
  its point lookup on this arm.

### Empty categories

No resource-cleanup findings: the scan is an async generator over `iterateEffective`,
which delegates cleanup to the underlying store iterator, and `ensureIndexStore` caches
handles rather than opening per query. No error-handling findings: the one silent
`continue` (empty index value) is the legacy tripwire above, and no exception is
swallowed. No type-safety findings: the store package builds clean under `tsc` with no
`any` introduced.

## Validation

- `@quereus/store` unit suite: **725 passing, 0 failing** (was 702 — 23 tests added).
- Store-path SQL logic suite: **6546 passing, 14 pending, 0 failing**
  (`packages/quereus && node test-runner.mjs --store`) — unchanged from the
  implement-stage baseline, so the `handledFilters` fix regressed nothing.
- `@quereus/isolation` suite: **146 passing** (the index-key-order emission contract its
  overlay merge depends on).
- `yarn build` (full monorepo, sequential): clean. Note this is the only type check the
  store package receives — its `lint` script is an intentional no-op, and `vitest`/`mocha`
  strip types without checking them. Building the store *in isolation* reports ~150
  spurious errors because `@quereus/quereus` is unbuilt; build the engine first.
- `yarn lint`: clean.
- Not run: default memory-mode `yarn test` beyond the store and isolation workspaces —
  it does not exercise the store module. Deferred to CI.

## Known gaps carried forward

- Partial indexes remain uniqueness enforcers only; a seek would need predicate-implication
  analysis. Queries full-scan + residual (correct, not sped up).
- No ordering is advertised for index scans, so `ORDER BY` over an indexed column keeps a
  Sort above the scan (correct, not elided).
- The physical index-column bytes are encoded under the table key collation K, not the
  index's declared per-column collation. This is a pre-existing store quirk that the
  collation guard routes *around* rather than fixes: a mismatched combination degrades to
  a cost-only plan instead of a seek.
- Bigint-PK index seek at `|int| ≥ 2^53` through SQL is not separately tested here; the
  PK-side analogue is tracked in `backlog/debt-bigint-pk-store-range-seek-test`, and the
  encoding itself is proven at the unit level in `encoding.spec.ts`.
