----
description: Canonical stored schemaName on tables/views/MVs + every schema-change emitter fires stored names, closing all four name-casing cached-plan invalidation misses. Reviewed; drop-view/drop-index builder asymmetry found and fixed inline; two backlog tickets filed.
files:
  - packages/quereus/src/schema/manager.ts                          # canonicalSchemaName; canonicalizing construction sites; stored-name-firing emitters
  - packages/quereus/src/planner/building/create-view.ts            # canonical schemaName; default 'main' → current schema
  - packages/quereus/src/planner/building/materialized-view.ts      # canonical schemaName in create/refresh/drop builders
  - packages/quereus/src/planner/building/drop-view.ts              # REVIEW FIX: 'main' default → canonical/current schema (symmetry with create)
  - packages/quereus/src/planner/building/drop-index.ts             # REVIEW FIX: 'main' default → canonical/current schema (symmetry with createIndex)
  - packages/quereus/src/runtime/emit/create-view.ts                # view_added fires stored names
  - packages/quereus/src/runtime/emit/drop-view.ts                  # view_removed fires stored names
  - packages/quereus/src/runtime/emit/materialized-view.ts          # _added/_refreshed/_removed fire stored names
  - packages/quereus/test/plan/schema-event-name-casing.spec.ts     # 7 implement pins + 2 review-added create/drop symmetry pins
  - docs/schema.md                                                  # naming contract under "Schema Change Events"
----

# Canonical stored schema names + stored-name-firing emitters

## What was implemented (implement stage)

The invariant, stated on `SchemaManager.canonicalSchemaName` and referenced
from each emitter comment: **stored `schemaName` on tables/views/MVs is
canonical (lowercase), and every schema-change emitter fires the *stored*
names of the object it swapped.** `Statement.compile()`'s listener compares
recorded dependencies against events exactly (statement.ts ~176-180,
untouched), so a raw-cased name on either side silently missed cached-plan
invalidation.

Canonicalization points: `buildTableSchemaFromAST` (createTable +
importTable), `importView`/`importMaterializedView`, `buildCreateViewStmt`
(also: unqualified default switched from hardcoded `'main'` to the current
schema), and the three MV builders. Emitters switched to stored names:
manager.ts `createIndex`/`commitTagUpdate`/`dropTable`/`dropIndex`/
`createTable`/`addAssertion`/`removeAssertion` (+ adjacent auto-event
payloads), runtime/emit `create-view`/`drop-view`/`materialized-view` ×3.
docs/schema.md gained the naming-contract paragraph.

## Review findings

### Checked

- **Implement diff** read in full with fresh eyes before the handoff summary.
- **Every `notifyChange` site engine-wide** (manager.ts ×13, alter-table.ts
  ×13, add-constraint.ts ×2, analyze.ts, materialized-view-helpers.ts ×2,
  create/drop-view, materialized-view ×3): all fire stored names — the sites
  the diff didn't touch already passed `tableSchema.schemaName`/
  `schema.name`/`mv.schemaName` (including alter-table's bare-variable site at
  rebuildTableWithNewShape, whose locals are `tableSchema.name`/`.schemaName`).
- **Dependency-recording side** (the other half of the exact compare):
  build-time `resolveTableSchema`/`buildViewMutation` and emission-time
  `EmissionContext.findTable` all record names off the *resolved* schema
  object — stored, hence canonical. The contract is closed from both
  directions.
- **`canonicalSchemaName` docblock claim** ("every Schema construction site
  lowercases"): verified against all `new Schema(` sites (constructor
  literals, `addSchema`, `getOrCreateSchema`) — all lowercase.
  `setCurrentSchema` lowercases too, so the `getCurrentSchemaName()` fallback
  used by every builder is canonical.
- **`dropIndex` non-null assertions** (`ownerTable.indexes!.find(…)!`): safe —
  `ownerTable` was selected by the same lowercased-name predicate on the same
  frozen snapshot; the intervening awaited `module.dropIndex` cannot mutate
  the captured immutable TableSchema.
- **Import paths**: `importTable` builds its stored schema through the
  canonicalizing `buildTableSchemaFromAST`; `importView`/`importMV`
  canonicalize directly; side-effect ordering (MV DML-body gate before schema
  creation) preserved.
- **Sweep for other raw `schemaName:` constructions** across building/emit/
  schema: remaining sites (lens-compiler, schema-declarative,
  materialized-view-helpers) all take canonical inputs (`Schema.name`,
  stored `def.schemaName`).
- **Test quality**: 7 implement pins all carry `===` cache-hit controls before
  every `!==`, and exact-case invalidation controls before case-differing
  asserts — not vacuously passable.
- **Docs**: the schema.md naming-contract paragraph matches the listener code;
  searched sql.md/schema.md for now-stale default-schema claims — the
  "typically main" language describes read-side resolution, which this diff
  did not change.
- **Validation**: quereus build + lint clean; full quereus suite 5685 passing
  / 9 pending; all other workspaces green. The store-mode failure the
  implementer flagged (`50.2-declare-schema-renames`) was already fixed by the
  runner's triage pass (commit 00181b37) and `.pre-existing-error.md` removed.

### Found — minor, fixed in this pass

- **`buildDropViewStmt` and `buildDropIndexStmt` still hardcoded `'main'`**
  for unqualified names (and passed qualified spellings raw). After the
  implement stage moved `buildCreateViewStmt` to the current schema, this made
  the create/drop pairs asymmetric: under a non-main current schema,
  `create view v` landed in the current schema while `drop view v` looked in
  `main` (same for index create vs drop — `createIndex` resolves via current
  schema). `DROP TABLE` and the MV drop builder already used the current
  schema, so these two were the only builders left behind. Fixed both to the
  same `canonicalSchemaName` / current-schema pattern, and added two
  symmetry pins to schema-event-name-casing.spec.ts using the API-only
  `addSchema`/`setCurrentSchema` — the first in-suite coverage of the
  handoff's noted gap ("no test exercises unqualified CREATE VIEW while the
  current schema is non-main").

### Found — major, filed as new tickets

- **`backlog/module-facing-schema-name-canonicalization`** — module-facing
  call args (`vtabModule.createIndex`, `module.dropIndex`, `module.connect`)
  still receive raw statement spellings; deliberately out of scope per the
  original ticket ("do NOT chase store-side keying") but a real residual
  inconsistency with store-keying blast radius that needs a decided contract.
- **`backlog/current-schema-vs-schema-path-resolution-split`** — discovered
  while writing the symmetry tests: unqualified DDL lands objects in the
  *current* schema but unqualified read references resolve via `schema_path`
  (default `main`, `temp`) which ignores the current schema entirely, so
  `setCurrentSchema('aux'); create table t; select * from t` fails.
  Pre-existing split, but the create-view default change extends its surface
  to views; needs a design decision.

### Explicitly not pursued

- Assertion events firing `schema.name`: consistency-only per the ticket — no
  listener maps `assertion_*` events to a dependency type (statement.ts
  returns early on them), so no invalidation test is possible or needed.
- Rendering change (introspection/errors now show `main.t` for a `MAIN.t`
  create): full suite green; only out-of-repo consumers comparing raw casing
  would notice, and the project rules say not to worry about backwards
  compatibility yet.
- `canonicalSchemaName`'s non-throwing lowercase fallback for absent schemas:
  deliberate (plan-time builders and catalog import need unchanged error
  timing); existence is still enforced at the original lookup sites, verified
  by the green suite.

## Validation (final state, post review fixes)

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (re-run after the last
  test edit).
- `yarn test` (all workspaces) — green; quereus 5685 passing / 9 pending
  (the +2 over implement are the new symmetry pins; pending unchanged).
- schema-event-name-casing.spec.ts — 9 passing.
