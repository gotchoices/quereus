description: Forward optional `beginSchemaBatch`/`endSchemaBatch` module hooks from `IsolationModule` to its underlying module so a batching-capable underlying still gets single-commit APPLY SCHEMA batching under isolation. Plus an audit of the remaining un-forwarded optional `VirtualTableModule` hooks.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/runtime/emit/schema-declarative.ts
----

## What was implemented

`IsolationModule` now forwards both APPLY SCHEMA batch hooks to the underlying module:

```ts
async beginSchemaBatch(db, schemaName) {
  await this.underlying.beginSchemaBatch?.(db, schemaName);
}
async endSchemaBatch(db, schemaName, error) {
  await this.underlying.endSchemaBatch?.(db, schemaName, error);
}
```

These are in `isolation-module.ts` directly above `getBestAccessPlan`. The `?.` optional-call means a non-batching underlying is a safe no-op (mirrors the loop's own `typeof module.beginSchemaBatch !== 'function'` guard).

## Open question resolved: straight delegate IS sufficient (overlay does NOT participate)

The ticket flagged that this touches the write/commit path, unlike the pure-read advertisement forward, so it might need the overlay/commit lifecycle to participate. **It does not**, and the implementation is a straight delegate. Reasoning:

- APPLY SCHEMA's migration loop (`runBatchedMigrationLoop` in `schema-declarative.ts`) wraps **DDL** execution (create/destroy/alter table). It is not staging user data.
- Per-connection overlays (`connectionOverlays`) hold uncommitted **data** writes inside a user transaction. Schema DDL does not route through the overlay — IsolationModule's `create`/`destroy`/`alterTable` forward structural changes directly to the underlying (overlays are only *migrated* to track the new schema, not written as batch data).
- So the "single substrate commit" the batch hooks fold together is composed of underlying DDL operations. Forwarding begin/end to the underlying is exactly what lets those underlying create/destroy/alter callbacks join one commit. There is nothing overlay-side to flush as part of the batch.

This verdict is documented inline in the `beginSchemaBatch` doc comment so a future reader doesn't re-litigate it.

## Audit of remaining un-forwarded optional `VirtualTableModule` hooks

Per the ticket's request to document a per-hook verdict rather than blindly forwarding:

| Hook / property | Forwarded? | Verdict |
|---|---|---|
| `getMappingAdvertisements` | yes (pre-existing) | isolation-transparent read delegate |
| `getCapabilities` | yes (pre-existing) | forwarded + isolation/savepoints layered on |
| `getBestAccessPlan` | yes (pre-existing) | delegated so planner sees underlying indexes |
| `createIndex`/`dropIndex`/`alterTable`/`renameTable`/`destroy` | yes (pre-existing) | structural ops; forwarded with overlay migration |
| `beginSchemaBatch`/`endSchemaBatch` | **yes (this ticket)** | straight delegate; overlay does not participate |
| `supports` (push-down predicate) | **intentionally NOT** | the overlay must see all rows to merge correctly; pushing a predicate to the underlying would hide overlay-resident rows. Correct to suppress. |
| `shadowName` | **NOT** | not implemented by IsolationModule; no consumer reaches it through the wrapper today. Low-risk gap — flag for the reviewer to confirm there is genuinely no path that needs the underlying's shadow-table naming. |
| `concurrencyMode` / `expectedLatencyMs` | **intentionally NOT** | isolation imposes its own concurrency semantics (snapshot isolation + savepoints, advertised via `getCapabilities`); the underlying's raw values would misdescribe the wrapped behavior. Correct to suppress. |

`shadowName` is the one I'm least certain about — I confirmed via a literal scan that nothing currently calls it on an isolation-wrapped module, but I did not exhaustively trace every shadow-table code path. Worth a reviewer glance.

## Tests added

Three tests in the `capability forwarding` describe block of `isolation-layer.spec.ts`:
- forwards both hooks with the right `(db, schemaName)` args
- `endSchemaBatch` forwards the loop error through to the underlying
- no-throw when the underlying omits the hooks (optional-call safety)

These are **unit-level direct calls** on the module — they do NOT exercise the end-to-end APPLY SCHEMA path under isolation, because no production module implements the hooks (the feature is future-facing, exactly as the ticket states). The engine-side end-to-end behavior is covered by `packages/quereus/test/schema-batch-hook.spec.ts` using a `RecordingMemoryModule`, but that test registers the recording module directly, not wrapped in `IsolationModule`.

## Known gaps for the reviewer

- **No end-to-end isolation+batch test.** The natural such test would register a recording/batching module as the `underlying` of an `IsolationModule`, run a real `apply schema`, and assert the underlying saw exactly one begin/end pair with create-callbacks in between. This would be a stronger floor than the direct-call unit tests and would also prove the registered-module-iteration in `schema-declarative.ts` actually reaches the wrapper. Consider adding it (pattern: combine `RecordingMemoryModule` from `schema-batch-hook.spec.ts` with `IsolationModule`). I did not add it because `RecordingMemoryModule` lives in the `quereus` package's test dir, not exported, so reusing it cross-package needs a small refactor or a re-implementation in the isolation test.
- **`shadowName` audit is shallow** (see table above).
- The overlay-non-participation verdict is reasoned, not empirically forced by a failing test (there's no batching underlying to demonstrate it against). If a store-module batching consumer lands later, an integration test should confirm a single substrate commit.

## Validation performed

- `yarn workspace @quereus/quereus build` — clean
- `yarn workspace @quereus/isolation build` — clean (typecheck passes)
- `yarn workspace @quereus/isolation test` — 74 passing
