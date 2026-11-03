description: If a device edits a row while offline and that row gets deleted elsewhere and forgotten by the server, the edit brings back a fragment of the row, so devices disagree and a new device can get empty values in required columns. The server should refuse such an edit, so the delete holds everywhere just as it does before the server forgets it.
architecture: docs/sync-protocol.md#client-snapshot-bootstrap
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # resolveChange (~959) flags the edit; a new pass beside reconcileInBatchDeletes (~1099) refuses it; called from applyChanges (~427) and drainTableGroup (~861)
  - packages/quereus-sync/src/metadata/delta-floor.ts # DeltaFloorStore.get: undefined means this replica has never pruned a tombstone
  - packages/quereus-sync/src/metadata/column-version.ts # getRowVersions (~254)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions (~1179): an insert records every column with no before-image; an update records only changed columns, each with one
  - packages/quereus-sync/test/sync/_peer-harness.ts # makePeer, localWrite, relay
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # add the reproduction beside "a device returning past a pruned delete"
  - docs/sync-protocol.md
  - docs/sync.md
repro: verified
----

## What happens

Run with real clients against a real coordinator, on `orders (id integer primary key, note text not null, qty integer not null)`:

1. A inserts rows 1 and 2. B receives them and disconnects.
2. B runs `update orders set note = 'edited offline' where id = 1`.
3. A deletes row 1. The server applies the delete and prunes the tombstone (the record that the row was deleted).
4. B reconnects, pushes its `note` cell, is refused an incremental update with `snapshot_required`, and takes a snapshot.
5. A new device C bootstraps from the server.

| Outcome for row 1 | A | B | Server | C |
|---|---|---|---|---|
| Today, tombstone pruned | no row | `(1, 'edited offline', 1)` | `note` cell only | `(1, 'edited offline', NULL)` |
| Today, tombstone still kept | no row | no row | no row | no row |
| With the rule below, tombstone pruned (prototype) | no row | no row | no row | no row |

The prototype was 22 lines in `change-applicator.ts` and has been removed. With it, all 804 `@quereus/sync` tests passed, and throwaway end-to-end scenarios gave the results in the table, plus the new-row case described under *The rule*. The full `sync-coordinator` suite was not run against it.

## Decision: the delete holds

The fix ticket left open which state replicas should converge on. This ticket takes **the delete wins**, the same outcome as the second row of the table, for these reasons:

- `docs/sync.md` makes delete-wins the default and gives tombstones the job of stopping older writes from resurrecting rows. Pruning is a storage limit, and nothing in the docs says it was meant to change that outcome.
- The alternative, letting the edit bring the row back, cannot converge without further changes. A still holds its tombstone and refuses every cell under the default policy. The server would also need the row's other cells, which B no longer pushes because it pushes only its own writes.
- Keeping tombstones longer only moves the horizon, at a storage cost.

**The cost:** B's offline edit is lost without any event, exactly as it already is while the tombstone exists. B's application sees the row leave through the snapshot's ordinary remote delete.

**Reversibility:** the rule changes no wire format or stored record, so it can be undone by removing it. Edits it already refused stay lost.

## The rule

In `resolveChange`, a column change is an **edit of a forgotten row**, and resolves as `skipped`, when all of these hold:

| Condition | Why it is there |
|---|---|
| `allowResurrection` is false | Under the other policy a later write may bring a row back. That policy's own fragment bug is `bug-sync-allow-resurrection-update-returns-partial-row`. |
| The change carries a before-image (`priorHlc`) | The writer saw an earlier version, so this is not a first write. A change without one is always accepted, so a producer that omits it gets today's behaviour. |
| This replica has no cell for this row, and no tombstone | The row is unknown here. This is reached only after the existing checks found no version of this cell and no blocking tombstone, so normal updates pay nothing extra. |
| The table is not `freshLocalTable` | That path does no reads by design: the table has no resolvable key mapping yet. |
| The delta floor is defined (`ctx.deltaFloor.get()`) | A replica that has never pruned has forgotten nothing, so an edit reaching a new, empty server ahead of the row's other cells stays accepted. Do not compare HLCs against the floor: the before-image can be newer than the pruned delete, because the edit may be concurrent with it. |
| Nothing in the same batch founds the row: no `applied` column change for that row without a before-image | A new row inserted then edited offline pushes `id` with no before-image, and `note` and `qty` with one (seen in a probe). This must be judged across the whole batch, because `applyChanges` is order-independent and Phase 1 sees only pre-batch state. |

The last condition cannot be decided in `resolveChange`. So `resolveChange` sets a flag on `ResolvedChange`, and a second pass over the batch flips flagged entries to `skipped` unless the row has a founding cell. Run that pass in both `applyChanges` and `drainTableGroup`, beside `reconcileInBatchDeletes`.

When the founding cells came in an earlier batch, the row already has cells here, because a device pushes in timestamp order, one batch at a time.

Read the floor before scanning the row, since the floor is the cheaper check.

B recovers on its own. If B missed the delete, its received watermark is below that delete's HLC, which is at or below the floor, so the server answers `snapshot_required`. The snapshot then removes B's row, including its untracked `qty = 1`. That reasoning comes from the code, and the prototype run showed this result.

## What this does not cover

- **A re-sent insert** carries no before-image, so a whole row still returns on the server and on B while A stays without it: `bug-sync-resent-insert-returns-pruned-row`.
- **Rows never recorded by sync** produce a fragment with no before-image: `bug-sync-edit-of-unrecorded-row-sends-partial-row`.
- **Fragments already stored** on a server are not repaired.
- **A possible false refusal, inferred from reading the code and not run.** A row that was never pushed, on a server that has pruned, is refused if every one of its cells was rewritten offline, including the key through a case-only change under a `NOCASE` key. No founding cell then remains. Park this as a `NOTE:` at the pass.

## TODO

- Add the end-to-end reproduction to `sync-coordinator-roundtrip.e2e.spec.ts`: the steps above with a third peer C, asserting A, B, server and C all lack row 1 and keep row 2. Coordinator tests load `@quereus/sync` from `dist`, so run `yarn workspace @quereus/sync exec tsc -b` first.
- Implement the flag and the batch pass in `change-applicator.ts`, using small functions.
- Add `applyChanges`-level tests in `packages/quereus-sync/test/sync/` for the branches that decide the outcome: refused when only edits arrive for an unknown row after a prune; accepted when the same batch founds the row, in either array order; accepted when nothing was ever pruned; accepted under `allowResurrection: true`.
- Update `docs/sync-protocol.md`: rewrite the limit under *Client snapshot bootstrap* (it names this ticket), keeping only the re-sent insert; amend the "purely additive" and "Best-effort" text under *Per-cell before-image*, since a before-image now affects this one default outcome and its absence still changes nothing.
- Update `docs/sync.md`: state under *Tombstones and Deletions* that a delete still holds against an edit after pruning, and what it does not cover; correct "neither affects default resolution" in the conflict-resolver paragraph.
- Run the `@quereus/sync` and `sync-coordinator` test suites.
