description: Store module now honours per-column collation in its pushed-constraint row filter (StoreTable.compareValues via compareSqlValues) and advertises BestAccessPlanResult.honorsCollatedRangeBounds, so collation-matched non-BINARY (NOCASE/RTRIM) PK range/BETWEEN seeks are used instead of declining to SeqScan + residual. Symmetric to memory-range-seek-collation-bounds. Build + typecheck + lint clean; memory suite 5550 passing / 9 pending; store logic suite 5546 passing / 13 pending; quereus-store package 410 passing (7 new tests).
files:
  - packages/quereus-store/src/common/store-table.ts            # matchesFilters threads columns[iColumn].collation; compareValues now delegates to compareSqlValues for ALL ops; scanPKRange TODO documents the no-early-termination audit result
  - packages/quereus-store/src/common/store-module.ts           # getBestAccessPlan → thin wrapper stamping honorsCollatedRangeBounds: true over private computeBestAccessPlan
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # comment-only: names the store as a second advertiser
  - packages/quereus-store/test/pushdown.spec.ts                # 6 new tests: plan (IndexSeek vs SeqScan) + rows for NOCASE/RTRIM/explicit-BINARY PK ranges, mismatch decline
  - packages/quereus-store/test/isolated-store.spec.ts          # 1 new test: NOCASE PK range under an open transaction (overlay+underlying merge, no residual)
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic # cross-backend: RTRIM PK range/BETWEEN, NOCASE mismatch control, explicit-BINARY PK control; comments refreshed
  - docs/optimizer.md                                           # access-path collation-cover paragraph now names both advertisers
----

# Store range/prefix seek now honours index collation

## What shipped

The store's post-fetch row filter (`StoreTable.matchesFilters` → `compareValues`) used raw
JS `<`/`<=`/`>`/`>=` (BINARY) for range bounds and a table-level-config NOCASE check for EQ
only. `matchesFilters` now resolves each pushed constraint's column **declared** collation
(`tableSchema.columns[iColumn].collation`, undefined ⇒ BINARY) — the exact same resolution
the planner's `indexColumnCollationLookup`/`primaryKeyCollationLookup` used to justify
pushing the constraint — and `compareValues` delegates every operator to the engine's
`compareSqlValues(a, b, collation)`. `StoreModule.getBestAccessPlan` is now a thin wrapper
that stamps `honorsCollatedRangeBounds: true` on every plan (mirrors the memory module's
shape: private `computeBestAccessPlan` + stamp).

Result: a NOCASE/RTRIM **primary-key** range or BETWEEN whose predicate collation matches
the column collation classifies as MATCH in `classifyConstraintCover`, uses the range plan
(IndexSeek node), and the residual Filter is dropped — the store's own filter is solely
responsible for reproducing the predicate. Mismatched and BINARY-over-non-BINARY ranges
still decline to SeqScan + residual, unchanged.

**Seek-start/early-termination audit result: there is nothing to thread.**
`StoreTable.scanPKRange` visits the full key space and post-filters (pre-existing TODO).
So this is a *plan-shape* improvement (residual eliminated; the store filter does the
work), not a fetch-window improvement. The TODO now documents that future bounds
refinement must encode bound keys under `pkKeyCollations` and keep `matchesFilters`
authoritative.

The isolation layer needed no changes: `IsolationModule.getBestAccessPlan` returns the
underlying plan verbatim (flag forwarded), `createOverlaySchema` copies base columns
(collations preserved) so the overlay memory table — already collation-aware — filters its
half of a merged in-transaction query correctly, and the merge comparators already pass
collation to `compareSqlValues`.

## Reviewer attention points (honest gaps / behavior widening)

- **`compareValues` semantics widened beyond the range arms.** EQ/NE also moved from raw
  JS (`===`, reference-equality for blobs/objects, `5n !== 5`) to `compareSqlValues` with
  SQL storage-class ordering. This is strictly closer to engine semantics (and fixes
  latent blob/bigint/mixed-type post-filter bugs), but it is a wider change than the
  ticket's literal LT/LE/GT/GE scope. Old EQ used the **table-level config** collation for
  all text; new EQ uses the **per-column declared** collation. For store-created tables
  the two agree on text PK columns (CREATE-time `reconcilePkCollations` stamps an explicit
  collation); a legacy non-reconciled DDL (connect path, undeclared text PK) now
  EQ-compares BINARY where it formerly compared config-NOCASE — that matches what the
  engine/planner assume for an undeclared column, and backwards compat is out of scope,
  but it is a behavior delta worth a second pair of eyes.
- **`null EQ null → true` convention retained** in `compareValues` (used by internal
  point-lookup re-checks; the planner never pushes `= NULL`). Not SQL ternary semantics —
  pre-existing, deliberately untouched.
- **NULL range semantics already correct** (the memory ticket's NULL-leak class):
  `compareValues` returns false for any range op when either side is NULL, so a pushed
  bound with no residual cannot leak NULL rows. Covered implicitly; no store-specific NULL
  test was added beyond the existing suites.
- **Secondary-index ranges on the store still never seek** — the store doesn't implement
  secondary-index scans at all (`computeBestAccessPlan` marks nothing handled there), so
  only the PK path improved. The sqllogic secondary-index cases (rng_sec_nc, rng_rtrim)
  still scan under the store, by design.
- **OR_RANGE non-BINARY still declines** (`effectivePredicateCollation` resolves it to
  BINARY) — carried forward from the memory ticket, unchanged here.
- **Per-database-only (non-global) custom collations** fall back to BINARY inside
  `compareSqlValues`'s global registry resolution — same pre-existing residual the memory
  ticket documented for its btree/bound compare. Also note the store *key encoding* maps
  comparator-only collations to NOCASE bytes (documented residual in docs/schema.md);
  harmless today because the range scan visits the full key space, but it becomes relevant
  if bounds refinement ever lands.
- **Flag stamped on every plan**, not just the range plan (point lookup, secondary-index
  hint, full scan). Honest — `matchesFilters` is collation-aware on all paths — and it
  matches the memory module's uniform stamp; the legacy planner path reads the flag off
  whatever plan shape was returned.

## Use cases to validate

- NOCASE PK: `name > 'banana'` / `between 'banana' and 'cherry'` over
  ('apple','Banana','CHERRY','date') — seek chosen, rows = NOCASE-correct set (a BINARY
  bound filter would under-fetch 'CHERRY'/'date').
- RTRIM PK: bounds carrying trailing spaces — `> 'cat'` excludes RTRIM-equal `'cat '`
  (BINARY over-fetch), `>= 'cat  '` includes it (BINARY under-fetch), BETWEEN trims both
  bounds.
- Negative controls: explicit `collate BINARY` PK range keeps BINARY semantics through
  the seek; `> 'banana' collate BINARY` over a NOCASE PK still declines (SeqScan + Filter
  in the plan) and returns BINARY-correct rows.
- Merged path: NOCASE range inside an open transaction returns committed (underlying
  store filter) + uncommitted (overlay memory filter) qualifying rows with no residual.

## Validation commands run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/store run typecheck` — clean.
- `npx eslint src/planner/rules/access/rule-select-access-path.ts` — clean (only quereus
  TS file touched; comment-only).
- `yarn workspace @quereus/quereus run test` (memory) — **5550 passing, 9 pending**.
- `yarn workspace @quereus/quereus run test:store` — **5546 passing, 13 pending**.
- `yarn workspace @quereus/store run test` — **410 passing** (was 403; +6 pushdown,
  +1 isolated-store).
