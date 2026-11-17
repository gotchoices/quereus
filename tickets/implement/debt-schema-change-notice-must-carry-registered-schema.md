description: When a table's definition changes, the database can correct the new definition as it stores it but then tell listeners about the uncorrected version. Add a check at the single point where those announcements go out, so any code path that announces something other than what was stored fails immediately, and fix the paths that do it today.
architecture: docs/invariants.md#sch--schema
files:
  - packages/quereus/src/schema/change-events.ts                     # SchemaChangeNotifier — gains the pre-dispatch check
  - packages/quereus/src/schema/manager.ts                           # constructs the notifier (line ~312); emit sites ~1014, ~1372, ~2739, ~2967, ~3210, ~3282
  - packages/quereus/src/schema/schema.ts                            # Schema.addTable — make generic so maintained-table callers keep their type
  - packages/quereus/src/schema/table.ts                             # pruneStaleColumnStatistics — make generic to match
  - packages/quereus/src/runtime/emit/alter-table.ts                 # emit sites ~303/313 (rename table), ~341 (maintained rename), ~1039 (add column), ~2606, ~2765
  - packages/quereus/src/runtime/emit/add-constraint.ts              # emit site ~119 (catalog-only CHECK path)
  - packages/quereus/src/runtime/emit/analyze.ts                     # emit site ~143
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # emit sites ~1377/1454→1497/1519 (attach), ~2789→2795 (reshape), ~3365 (backing column rename)
  - packages/quereus-store/src/common/store-module-schema-sync.ts    # the listener that caches announced schemas (read-only context)
  - docs/invariants.md                                               # new SCH-008 entry
  - docs/schema.md                                                   # change-event table (~line 463) — one sentence on the rule
----

# Every announced table definition is the one the catalog holds

## Background

`Schema.addTable` (packages/quereus/src/schema/schema.ts) does not always store the object it is handed: today it drops recorded column statistics that name a column the table no longer has (`pruneStaleColumnStatistics` in schema/table.ts) and stores that corrected copy. It returns what it stored, and its doc comment says a caller that passes the schema on must pass the return value.

The DDL code's common shape is "register, then announce on the schema change notifier". The storage module (`@quereus/store`, `store-module-schema-sync.ts` → `connected.updateSchema(event.newObject)`) caches the announced object as its working copy of the table and builds later ALTER results from it, so an announced-but-uncorrected definition comes back into the catalog on the next ALTER. That already happened once (DROP COLUMN then ADD COLUMN of the same name gave the new column the old column's statistics) and was fixed at that one site.

## Design

**One check, at the one point every announcement passes through.** `SchemaChangeNotifier.notifyChange` (schema/change-events.ts) runs a verification hook *before* it dispatches to listeners. The hook is outside the per-listener try/catch, so a violation throws to the announcing code instead of being logged and swallowed.

**Rule.** For each event that carries a table definition the catalog is supposed to hold, the catalog's current entry under the event's `schemaName` + `objectName` must be *the same object* (reference equality, `===`) as the payload:

| event type | payload checked |
|---|---|
| `table_added` | `newObject` |
| `table_modified` | `newObject` |
| `materialized_view_added` | `newObject` |
| `materialized_view_modified` | `newObject` |
| `materialized_view_refreshed` | `object` |

All other event types pass unchecked: `table_removed` / `materialized_view_removed` carry a definition that is leaving the catalog (and a detach re-registers the table without its derivation, so the departing object is legitimately not the registered one); view, assertion, function, module and collation events carry no table definition.

No entry under that name is also a violation: an "added/modified/refreshed" announcement for a table the catalog does not hold is a bug in the announcing path.

Reference equality, not structural comparison: it is cheaper, it needs no deep-compare of ASTs and maps, and it is exactly the property the listener relies on (it caches *this object*).

**Failure.** Throw `QuereusError(…, StatusCode.INTERNAL)` naming the event type, `schema.table`, and which failure it was (no registered table / a different object is registered). Precedent: `addTable`'s own registration assertions (`assertPrimaryKeyCollationsMatchColumns`, `assertGeneratedColumnGraphMatchesColumns`) throw INTERNAL at the same point in the same statements, after the module has already been altered. This is a producer-bug tripwire, not a recoverable condition.

**Wiring.** Keep the notifier free of a catalog dependency:

- `SchemaChangeNotifier` gets an optional constructor parameter, `verify?: (event: SchemaChangeEvent) => void`, called first thing in `notifyChange`.
- The check itself is an exported function in change-events.ts, e.g. `assertAnnouncedTableIsRegistered(event, lookup)` with `lookup: (schemaName: string, tableName: string) => TableSchema | undefined`, so the rule and the event-type table above live next to the event types.
- `SchemaManager` (manager.ts ~312) constructs the notifier with `event => assertAnnouncedTableIsRegistered(event, (s, t) => this.getSchema(s)?.getTable(t))`. Both lookups lowercase, and every emitter already passes stored names (see `canonicalSchemaName`).

`SchemaManager` is the only place that constructs a notifier (`grep -rn "new SchemaChangeNotifier"`), so every database gets the check.

**Typing support.** Several maintained-table paths ignore `addTable`'s return because it is typed `TableSchema` while they hold a `MaintainedTableSchema`. Make `pruneStaleColumnStatistics` and `Schema.addTable` generic — `<T extends TableSchema>(table: T): T` — which is sound because the only correction is `{ ...table, statistics }`, which keeps every other field (including `derivation`). Keep the existing doc comment's rule; add that the check enforces it.

## Sites to fix

A sweep of every emitter of the five checked event types (all inside `packages/quereus/src` — no other package emits them) found these announcing an object other than `addTable`'s return value. Each fix is "capture `addTable`'s return and announce that" unless noted. Today most are latent (identical unless a statistics prune happened), but the check rejects them all, so the suite will not pass until they are fixed:

- `runtime/emit/alter-table.ts` rename table (~303): `schema.addTable(renamedTableSchema)` → use the return for the `table_modified` at ~313.
- `runtime/emit/alter-table.ts` maintained-table rename (~330–345): **a real divergence, not latent.** `propagateTableRename` (called between the `table_modified` and this block) walks every table in the schema *including the just-renamed one* and re-registers it when a self-referencing foreign key, CHECK, or the MV body pass rewrites it. The block then calls `registerMaterializedView(renamedTableSchema)` and announces `materialized_view_added` with `renamedTableSchema` — possibly a superseded object. Re-fetch `schema.getTable(newName)` after propagation and use it for both the maintenance registration and the announcement.
- `runtime/emit/alter-table.ts` add column (~1039): `schema.addTable(finalTableSchema)` → announce the return.
- `runtime/emit/alter-table.ts` `propagateTableRenameInSchema` (~2606) and `propagateColumnRenameInSchema` (~2765): announce the return of `schema.addTable(updated)`.
- `runtime/emit/add-constraint.ts` catalog-only CHECK path (~119).
- `runtime/emit/analyze.ts` (~143).
- `runtime/emit/materialized-view-helpers.ts` attach (`live = graftReshapedRecord(…); schema.addTable(live)` at ~1377 and ~1454, announced at ~1497 and ~1519): assign `live = schema.addTable(graftReshapedRecord(…))` — needs the generic `addTable`.
- `runtime/emit/materialized-view-helpers.ts` MV reshape (~2789, announced ~2795): same pattern.
- `runtime/emit/materialized-view-helpers.ts` backing column rename (~3365).
- `schema/manager.ts`: `commitTagUpdate` (~1012), MV tag update (~1372), the two index paths (~2739, ~2967), and both `createTable` paths (~3210, ~3282).

Already correct (no change): alter-table.ts rename column (~480), drop column (~1361), drop/rename constraint (~1421, ~1503), alter column (~1661), tags arm (~1766), alter primary key (~2006, ~2134 — re-reads `schema.getTable`), add-constraint.ts module path (~269); `emitBackingInvalidation` in core/database-materialized-views.ts (announces what `getTable` returned); materialized-view.ts create (~113) and refresh (~218) and materialized-view-helpers.ts ~3119 — verify these by running the suite rather than by reading, since they announce objects returned from deeper helpers.

No path was found that announces before registering. If the suite surfaces one, fix it by moving the announcement after the registration rather than by adding an exception to the check.

## Edge cases & interactions

- **Table rename.** `table_modified` is announced under the *new* name after `removeTable(old)` + `addTable(new)`; the lookup by new name finds the registered object. No exception needed. Verified by the existing rename tests passing.
- **A later step in the same statement replaces the definition.** The check runs synchronously at announcement time, so a re-registration *after* an announcement (rename propagation, the per-op re-registration loop in MV reshape) does not affect it. Only an announcement made *after* a replacement with the pre-replacement object is caught — which is the maintained-rename case above. Verified by inspection.
- **Listener re-registers during dispatch.** The check runs once, before the first listener. If a listener re-registered the table, later listeners would receive a superseded object. None does today — MV staleness is an in-place mutation of `derivation.stale`, not a re-registration. Leave a `NOTE:` at the check: "checked once before dispatch; if a listener ever re-registers the announced table, later listeners receive a superseded object."
- **Synthetic backing-invalidation event** (`emitBackingInvalidation`, same object as old and new): passes, because it announces `getTable`'s result. Verified by the MV-over-MV suites.
- **Absent table.** `emitBackingInvalidation` and `rebuildTableWithNewShape` already skip their announcement when the table is gone. materialized-view-helpers.ts ~3117 announces `schema.getTable(mv.name) ?? mv`; if the suite ever reaches the `?? mv` fallback, the check fires — fix by skipping the announcement when absent, matching `emitBackingInvalidation`.
- **Removal events and detach.** Not checked (see the table above). `detachMaintainedDerivation` announces `materialized_view_removed` with the maintained object while the plain object is registered — legitimate.
- **Listener exceptions remain swallowed.** Only the verification hook throws; the existing per-listener try/catch is unchanged, so `ddl-event-scope.ts`'s note ("`notifyChange` swallows listener errors") stays true for listeners. Update that note to say the pre-dispatch check can throw an INTERNAL error, which is a producer bug, not a listener failure.
- **Store path.** Run `yarn test:store` once as well as `yarn test`: the store module re-registers tables at reopen and through its own ALTER arms, and the logic tests under the store exercise those registrations followed by announcements.

## Tests

The check is a runtime assertion at the seam; the existing suites (`yarn test`, `yarn test:store`) run every DDL form and are what prove the sites are fixed. Add exactly one new test, proving the check is wired in (a disconnected check would otherwise pass silently): through a real `Database`, create a table, then call `db.schemaManager.getChangeNotifier().notifyChange({ type: 'table_modified', schemaName: 'main', objectName: 't', oldObject: registered, newObject: { ...registered } })` and expect a `QuereusError` with `StatusCode.INTERNAL`. Put it in the spec that holds the DROP COLUMN statistics regression if one fits, otherwise a small `test/schema/announced-schema-is-registered.spec.ts`.

## Docs

- `docs/invariants.md`: add `SCH-008 — An announced table definition is the registered one`, `code:` the emit-site convention (`schema.ts` — `addTable`), `guard:` `change-events.ts` — `assertAnnouncedTableIsRegistered` (called by `SchemaChangeNotifier.notifyChange` before dispatch), `doc:` schema.md's change-events section. Keep within the register's 120-word limit; run `yarn docs:check`.
- `docs/schema.md` (~line 463, change-event table): one sentence that table-carrying events must carry the registered object and the notifier enforces it.

## TODO

- Make `pruneStaleColumnStatistics` and `Schema.addTable` generic over `T extends TableSchema`.
- Add `assertAnnouncedTableIsRegistered` and the optional `verify` hook to change-events.ts; call it before the listener loop, outside the try/catch; add the `NOTE:` about re-registration during dispatch.
- Wire the hook in `SchemaManager`'s notifier construction.
- Fix every site under "Sites to fix", including the maintained-table rename re-fetch.
- Update the `ddl-event-scope.ts` note about `notifyChange` not throwing.
- Add the one wiring test.
- Add SCH-008 to docs/invariants.md and the sentence to docs/schema.md; run `yarn docs:check`.
- Run `yarn build`, `yarn lint` (packages/quereus), `yarn test`, and `yarn test:store`; fix any further site the check rejects at its source.
