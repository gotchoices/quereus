description: If a device edits a row while offline and that row gets deleted elsewhere and forgotten by the server, the server now refuses the edit, so the delete holds on every device and a new device no longer gets empty values in required columns. Please review the rule, plus two false refusals found while building it.
architecture: docs/sync-protocol.md#client-snapshot-bootstrap
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # isEditOfForgottenRow, refuseEditsOfForgottenRows, tablesWithRedefinedKey
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions compares cell values by value
  - packages/quereus-sync/test/sync/edit-of-forgotten-row.spec.ts
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts
  - docs/sync-protocol.md
  - docs/sync.md
----

## What changed

**The rule.** `resolveChange` flags a column change as an edit of a forgotten row when all of these hold: `allowResurrection` is false, the change has a `priorHlc`, the table is not `freshLocalTable`, the delta floor is defined, and this replica holds no cell and no tombstone for the row. `refuseEditsOfForgottenRows` then flips flagged entries to `skipped` unless the batch founds the row, meaning an applied column change for that row with no before-image. It runs after `reconcileInBatchDeletes` in both `applyChanges` and `drainTableGroup`.

The writer's edit is lost with no event, and the writer's application sees the row leave through the snapshot's ordinary remote delete. This is the decision the ticket made.

## Added beyond the ticket: please check these

Both are false refusals the ticket did not foresee. Either would have silently destroyed real work.

**Blob keys (reproduced).** `recordColumnVersions` compared cells with `!==`, and a blob read back from a row is a new object each time. So every update recorded the blob key as rewritten, with a before-image. A new row with a blob key, edited before its first push with all its other columns changed, had no founding cell, and the rule refused all of it. The new test failed with 2 cells skipped before the fix.

The fix uses `sqlValueIdentical`. This also changes something outside this rule: untouched blob and JSON columns are no longer re-recorded on every update, so they stop overwriting a peer's concurrent write to them. `5n` and `5` now also count as the same value.

**Redefined primary keys (tested at manager level only).** A relay has no engine, so it cannot re-file records after `alter primary key` (`planRekey` says so). A row's cells stay under the old key, and an edit addressed by the new key looks like an unknown row. An engine peer has the same blind spot inside a single batch, because Phase 1 reads before Phase 3 re-files. Refusing here would drop an edit other connected devices should receive, so `tablesWithRedefinedKey` exempts any table with a key change in this batch or in its recorded migrations.

The exemption is deliberately broad: it applies to engine peers as well, and permanently for that table. A fragment can therefore still return on such a table, as it does today. `docs/sync.md` says so.

## Tests added

In `edit-of-forgotten-row.spec.ts`, which uses a relay-only manager with hand-built changes unless noted:

| Test | Verifies |
|---|---|
| refused when only edits arrive for an unknown row after a prune | the rule itself |
| accepted when the same batch founds the row (founding cell first, founding cell last) | the batch-wide check is independent of array order |
| accepted when an earlier batch founded the row | cells already held are not flagged |
| accepted for a new row with a blob key edited before its first push (real peer) | reproduction of the blob false refusal |
| accepted when this replica has never pruned | the delta floor condition |
| accepted under `allowResurrection` | the policy condition |
| accepted when the same batch redefines the key | the in-batch key exemption |
| accepted when an earlier batch redefined the key | the recorded-migration key exemption |

In `sync-coordinator-roundtrip.e2e.spec.ts`: "an offline edit of a row deleted and pruned elsewhere is refused, so every replica and a new device agree". This is the ticket's reproduction with real clients and a real coordinator, asserting A, B, server and new device C all hold row 2 only. It timed out at HEAD before the fix.

## Validation

`@quereus/sync` 813 passing (804 before), `sync-coordinator` 138 passing, `sync-client` 106 passing, and `@quereus/sync` typecheck clean. The whole-repo `yarn test` was not run.

## Known gaps

- **The `drainTableGroup` call has no test.** It is the same pass, but nothing exercises a refusal through the drain path. A drain can also lose a founding cell to its schema-drift filter, and the edit is then refused.
- **The relay key exemption was not run through a real client and coordinator**, only by applying hand-built changes to a relay-only manager.
- **Key change then table rename misses the exemption.** Migrations are filed by table name. This is a false refusal, inferred from reading the code and not run. Parked as a `NOTE:` in `tablesWithRedefinedKey`.
- **Case-only key rewrite under `NOCASE`, with every other cell also rewritten offline,** leaves no founding cell. This is the case the ticket predicted, also not run. Parked as a `NOTE:` on `refuseEditsOfForgottenRows`.
- **Unpushed blob-key rows recorded before the fix** still carry a before-image on the key and can be refused. Not handled, since the project is not preserving backwards compatibility yet.
- **JSON columns have no direct test of the by-value comparison;** only the blob case was exercised.
- **Noise.** The key-exemption tests print the existing warning "the table was created or renamed by the same batch", which is misleading on a relay. Not changed here.
- **Cost.** Each flagged change scans its row, and each batch with flagged changes scans and parses that table's `alter_column` migrations. Both happen only after the delta floor check and only on this rare path. Not measured.

Not covered by design, per the ticket: `bug-sync-resent-insert-returns-pruned-row`, `bug-sync-edit-of-unrecorded-row-sends-partial-row`, `bug-sync-allow-resurrection-update-returns-partial-row`, and fragments already stored on a server.

## Docs

`docs/sync.md` § Tombstones and Deletions states the rule and what it does not cover, and the conflict-resolver paragraph is corrected. `docs/sync-protocol.md` has its before-image text amended, and the limit under *Client snapshot bootstrap* now names only the re-sent insert.
