description: |
  Quereus's SchemaManager.createBackingTable always builds a materialized-view backing through the
  module's ordinary create(), so durable-backing modules (Lamina) never get a chance to route the
  backing into their durable store. Add an optional createBacking?() seam to the VirtualTableModule
  interface and make createBackingTable prefer it (createBacking?() ?? create()). Non-breaking: modules
  without createBacking keep using create().
prereq:
files:
  - packages/quereus/src/vtab/module.ts — VirtualTableModule interface; add optional createBacking?()
  - packages/quereus/src/schema/manager.ts — SchemaManager.createBackingTable (~line 2656); prefer createBacking
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts — materializeView caller (context only, no edit)
  - ../lamina/packages/lamina-quereus/src/module.ts — LaminaModule.createBacking (already shipped; the seam target)
difficulty: easy
----

# Quereus `createBackingTable` must prefer `module.createBacking?()` so durable MV backings route to Lamina

## Problem (confirmed root cause)

`SchemaManager.createBackingTable` (`packages/quereus/src/schema/manager.ts`, ~line 2656) creates a
materialized view's backing table by calling the module's ORDINARY create:

```ts
tableInstance = await moduleInfo.module.create(this.db, tableSchema);
```

`module.createBacking` is **never called anywhere in this repo** — verified by
`find_references("createBacking", path_filter: "packages/quereus/%")`, which returns only
`createBackingTable` hits, no `module.createBacking(` call site.

Consequence for a durable-backing module (Lamina): the full SQL path
`create materialized view mv using lamina as <body>` builds an ORDINARY relational Lamina table named
`main.mv` via `create`, never the durable `LocalRowStore`. Then `materializeView` →
`resolveBackingHost` → `module.getBackingHost('main','mv')` resolves no durable store and throws
`backing host not found for 'main.mv'`, even on an install that fully opted into durable MV backing
(`createLaminaInstallation(…, { durableMvBacking: true })`).

Lamina already ships the durable router `LaminaModule.createBacking`
(`../lamina/packages/lamina-quereus/src/module.ts:1286`), with signature
`createBacking(db, tableSchema): Promise<LaminaTable>` — mirroring `create` exactly. It routes the
backing create into the basis-store catalog's `LocalRowStore` and is idempotent on a present store.
Its own docstring explicitly states it is waiting on Quereus to prefer `createBacking?.() ?? create()`.
The ONLY missing piece is the quereus-side seam.

## Fix

This is a **quereus-side change only**. Do NOT touch Lamina (its router + production opt-in already
exist and are tested). Two edits:

### 1. Declare the optional capability on `VirtualTableModule` (`packages/quereus/src/vtab/module.ts`)

Add an optional `createBacking?()` method to the `VirtualTableModule` interface, mirroring `create`'s
signature (`create(db, tableSchema): Promise<TTable>`). Place it adjacent to `create` and document the
seam: presence of the method is the capability (mirrors `getBackingHost?` / `getMappingAdvertisements?`
— no `ModuleCapabilities` flag); the engine prefers it over `create` when creating a materialized-view
backing table, so a durable-backing module can route the backing into its durable store. Modules that
omit it keep ordinary `create` behavior.

```ts
/**
 * Optional. Creates a materialized-view BACKING table, preferred by
 * SchemaManager.createBackingTable over {@link create} when present
 * (createBacking?.() ?? create()). Presence is the capability (mirrors
 * getBackingHost?): a durable-backing module routes the backing into its
 * durable store here instead of building an ordinary relational table, so the
 * subsequent getBackingHost resolves a real host. Same signature/contract as
 * {@link create}; omit ⇒ backings go through create (today's behavior).
 */
createBacking?(
	db: Database,
	tableSchema: TableSchema,
): Promise<TTable>;
```

### 2. Prefer it in `createBackingTable` (`packages/quereus/src/schema/manager.ts`)

Replace the direct `module.create` call (inside the `try` at ~line 2677) with the
`createBacking ?? create` seam, preserving the existing error-wrapping `catch`:

```ts
const create = moduleInfo.module.createBacking?.bind(moduleInfo.module)
	?? moduleInfo.module.create.bind(moduleInfo.module);
tableInstance = await create(this.db, tableSchema);
```

`bind` is required so the chosen method keeps its module as `this`. The fallback (`create`) keeps the
memory module and every other current module on their exact present behavior — non-breaking. Optionally
generalize the catch's wrap message from "create failed" to "backing create failed" (minor; not
required).

## Why non-goal collisions don't apply

- Distinct from `sqllogic-conformance-untracked-failures` cluster B (that cluster is the sqllogic
  harness keeping durable seams OFF by design; THIS gap is that even WITH seams on, SQL can't reach
  `createBacking`). They share the error string but differ in cause — do not conflate.

## What unblocks downstream (lamina-side, not this ticket)

- `../lamina/packages/lamina-quereus-test/src/mv-backing-installer-enablement-e2e.test.ts` — its
  `it.skip` full-SQL round-trip can be un-skipped once the linked quereus prefers `createBacking`.
- lamina `lamina-mv-backing-general-body-golden` (parked in lamina's `blocked/` until this lands).

## TODO

- [ ] Add `createBacking?(db, tableSchema): Promise<TTable>` to the `VirtualTableModule` interface in
      `packages/quereus/src/vtab/module.ts`, adjacent to `create`, with the seam docstring above.
- [ ] In `SchemaManager.createBackingTable` (`packages/quereus/src/schema/manager.ts`), replace the
      direct `moduleInfo.module.create(...)` call with `createBacking?.bind(...) ?? create.bind(...)`
      then await it. Keep the existing try/catch error wrapping.
- [ ] Add an engine-side regression test (no Lamina needed): register a stub `VirtualTableModule` that
      implements BOTH `create` and `createBacking` (each recording which was invoked, both returning a
      memory-style backing), create a materialized view `using <stub>`, and assert `createBacking` was
      the path taken; also register a stub that omits `createBacking` and assert it falls back to
      `create`. Mirror the existing vtab test conventions under `packages/quereus/test/vtab/`.
- [ ] `yarn workspace @quereus/quereus run build` — type-check the new optional-method declaration and
      the seam.
- [ ] `yarn test` (default, memory-backed) — confirm no MV/backing regressions.
- [ ] `yarn lint` (single-quote globs on Windows) — eslint + test-file tsc pass.

## End
