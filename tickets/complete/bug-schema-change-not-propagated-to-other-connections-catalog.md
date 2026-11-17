description: When two open connections share one table and one of them changes the table's columns, the other connection used to keep its old column list and silently read or write values in the wrong columns. It now fails with a clear "table altered outside this connection — re-open" error instead.
architecture: docs/schema.md
files:
  - packages/quereus/src/runtime/stale-catalog-guard.ts
  - packages/quereus/src/runtime/emit/scan.ts
  - packages/quereus/src/runtime/utils.ts
  - packages/quereus/src/runtime/emit/remote-query.ts
  - packages/quereus/src/runtime/emit/analyze.ts
  - packages/quereus/src/vtab/table.ts
  - packages/quereus/test/vtab/shared-module-stale-catalog.spec.ts
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/schema.md
  - docs/design-isolation-layer.md
  - docs/module-authoring-schema-changes.md
  - tickets/backlog/feat-connection-adopts-another-connections-schema-change.md
repro: verified
---

# What was built

Each `Database` keeps its own catalog, but two `Database`s that register one module instance share that module's tables. An ALTER through one left the other planning against its old catalog entry while the module stored rows in the new layout; after DROP COLUMN, the other connection's inserts put values one column over.

`assertCatalogMatchesModule` (`packages/quereus/src/runtime/stale-catalog-guard.ts`) runs right after `module.connect(...)` at the four runtime connect sites (scan leaf, `getVTable` for DML, remote-query pushdown, ANALYZE). It compares the connecting `Database`'s current catalog entry with the instance's `tableSchema` on column count, column names in order (case-insensitive), generated-ness, and the primary-key definition. On a mismatch it disconnects the instance and throws `StatusCode.SCHEMA` ("Table main.t was altered outside this connection (…); … re-open the connection"). It skips instances without `tableSchema` and registered modules without `alterTable`.

Constraint, NOT NULL, type, collation and DEFAULT drift are not compared (each has a legitimate single-`Database` disagreement — see `docs/schema.md` § "Catalogs are per connection"); that drift is an arm of `tickets/backlog/feat-connection-adopts-another-connections-schema-change.md`.

Implemented in `ticket(implement): bug-schema-change-not-propagated-to-other-connections-catalog`.

# Review findings

Read the implement diff first, then the four connect sites in full, the other `connect(` call sites in `packages/quereus/src`, and the docs the change touches or should touch.

**Correctness / design deviations (the implementer asked these to be weighed).**
- Narrowing the comparison to row placement (count, names, generated, PK): agreed. The type/collation exclusion is forced by the materialized-view reshape preview window (`previewReshapedColumns`), and the plan's schema cannot be used to recognise that window. Excluding DEFAULT keeps one rule ("what decides which slot and which row a value goes to"); no change.
- Comparing against the current catalog (not the plan's schema), and using `effectiveName` at the scan leaf so a deferred constraint after RENAME TO looks up the renamed entry: correct.
- Checking the registered module for `alterTable` rather than `vtab.module`: correct for wrapper modules (`test/no-alter-module.ts`).
- Disconnect ownership: at every site the guard runs before the caller has taken ownership (scan caches/owns only after the guard; remote-query and ANALYZE enter their `try/finally` after it; `getVTable` returns after it), so there is no double disconnect and no leak on the SCHEMA path.
- ANALYZE swallows the SCHEMA error in its per-table catch (debug log, table missing from the report); this matches the accepted `NOTE:` there. No change.

**Fixed inline (minor).**
- `runtime/emit/remote-query.ts`: the "module does not implement `executePlan()`" error was thrown before the `try/finally`, leaking the connected instance (this predates the ticket but sits next to the new guard). Moved the check inside the `try`.
- Docs: the change adds an obligation on module authors (an instance's `tableSchema` must track the module's current layout after `alterTable`, or the module's own next connect fails with SCHEMA) that `docs/module-authoring-schema-changes.md` did not mention. Added a paragraph to the `alterTable` contract, and a doc comment on `VirtualTable.tableSchema` (`src/vtab/table.ts`).

**Coverage gaps (documented by the implementer, re-checked).**
- The materialized-view apply paths (`core/database-materialized-views-apply.ts`, `runtime/emit/materialized-view-helpers.ts`) write to a backing table through `host.connect()`, not `module.connect`, so the guard does not run there. Backing tables are engine-owned and maintained by the `Database` that wrote the source change, so a stale cross-`Database` catalog entry would have to be a backing table registered in two catalogs. That is speculative, so no ticket and no tripwire beyond this line.
- Statements already running when another connection alters the table: tripwire `NOTE:` already at the helper. Separate processes and separate module instances: listed in `docs/schema.md`.

**DRY / hygiene.** The guard repeats the four-line "disconnect and log" of `disconnectVTable` (`runtime/utils.ts`). It can't import it without a circular import, because `utils.ts` imports the guard. The duplicate is small, so I left it. The helper file is 108 lines, its functions are small, and its comments explain why rather than narrate. No change.

**Performance.** One `schemaManager.getTable` lookup per connect, then identity checks and at worst O(columns) name comparisons. NLJ re-scans reuse the cached instance and skip the guard. Not measured, and I see no reason to: the cost is small next to `connect` itself.

**Tests.** I kept both new tests in `shared-module-stale-catalog.spec.ts`. The drop-column test reproduces the bug (the implementer confirmed it fails without the guard). The tags-only test pins the documented "informational changes don't trip the guard" rule across two `Database`s, which the single-`Database` suite cannot exercise. The isolation test changes are correct: the conformance test now expects SCHEMA on B's read and CONSTRAINT on its commit, and `isolation-layer.spec.ts` registers the schema returned by a direct `alterTable` call, as the engine does. The primary-key-difference branch is untested; it is a simple comparison, so no test added.

**Validation.** `yarn workspace @quereus/quereus lint` clean (eslint and the test-file `tsc`). `yarn test` (all workspaces) green, quereus 11187 passing / 0 failing. I did not re-run `yarn test:store` after the review edits: they add a doc comment, a docs paragraph, and move one `throw` inside a `try` on the remote-query path. The implementer's store run (11180 passing) covers the guard itself.
