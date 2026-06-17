description: An end-to-end test now proves that turning on replication for a materialized view over an already-populated table publishes those existing rows to peers as one batched change under a single timestamp.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # ALL changes live here (test-only)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                   # recordColumnVersions (:441) — column-granularity contract verified here
  - tickets/backlog/sync-refresh-stale-fill-grouped-changeset-test.md      # deferred non-empty refresh-grouping half
difficulty: medium
----

## What was built (test-only)

An end-to-end integration test for the headline migration scenario: enabling
`quereus.sync.replicate` on a materialized view whose **source already holds
rows** publishes the create-fill rows to a peer, delivered as **one grouped
change-set under a single HLC**. **No production code was touched** — verified
via `git show --name-status` (only the test file + ticket board moves).

All edits live in `packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`:
`makeBarePeer` (shared wiring factored out of `makePeer`), `makeFilledPeer`
(source seeded in one multi-row insert before the tagged MV is created), and a new
`describe('create-fill of a populated source publishes one grouped change-set')`
with three tests — producer grouping (exactly one mv ChangeSet, all changes under
one transactionId + base HLC, seed is a distinct src set), peer delivery
(relay A→B, convergence, cold-fill delivered remote:true with zero B-origin echo),
and refresh-suppression (refresh over a converged MV publishes nothing).

## Review findings

### Process followed
Read the implement diff (`97699abd`) and the full current test file with fresh
eyes before the handoff summary. Independently re-derived the implementer's
flagged finding against source. Ran the test suite and the test type-check. Scrutinized
the suite for SPP/DRY, vacuous-green risk, type safety, edge/error-path coverage,
and the legitimacy of the deferred scope.

### Validation gates (both pass)
- `cd packages/quereus-sync && yarn test` → **279 passing, 0 failing** (the prior 5
  echo-loop tests + the 3 new ones). The `[Sync] Oversized transaction …` and
  `[Sync] Error handling transaction commit …` console lines in the output are
  **pre-existing test design**, not failures: their stack traces point into
  `sync-manager.spec.ts` itself (`:1662`, `:1694`), which deliberately injects
  `batchSize: 1` and a failing KV to exercise error paths. Unrelated to this diff.
- Test type-check clean: `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit`
  (exit 0, no output). `quereus-sync` has no eslint script (only `packages/quereus`
  does, per AGENTS.md), so the tsconfig.test type-check is the relevant gate.

### Findings checked & disposition

- **The implementer's central correction is CORRECT (verified, not taken on
  faith).** The original plan ticket predicted **3** mv changes (one `ColumnChange`
  per non-PK column × 3 rows); the implementer corrected this to **6**. I read
  `recordColumnVersions` (`sync-manager-impl.ts:441-480`): it loops over *every*
  column of `newRow` and records a `ColumnChange` wherever `!oldRow || oldValue !==
  newValue`. A create-fill row is a fresh insert (`oldRow` undefined), so **every**
  column is recorded — including the PK `id`. There is no non-PK filtering. So 3
  rows × 2 columns = 6 is the actual contract; the test asserts `N ×
  COLUMNS_PER_FRESH_INSERT` (per-column, regression-proof for wider MVs) and is
  correct. The grouping crux (`mvSets.length === 1`, all changes under one
  transactionId + one base HLC) is unaffected and asserted strictly.

- **Observation (not a defect, not filed): the PK column `id` is recorded as its own
  `ColumnChange` on a fresh insert,** duplicating the value already carried in the
  change's `pk` field. This is pre-existing CRDT behavior (independent per-column
  versioning records the full row on insert), it converges cleanly on relay, and it
  is **outside this test ticket's scope** — the test correctly asserts the *actual*
  contract. It is a defensible design choice, not clearly a bug, so I did **not**
  file a ticket. If a future maintainer judges the redundant PK-column entry
  wasteful, that is a separate production-efficiency concern to raise then.

- **Test quality — no minor inline fixes needed.** The suite is well-constructed:
  the `makeBarePeer` factoring is clean DRY with no behavioral drift to the existing
  5 echo-loop tests (verified by 279-pass); non-empty guards (`mvChanges.length > 0`,
  the `bBefore` precondition) prevent a vacuous-green seed-ordering regression; the
  grouping assertion is non-vacuous (broken grouping → N ChangeSets → `mvSets.length
  !== 1`); type safety is sound (`c is ColumnChange` narrowing on the imported type).
  Coverage spans producer grouping, peer convergence + quiescence, refresh
  suppression, plus the pre-existing insert/update/delete/negative-control/reverse-
  relay cases.

- **Honest gaps the implementer documented, confirmed reasonable:**
  - *B-side delivery grouping uses the remote-event proof, not
    `ApplyResult.transactions`.* Confirmed: `transactions` counts the full relayed
    ChangeSet array (empty create-table-src set + seed set + mv fill set = 3), so it
    cannot isolate "the mv fill = 1 txn". The producer-side test already pins the
    fill to one ChangeSet; the peer side correctly reuses the suite's
    remote:true / no-local-event / zero-echo proof. Sound choice.
  - *Non-empty refresh-grouping is DEFERRED* and filed as
    `tickets/backlog/sync-refresh-stale-fill-grouped-changeset-test.md`. I reviewed
    that ticket: the deferral reasoning is legitimate — a continuously
    row-time-maintained synced MV never drifts, so a non-empty refresh delta cannot
    be staged through the public SQL surface without reaching into engine internals.
    The refresh grouping seam is shared with the now-covered create-fill path, so
    residual risk is low. Appropriate scope split, not a cop-out.
  - *Settle timing* reuses the suite's existing 25ms `settle()` for fire-and-forget
    post-commit capture — same in-memory race the existing suite already lives with;
    acceptable.

### Major findings requiring new tickets
**None** beyond the already-filed backlog ticket
(`sync-refresh-stale-fill-grouped-changeset-test`). No correctness, type-safety, or
coverage defect was found that warrants a new fix/plan ticket.

## How to re-validate

```
cd packages/quereus-sync && yarn test 2>&1 | tee /tmp/sync-test.log; tail -n 25 /tmp/sync-test.log
# from repo root:
node_modules/typescript/bin/tsc -p packages/quereus-sync/tsconfig.test.json --noEmit
```
