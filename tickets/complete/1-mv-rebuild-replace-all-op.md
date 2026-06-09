description: The `replace-all` `MaintenanceOp` on `MemoryTableManager` — wholesale, transactional pending-layer replacement realized as a keyed diff (by backing PK) → minimal `BackingRowChange[]`, the primitive the full-rebuild MV arm will drive. Implemented, reviewed, landed.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/vtab/maintenance-replace-all.spec.ts, docs/incremental-maintenance.md
----

## What landed

A `replace-all` variant on the `MaintenanceOp` union in `vtab/memory/layer/manager.ts`,
handled by `applyMaintenanceToLayer`:

```
| { kind: 'replace-all'; rows: Row[] }
```

It replaces the backing's entire pending-effective contents with `rows`, realized as a
keyed diff by backing PK against the layer's current rows, returning the minimal realized
`BackingRowChange[]` the MV-over-MV cascade already consumes. The op targets the *pending*
`TransactionLayer` (created lazily, like a user write), so it commits/rolls-back in lockstep
with the source write — unlike the CREATE/REFRESH `replaceBaseLayer` primitive, which swaps
the committed *base* layer.

Algorithm: snapshot current effective rows into a PK-keyed btree (`oldByKey`); build a
PK-keyed set of new-row keys (`newKeys`); upsert pass in new-row order (`insert` when key
absent, `update` when present and `rowsEqual` is false, skip when equal); delete pass in
ascending PK order (`recordDelete` every old key absent from `newKeys`). Key matching and the
skip-identical check are collation-aware (`comparePrimaryKeys` / `rowsEqual` via
`compareSqlValues` per column), never JS `===`. The switch keeps its `never` default.

## Review findings

**Diff reviewed first, with fresh eyes (commit `ecaee4c2`), before the handoff summary.**
Scrutinized across SPP, DRY, modularity, type safety, resource cleanup, error handling,
performance, and consumer/interaction surface.

### Verified sound (no change needed)
- **Comparator/extractor binding.** `comparePrimaryKeys` / `primaryKeyFunctions.{compare,extractFromRow}`
  are standalone closures (`utils/primary-key.ts`) that do not reference `this`; passing
  `this.comparePrimaryKeys` straight into the `BTree` constructor is safe — no lost-`this` hazard.
- **BTree API usage.** `get` / `insert` / `first` / `ascending` / `at` match the `inheritree`
  d.ts and the sibling pattern in `base.ts:106`. `get(key)` returns the value entry; the
  ascending-snapshot-then-`at(path)!` delete walk mirrors existing code.
- **Snapshot-before-mutate.** `oldByKey` is built fully before any `recordUpsert`, so the diff
  is computed against a stable before-image; the delete pass iterates that private snapshot
  while `recordDelete` mutates the layer's tree — no mid-iteration mutation hazard.
- **Index + change bookkeeping.** Both passes route through `recordUpsert`/`recordDelete`, so
  secondary-index maintenance and pending-change events stay correct. The collation-equal
  key-flip `update` (`'Apple'`→`'apple'`) is handled by `recordUpsert`'s key-change branch
  (verified in `transaction.ts:171`) — no leaked index entry. Confirmed by the secondary-index
  and NOCASE tests.
- **`rowsEqual` semantics.** Per-column `compareSqlValues` with each column's collation is
  consistent with the PK comparator's collation handling; cross-type numeric (`5` vs `5n`) and
  NOCASE skips behave as documented. The collation-honoring (not byte-for-byte) definition is a
  deliberate, documented choice; acceptable for the MV use (the body's logical value, not stored
  binary casing, is what the cascade consumes).
- **Exhaustiveness / consumers.** The `never` default is retained. No other site switches on
  `MaintenanceOp.kind` — `database-materialized-views.ts` only *builds* ops and consumes the
  returned `BackingRowChange[]` uniformly — so the new variant breaks nothing. `yarn typecheck`
  clean.
- **Store-path parity.** Confirmed memory-only by design (MV backings are always the `memory`
  module; `getBackingManager` throws otherwise). No store mirror needed.

### Minor — fixed in this pass
- **Composite-PK coverage gap.** Every implementer test used a single-column PK, yet MV backing
  tables routinely carry composite PKs (group-by/join keys) — the primary realistic path the
  full-rebuild arm will drive was untested. Added
  `composite PK: diffs by the full composite key, deletes in ascending composite-PK order`
  to `maintenance-replace-all.spec.ts`, exercising composite key extraction, comparison,
  identical-skip, and ascending multi-key delete ordering. Passes.

### Minor — noted, no code change (corrects the handoff record)
- **Duplicate-key behavior was mis-described in the handoff.** The handoff claimed two `rows`
  sharing a backing PK would resolve to "second sees the first as existing → update." That is
  incorrect: the upsert pass consults `oldByKey` (the *old* snapshot), not the running layer or
  `newKeys`, so two new rows at the same absent key both resolve to **`insert`**, and the second
  `recordUpsert(key, rowB, null)` (passing `null` as old-row) would leak rowA's secondary-index
  entry. This **cannot arise** from a set-producing MV body (enforced upstream via
  `materializedViewNotASetError`), so the op is correctly left undefended — but the actual
  failure mode is recorded here rather than the handoff's wrong rationale, in case a future
  non-set producer ever drives this primitive.

### Not in scope (carried forward, as the handoff disclosed)
- **No producer / integration coverage yet.** Nothing emits `replace-all` today; the unit suite
  is the floor. The full-rebuild arm and the equivalence harness
  (`test/incremental/maintenance-equivalence.spec.ts`) are the next ticket
  (`mv-full-rebuild-arm`, `prereq: mv-rebuild-replace-all-op`). Treated as expected, not a defect.

### Validation run
- `yarn typecheck` — clean.
- `yarn lint` (manager.ts + spec) — clean.
- `maintenance-replace-all.spec.ts` — **10 passing** (9 original + new composite-PK case).
- Full `test/vtab/**` suite — **101 passing**, 0 failing (sibling maintenance/prefix-delete,
  concurrency, scan-layer, event-emitter all green; no regression).

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

## End
