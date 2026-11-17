description: When a table's definition changes, the database can correct the new definition as it stores it but then tell listeners about the uncorrected version. A check now runs at the single point where those announcements go out and fails immediately on a mismatch, and every path that announced the wrong object has been fixed.
architecture: docs/schema.md#event-types
files:
  - packages/quereus/src/schema/change-events.ts                     # assertAnnouncedTableIsRegistered, SchemaChangeNotifier verify hook
  - packages/quereus/src/schema/manager.ts                           # notifier construction (~312); attachDerivation; commitTagUpdate; MV tags; create/drop index; both createTable paths
  - packages/quereus/src/schema/schema.ts                            # Schema.addTable now generic
  - packages/quereus/src/schema/table.ts                             # pruneStaleColumnStatistics now generic
  - packages/quereus/src/runtime/emit/alter-table.ts                 # rename table (+ maintained-rename re-fetch), add column, both propagate*InSchema loops
  - packages/quereus/src/runtime/emit/add-constraint.ts              # catalog-only CHECK path
  - packages/quereus/src/runtime/emit/analyze.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attach reshape, reshapeBackingInPlace, renameShiftedBackingColumns
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts             # note about notifyChange throwing
  - packages/quereus/test/schema-column-statistics-prune.spec.ts     # the one new test
  - docs/schema.md                                                   # "Registered-object contract" paragraph under Event Types
  - tickets/blocked/invariant-register-outgrows-word-cap.md          # held-back invariant text appended
----

# Every announced table definition is the one the catalog holds

## What changed

`Schema.addTable` can register a corrected copy of what it is handed (today: it drops column statistics naming a column the table no longer has). Listeners such as the store module cache the announced object, so announcing the pre-`addTable` object puts the uncorrected definition back into the catalog on the next ALTER.

- **The check.** `assertAnnouncedTableIsRegistered(event, lookup)` in `schema/change-events.ts`. For `table_added`, `table_modified`, `materialized_view_added`, `materialized_view_modified` (payload `newObject`) and `materialized_view_refreshed` (payload `object`), the catalog's entry under `schemaName` + `objectName` must be the same object by reference. No entry, or a different object, throws `QuereusError` with `StatusCode.INTERNAL`, naming the event type, `schema.table` and which of the two failures it was. Every other event type passes unchecked; removal events are deliberately exempt (a detach announces the maintained object while the plain one is registered).
- **Wiring.** `SchemaChangeNotifier` takes an optional `verify` constructor hook, called first in `notifyChange`, outside the per-listener try/catch. `SchemaManager` (the only constructor of a notifier) passes the check with a lookup over `getSchema(s)?.getTable(t)`. A `NOTE:` at the call site records the tripwire: the check runs once before dispatch, so a listener that re-registers the announced table would hand later listeners a superseded object (none does today).
- **Typing.** `pruneStaleColumnStatistics` and `Schema.addTable` are generic over `T extends TableSchema`, so maintained-table callers keep `MaintainedTableSchema` on the return value.
- **Sites fixed** (each now announces `addTable`'s return): alter-table.ts rename table, add column, `propagateTableRenameInSchema`, `propagateColumnRenameInSchema`; add-constraint.ts catalog-only CHECK; analyze.ts; materialized-view-helpers.ts attach reshape (both pre- and post-reconcile loops), `reshapeBackingInPlace` (both), `renameShiftedBackingColumns`; manager.ts `commitTagUpdate`, MV tag update, create index, drop index, both `createTable` paths.
- **Maintained-table rename.** After `propagateTableRename`, `runRenameTable` re-fetches `schema.getTable(newName)` and uses it for both `registerMaterializedView` and the `materialized_view_added` announcement (propagation can re-register the just-renamed table). If the re-fetched entry is missing or has lost its derivation, it throws INTERNAL rather than silently skipping the old-name unregister.
- **Beyond the ticket's list.** `SchemaManager.attachDerivation` now returns `addTable`'s return (it returned its own pre-registration object, which the attach path then announced). `createTable` and `createBackingTable` now return the registered object rather than the pre-registration one.

## Deviation: the invariant register entry was not added

The ticket asked for a `SCH-008` entry in `docs/invariants.md`. Adding it took the register from 11,983 to 12,099 words (`git show HEAD:docs/invariants.md | wc -w`, then `wc -w` after), over the 12,000-word cap, and `yarn docs:check` failed. That conflict is already with a human in `tickets/blocked/invariant-register-outgrows-word-cap.md`. Following that ticket's precedent, the drafted entry is appended to it (section "Schema invariant drafted but held back for room"), and the rule is stated in `docs/schema.md` § Event Types ("Registered-object contract"), pointing at `assertAnnouncedTableIsRegistered`. Code comments refer to that doc section, not to an ID that does not exist yet.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (before the final comment-only rewraps).
- `yarn build` — exit 0.
- `yarn workspace @quereus/quereus run test` — 11,183 passing, 23 pending, 0 failing.
- All other workspaces' `test` — passing, except one pre-existing failure in `@quereus/store` (below).
- Store mode: the full `node test-runner.mjs --store` run exceeds the 10-minute tool limit and was cut off without a summary. The store-specific part, `QUEREUS_TEST_STORE=true` mocha over `test/logic.spec.ts` + `test/numeric-canonical.spec.ts` (the only specs that read that variable), passed: 406 passing, 7 pending, 0 failing. The other specs build their own databases and do not change under store mode.
- `yarn docs:check` — passes.

No site needed fixing beyond the static sweep: the check never fired in any suite. The sites the ticket said to verify by running (materialized-view.ts create/refresh, materialized-view-helpers.ts `applyMaterializedViewRewrite`'s `getTable(...) ?? mv` fallback, `emitBackingInvalidation`) passed without change.

## Pre-existing failure (not this ticket)

`packages/quereus-store/test/mv-store-backing.spec.ts` — "a declared `collate binary` key survives a source NOT NULL loosening (still data-only)" expects the view to stay live after `drop not null` on its key column. Commit `994ed95bf` (debt-mv-ordering-seed-to-materialized-index) intentionally made that case go stale, and its validation did not run the store workspace tests. A debug-logged single run shows no error from the new check. Recorded in `tickets/.pre-existing-error.md` for triage.

## Tests

- `test/schema-column-statistics-prune.spec.ts` › "announcing a table definition" › "rejects an announcement whose payload is not the registered object" — through a real `Database`, announces `table_modified` for `t` with a spread copy of the registered schema and expects `QuereusError` / `INTERNAL`. Proves the check is wired into every database's notifier. The per-site fixes are proven by the existing DDL suites passing with the check active.

## For the reviewer

- The check is reference equality only. A path that announces the right object but under a different name than it is registered by (case aside, the lookup lowercases) would also throw; none was found.
- An INTERNAL throw from a nested announcement made inside a listener (for example the MV staleness listener's `emitBackingInvalidation`) is caught by the outer notifier's per-listener trap and only logged at debug level. The check therefore throws to the announcing code only for top-level announcements. Worth a look at whether that weakens the guard enough to matter; no nested violation appeared in any run.
- The maintained-rename INTERNAL throw (re-fetched entry missing or not maintained) is new behaviour on a path that previously could not fail there. It is unreachable unless rename propagation strips a derivation.
