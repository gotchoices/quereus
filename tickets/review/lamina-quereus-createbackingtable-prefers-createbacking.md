description: Review createBacking? seam implementation in Quereus
files:
  - packages/quereus/src/vtab/module.ts — added optional createBacking?() to VirtualTableModule interface
  - packages/quereus/src/schema/manager.ts — createBackingTable now prefers createBacking over create
  - packages/quereus/test/vtab/create-backing-seam.spec.ts — new regression tests for the seam
----

## What was done

Two minimal quereus-side changes add the `createBacking?()` seam:

### 1. `packages/quereus/src/vtab/module.ts`

Added optional `createBacking?(db, tableSchema): Promise<TTable>` to the `VirtualTableModule` interface, placed immediately after `create`. The docstring explains the seam contract: presence is the capability; `SchemaManager.createBackingTable` prefers it over `create` so a durable-backing module (e.g. Lamina) can route the backing into its durable store. Omitting it preserves today's `create`-only behavior.

### 2. `packages/quereus/src/schema/manager.ts` (~line 2675)

Replaced the direct `moduleInfo.module.create(this.db, tableSchema)` call in `createBackingTable` with:

```ts
const create = moduleInfo.module.createBacking?.bind(moduleInfo.module)
    ?? moduleInfo.module.create.bind(moduleInfo.module);
tableInstance = await create(this.db, tableSchema);
```

`bind` keeps `this` correct for whichever method is chosen. The existing try/catch error wrapping is preserved; the wrap message was updated from "create failed" to "backing create failed" for clarity.

### 3. `packages/quereus/test/vtab/create-backing-seam.spec.ts`

Two tests:
- **prefers createBacking**: A stub wrapping `MemoryTableModule` that declares `createBacking` — confirms `createBacking` is called and `create` is not, during `CREATE MATERIALIZED VIEW`.
- **falls back to create**: Same stub without `createBacking` — confirms `create` is called as fallback.

All tests pass (`yarn test`, exit 0); lint passes (`yarn workspace @quereus/quereus run lint`, exit 0).

## What this unblocks (downstream, not this ticket)

- Lamina's `LaminaModule.createBacking` (already shipped at `../lamina/packages/lamina-quereus/src/module.ts:1286`) is now reachable through the engine.
- The `it.skip` full-SQL round-trip in `../lamina/packages/lamina-quereus-test/src/mv-backing-installer-enablement-e2e.test.ts` can be un-skipped.
- Lamina's `lamina-mv-backing-general-body-golden` ticket (currently in lamina's `blocked/`) can now proceed.

## Known gaps / reviewer focus areas

- **No Lamina integration test here** — the downstream lamina tests cover end-to-end durable routing. This ticket is quereus-only per the spec.
- **`createBacking` is never called by `CREATE VIRTUAL TABLE`** — it is exclusively for `createBackingTable` (MV backing path). Reviewer should confirm this is the intended scope.
- **Error message change** — "create failed" → "backing create failed" in the catch block; minor but reviewers should confirm it doesn't break any test fixture that matches the old string.
