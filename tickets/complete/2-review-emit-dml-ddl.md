description: Review of DML and DDL runtime emitters
files:
  packages/quereus/src/runtime/emit/insert.ts
  packages/quereus/src/runtime/emit/update.ts
  packages/quereus/src/runtime/emit/delete.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/create-table.ts
  packages/quereus/src/runtime/emit/create-view.ts
  packages/quereus/src/runtime/emit/create-index.ts
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/src/runtime/emit/drop-table.ts
  packages/quereus/src/runtime/emit/drop-view.ts
  packages/quereus/src/runtime/emit/drop-assertion.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/src/runtime/emit/transaction.ts
  packages/quereus/src/runtime/emit/block.ts
  packages/quereus/src/runtime/emit/pragma.ts
----
## Findings

### defect: UPSERT/REPLACE paths missing FK cascading actions
file: packages/quereus/src/runtime/emit/dml-executor.ts:310,357
When INSERT resolves to UPSERT DO UPDATE or INSERT OR REPLACE, `executeForeignKeyActions` is not called, unlike the normal UPDATE path. Child tables with ON UPDATE CASCADE won't see the parent row change.
Ticket: tickets/fix/upsert-fk-cascade-missing.md

### defect: CREATE ASSERTION silent fallback to non-functional assertion
file: packages/quereus/src/runtime/emit/create-assertion.ts:25-29
When `expressionToString` fails, the assertion is created with `violationSql = 'select 1 where false'` — an assertion that never fires. User gets false sense of data protection.
Ticket: tickets/fix/create-assertion-silent-fallback.md

### defect: APPLY SCHEMA seed data silently NULLs boolean/Uint8Array values
file: packages/quereus/src/runtime/emit/schema-declarative.ts:147-155
Seed data interpolation handles null/string/number/bigint but boolean and Uint8Array fall through to 'NULL'.
Ticket: tickets/fix/schema-declarative-seed-data-types.md

### smell: ANALYZE mutates potentially frozen TableSchema objects
file: packages/quereus/src/runtime/emit/analyze.ts:61,68
Statistics are assigned directly onto TableSchema via cast, bypassing immutability. Other DDL emitters correctly create new schema objects.
Ticket: tickets/fix/analyze-mutates-frozen-schema.md

## Trivial Fixes Applied
- delete.ts:10 — renamed unused `ctx` parameter to `_rctx` (convention compliance, removed shadowing)
- constraint-check.ts:236-257 — removed no-op catch-and-rethrow block in checkCheckConstraints
- constraint-check.ts:112-114 — hoisted `composeCombinedDescriptor` call out of per-row loop (was recomputing constant value each iteration)
- alter-table.ts:18 — added missing `_ensureTransaction()` call (all other DDL emitters had it; ALTER TABLE was the sole exception)
- create-table.ts:17 — added `note` property for debugging consistency
- create-index.ts:17 — added `note` property for debugging consistency
- drop-table.ts:29 — fixed indentation (2 spaces → tab) and added `note` property

## No Issues Found
- insert.ts — clean, simple OLD/NEW flat row transformation
- update.ts — correct two-phase evaluation (regular then generated columns), proper slot cleanup
- returning.ts — clean streaming with createRowSlot, parallel projection evaluation via Promise.all
- add-constraint.ts — proper immutable schema update with Object.freeze, change notification
- create-view.ts — correct IF NOT EXISTS handling, schema validation
- drop-view.ts — defensive double-check on removal, clean
- drop-assertion.ts — proper IF EXISTS handling, cache invalidation
- transaction.ts — all operations correctly handled (begin/commit/rollback/savepoint/release)
- block.ts — elegant findLastIndex for result selection
- pragma.ts — intentional asymmetry between read (throws) and write (ignores unknown)
