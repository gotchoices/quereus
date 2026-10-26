description: When a table sits behind the transaction-isolation overlay, the per-row write descriptions and mutation statements the engine attaches at staging time never reach the real storage module, because the overlay rebuilds the write arguments when it flushes at commit; carry them through so a module behind the overlay can use them.
architecture: docs/change-scope.md
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/flush.ts, packages/quereus/src/vtab/table.ts, docs/module-authoring.md
tradeoffs: The overlay stages rows per table and flushes them in bulk; keeping a per-row reference to the statement description and the mutation statement costs memory for every staged row even when the underlying module never reads them, and a module that needs them can today be registered without the overlay.
----

## Context

`VirtualTable.update()` receives two optional per-row descriptions from the engine: `mutationStatement` (opt-in via `wantStatements`, docs/module-authoring.md § Mutation Statements) and, once the `write-scope-module-hook` ticket lands, `writeScope` (opt-in via `wantWriteScope`, docs/write-scope.md). Both are attached by the DML executor at the moment it calls `update()`.

When the table is wrapped by `@quereus/isolation`, that call lands on `IsolatedTable.update`, which spreads the incoming arguments into a write against its in-memory overlay. The underlying module only sees the rows later, when `flush.ts` replays the overlay into it at commit, and that path constructs fresh `UpdateArgs` (`preCoerced`, `trustedWrite`, values, keys) — neither description is carried. A module that queues writes for a remote peer and sits behind the overlay therefore cannot use either description.

## Expected behaviour

If the underlying table opts in to either description, the overlay retains the description with each staged row and passes it to the underlying `update()` at flush, unchanged. Rows staged by several statements in one transaction keep their own descriptions. Overlay-internal writes that have no originating statement (tombstones, migration rewrites under ALTER) pass none.

## Open questions for whoever picks this up

- Retain per row (simple, memory proportional to staged rows) or per statement with a per-row index (cheaper when one statement stages many rows).
- Whether a row updated twice in one transaction should carry the last statement's description or both.

## State after write-scope-module-hook

`IsolatedTable`'s constructor now mirrors `wantStatements` and `wantWriteScope` from the underlying table, so the executor already computes both descriptions for a wrapped table and they arrive in `IsolatedTable.update`'s `args`; only retention per staged row and forwarding in `flush.ts` remain.
