description: Review — declared secondary (non-PK) UNIQUE constraints are now enforced against rows a maintained-table derivation writes, via host-side post-batch checks in both backing hosts (memory + store), with a maintained-table-attributed CONSTRAINT diagnostic. Includes a load-bearing fix to MemoryIndex entry copy-on-write (a pre-existing rollback-corruption bug the new enforcement tripped over) and live-candidate validation in checkUniqueViaIndex.
prereq: maintained-table-derivation-check-fk-validation
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # enforceSecondaryUniqueOnMaintenance (post-batch, end of applyMaintenanceToLayer); allowMvCovering param on findIndexForConstraint/checkSingleUniqueConstraint; checkUniqueViaIndex live-candidate validation
  - packages/quereus/src/vtab/memory/index.ts                    # ownedEntries WeakSet — copy-on-write for inherited index entries (engine bugfix)
  - packages/quereus/src/schema/constraint-builder.ts            # maintainedTableUniqueViolationError + exported formatKeyValue
  - packages/quereus/src/vtab/backing-host.ts                    # contract rewrite: § Constraint validation — split by shape (UNIQUE is host-owned)
  - packages/quereus-store/src/common/store-table.ts             # enforceSecondaryUniqueForMaintenance (reuses findUniqueConflict)
  - packages/quereus-store/src/common/backing-host.ts            # post-batch call in applyMaintenance; header update
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # formatKeyValue moved to constraint-builder (DRY only — no validation change here)
  - packages/quereus/src/index.ts                                # barrel export for the store package
  - packages/quereus/test/logic/51.9-maintained-table-secondary-unique.sqllogic
  - docs/materialized-views.md                                   # § Derived-row constraint validation — new "Declared secondary UNIQUE" subsection
difficulty: hard
----

# Review: secondary UNIQUE enforcement on maintained-table derivation writes

## What was built

Approach **(a)** from the implement ticket (host-side reuse of shipped UNIQUE
enforcement), with one structural refinement: enforcement runs **post-batch**
inside each host's `applyMaintenance`, never per-op or per-seam. After an op
batch lands in the pending state, every written (insert/update)
`BackingRowChange` image is checked against the batch's **final effective
contents** for a different-PK row matching the constraint; a hit throws
`maintainedTableUniqueViolationError` (attributed, names constraint + key
values; `UNIQUE constraint failed:` prefix preserved).

Post-batch is load-bearing: a `replace-all` diff applies upserts before
deletes, so a per-op check would false-positive when the derived set moves a
unique value between primary keys (51.9 §7 and §9 pin this). One mechanism
covers all maintenance shapes — create-fill/attach reconcile (the bulk write
IS a `replace-all` batch), steady-state bounded deltas, full-rebuild flush,
and MV-over-MV cascades — so there is **no separate engine-side bulk
validation seam** (deviation from the implement ticket's "whole-set scan after
reconcile" sketch; rationale below).

Maintenance-specific postures, both hosts:
- conflict action forced to **ABORT** — a declared `on conflict
  replace/ignore` default must not evict/drop derived rows (51.9 §6);
- the covering-MV route is **bypassed** (`allowMvCovering = false` in memory;
  `findUniqueConflict` directly in store) — a covering MV over the maintained
  table is cascade-maintained only after the batch returns, so it lags
  same-batch pairs;
- NULL-pass, partial-predicate scope, per-column collation, same-PK exclusion
  all reused from the host's own DML enforcement (memory:
  `checkSingleUniqueConstraint`; store: `findUniqueConflict`), not re-derived.

`vtab/backing-host.ts` § "Constraint validation" was rewritten: CHECK/FK stay
engine-owned (per-row shape), secondary UNIQUE is now **host-owned**
(collision shape, lives with each host's key/collation machinery). This is a
contract change — a future third-party backing host must implement the
post-batch guard or maintained tables it hosts get no UNIQUE enforcement.

## Engine bugfix folded in (review this hardest)

The new test's PK-move case exposed a **pre-existing** memory-module bug:
`MemoryIndex.addEntry/removeEntry` mutated the found entry's `primaryKeys` Set
in place, but entries found through an inherited layer tree are SHARED with
the ancestor (only btree nodes are copy-on-write) — so a rolled-back
statement's index mutations leaked into the committed base layer.
Reproducible at HEAD on an ordinary table: `begin; delete from t where id=1;
rollback;` then a duplicate insert is silently ACCEPTED (UNIQUE un-enforced).

Two-part remedy:
- `MemoryIndex.ownedEntries` (WeakSet): entries created by this index instance
  mutate in place (fast path — bulk loads unchanged); inherited entries are
  copy-on-written via `BTree.updateAt`/`insert` with a copied Set.
- `checkUniqueViaIndex` now validates each candidate PK against the live
  effective row (value match under collation + partial-predicate scope) before
  acting — mirroring `checkUniqueViaMaterializedView`'s stale-candidate
  discipline. Behavior deltas for ordinary DML: stale candidates no longer
  false-reject, REPLACE no longer evicts a row that doesn't actually conflict,
  and the REPLACE arm `continue`s scanning instead of returning after the
  first eviction (matters only if multiple live conflicts could exist, which
  enforced UNIQUE precludes).

A remaining, related pre-existing defect (composite-PK Set members compared by
reference — stale accumulation affecting index scans/stats, NOT enforcement)
is filed as `fix/memory-index-composite-pk-value-identity` with a repro sketch.

## Why no engine-side bulk whole-set scan

The implement ticket sketched a post-reconcile whole-set duplicate scan in
`validateDeclaredConstraintsOverContents`. Deliberately not added: (1) the
host-side post-batch check already validates the entire reconcile delta, and
pre-existing rows satisfied the constraint via DML/ADD-CONSTRAINT enforcement,
so any colliding pair includes a written image — coverage is complete by
induction; (2) an engine-side SQL duplicate scan would require stripping
`uniqueConstraints` from the live record during the scan (the optimizer trusts
declared UNIQUE as a key — same folding hazard the CHECK/FK swap handles),
which host-side enforcement avoids entirely. A reviewer who disagrees should
weigh the third-party-host argument (above) against the redundancy.

## Validation performed

- `yarn build` clean (all packages), `yarn lint` clean.
- `yarn test` (full workspace run): green.
- `yarn test:store --grep "51"` (all six 51.x MV/maintained files, including
  new 51.9): green. **Full `yarn test:store` was NOT run** — deferral per
  build guidance (51.x exercises the store-side change; the memory-side
  changes are covered by the full memory run).
- 51.9 covers: create-fill collision + clean rollback; steady-state
  insert/update collisions; multi-row intra-statement collision; same-PK
  unique-value change (no false positive); PK-move in one statement (post-batch
  regression); NOCASE collision; NULLs distinct; partial UNIQUE via
  `create unique index … where` (out-of-scope coexists, in-scope and
  scope-transition reject); `on conflict replace` default not masking; attach
  move-between-PKs; attach collision reverting to plain; re-attach failure
  restoring prior derivation; MV-over-MV cascade; full-rebuild flush collision
  AND full-rebuild PK-move (composite backing PK — exercises the live-candidate
  validation); detach handoff to user DML; zero-overhead regression.

## Known gaps / reviewer attention

- **Coarsened-backing-key + secondary UNIQUE** (edge case in the implement
  ticket) has no dedicated test — the mechanism is identical (post-batch check
  on written images at distinct PKs), but a test forcing a coarsened lineage
  key plus a declared UNIQUE would close it.
- **Intra-statement value swap asymmetry** (documented in
  docs/materialized-views.md): bounded-delta maintenance applies per source
  row, so a swap (`update src set tag = case …`) aborts mid-statement exactly
  like the equivalent ordinary-table UPDATE; a full-rebuild body realizes the
  same swap as one batch and succeeds. Consistent with DML semantics but
  order-dependent for bounded deltas — no test pins the bounded-delta swap.
- **Store cost posture**: per written image per UC, one effective full scan
  (same as store DML UNIQUE enforcement). Bulk attach over a large store
  backing is O(diff × n); a whole-set single-scan variant (mirror of
  `validateUniqueOverExistingRows`) would be the optimization if it matters.
- **`replaceContents` stays validation-free** (refresh/create-fill MV-sugar
  path) — pre-existing posture, tracked by `maintained-table-refresh-revalidation`.
- The store host's value-identical-upsert skip and effective-change reporting
  are untouched (enforcement reads `changes` after the fact) — verify no
  contract drift in `test/vtab/maintenance-*.spec.ts` if suspicious.
