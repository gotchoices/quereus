---
description: Public Database.getTable() handle that exposes per-table event subscription
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/table-handle.ts
  - packages/quereus/src/vtab/events.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/vtab-events.spec.ts
  - docs/usage.md
---

## What landed

A public `Database.getTable(schemaName, tableName)` method returning a narrow
`Table` handle. The handle exposes `schemaName`, `tableName`, `schema` (frozen
reference to the underlying `TableSchema`), `moduleName`, and a single method
`getEventEmitter(): VTableEventEmitter | undefined` that delegates to the
shared `tryGetEventEmitter()` predicate in `vtab/events.ts`.

The `getEventEmitter API` block of `vtab-events.spec.ts` (previously
`describe.skip`) is now active and covers the happy path, case-insensitive
unknown-table resolution, unsubscribe, post-DROP behavior, and default-schema
resolution.

## Review findings

### Process

- Re-read the implement diff (`git show 4225ea40`) with fresh eyes before
  consulting the handoff.
- Verified the structure of `tryGetEventEmitter`, the lifted helper, and the
  call sites in `core/database.ts`.
- Cross-checked `Table` field shape against the plan ticket's contract.
- Ran lint, build, and the full test suite (`yarn workspace @quereus/quereus
  run lint|build|test`) before and after the inline fixes; all green
  (3157 passing after the additional test).

### Inline fixes (minor — applied in this pass)

- **Removed unused `db` field from `Table`** (`packages/quereus/src/core/table-handle.ts`).
  The implementer flagged this; per AGENTS.md "Don't design for hypothetical
  future requirements" the field had no current consumer. Constructor
  signature is now `(schema, moduleName, module)` and the only caller
  (`Database.getTable`) was updated.
- **Added `db.getTable(...)` to the Database API Reference section of
  `docs/usage.md`** (line ~452). The Event-System subsection already covered
  it; this is the symmetric reference entry the implementer flagged as
  missing.
- **Added a test for `db.getTable(undefined, 'users')`** that resolves via the
  default schema (`packages/quereus/test/vtab-events.spec.ts`, in the
  `getEventEmitter API` block). Cheap belt-and-braces coverage of the
  documented "pass `undefined` for the default schema" overload that the
  implementer noted was unexercised.

### Areas scrutinized

- **SPP / DRY** — `tryGetEventEmitter` lifted to `vtab/events.ts` and shared
  between `Database` (event-hooking path) and `Table.getEventEmitter()`. The
  two paths now share one predicate and cannot drift. ✓
- **Modularity** — `Table` lives in its own `core/table-handle.ts` file.
  Constructor is `@internal`; the class is re-exported from `index.ts`. ✓
- **Type safety** — No `any`. The `tryGetEventEmitter` shape probing uses
  `as` casts for runtime structural checks, which is unavoidable for a
  duck-typed optional interface; functions in/out are correctly typed. ✓
- **Error handling** — `getTable` returns `undefined` (not throws) for
  missing tables or unregistered modules. `checkOpen()` is called first so a
  closed database produces the same error as other public methods. ✓
- **Resource cleanup** — `Table` holds only a reference to the module and
  the captured schema. No subscriptions or timers; GC handles disposal.
  Unsubscribe is the caller's responsibility (the new
  `unsubscribe stops further events` test verifies this). ✓
- **Lifecycle / DROP semantics** — Tested: a previously acquired handle
  keeps its emitter reference after DROP (the module outlives individual
  tables), and a fresh `db.getTable('main', 'users')` returns `undefined`.
  Documented in JSDoc and `docs/usage.md`. ✓
- **Module-shared-emitter caveat** — Returning the module-level emitter
  rather than a per-table filtered wrapper matches the existing
  `VirtualTable.getEventEmitter?()` shape and the failing-spec
  `assert.equal(tableEmitter, emitter)` expectation. The shared-emitter
  surprise is called out explicitly in both the JSDoc and the docs section.
  A future filtered-subscription wrapper is deferred (already listed as out
  of scope in the plan ticket). ✓
- **Docs** — `docs/usage.md` now references the API in both the Event System
  section (with lifecycle caveats) and the Database API Reference section. ✓
- **Test floor** — Six tests in the un-skipped `getEventEmitter API` block:
  expose emitter, subscribe-via-emitter, unknown-table (case variants),
  unsubscribe-detaches, post-DROP, default-schema. ✓

### Not flagged (considered and accepted)

- **Constructor `@internal` is TS-only.** A runtime guard using a symbol
  would harden the invariant but matches the convention used elsewhere
  (e.g. `Statement`). Accepting the lighter convention.
- **`schema` exposes a live `TableSchema` reference, not a deep-frozen
  clone.** The JSDoc says "frozen reference" meaning the reference itself
  is `readonly`. The plan ticket used the same wording. If the schema
  manager later mutates a table schema in place (e.g. column add), the
  handle observes the mutation. Documented as a snapshot of references, not
  values — acceptable for the immediate use cases. If stronger semantics
  become necessary, a separate ticket can clone-on-acquire.
- **`schemaManager.getModule(moduleName)` lookup vs. `tableSchema.vtabModule`
  direct reference.** Both resolve to the same module. The lookup is
  defensive against an unregistered module name and adds a single map
  hit — kept for symmetry with `hookModuleEvents`.

### Major findings

None.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 3157 passing, no failures.
  The previously-skipped `getEventEmitter API` block runs (six tests) and
  all pass.

`yarn test:store` not run (no store-specific code paths touched; per
AGENTS.md "only run when diagnosing a store-specific issue or preparing a
release").
