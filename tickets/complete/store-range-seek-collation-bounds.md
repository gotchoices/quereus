description: Store module honours per-column collation in its pushed-constraint row filter (StoreTable.compareValues via compareSqlValues) and advertises BestAccessPlanResult.honorsCollatedRangeBounds, so collation-matched non-BINARY (NOCASE/RTRIM) PK range/BETWEEN seeks are used instead of declining to SeqScan + residual. Symmetric to memory-range-seek-collation-bounds. Reviewed: stale flag doc fixed, two point-lookup latent-bug regression tests added.
files:
  - packages/quereus-store/src/common/store-table.ts            # matchesFilters threads columns[iColumn].collation; compareValues delegates to compareSqlValues for ALL ops; scanPKRange TODO documents the no-early-termination audit result
  - packages/quereus-store/src/common/store-module.ts           # getBestAccessPlan → thin wrapper stamping honorsCollatedRangeBounds: true over private computeBestAccessPlan
  - packages/quereus/src/vtab/best-access-plan.ts               # (review) honorsCollatedRangeBounds doc comment updated — no longer claims the store leaves the flag off
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # comment-only: names the store as a second advertiser
  - packages/quereus-store/test/pushdown.spec.ts                # 8 new tests: plan + rows for NOCASE/RTRIM/explicit-BINARY PK ranges, mismatch decline; (review) RTRIM + blob PK point-lookup EQ re-check
  - packages/quereus-store/test/isolated-store.spec.ts          # 1 new test: NOCASE PK range under an open transaction (overlay+underlying merge, no residual)
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic # cross-backend: RTRIM PK range/BETWEEN, NOCASE mismatch control, explicit-BINARY PK control
  - docs/optimizer.md                                           # access-path collation-cover paragraph names both advertisers
----

# Store range/prefix seek now honours index collation

## What shipped

The store's post-fetch row filter (`StoreTable.matchesFilters` → `compareValues`) used raw
JS `<`/`<=`/`>`/`>=` (BINARY) for range bounds and a table-level-config NOCASE check for EQ
only. `matchesFilters` now resolves each pushed constraint's column **declared** collation
(`tableSchema.columns[iColumn].collation`, undefined ⇒ BINARY) — the same resolution the
planner's `indexColumnCollationLookup`/`primaryKeyCollationLookup` uses to justify pushing
the constraint — and `compareValues` delegates every operator to the engine's
`compareSqlValues(a, b, collation)`. `StoreModule.getBestAccessPlan` is a thin wrapper
that stamps `honorsCollatedRangeBounds: true` on every plan (mirrors the memory module).

Result: a NOCASE/RTRIM **primary-key** range or BETWEEN whose predicate collation matches
the column collation classifies as MATCH in `classifyConstraintCover`, uses the range plan
(IndexSeek node), and the residual Filter is dropped — the store's own filter is solely
responsible for reproducing the predicate. Mismatched and BINARY-over-non-BINARY ranges
still decline to SeqScan + residual, unchanged.

**Seek-start/early-termination audit: nothing to thread.** `StoreTable.scanPKRange`
visits the full key space and post-filters (pre-existing TODO, now documents that future
bounds refinement must encode bound keys under `pkKeyCollations` and keep `matchesFilters`
authoritative). This is a plan-shape improvement, not a fetch-window improvement.

The isolation layer needed no changes: `IsolationModule.getBestAccessPlan` returns the
underlying plan verbatim (flag forwarded), `createOverlaySchema` spreads the base schema
and reuses base columns (collations preserved), and the merge comparators already pass
collation to `compareSqlValues`.

Known residuals (pre-existing, documented, untouched): secondary-index ranges never seek
on the store (no secondary scans implemented); OR_RANGE non-BINARY resolves to BINARY and
declines; per-database-only custom collations fall back to BINARY in `compareSqlValues`'s
global registry; comparator-only collations map to NOCASE key bytes (docs/schema.md) —
harmless while the range scan visits the full key space.

## Review findings

Review read the implement diff fresh (`git show 1c6650ee`), then audited every claim in
the handoff against the live code.

**Checked — confirmed correct:**
- `classifyConstraintCover` gating: the flag only affects the non-equality MATCH arm
  (`predColl === indexColl && (BINARY || honorsCollatedRangeBounds)`); stamping it on
  every plan shape (point lookup, secondary hint, full scan) is harmless because the
  equality arm ignores it and `matchesFilters` is collation-aware on all paths. Both the
  index-aware and legacy planner paths read the flag off whatever plan shape is returned.
- `matchesFilters` collation resolution (`columns[iColumn]?.collation`, `iColumn < 0`
  skipped) matches the planner's `primaryKeyCollationLookup`/`indexColumnCollationLookup`
  exactly, so plan-time MATCH and runtime filter can never disagree on the collation.
- `compareSqlValues` semantics: NULL < numeric < text < blob storage-class ordering,
  BINARY default, global-registry resolution — the same comparator the engine's
  comparison ops use, so the no-residual filter reproduces engine semantics for mixed
  types too (the old raw-JS comparisons did not).
- NULL handling: `compareValues` fails every range op when either side is NULL, so a
  pushed bound with no residual cannot leak NULL rows (the memory ticket's leak class).
  The `null EQ null → true` internal point-lookup convention is retained; the planner
  never pushes `= NULL`.
- Isolation layer: `getBestAccessPlan` forwards the underlying plan verbatim
  (isolation-module.ts:436), `createOverlaySchema` preserves base column collations
  (isolation-module.ts:1059), merged-path test exercises both halves with NOCASE-vs-BINARY
  order-diverging values.
- No subclasses of `StoreTable` exist, so the widened `compareValues` signature
  (added optional `collation`) breaks no overrides; `matchesFilters` is its only caller.
- `computeBestAccessPlan` range branch only marks leading-PK-column range filters handled
  and the secondary-index branch marks nothing handled — the flag cannot cause an
  unfiltered secondary "seek" because no such seek is ever produced.
- EQ behavior delta for legacy non-reconciled DDL (declared-BINARY text PK in a
  NOCASE-config store now EQ-compares BINARY instead of config-NOCASE): verified this
  matches what the planner assumes for the declared column; the key-encoding divergence
  it exposes is the pre-existing docs/schema.md residual, not a new defect.
- Searched all *.md and src for stale "store bound-filters BINARY" claims.

**Found — minor, fixed in this pass:**
- `packages/quereus/src/vtab/best-access-plan.ts` `honorsCollatedRangeBounds` doc comment
  still said "the store module does NOT (its range filter is BINARY), so it leaves this
  off" — directly contradicted the change. Rewritten to name the store as the second
  advertiser.
- The EQ widening silently fixed two latent point-lookup bugs with no regression
  coverage: (a) a **blob PK** point lookup fetched the row by key then dropped it in the
  EQ re-check (old `a === b` is reference equality for Uint8Array — always false);
  (b) an **RTRIM PK** point lookup (`val = 'cat'` vs stored `'cat '`) fetched via the
  RTRIM-normalized key then failed the old exact/NOCASE-config EQ. Added two tests to
  pushdown.spec.ts locking both in (412 passing, was 410).

**Found — major:** none. The implementation, planner gating, isolation forwarding, and
test coverage are sound; no new tickets filed.

**Validation (review pass):**
- `npx eslint src/vtab/best-access-plan.ts` — clean.
- `yarn workspace @quereus/store run test` — 412 passing (incl. 2 new review tests).
- `yarn workspace @quereus/quereus run test` (memory) — 5550 passing, 9 pending.
- `yarn workspace @quereus/quereus run test:store` — 5546 passing, 13 pending.
No pre-existing failures encountered.

## Use cases validated

- NOCASE PK: `name > 'banana'` / `between 'banana' and 'cherry'` over
  ('apple','Banana','CHERRY','date') — seek chosen, rows = NOCASE-correct set.
- RTRIM PK: `> 'cat'` excludes RTRIM-equal `'cat '`; `>= 'cat  '` includes it; BETWEEN
  trims both bounds; `= 'cat'` point lookup matches the stored `'cat '` row.
- Blob PK point lookup returns the row (EQ content compare).
- Negative controls: explicit `collate BINARY` PK range keeps BINARY semantics through
  the seek; `> 'banana' collate BINARY` over a NOCASE PK declines (SeqScan + residual)
  and returns BINARY-correct rows.
- Merged path: NOCASE range inside an open transaction returns committed + uncommitted
  qualifying rows with no residual.
