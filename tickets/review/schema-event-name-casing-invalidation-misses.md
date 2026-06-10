----
description: Implemented — canonical stored schemaName on tables/views/MVs + every schema-change emitter fires stored names, closing all four name-casing cached-plan invalidation misses. Build/tests/lint green; one pre-existing store-mode failure documented separately.
files:
  - packages/quereus/src/schema/manager.ts                          # canonicalSchemaName (new, after getSchemaOrFail); buildTableSchemaFromAST, importView, importMaterializedView canonicalize; addAssertion/removeAssertion, commitTagUpdate, dropTable, createIndex, dropIndex, createTable fire stored names (+ adjacent auto-event payloads)
  - packages/quereus/src/planner/building/create-view.ts            # canonical schemaName; default 'main' → current schema
  - packages/quereus/src/planner/building/materialized-view.ts      # canonical schemaName in create/refresh/drop builders
  - packages/quereus/src/runtime/emit/create-view.ts                # view_added fires viewSchema.schemaName
  - packages/quereus/src/runtime/emit/drop-view.ts                  # view_removed fires existingView.schemaName
  - packages/quereus/src/runtime/emit/materialized-view.ts          # _added/_refreshed/_removed fire mv.schemaName/mv.name
  - packages/quereus/test/plan/schema-event-name-casing.spec.ts     # NEW — 7 plan-identity pins with cache-hit controls
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts # untouched; still green (13 passing)
  - docs/schema.md                                                  # naming contract added under "Schema Change Events"
----

# Review: canonical stored schema names + stored-name-firing emitters

## What was implemented

The invariant, stated once on `SchemaManager.canonicalSchemaName` (manager.ts,
right after `getSchemaOrFail`) and referenced from each emitter comment:
**stored `schemaName` on tables/views/MVs is canonical (lowercase), and every
schema-change emitter fires the *stored* names of the object it swapped.** The
statement listener compare (statement.ts ~176-180) stays exact, untouched.

`canonicalSchemaName(raw)` resolves through the Schema object
(`schemas.get(raw.toLowerCase())?.name`) with a lowercase fallback for absent
schemas — deliberately **non-throwing** so plan-time builders (CREATE VIEW into
a not-yet-existing schema) and catalog-import paths keep their current error
timing/messages.

Canonicalization points (stored names):
- `buildTableSchemaFromAST` — covers `createTable` and `importTable`
- `importView` / `importMaterializedView` — via `getOrCreateSchema(...).name`
  resp. `canonicalSchemaName` (MV keeps the DML-body gate *before* schema
  creation, preserving side-effect order)
- `buildCreateViewStmt` — also switched its unqualified default from hardcoded
  `'main'` to the current schema, aligning with every other DDL builder
- `buildCreateMaterializedViewStmt` / `buildRefresh…` / `buildDrop…`

Emitters switched from raw statement spellings to stored names:
- manager.ts: `createIndex` (fires `updatedTableSchema.schemaName/.name`),
  `commitTagUpdate` (`newSchema.schemaName` — covers ALTER INDEX/TABLE/COLUMN/
  CONSTRAINT TAGS), `dropTable` (`tableSchema.schemaName/.name`), `dropIndex`
  (`ownerTable.schemaName`), `createTable` (`completeTableSchema.schemaName/.name`),
  `addAssertion`/`removeAssertion` (`schema.name`)
- runtime/emit: `drop-view.ts` (`existingView.schemaName`),
  `materialized-view.ts` ×3 (`mv.schemaName`/`mv.name` — also fixes raw-cased
  `REFRESH`/`DROP MATERIALIZED VIEW` spellings feeding the events),
  `create-view.ts` (`viewSchema.schemaName`, uniformity)
- Adjacent `emitAutoSchemaEventIfNeeded` payloads aligned to the same stored
  names in createIndex/dropIndex/createTable/dropTable. dropIndex's auto event
  now fires the stored index display name (captured before the filter) instead
  of the raw `DROP INDEX` spelling. No store-side keying logic touched.

docs/schema.md gained a "Naming contract" paragraph under Schema Change Events.

## Validation performed

- `yarn build` (full monorepo) — clean, no TS errors.
- `yarn test` (all workspaces) — all green; quereus 5683 passing / 9 pending
  (pending counts unchanged from HEAD), every other workspace green.
- `yarn lint` (quereus) — clean, including the test file.
- New `test/plan/schema-event-name-casing.spec.ts` — 7 pins, all four ticket
  bugs + the self-consistent ALTER TABLE TAGS control + a direct stored-name
  pin, every `!==` preceded by a `===` cache-hit control, case-differing
  asserts additionally preceded by exact-case invalidation controls:
  1. stored schemaName is canonical for `MAIN.`-qualified table/view/MV
  2. `create index idx2 on T (x)` invalidates a cached read plan (bug 1)
  3. `create table MAIN.t` + unqualified CREATE INDEX invalidates (bug 4)
  4. `create view MAIN.v` + `alter view v set tags` invalidates write plan (bug 2)
  5. mirror for `create materialized view MAIN.mv` (bug 2)
  6. `alter index MAIN.idx add tags` invalidates after exact-case control (bug 3)
  7. control: `create table MAIN.t` + `alter table t set tags` still invalidates
  Pre-fix failure of 2-6 was verified live during the fix stage (see original
  ticket); post-fix all pass.
- `yarn test:store` — 1891 passing, **1 failing: pre-existing**
  (`50.2-declare-schema-renames.sqllogic`, store plugin's own dropIndex
  registry after a lens rename). Reproduced byte-identically at HEAD with this
  diff stashed; documented in `tickets/.pre-existing-error.md` for the
  runner's triage pass. Not store-keying-related to this diff.

## Reviewer attention points (honest gaps)

- **Behavior change beyond casing:** unqualified `CREATE VIEW` now lands in
  the *current* schema instead of hardcoded `'main'`. No test exercises an
  unqualified CREATE VIEW while the current schema is non-main (I found no SQL
  surface to switch current schema in-suite; `setCurrentSchema` is API-only).
  If a consumer relied on the old always-main behavior, this is where it shows.
- **Rendering change:** stored schemaName is now canonical, so introspection /
  error messages render `main.t` for a table created as `MAIN.t`. Full suite
  green, but out-of-repo consumers comparing raw casing would notice.
- Module-facing call args (`vtabModule.createIndex(db, targetSchemaName, …)`,
  `module.connect` on import) still receive the raw spelling — deliberately
  unchanged per ticket scope ("do NOT chase store-side keying"). A reviewer
  could reasonably ask whether modules should get canonical names too; that
  would be a follow-up with store-keying blast radius.
- Assertion events now fire `schema.name` — no listener compares assertion
  names today, so no test was added (per ticket: consistency only).
- `canonicalSchemaName`'s lowercase fallback for absent schemas means a
  nonsense qualifier canonicalizes silently at plan time; existence is still
  enforced at the same places it was before (verified by the green suite).
- The `dependencyKey` exact-compare on the *dep* side was not touched (per
  ticket: listener stays exact, convention is canonicalize-at-source).
