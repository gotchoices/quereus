description: `IsolationModule` does not forward the optional `beginSchemaBatch`/`endSchemaBatch` module hooks to its underlying module. APPLY SCHEMA's migration loop iterates the *registered* modules and fires these hooks on whatever module owns the table — which is the `IsolationModule` wrapper when a basis is isolated. Because the wrapper neither implements nor forwards them, a batching-capable underlying module silently loses single-commit batching of APPLY SCHEMA under isolation. Future-facing: no production module (memory/store) implements these hooks today, so there is zero observable effect until one does (e.g. a store module that folds APPLY SCHEMA into one substrate commit). Same silent-degradation class as `lens-isolation-module-advertisement-forwarding`.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus-isolation/test/isolation-layer.spec.ts
----

## Problem

APPLY SCHEMA's `runBatchedMigrationLoop` (`packages/quereus/src/runtime/emit/schema-declarative.ts`) wraps the per-DDL migration loop in optional module hooks: `beginSchemaBatchAll` iterates `db.schemaManager.allModules()` and calls `module.beginSchemaBatch?.(db, schemaName)` on every module that implements it, then `endSchemaBatchAll` mirrors with `endSchemaBatch`. The contract (`packages/quereus/src/vtab/module.ts`) is that a storage-backed module may open an in-memory overlay/batch in `beginSchemaBatch` that subsequent `create`/`destroy`/`alter` callbacks join, so the whole APPLY SCHEMA produces a single substrate commit.

When a basis table is created `USING isolated`, its `TableSchema.vtabModule` is the `IsolationModule` wrapper (the registered module — see `schema/manager.ts` `finalizeCreatedTableSchema` / `buildTableSchema`, `vtabModule: moduleInfo.module`), not the underlying. `IsolationModule` implements neither `beginSchemaBatch` nor `endSchemaBatch` and does not forward them, so:

- the wrapper is skipped by the `typeof module.beginSchemaBatch !== 'function'` guard, and
- the underlying module is never reached by the loop (it is not a registered module — only the wrapper is).

Net effect: a batching-capable underlying module under isolation gets no begin/end signal, so APPLY SCHEMA falls back to per-DDL commits instead of one batch commit.

## Why this is future-facing (not a live bug today)

A literal-symbol scan (`beginSchemaBatch|endSchemaBatch`) finds the hooks only in the engine (`schema-declarative.ts`), the interface (`module.ts`), and one test (`packages/quereus/test/schema-batch-hook.spec.ts`). **No production module — `MemoryTableModule`, `StoreModule`, sync — implements them.** So the non-forwarding has no observable effect until a real underlying module adopts batching. This is exactly the situation `lens-isolation-module-advertisement-forwarding` was in before its consumer existed: a correct-but-unexercised wrapper-transparency gap.

## Expected behavior

`IsolationModule` should forward both hooks to the underlying when present:

```
async beginSchemaBatch(db, schemaName) {
  await this.underlying.beginSchemaBatch?.(db, schemaName);
}
async endSchemaBatch(db, schemaName, error) {
  await this.underlying.endSchemaBatch?.(db, schemaName, error);
}
```

Open question for the implementer: a batch under isolation spans *underlying* writes, but isolation also routes writes through per-connection overlays. Confirm whether forwarding begin/end to the underlying is sufficient, or whether the overlay/commit lifecycle needs to participate too (i.e. whether the batch should flush the overlay as part of the single commit). The advertisement-forwarding ticket was a pure isolation-transparent read delegate; this one touches the write/commit path, so it is **not** a guaranteed straight delegate — verify against the overlay-flush-on-commit machinery (`isolated-connection.ts`, `isolated-table.ts`).

## Notes

- Pin the forward with a test in `packages/quereus-isolation/test/isolation-layer.spec.ts` (the `capability forwarding` describe block added by `lens-isolation-module-advertisement-forwarding` is the natural home).
- Also re-audit the remaining un-forwarded optional `VirtualTableModule` hooks at the same time: `supports` (push-down — likely intentionally NOT forwarded, since the overlay must see rows), `shadowName`, and the `concurrencyMode`/`expectedLatencyMs` properties (likely intentionally NOT forwarded, since isolation imposes its own concurrency semantics). Document the verdict per hook rather than blindly forwarding.
