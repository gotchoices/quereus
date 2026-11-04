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

## What was built

- `Database._needsDataEvents()` (internal) became `Database.needsDataEvents()` (public), with no alias. It delegates to `DatabaseEventEmitter.needsDataEvents()`, whose logic did not change. It returns `true` when an `onDataChange` or `onTransactionCommit` listener exists, and `false` inside an engine-internal suppression scope.
- The three automatic-event gates in `dml-executor.ts` use the new name. `_needsSchemaEvents` stays internal, by design.
- JSDoc was updated on `Database.needsDataEvents`, `Database.hasDataListeners`, `DatabaseEventEmitter.needsDataEvents` and `VTableEventEmitter.hasDataListeners`.
- `docs/module-events.md` has a new subsection, "Skip building events no one will receive". `docs/stability.md` lists the method in the "Database event hooks" row.

## Review findings

**Checked by reading the code, and correct:**
- The gate logic is unchanged, and a transaction-commit listener makes the answer `true` where `hasDataListeners()` says `false`.
- Suppression returns `false`, and the scope is only ever opened under the execution mutex, so a module asking during its write sees the right answer.
- `close()` sets `isOpen = false` and tears modules down before `removeAllListeners()`. `needsDataEvents` has no `checkOpen()`, so it does not throw at any point in that sequence.
- The database subscribes to a module's emitter through `hookModuleEmitter`, so the emitter's `hasDataListeners()` stays `true` as the docs and JSDoc say.
- The doc example is valid: `VirtualTable` has a public `db`, and the `#engine-internal-scaffolding-is-silent` link resolves.
- `db.getTable(...).getEventEmitter()` is a real subscription route (docs/usage.md § Per-Table Subscription), so the docs' warning about direct subscribers is needed.
- The method is public in the built output: `dist/src/core/database.d.ts:363` declares it, so `stripInternal` does not remove it.
- No source or docs in `packages/` or `docs/` still use `_needsDataEvents`.

**Fixed in this pass (minor):**
- The `Database.needsDataEvents` JSDoc said it returns `false` on a closed database, without covering the period during `close()`. Listeners are removed last, so a module asking during teardown can get `true`. The JSDoc now says it never throws and that the answer is `false` once `close()` finishes.

**Tests:** kept the one new test, because it pins the difference between `needsDataEvents` and `hasDataListeners`, which is the reason the method is public. Added none: suppression is already covered on the emitter and the `Database` method is a one-line delegate. Closed-database behaviour is still untested. It follows from the absence of a guard and from `removeAllListeners()`, and did not meet the bar for a new test.

**Major findings:** none, so no tickets filed. Adopting the method in the store and memory modules is already tracked by the backlog ticket `feat-built-in-modules-skip-events-nobody-hears`, which also covers the missing way to tell the database's subscription apart from direct subscribers. No `NOTE:` was added at those sites for that reason.

**Tripwires:** none added. The late-subscriber limit is a documented behaviour in `docs/module-events.md`, not a conditional concern with a code site.

**Noticed, left alone:** the same `needsAutoEvents` line appears three times in `dml-executor.ts`. The duplication predates this ticket, which only renamed the call, and each line sits in a separate statement-run path.

**Docs:** read `docs/module-events.md`, `docs/stability.md`, `docs/usage.md` § Per-Table Subscription and the event pointer in `docs/module-authoring.md`. The last two need no change: `module-authoring.md` defers to `module-events.md`, and `usage.md` is for hosts, who do not call this method.

**Validation:** `yarn workspace @quereus/quereus run lint` is clean after the JSDoc edit. `yarn workspace @quereus/quereus run test` gave 11039 passing, 26 pending, run before that comment-only edit.

**Not checked:** other workspaces were not linted or tested, because the search shows none of them used the old name. Lamina's adapter lives outside this repo, so its claimed fallback from the public name to `_needsDataEvents` on 4.20.x was not checked.
