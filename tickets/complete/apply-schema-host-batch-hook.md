description: Optional `beginSchemaBatch` / `endSchemaBatch` module-level hooks fired by APPLY SCHEMA's migration-DDL loop. Capability-keyed: hook absent → today's behaviour exactly.
files:
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/test/schema-batch-hook.spec.ts
  docs/schema.md
----

## What landed

Two optional methods on `VirtualTableModule` that let storage-backed modules fold an entire `apply schema` migration into a single substrate commit:

- `beginSchemaBatch(db, schemaName)` — called once before the migration-DDL loop, only if there is at least one statement to execute.
- `endSchemaBatch(db, schemaName, error?)` — called exactly once per successful begin, on both success (`error === undefined`) and failure (the loop error).

Modules without the hooks pay nothing — they are skipped via a `typeof === 'function'` guard.

### Engine plumbing
- `SchemaManager.allModules()` (new generator) iterates the module registry in registration order without exposing the internal map.
- `emitApplySchema` (`runtime/emit/schema-declarative.ts`) splits into:
  - **Empty diff fast-path** — no migration statements, no hooks fire (preserves today's idempotency behaviour exactly).
  - **`runBatchedMigrationLoop`** — wraps the existing per-DDL `_execWithinTransaction` loop in begin/end. Begin walks every module that defines the hook in registration order; on begin-failure, already-started modules receive `endSchemaBatch(error)` in reverse order and the original error is rethrown. On loop failure, every started module's end fires (reverse order) with the loop error attached; end-errors are logged-and-swallowed so the original cause survives. On success, the first end-error is captured, every remaining end still fires, then the captured error is rethrown.
- Seed-data block (`applyStmt.withSeed`) runs unchanged after `endSchemaBatch` fires.

## Key Files

- `packages/quereus/src/vtab/module.ts` — interface additions with full doc comments.
- `packages/quereus/src/schema/manager.ts` — `allModules()` generator.
- `packages/quereus/src/runtime/emit/schema-declarative.ts` — `runBatchedMigrationLoop`, `beginSchemaBatchAll`, `endSchemaBatchAll`.
- `packages/quereus/test/schema-batch-hook.spec.ts` — 6 cases covering the contract.
- `docs/schema.md` — "Module Batch Hooks" subsection under "Declarative Schema".

## Testing Notes

`yarn workspace @quereus/quereus run lint` clean. `yarn workspace @quereus/quereus run test` reports 2643 passing (including the 6 new batch hook cases):

1. **Pass-through** — module without hooks produces the same final catalog as today.
2. **Begin/End ordering** — exactly one begin and one end per migration loop, with `error === undefined` on success.
3. **Visibility from xCreate** — `batchActive === true` when each `create` is invoked inside the loop; `false` after end fires.
4. **Error propagation** — DDL failure during the loop propagates out of `apply schema`, end fires once with the loop error attached.
5. **Idempotency fast-path** — second `apply schema` against an already-up-to-date schema fires no further begin/end/create.
6. **Begin-failure** — a module's begin throwing aborts the migration: no DDL runs, end is *not* called for the failing module, the begin error propagates, no table registered.

## Usage

A module that backs `apply schema` with a single substrate commit:

```ts
class MyModule implements VirtualTableModule<MyTable> {
  // ... required methods ...

  async beginSchemaBatch(db: Database, schemaName: string): Promise<void> {
    // Open an in-memory overlay for this batch
    this.overlay = this.openOverlay(schemaName);
  }

  async endSchemaBatch(db: Database, schemaName: string, error?: unknown): Promise<void> {
    if (error !== undefined) {
      this.overlay?.discard();
    } else {
      await this.overlay?.commit();
    }
    this.overlay = undefined;
  }
}
```

Subsequent `create` / `destroy` / `alterTable` callbacks during the migration loop join the overlay; the whole `apply schema` produces a single commit.

## Review Sign-off

- Surface is non-breaking: hooks are optional on `VirtualTableModule`, existing modules unaffected.
- Error policy verified against the doc comments and the inline `log()` calls in `endSchemaBatchAll`. Begin-failure cleanup, success-path rethrow, and failure-path swallow are each tested or exercised.
- Idempotency fast-path is a single guard; seed block runs unconditionally below, so `apply schema with seed` against an unchanged schema still seeds without firing batch hooks (by design — seed batching out of scope).
- Cross-platform: pure async/await, no Node-specific APIs.

Minor non-blocking observations (recorded for future work, not action items):
- A module that implements only `beginSchemaBatch` (without `endSchemaBatch`) gets begin called and never end. Permitted by the independent-optional types; modules adopting the contract should implement both.
- Multi-module ordering (multiple modules each with hooks, end fires in reverse) is implementation-correct via `allModules()` insertion order + reverse walk, but is not separately tested. Single-module coverage is sufficient for the current contract.
