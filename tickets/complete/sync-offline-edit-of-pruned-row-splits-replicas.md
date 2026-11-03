description: If a device edits a row while offline and that row gets deleted elsewhere and forgotten by the server, the server now refuses the edit, so the delete holds on every device and a new device no longer gets empty values in required columns.
architecture: docs/sync-protocol.md#client-snapshot-bootstrap
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # isEditOfForgottenRow, refuseEditsOfForgottenRows, tablesWithRecordsElsewhere, commitColumnMetadata
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions: by-value comparison, key cells carry no before-image
  - packages/quereus-sync/test/sync/edit-of-forgotten-row.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts
  - docs/sync-protocol.md
  - docs/sync.md
----

## What landed

**The rule.** Under the default delete-wins policy, a replica that has pruned at least one tombstone refuses a column change that carries a before-image when it holds no cell and no tombstone for that row, unless the same batch contains a first write for the row. The refused change counts as `skipped` and fires no event. The writer's application sees the row leave through the snapshot's ordinary remote delete.

**What makes a first write reliable.** A row's primary-key cells never carry a before-image, and a relay never adds one to a change that arrived without one. So every row on the wire has a cell showing it is not an edit of a forgotten row. Review added this invariant.

**Exemptions.** Replicas that never pruned, `allowResurrection: true`, a table the same batch renames, and a table whose key was ever redefined, including under an earlier name.

**A wider effect.** Local updates now compare cells by value, so untouched blob and JSON columns are no longer re-recorded and stop overwriting a peer's concurrent write to them.

## Review findings

**Checked:** the implement diff first, then every condition in the rule against real writes. Scenarios run against a pruned relay were insert-or-replace, upsert, key updates and updates back, delete then reinsert, `NOCASE` key rewrites, table rename, and concurrent first writes. Docs in `docs/sync.md` and `docs/sync-protocol.md` were read against the final behaviour.

**Found and fixed in this pass.** All four were false refusals, and each silently lost real work. Each has a test that was confirmed to fail with its fix reverted.

- **A row two devices first-wrote was refused by a third replica.** `commitColumnMetadata` stored a before-image from the relay's own previous version, even when the change arrived with none. Every cell of the row then looked like an edit, so a replica with a delta floor refused the whole row and stayed without it. A device has a floor as soon as it bootstraps from a server that has pruned, so this needs only two devices inserting one key while a third is offline. Fixed by not adding a before-image the writer did not send. An existing test in `sync-protocol-e2e.spec.ts` relied on the old behaviour through hand-built changes with no before-image, so it now supplies them; what it pins is unchanged.
- **A `NOCASE` key rewrite lost real edits, and more widely than the handoff said.** The handoff had this as an unrun note about a row never pushed. Running it showed the never-pushed row refused outright (2 of 2 cells). It also showed that on a relay, which keys raw values, `update orders set id = 'a', note = 'b' where id = 'A'` on an already-pushed row was refused, losing the `note` edit with no snapshot to reconcile the writer. Fixed by the key-cell invariant above, and the note is removed.
- **A table renamed in the same batch as an edit.** A relay has no catalog, so it takes the new name for one it already has, and the records still answer to the old name during resolution. Fixed by exempting that table.
- **A key change followed by a rename lost the exemption.** The handoff parked this as a `NOTE:`, but it was a defect on a reachable path rather than a conditional concern. `keyWasEverRedefined` now follows `rename_table.fromTable` back through earlier names.

**Test changes.** The blob-key test no longer tested the by-value comparison once key cells stopped carrying before-images, so it was replaced by one that pins the real contract: an untouched blob cell keeps its version. Other tests were kept, as each pins a named branch of the rule.

**Ticket filed:** `bug-sync-key-change-through-relay-diverges`. Running the handoff's unverified relay key exemption through a real client and coordinator showed the edit is accepted and reaches the other device as designed, but the writer diverges: it loses its own edit, or loses a row if it takes a snapshot. This also happens with no prune at all, so this rule did not cause it. `docs/sync.md` now points to the ticket.

**Tripwires and limits, recorded in docs rather than code:**

- A key rewritten to a new spelling on a forgotten row counts as a first write, so a fragment can return. Listed under what the rule does not cover in `docs/sync.md`. This is the accepted cost of the key-cell invariant.
- The key exemption stays broad and permanent for a table, including on engine peers, as the implementer chose. `docs/sync.md` says so.

**Considered and left alone:**

- **The `drainTableGroup` call has no test.** It calls the same pass, and reading it showed nothing specific to drain except that its schema-drift filter can drop a first-write cell. Not worth a test by the project's bar.
- **JSON columns have no direct by-value test.** They use the shared `sqlValueIdentical` comparator, which the engine already relies on.
- **Unpushed rows recorded before this change** can still carry a before-image on their key. The project is not preserving backwards compatibility yet.
- **The rekey warning text** ("the table was created or renamed by the same batch") is misleading on a relay and was seen again in the end-to-end runs. Logging only, so it was not changed here.
- **Cost.** Each flagged change scans its row, and each batch with flagged changes reads that table's migrations. Both are behind the delta floor check on a rare path. Not measured.

**Validation:** after the last code edit, `@quereus/sync` has 817 passing, `sync-coordinator` 138 passing and `sync-client` 106 passing, and the `@quereus/sync` typecheck is clean. `yarn lint` was not run, because these packages' lint scripts are no-ops. The whole-repo `yarn test` was not run, because only `@quereus/sync` source changed.
