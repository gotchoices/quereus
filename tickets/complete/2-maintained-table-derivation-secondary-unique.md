description: Complete — declared secondary (non-PK) UNIQUE constraints are enforced against rows a maintained-table derivation writes, via host-side post-batch checks in both backing hosts (memory + store), with a maintained-table-attributed CONSTRAINT diagnostic. Includes the MemoryIndex entry copy-on-write fix (pre-existing rollback-corruption bug) and live-candidate validation in checkUniqueViaIndex. Review fixed a collation regression in that live-candidate validation and added three regression tests.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # enforceSecondaryUniqueOnMaintenance; checkUniqueViaIndex live-candidate validation (review: now compares under the INDEX's per-column collation)
  - packages/quereus/src/vtab/memory/index.ts                    # ownedEntries WeakSet — copy-on-write for inherited index entries
  - packages/quereus/src/schema/constraint-builder.ts            # maintainedTableUniqueViolationError + exported formatKeyValue
  - packages/quereus/src/vtab/backing-host.ts                    # contract: § Constraint validation — split by shape (UNIQUE is host-owned)
  - packages/quereus-store/src/common/store-table.ts             # enforceSecondaryUniqueForMaintenance (reuses findUniqueConflict)
  - packages/quereus-store/src/common/backing-host.ts            # post-batch call in applyMaintenance
  - packages/quereus/test/logic/51.9-maintained-table-secondary-unique.sqllogic  # + §12 bounded-delta swap (review)
  - packages/quereus/test/logic/05-vtab_memory.sqllogic          # + explicit unique-index collation regression (review, memory-only)
  - packages/quereus/test/logic/101-transaction-edge-cases.sqllogic  # + rolled-back-statement UNIQUE-state regression (review, both modules)
  - docs/materialized-views.md                                   # § Derived-row constraint validation › Declared secondary UNIQUE
----

# Complete: secondary UNIQUE enforcement on maintained-table derivation writes

## What shipped

Approach (a) from the implement ticket: host-side reuse of each host's shipped
UNIQUE enforcement, run **post-batch** inside `applyMaintenance` — after an op
batch lands in pending state, every written (insert/update) image is checked
against the batch's final effective contents for a different-PK row matching
the constraint; a hit throws `maintainedTableUniqueViolationError` (attributed,
names constraint + key values, `UNIQUE constraint failed:` prefix preserved).
Post-batch is load-bearing (a `replace-all` diff applies upserts before
deletes, so a per-op check would false-positive on a PK-move of a unique
value); checking only written images is complete by induction (pre-existing
rows entered through validated paths). Maintenance postures: conflict action
forced to ABORT (a declared `on conflict replace/ignore` default must not
evict derived rows), covering-MV route bypassed (it lags the batch). NULL-pass,
partial-predicate scope, per-column collation, same-PK exclusion all reused
from each host's DML enforcement. One mechanism covers create-fill/attach
reconcile, steady-state bounded deltas, full-rebuild flush, and MV-over-MV
cascades. `vtab/backing-host.ts` § Constraint validation now records the
host-owned contract (CHECK/FK stay engine-owned).

Folded-in engine fix (pre-existing, reviewer-confirmed reproducible at the
parent commit): `MemoryIndex.addEntry/removeEntry` mutated entries shared with
ancestor layer trees in place, so a rolled-back statement's index mutations
leaked into committed state — a rolled-back DELETE silently un-enforced
UNIQUE. Remedied by `ownedEntries` (WeakSet) copy-on-write plus live-candidate
validation in `checkUniqueViaIndex`.

## Review findings

**Read first-hand:** the full implement diff (all 13 files), then the current
state of: memory manager UNIQUE machinery (`checkSingleUniqueConstraint`,
`findIndexForConstraint`, `checkUniqueViaIndex`, `checkUniqueByScanning`,
`checkUniqueViaMaterializedView`, `applyMaintenanceToLayer`,
`enforceSecondaryUniqueOnMaintenance`), `MemoryIndex`, `TransactionLayer`,
`MemoryTableConnection` (savepoint paths), layer collapse, inheritree's
`updateAt`/`internalUpdate`/`deleteAt` (node-level CoW + entry freezing), store
`findUniqueConflict`/`compileFor`/`checkUniqueConstraints`/
`applyMaintenance`/`applyReplaceAll`, `appendIndexToTableSchema` /
`buildUniqueConstraintSchema` / `ensureUniqueConstraintIndexes` (UC↔index
collation flow), and the isolation module's `getBackingHost` delegation.

### Major (fixed inline — regression introduced by the implement diff)

- **`checkUniqueViaIndex` live-candidate validation used the wrong collation.**
  It re-compared candidates under the *column's* declared collation; an
  explicit `create unique index … (b collate nocase)` over a BINARY column
  finds case-variant candidates via the index comparator but the validation
  then skipped them — the index silently stopped enforcing. Reproduced
  empirically: enforced at the parent commit, accepted at the implement
  commit. This also broke the planner's key-promotion soundness assumption
  (`enforcementCollationCoversDeclared` and
  `test/planner/collation-soundness.spec.ts` document that index-derived
  UNIQUE enforces under the *index's* per-column collation — a key claim over
  data that can hold duplicates is unsound). Fixed: validation now compares
  under `index.specColumns[i].collation` (positionally aligned with
  `uc.columns` by `findIndexForConstraint`'s match), falling back to the
  column collation. Regression pinned in `05-vtab_memory.sqllogic` (memory-only
  file — the store has a *pre-existing* divergence here, see below).

### Minor (fixed inline)

- **No regression test for the rollback-corruption fix on an ordinary table.**
  The CoW fix is an engine-wide correctness fix, but the implement commit only
  exercised it through maintained-table scenarios (51.9). Added both shapes to
  `101-transaction-edge-cases.sqllogic` (runs under memory AND store): a
  rolled-back DELETE must leave UNIQUE enforced; a rolled-back INSERT must not
  leave a phantom blocking the value.
- **Bounded-delta swap asymmetry untested** (called out by the handoff itself).
  Added 51.9 §12: an intra-statement value swap across two source rows aborts
  mid-statement with whole-statement rollback, per the documented semantics.

### Verified sound (no action)

- **CoW ownership discipline**: every mutation path goes through a pending
  `TransactionLayer`'s fresh `MemoryIndex` instances; committed layers reject
  `recordUpsert`/`recordDelete`; savepoints `markCommitted()` the pending layer
  before stacking over it; collapse only calls `clearBase()` on committed
  layers — so an entry owned by a layer's index is never mutated while another
  live tree inherits it. inheritree's `updateAt` same-key arm does node-level
  CoW (`mutableLeaf`) and the entry freeze is shallow (the `primaryKeys` Set
  stays mutable for the owned fast path).
- **REPLACE arm `continue` + iteration safety**: `getPrimaryKeys` returns a
  copied array, so `recordDelete` during the candidate scan is safe; multiple
  evictions only possible with pre-existing duplicates (e.g. stale entries),
  where scanning on is strictly more correct.
- **Post-batch completeness argument** (any colliding pair includes a written
  image) holds; value-identical-upsert skip cannot mask a collision.
- **Store enforcement** reads the pending overlay (post-batch view), honors
  partial-predicate scope/NULL-pass/self-PK exclusion via `findUniqueConflict`;
  enforcement runs after all ops land. The skip-identical contract and
  effective-change reporting are untouched.
- **Contract docs** (`vtab/backing-host.ts` both packages,
  `docs/materialized-views.md`) accurately describe the shipped behavior,
  including the bounded-delta vs full-rebuild swap asymmetry. The isolation
  module delegates `getBackingHost` to the underlying module, so no in-repo
  host lacks the guard.
- **Filed ticket accuracy**: `fix/memory-index-composite-pk-value-identity`
  correctly scopes the remaining by-reference Set-membership defect to
  scans/stats (enforcement is mitigated by the live-candidate validation).

### Deferred / tracked elsewhere

- **Store ignores explicit unique-index collation** (`findUniqueConflict`
  compares under the column collation only) — *pre-existing* memory↔store
  divergence, now concretely documented in the existing backlog ticket
  `unique-enforcement-collation-cross-module-audit` (updated with the
  post-review enforcement reality and the exact divergent shape).
- **Coarsened-backing-key + secondary UNIQUE** still has no dedicated test;
  the mechanism is shape-identical (post-batch check on written images at
  distinct PKs) and the cost of constructing the scenario outweighed the
  marginal coverage — left as a known gap.
- **`replaceContents` validation-free** posture: tracked by
  `maintained-table-refresh-revalidation` (backlog, confirmed present).
- **Parent-side FK orphan**: `maintained-table-parent-side-fk-orphan`
  (backlog, confirmed present).
- **Store bulk-attach cost** (per written image × full scan): same posture as
  store DML UNIQUE; optimize only if it surfaces.

## Validation

- `yarn lint` clean; `yarn build` clean (all packages).
- `yarn test` (full workspace) after the review fix: green (5987 passing in
  quereus + all other workspaces).
- Store mode: all six 51.x files plus 101, 102, 102.1, 102.2 green
  (`test-runner.mjs --store`); re-ran 51.9 and 101 after the new sections.
- Empirical before/after repro (worktree at the parent commit) confirming both
  the collation regression (introduced) and the rollback corruption
  (pre-existing, now fixed).
