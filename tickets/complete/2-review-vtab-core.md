description: Review of virtual table core interfaces
files:
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/vtab/capabilities.ts
  packages/quereus/src/vtab/connection.ts
  packages/quereus/src/vtab/events.ts
  packages/quereus/src/vtab/filter-info.ts
  packages/quereus/src/vtab/index-info.ts
  packages/quereus/src/vtab/manifest.ts
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/table.ts
----
## Findings

### smell: File-wide eslint-disable for `any` in best-access-plan.ts
file: packages/quereus/src/vtab/best-access-plan.ts:6
The file had `/* eslint-disable @typescript-eslint/no-explicit-any */` but only used `any` in two places for `residualFilter` callbacks. The `Row` type is the correct type for filter functions operating on table rows.
Ticket: fixed in review — replaced `any` with `Row`, removed file-wide eslint-disable.

### smell: Non-functional eslint-disable comment in module.ts
file: packages/quereus/src/vtab/module.ts:193
The `eslint-disable-next-line` comment was inside a JSDoc block (`/** ... */`), where it has no effect. Moved to a standalone `//` comment above the export line.
Ticket: fixed in review.

### note: Extra blank lines in module.ts
file: packages/quereus/src/vtab/module.ts:112-114
Two consecutive blank lines between `getBestAccessPlan?` and `destroy` methods.
Ticket: fixed in review.

### note: DRY opportunity in DefaultVTableEventEmitter
file: packages/quereus/src/vtab/events.ts:131-166
The listener dispatch + error handling loop is duplicated between `emitDataChange` (lines 137-144) and `flushBatch` (lines 158-166). A private `dispatchDataEvent` helper could consolidate this. Low priority — the duplication is small and contained within one class.

### note: IsolationCapableTable has no internal consumers
file: packages/quereus/src/vtab/capabilities.ts:28
The `IsolationCapableTable` interface is defined and re-exported from `index.ts` but never imported within the monorepo. Its methods mirror the optional isolation methods on `VirtualTable` (extractPrimaryKey, comparePrimaryKey, etc.). This is likely a public API contract for external consumers. No action needed unless it becomes dead code.

### note: TestQueryTable.update() return type mismatch
file: packages/quereus/test/vtab/test-query-module.ts:124
The test module's `update()` returns `Promise<Row | undefined>` but the abstract declaration on `VirtualTable` specifies `Promise<UpdateResult>`. This likely predates the `UpdateResult` refactor. The test still compiles because TypeScript type-stripping is used. Not blocking since it's test-only code, but should be updated if the test is modified.

## Trivial Fixes Applied
- best-access-plan.ts:6 — removed file-wide `/* eslint-disable @typescript-eslint/no-explicit-any */`, imported `Row` type
- best-access-plan.ts:80 — changed `residualFilter?: (row: any) => boolean` to `(row: Row) => boolean`
- best-access-plan.ts:204 — changed `setResidualFilter(filter: (row: any) => boolean)` to `(row: Row) => boolean`
- module.ts:193-195 — moved `eslint-disable-next-line` from inside JSDoc to a standalone `//` comment
- module.ts:112-114 — removed extra blank lines

## No Issues Found
- capabilities.ts — clean (ModuleCapabilities well-structured, IsolationCapableTable correctly uses structural typing)
- connection.ts — clean (simple interface, good MaybePromise usage for sync/async flexibility)
- filter-info.ts — clean (well-typed bridge between legacy IndexInfo and modern access)
- index-info.ts — clean (proper use of bigint for colUsed/estimatedRows, clean enum for IndexScanFlags)
- manifest.ts — clean (well-organized plugin manifest/registration types)
- table.ts — clean (appropriate abstract class design, clear optional method pattern for capabilities)
