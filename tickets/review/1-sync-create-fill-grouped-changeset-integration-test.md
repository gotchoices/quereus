description: Review a new end-to-end test that proves turning on replication for a materialized view over an already-populated table publishes those existing rows to peers as one batched change.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # ALL changes live here (test-only)
  - tickets/backlog/sync-refresh-stale-fill-grouped-changeset-test.md      # deferred non-empty refresh-grouping half
difficulty: medium
----

## What was built

Test-only change. **No production code was touched.** Added an end-to-end
integration test for the headline migration scenario: enabling
`quereus.sync.replicate` on a materialized view whose **source already holds
rows** publishes the create-fill rows to a peer, delivered as **one grouped
change-set under a single HLC**.

All edits are in `packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`:

- **`makeBarePeer(name)`** — factored the shared provider/events/db/module/adapter/
  SyncManager wiring out of `makePeer` (stops before any `create table`). `makePeer`
  now calls it then runs its same two `db.exec`s in the same order — behaviorally
  identical, so the existing 5 echo-loop tests are unaffected.
- **`makeFilledPeer(name, seedRows)`** — builds a peer whose `src` is seeded (ONE
  multi-row insert → one src txn) **before** the tagged MV is created, so create-fill
  is non-empty.
- A new `describe('create-fill of a populated source publishes one grouped
  change-set')` with three tests:
  1. **Producer (A)** — A's relayable log carries the create-fill as **exactly one**
     mv ChangeSet (the grouping crux), with all mv changes sharing the set's
     `transactionId` and base HLC `(wallTime, counter, siteId)`; the seed is its own
     **distinct** src ChangeSet (not fused into the create-fill commit).
  2. **Peer (B)** — relay A→B, `res.applied > 0`, B's `mv`/`src` deep-equal the seed
     and A's; cold-fill delivered remote:true with **no** local re-derivation and
     **zero** B-origin echo (quiescence reused for the cold path).
  3. **Refresh-suppression (A)** — `refresh materialized view mv` over the converged
     MV emits nothing and publishes no new change-set (refresh path wired, no
     double-publish).

## Validation run

- `cd packages/quereus-sync && yarn test` → **279 passing, 0 failing** (the prior 5
  echo-loop tests + the 3 new ones). The `[Sync] Oversized transaction …` and
  `[Sync] Error handling transaction commit …` log lines in the output are emitted by
  **`sync-manager.spec.ts`** tests that deliberately inject `batchSize: 1` and a
  failing KV — pre-existing test design, not failures and unrelated to this change.
- Type-check clean: `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit`
  (exit 0, no output). `quereus-sync` has no eslint script (only `packages/quereus`
  does, per AGENTS.md), so the tsconfig.test type-check is the relevant gate.

## ⚠️ Finding the reviewer must scrutinize — the ticket's column-granularity claim was WRONG

The ticket asserted (Edge cases § Granularity) that "an insert records one
`ColumnChange` per **non-PK** column", predicting **3** mv changes for 3 cold rows
of the `(id, v)` schema. **This is incorrect for this codebase.** The actual count
is **6** (3 rows × 2 columns).

Root cause (verified, not a regression): `recordColumnVersions`
(`sync-manager-impl.ts:441`) emits one `ColumnChange` for every column where
`!oldRow || oldValue !== newValue`. A create-fill row is a **fresh insert** (no
`oldRow`), so **every** column is recorded — **including the PK `id`**. There is no
non-PK filtering. (An UPDATE, by contrast, records only the columns that differ.)

I adjusted the test to assert the **actual** contract (`rows ×
columnsPerFreshInsert`, with `COLUMNS_PER_FRESH_INSERT = 2`, fully commented) and
kept the assertion expressed per-column (not a flat N) as the ticket asked.

**Why this is not a relaxation of the grouping assertion:** the grouping crux
(`mvSets.length === 1`, all changes under one transactionId + one base HLC) is
unaffected and passes strictly. The discrepancy is purely the *count* of changes
*within* that one group, and it stems from the ticket author's mistaken assumption
about column recording — not from a grouping bug. The relay test confirms the
PK-column change applies and converges cleanly on the peer.

**Reviewer judgment call:** confirm that recording the PK column `id` as its own
`ColumnChange` on a fresh insert is *intended* (it appears to be standard
column-version-on-insert behavior — the value equals the pk and the relay
converges). If it is considered redundant/undesirable, that is a **separate
production concern**, not part of this test ticket; file a fix/backlog ticket rather
than editing this test.

## Other honest gaps / choices

- **B-side delivery grouping uses the remote-event proof, not
  `ApplyResult.transactions`.** As the ticket anticipated, `transactions` =
  `changes.length` of the full relayed ChangeSet array (the empty create-table-src
  set + the seed set + the mv create-fill set = 3), so it does **not** cleanly
  isolate "the mv fill = 1 transaction". The producer-side test already pins the fill
  to one ChangeSet; the peer side reuses the suite's remote:true / no-local-event /
  zero-echo proof. Documented inline.
- **Non-empty refresh-grouping is DEFERRED.** Only the refresh-**suppression** half
  is implemented (converged MV → refresh → zero deltas). Staging a non-empty refresh
  delta needs the committed MV to drift from its body without row-time maintenance
  (the "stale table" trigger), which can't be staged in this synced-MV harness
  without hacking internals. Filed as `tickets/backlog/sync-refresh-stale-fill-grouped-changeset-test.md`.
  The store-host unit suite already covers refresh-path delta correctness; residual
  grouping risk is low. Reviewer may promote that backlog ticket if desired.
- **Settle timing.** Reuses the harness's existing 25ms `settle()` for the
  fire-and-forget post-commit capture (after `makeFilledPeer`, and after the refresh).
  If CI ever flakes on this, it is the same race the existing suite already lives with.

## How to re-validate

```
cd packages/quereus-sync && yarn test 2>&1 | tee /tmp/sync-test.log; tail -n 60 /tmp/sync-test.log
# from repo root:
node_modules/typescript/bin/tsc -p packages/quereus-sync/tsconfig.test.json --noEmit
```
