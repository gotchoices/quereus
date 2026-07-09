description: When two connections commit disjoint changes to the same in-memory table in one transaction, the second commit used to silently discard the first's already-committed rows; the commit path now rebases instead of overwriting, so both survive.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/transaction.ts, packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts, docs/memory-table.md
difficulty: medium
----

## What shipped

`MemoryTableManager.commitTransaction` no longer overwrites the committed head
wholesale on the sibling-layer path. It now relates the committing connection's
pending `TransactionLayer` to the current committed head via three explicit cases:

- **Case A** — head is an ancestor of pending: publish wholesale (unchanged).
- **Case B** — head advanced past pending's fork point (a sibling connection
  committed a disjoint change first): *rebase*. `rebaseLayerOntoHead` builds a fresh
  `TransactionLayer` parented on the advanced head and replays only this branch's
  own structural writes on top, so the sibling's rows are inherited (not discarded).
  A schema-drift guard aborts with `BUSY` rather than replay stale-schema rows.
- **Case C** — no common ancestor: `BUSY` outside a coordinated commit; wholesale
  fallback inside one (unchanged).

Replay source is a new always-on per-layer write log (`TransactionLayer.ownWrites`
/ `getOwnWrites()`), maintained independently of the event-tracking `pendingChanges`
(which only records when listeners are present). Each replayed write re-derives the
effective row at its PK on the new head and passes it as the old row so
secondary-index maintenance removes the correct pre-existing entry.

See commit `55a0e9aa` for the full implementation diff.

## Review findings

**Scope reviewed:** the implement diff fresh (manager.ts commit path + helpers,
transaction.ts own-write log), the `TransactionLayer` constructor / secondary-index
inheritance, `lookupEffectiveRow`, `recordUpsert`/`recordDelete` index maintenance,
the three shipped tests, and `docs/memory-table.md`.

### Correctness — no defects found
- **Rebase replay ordering** is chronological: write chunks are gathered
  newest-layer-first then reversed (oldest layer first), and each layer's `ownWrites`
  is already oldest-first. Correct.
- **Secondary-index inheritance under rebase** verified: `new TransactionLayer(head)`
  inherits the head's secondary trees via `initializeSecondaryIndexes`, and the
  replay's `recordUpsert(pk, newRow, effective)` runs full index maintenance against
  them. Correct — but was the one non-trivial path with **zero test coverage** (all
  three shipped tests use a PK-only table). **Fixed inline:** added a fourth test
  (`maintains a secondary index when rebasing a sibling`) that creates an index,
  commits two disjoint sibling inserts, and asserts the rebased head's secondary
  index tree carries all three distinct keys (a rebase that skipped index maintenance
  would drop the rebasing writer's entry). Passes.
- **Three-way rebase chain** (`B ← P1 ← rebased-P2 ← rebased-P3`) traced by hand and
  covered by the existing test — the rebased layer populates its own `ownWrites`, so
  it can itself serve as a future fork point. Correct.
- **DELETE replay** skips when the effective row is null (nothing to delete on the
  head) and removes the sibling/base row otherwise. Correct for the disjoint case;
  contended case is last-writer-wins by design (below).

### Behavior changes (flagged, not defects)
- **Savepoint-sibling now rebases.** The old sibling detection only checked
  `pendingLayer.getParent()` directly; the new fork-point walk finds the true common
  ancestor through intervening savepoint layers, so those rebase too. Strictly more
  correct. Still no test targets the savepoint-sibling combination specifically — a
  known coverage gap, not a defect (full suite green).
- **Schema drift under a coordinated commit now aborts with `BUSY`** (Case B guard)
  instead of a wholesale overwrite. Safer (no stale-schema corruption) but rolls back
  the whole coordinated `COMMIT`. Untested directly (needs an `ALTER TABLE`
  consolidating the base mid-transaction while a sibling holds a pending layer) —
  low-frequency, flagged not covered.
- **Event-emission oldRow in the contended case.** Case B emits events collected from
  the original pending layer, whose `oldRow` reflects the base `B`, not the rebased
  head. Only diverges when both siblings touch the same PK — already the documented
  last-writer-wins boundary. No event-emission test exercises the sibling path.

### Tripwires (parked in code as `NOTE:`, not tickets)
- **Own-write log allocation** — `TransactionLayer.ownWrites` is an always-on
  per-write array. Fine now; if write-heavy transactions ever show memory pressure,
  collapse to a PK-keyed last-write map. Parked at the field in `transaction.ts`.
- **Cross-sibling conflict undetected by design** — a contended PK / secondary-`UNIQUE`
  between two siblings resolves last-writer-wins with no error (`recordUpsert` does not
  re-run `checkUniqueConstraints`). This is the read-your-own-writes model; full
  conflict detection lives in `quereus-isolation`. Parked at the replay site in
  `manager.ts` and in `docs/memory-table.md`.

### Docs
- `docs/memory-table.md` gained an accurate "Commit and sibling-layer rebase" section
  covering the three cases, the own-write replay source, and the isolation-model
  boundary. Verified against the code — no drift.

### Major findings / new tickets
- **None.** No new `fix/`, `plan/`, or `backlog/` tickets filed. The untested paths
  (savepoint-sibling, schema-drift-under-coordinated-commit, sibling event emission)
  are low-frequency test-coverage gaps whose general logic is exercised by the full
  suite; not worth queued work.

## Validation
- `packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts` — 4 passing
  (3 original + the new secondary-index case).
- `yarn test` (all workspaces) — green; quereus package 6528 passing (was 6527, +1
  new test), zero failures across all packages (~3m).
- `cd packages/quereus && yarn lint` — clean (eslint + test `tsc`), exit 0.

## Known gaps (for a future reader)
- No test for the savepoint-sibling combination, schema-drift-during-coordinated-commit
  `BUSY`, or the event-emission path under a sibling commit (all flagged above).
- Rebase reconstructs the pending layer via replay, not by moving BTrees (inheritree
  exposes no base-swap primitive). Replay cost is O(writes in the rebased branch);
  large sibling transactions rebasing repeatedly is the theoretical worst case,
  untested for performance.
