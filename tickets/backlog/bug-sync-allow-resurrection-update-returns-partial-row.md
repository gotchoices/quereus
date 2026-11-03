description: With the optional setting that lets deleted rows come back, an edit made after a delete brings back only the edited column, so devices disagree and some get empty values in required columns, even when nothing has been forgotten.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/metadata/tombstones.ts # isDeletedAndBlocking (~211): under allowResurrection a later write passes, whatever it is
  - packages/quereus-sync/src/sync/change-applicator.ts # resolveChange (~959), reconcileInBatchDeletes (~1099)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: `allowResurrection` is off by default, and neither the coordinator nor quoomb-web turns it on; `docs/sync.md` explicitly says an update can resurrect a row, so fixing this changes documented behaviour for an option that may have no users.
----

## What happens

Run with real clients against a real coordinator, with `allowResurrection: true` on every replica, on `orders (id integer primary key, note text not null, qty integer not null)`. No tombstone was pruned.

1. A inserts rows 1 and 2. B receives them and disconnects.
2. A deletes row 1, and the server receives it.
3. B then runs `update orders set note = 'edited offline' where id = 1`, so its edit is later than the delete.
4. B reconnects, and a new device C bootstraps.

| Replica | Row 1 |
|---|---|
| A | `(1, 'edited offline', NULL)` |
| B | no row |
| Server | `note` cell only |
| C | `(1, 'edited offline', NULL)` |

So the writer loses its row, and the others hold a fragment with a null in a `not null` column. No error is reported.

## Expected behaviour

Replicas converge, and none materializes a row missing cells. The open question is what "resurrect" should mean. The rule that keeps deletes in force past pruning, from `sync-offline-edit-of-pruned-row-splits-replicas`, is switched off under this option. Candidate: only a write with no before-image (a real re-insert, which carries every column) resurrects, and an edit does not. That would change the sentence in `docs/sync.md` saying an update can resurrect a row.
