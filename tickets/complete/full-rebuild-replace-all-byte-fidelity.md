description: Full-rebuild floor `replace-all` byte-fidelity — the wholesale identical-row skip now uses byte-faithful `rowsValueIdentical` instead of collation-aware `rowsEqual` (key pairing stays collation-aware via the PK comparator), in both the memory and store hosts. Reviewed and completed.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                    # replace-all arm now rowsValueIdentical; dead rowsEqual removed
  - packages/quereus-store/src/common/backing-host.ts                    # applyReplaceAll now rowsValueIdentical; dead rowsEqual + compareSqlValues import dropped
  - packages/quereus/src/util/comparison.ts                              # rowsValueIdentical (unchanged) — the byte-faithful discipline
  - packages/quereus/test/vtab/maintenance-replace-all.spec.ts          # case flipped + byte-identical sibling added
  - packages/quereus-store/test/backing-host.spec.ts                    # replace-all NOCASE byte-faithful case
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts   # new full-rebuild floor NOCASE-PK suite (+ plan-kind guard, added in review)
  - docs/materialized-views.md                                          # § Value-identical write suppression — one discipline
  - docs/incremental-maintenance.md                                     # § replace-all primitive — collation-aware KEY pairing + byte-faithful VALUE compare
----

# Complete: full-rebuild floor `replace-all` byte-fidelity

## Summary

The full-rebuild MV maintenance floor's wholesale `replace-all` keyed diff conflated two
disciplines: **key pairing** (which old row a new row pairs with — collation-aware via the
PK comparator, load-bearing, unchanged) and the **identical-row skip** (whether a paired
row is a no-op). The skip was *also* collation-aware (`rowsEqual` → per-column
`compareSqlValues` under each column's collation), so under a NOCASE PK a case-only rewrite
(`'apple'` → `'APPLE'`) matched and was skipped, leaving stale bytes in the backing —
`read(MV) != evaluate(body)`, a byte-wise violation of the maintenance-equivalence oracle.

The fix narrows the skip to byte-faithful `rowsValueIdentical` (BINARY per column,
numeric-storage-class tolerant) in both hosts (memory `MemoryTableManager`, store
`StoreBackingHost`), matching the point-op `upsert` skip. A collation-equal / byte-different
paired row is now an `update` that re-keys the stored bytes; a byte-identical row still
skips. The dead private `rowsEqual` was removed from both hosts and the store host's
now-unused `compareSqlValues` import dropped. Docs collapsed to one discipline.

## Review findings

Adversarial pass over the implement diff (`ecbe031e`), read fresh before the handoff.

### Checked

- **Source correctness (both hosts).** `rowsEqual` → `rowsValueIdentical` swap is correct in
  `manager.ts` (~L1403) and `backing-host.ts` (~L211). Key pairing remains the PK comparator
  / encoded-key-hash (collation-aware) in both. Store host re-keys a byte-different paired row
  *in place* — under NOCASE the new and old encoded data keys are byte-identical (key collation
  folds case), so `put(newKey, …)` overwrites the same slot; the `update` path correctly omits
  `trackPrivilegedMutation` (count unchanged). Verified against the test's `scanEffective` result.
- **Dead-code removal.** `find_references` confirms `rowsEqual` is gone from both hosts — the
  only surviving mention is the historical docstring in `maintenance-equivalence.spec.ts`
  ("the prior `rowsEqual`"), which reads as bug context, not a live reference.
- **Import drop scoping.** `compareSqlValues` was dropped only from `backing-host.ts`; it stays
  imported/used in `store-table.ts` and `store-module.ts` (their own imports — collation-aware
  range bounds, UNIQUE enforcement). Correct, no broken import.
- **`rowsValueIdentical` semantics.** BINARY per column via `compareSqlValuesFast`, numeric
  storage classes fold (`5` ≡ `5n`), byte-exact for text/blob — matches the documented contract
  in `comparison.ts` and the point-op upsert skip.
- **Docs.** Both `docs/materialized-views.md` and `docs/incremental-maintenance.md` now state
  one discipline (collation-aware KEY pairing + byte-faithful VALUE skip); the prior divergence
  note is gone. Verified both read correctly against the new reality.
- **Routing (the handoff's flagged sanity check).** `forceFullRebuild` *unconditionally*
  installs a `'full-rebuild'` plan into `mgr.rowTime`, so the NOCASE suite exercises
  `replace-all` by construction (the multi-source suite asserts `plan.kind === 'full-rebuild'`
  via the identical helper). Hardened anyway — see below.
- **Test coverage.** Happy path (byte-identical skip), the bug (case-only rewrite re-keys),
  cross-type numeric tolerance, collation-aware key pairing with changed payload, store-host
  parity (composite DESC/NOCASE PK), and a 60-run property suite over random NOCASE mutations
  incl. case-only rewrites, in-txn + post-rollback.

### Found & fixed inline (minor)

- **Formatting:** an over-indented comment line in `manager.ts` (6 tabs vs the surrounding
  5-tab block) plus an overlong comment line introduced by the edit — rewrapped to a clean,
  consistent 5-tab block.
- **Test hardening:** added a white-box `registeredPlanKind(db, 'mv') === 'full-rebuild'`
  assertion to the deterministic NOCASE test. The body (`select id, v from t`) is a distinct
  shape from the integer-PK floor suites; this pins that it really routes through the fixed
  `replace-all` path and not a bounded-delta arm that would pass equivalence via delete+insert
  without exercising the byte-faithful skip — closing the handoff's explicit concern.

### Found, not actioned (acknowledged gaps — no ticket filed)

- **`test:store` (LevelDB persistence path) not run.** The byte-fidelity change is a pure row
  comparison *before* `coordinator.put` — provider-agnostic. The store `backing-host.spec.ts`
  exercises the host against the in-memory store provider. Persisted behavior is identical by
  construction; a full `test:store` run is slow and CI-grade, not worth a ticket.
- **No store-backed equivalence oracle for the floor.** The `read(MV) == evaluate(body)` oracle
  is memory-only; the store `replace-all` is covered by the direct host unit spec. Minor
  coverage gap, not a correctness risk — not filed.

### Majors

None. No new fix/plan/backlog tickets spawned.

## Validation (all green, post-review-edits)

- `test:single maintenance-replace-all.spec.ts` — 11 passing.
- `test:single maintenance-equivalence.spec.ts` — 104 passing (incl. the floor-NOCASE suite + new plan-kind guard).
- `@quereus/store test:single backing-host.spec.ts` — 28 passing.
- `@quereus/quereus lint` — clean, exit 0.

No pre-existing failures encountered.
