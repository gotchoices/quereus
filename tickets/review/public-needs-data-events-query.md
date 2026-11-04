description: Modules can now ask a Quereus database whether anyone is listening for data-change events, so a module with its own event emitter can skip preparing events nobody will receive.
architecture: docs/module-events.md#module-integration
difficulty: easy
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/vtab/events.ts
  - packages/quereus/test/database-events.spec.ts
  - docs/module-events.md
  - docs/stability.md
----

Filed from the lamina board. Lamina holds one record per written row until commit so it can emit its events afterwards, and on a large import that memory is wasted when nobody is listening.

## What changed

- `Database._needsDataEvents()` (internal) is now `Database.needsDataEvents()` (public, no `@internal`). No alias was kept. It still delegates to `DatabaseEventEmitter.needsDataEvents()`, whose logic is unchanged.
- The three auto-event gates in `dml-executor.ts` use the new name.
- `_needsSchemaEvents` stays internal, by design.
- JSDoc updated on `Database.needsDataEvents`, `Database.hasDataListeners`, `DatabaseEventEmitter.needsDataEvents`, and `VTableEventEmitter.hasDataListeners`.
- `docs/module-events.md` has a new subsection, "Skip building events no one will receive", under § For Modules with Native Events. `docs/stability.md` lists the method in the "Database event hooks" row.

## Usage and behaviour to check

- A listener only on `onTransactionCommit`: `needsDataEvents()` is `true`, `hasDataListeners()` is `false`. This difference is why the method exists.
- Inside a suppression scope (the `ALTER PRIMARY KEY` shadow-table rebuild): `false`, and it recovers when the scope closes.
- Closed database: `false`, with no throw, because there is no `checkOpen()` and `close()` calls `removeAllListeners()`. A module may ask during `close()`, which tears modules down before removing listeners.
- Listeners on a module's own emitter, including through `db.getTable(...).getEventEmitter()`, are not counted. The emitter's `hasDataListeners()` stays `true` after registration because the database subscribes to it (`database.ts:1330`). The docs tell modules with direct subscribers to track them themselves.
- A listener that subscribes mid-transaction misses earlier writes. This is documented, and no code changed for it.

## Tests

- `needsDataEvents counts transaction-commit listeners, unlike hasDataListeners` (`database-events.spec.ts`): the four-step table of `hasDataListeners` and `needsDataEvents` answers as data and commit listeners are added and removed.

Suppression is not retested at the `Database` layer. The `withPublicEventsSuppressed` tests already cover it on the emitter, and the `Database` method is a one-line delegate.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 11039 passing, 26 pending. The new test was also run alone with `--grep`, because the default reporter does not list test names.
- After `yarn workspace @quereus/quereus run build`, `dist/src/core/database.d.ts` declares `needsDataEvents(): boolean`, so `stripInternal` does not remove it.
- `grep -rn _needsDataEvents packages docs` (excluding `node_modules` and `dist`): no hits.

## Known gaps

- Only `@quereus/quereus` was linted and tested. The other workspaces were not run; the grep shows none of them used the old name.
- Closed-database and mid-`close()` behaviour was checked by reading the code. No test covers them.
- Lamina's adapter lives outside this repo, so its claimed fallback from the public name to `_needsDataEvents` on 4.20.x was not checked.
