----
description: The unified-model `create table … maintained as` persistence form cannot round-trip the implicit-vs-explicit output-column distinction, so an implicit `select *` materialized view whose source shape drifted between sessions arity-errors on reopen instead of reshaping; also the `generateMaintainedTableDDL` fixed-point test still expects the old sugar output.
difficulty: hard
files:
  - packages/quereus/src/schema/manager.ts                            # maintainedImportFromTableStmt — columns reconstruction from the table form
  - packages/quereus/src/schema/ddl-generator.ts                      # generateMaintainedTableDDL — table-form render must be lossless re: explicit columns
  - packages/quereus/src/parser/parser.ts                             # maintained clause grammar (if the explicit column list is encoded there)
  - packages/quereus/src/parser/ast.ts                                # MaintainedClause shape (if a rename list is added)
  - packages/quereus/src/emit/ast-stringify.ts                        # maintainedClauseToString
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts            # source-shape-change refill + adopt-ledger MV-over-MV residuals
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts             # generateMaintainedTableDDL fixed-point expectations (still assert sugar output)
----

# Table-form maintained DDL: implicit-vs-explicit columns round-trip

Follow-up to the triage of the `maintained-table-unified-model` /
`maintained-table-attach-detach-verbs` rollout. The import side was taught to
route the canonical `create table … maintained as <body>` form through the MV
re-materialize/adopt path (`SchemaManager.importDDL` →
`importMaterializedView`), which fixed 20 of the 22 store rehydrate failures.
These residuals remain because the table form is **lossy**.

## The gap

`generateMaintainedTableDDL` always emits the full declared column list and the
`maintained as <select>` clause carries no rename list, so the persisted form
**cannot distinguish**:

- an IMPLICIT body (`create materialized view mv using store as select * from src`)
  — which must reshape to follow its source on a column add, and
- an EXPLICIT rename list (`create materialized view mv (a, b) using store as select * from src`)
  — which arity-locks (a source widening is a sited error, backing preserved).

Both persist as `create table mv (<cols>) using store maintained as select * from src`.
On reopen the importer (`maintainedImportFromTableStmt`) passes the declared
column names as the derivation's `columns` (rename) list. When the source shape
has NOT drifted, declared == the body's natural output names and everything is
fine. When the source HAS drifted between sessions, the declared list is the
stale narrow shape while the re-planned body is wider, so
`assertDeclaredColumnArity` raises a spurious arity error for the implicit case —
yet the explicit case legitimately needs exactly that error.

A normalization that re-derives the body's natural names and treats
`declared == natural ⇒ implicit (no columns lock)` was tried and does NOT close
the gap: under source drift `declared != natural` in BOTH the implicit and the
explicit case, so they remain indistinguishable. The fix needs a **lossless**
table form — most likely encoding the explicit rename list in the `maintained`
clause grammar (or otherwise recording on the derivation whether the column list
was authored) so import can restore `derivation.columns` faithfully.

## Failing tests (at HEAD, after the import-routing triage fix)

`yarn workspace @quereus/store run test`:

1. `materialized-view adopt-without-refill at rehydrate` ›
   "a source shape change between sessions fails the shape gate: refill matches
   the new shape" (`mv-rehydrate-adopt.spec.ts:215`)

   ```
   AssertionError: expected [ { …(2) } ] to have a length of +0 but got 1
   ```
   (session-3 rehydrate records one error — the spurious arity throw on the
   `select *` body widened from 2 to 3 columns — instead of refilling.)

2. `materialized-view adopt-without-refill at rehydrate › MV-over-MV` ›
   "a refilled upstream forces the dependent to refill (adopt-ledger gate)"
   (`mv-rehydrate-adopt.spec.ts:322`)

   ```
   AssertionError: expected [ { …(2) }, { …(2) } ] to have a length of +0 but got 2
   ```
   (the `select *` upstream `zmv` arity-errors on widening; both entries fail.)

`yarn workspace @quereus/quereus run test`:

3. `view persistence: generateMaintainedTableDDL fixed point` ›
   "always emits a fully-qualified (schema.name) MV name; explicit-default USING
   normalizes away" (`view-mv-ddl-persistence.spec.ts:627`)

   ```
   expect(ddl).to.match(/^create materialized view main\.v /i)   // fails
   ```
   The test still asserts the OLD sugar (`create materialized view …`) output;
   `generateMaintainedTableDDL` now emits `create table … maintained as`. The
   whole `generateMaintainedTableDDL fixed point` matrix needs its expectations
   migrated to the table form (re-parse to `createTable` carrying a `maintained`
   clause, as `mv-rename-propagation.spec.ts` already does).

## Ruled out / done in triage

- Root cause of the mass failure (all `Module 'memory' connect failed …` /
  `not found. Cannot connect` errors): `importDDL` routed the table-form
  `createTable` to `importTable` (module.connect), which cannot reconnect an
  ephemeral/never-persisted backing. Fixed by routing a `createTable` carrying a
  `maintained` clause through `importMaterializedView` (re-materialize/adopt),
  keeping the `create materialized view` sugar path working. The store's
  `manualImport` test scaffold was updated to classify the table form as an MV.
- This residual is NOT a regression: it is unfinished work of the in-progress
  ticket `maintained-table-attach-detach-verbs` (its TODO lists "Import/rehydrate:
  accept the table-form DDL" and "update view-mv-ddl-persistence expectations").
  The bodyHash/columns-list concern is explicitly deferred there.
