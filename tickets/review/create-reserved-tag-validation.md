description: Review create-time reserved-`quereus.*`-tag validation on the direct CREATE TABLE / CREATE INDEX paths (mirrors the ALTER SET TAGS arm and the declarative differ), plus the registry fix that closing the hole required (registering the previously-unlisted `quereus.expose_implicit_index` behavioral tag).
files:
  - packages/quereus/src/planner/building/ddl.ts                 # NEW create-time validation (table/column/constraint + index surfaces)
  - packages/quereus/src/schema/reserved-tags.ts                 # registered quereus.expose_implicit_index + added 'boolean' value schema
  - packages/quereus/src/planner/building/alter-table.ts         # the setTags arm this mirrors (reference)
  - packages/quereus/src/schema/reserved-tags-policy.ts          # raiseReservedTagDiagnostics (reference)
  - packages/quereus/src/schema/schema-differ.ts                 # the differ's per-surface validation this mirrors (reference)
  - packages/quereus/src/schema/catalog.ts                       # the sole consumer of quereus.expose_implicit_index (reference)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic        # NEW Phase 23: create-time reserved-tag cases
  - packages/quereus/test/schema/reserved-tags.spec.ts           # NEW expose_implicit_index unit tests; count 16→17
  - packages/quereus/test/lens-advertisement.spec.ts             # UPDATED malformed-decomp test → now create-time rejection
  - docs/schema.md                                               # documented the direct-CREATE validation path
----

# Review: create-time reserved-tag validation on direct CREATE TABLE / CREATE INDEX

## What shipped

The direct `CREATE TABLE … WITH TAGS` and `CREATE INDEX … WITH TAGS` paths now
validate reserved `quereus.*` tags **at plan-build**, exactly as
`ALTER … SET TAGS` (`alter-table.ts` `setTags` arm) and the declarative differ
(`schema-differ.ts`) already do. Before this, a misspelled or mis-sited reserved
key on the most common authoring path was silently stored.

Implementation — `planner/building/ddl.ts`:
- `buildCreateTableStmt` calls `raiseCreateTableTagDiagnostics(stmt)` (new) which
  accumulates diagnostics across the **three surfaces the differ checks**:
  `stmt.tags` → `physical-table`, each `stmt.columns[].tags` → `physical-column`,
  each `stmt.constraints[].tags` → `physical-constraint`, then raises once.
- `buildCreateIndexStmt` validates `stmt.tags` → `physical-index`.
- A shared `raiseStmtTagDiagnostics(diagnostics, stmt)` threads `stmt.loc.start`
  into `raiseReservedTagDiagnostics` for a sited error, with a no-op warning sink
  (warnings never block — matches the ALTER arm).

## ⚠️ Scope expansion the reviewer MUST scrutinize: the registry fix

Closing the hole surfaced a **pre-existing registry gap**, NOT anticipated by the
plan ticket. `quereus.expose_implicit_index` is a real *behavioral* reserved tag
— read by `catalog.ts` (`implicitCoveringIndexExposure`, gating whether a UNIQUE
constraint's implicit covering index is catalog-visible) and treated as
"real schema state … ARE compared" by `schema-differ.ts` (§ `RENAME_HINT_KEYS`,
line ~1124) — but it was **never added to `RESERVED_TAG_SPECS`**. Two existing
**direct-create** tests use it:
- `covering-structure.spec.ts:894` — `… constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true)`
- `schema-manager.spec.ts:333` — `… constraint uq_email unique (email) with tags ("quereus.expose_implicit_index" = true)`

Without registering it, my new validation would reject both (the differ and
`ALTER … ALTER CONSTRAINT … SET TAGS` would *already* reject it too — that path
was simply never exercised, a latent bug). So I **registered it**:
- New spec entry: `key: 'quereus.expose_implicit_index'`, `sites: ['physical-constraint']`,
  `valueSchema: 'boolean'`.
- Added a new **`'boolean'`** `TagValueSchema` (the first non-text value schema)
  — the tag's value is a SQL boolean and `catalog.ts` reads it via a strict
  `=== true`, so only a real boolean is meaningful.
- Updated the `unknownReservedTag` suggestion string to list the new key.

**Decisions to second-guess:**
1. **Is `physical-constraint`-only the right site?** I argued yes: it is a
   UNIQUE-constraint-only physical concept (a logical schema has no physical
   covering index), and `physical-constraint` is the shared position of the
   direct-create named constraint, the `ALTER … ALTER CONSTRAINT … SET TAGS`
   target, and the differ's declared constraint. Not registered at
   `logical-constraint` (meaningless there). Confirm this is the intended reach.
2. **Is registering it in *this* ticket acceptable, or should it have been a
   separate fix ticket?** It is strictly necessary to avoid a regression and is
   purely additive, so I folded it in and documented it loudly here. If the
   reviewer prefers it isolated, the registry diff is self-contained
   (`reserved-tags.ts` + its unit test) and could be cherry-picked.
3. **The `'boolean'` value schema** is new machinery in a shared module. It is a
   3-line `case` in `validateTagValue` and a union member — verify nothing else
   switches exhaustively over `TagValueSchema` (I found only `validateTagValue`).

## How to validate (use cases / what the tests assert)

`50-metadata-tags.sqllogic` **Phase 23** (new) covers, end-to-end via `db.exec`:
- **Rejections** (each its own statement; error fires at `db.prepare` / plan-build):
  - table-level bogus key (`"quereus.bogus"`) → `-- error: reserved tag`
  - column-level bogus key → `-- error: reserved tag`
  - table-level **named-constraint** bogus key
    (`constraint c check (x>0) with tags ("quereus.bogus" = 1)`) → `-- error: reserved tag`
  - mis-sited valid key (`"quereus.lens.access.id"`, legal only at `logical-table`)
    → `-- error: not allowed`
  - `CREATE INDEX … with tags ("quereus.bogus" = 1)` → `-- error: reserved tag`
  - **multiple offending tags** (bad table + bad column in one stmt) → first
    (table-level) error raised — deterministic accumulation order
  - **`IF NOT EXISTS`** on an existing table still rejects at build time (the
    create would be runtime-skipped, but validation precedes the existence check)
- **Acceptances + round-trip** (valid `quereus.id` hint, legal at every physical site):
  - on a table → `schema().tags`; on a column → `table_info().tags`; on a
    table-level named UNIQUE constraint → `unique_constraint_info().tags`; on an
    index → `schema().tags` and `index_info().tags`. (Dotted reserved keys are
    read back with `json_extract(tags, '$."quereus.id"')` — quoted-key path.)
  - free-form `with tags (display_name='x', audit=true)` still creates cleanly
    (guards against over-rejection).

`reserved-tags.spec.ts` (new describe `quereus.expose_implicit_index`): boolean
accept (`true`/`false`), non-boolean reject, `tag-not-allowed-here` at
table/column/index sites, typo → `unknown-reserved-tag`; plus the registry-count
assertion bumped 16 → 17.

`lens-advertisement.spec.ts` (**behavior change**): the malformed-`decomp.role`
test previously asserted the error surfaced at `apply schema` (through the
advertisement builder). Those decomp facts live on a table-level `WITH TAGS`
(`physical-table` site), so create-time validation now catches the bad enum value
**at `CREATE TABLE`** — the builder uses the identical `validateReservedTags`
check, so create-time is the gate now. Test updated to assert create-time
rejection. **Note for reviewer:** the advertisement builder's *structural*
resolution errors (missing facet / inconsistent logical mapping — a different
error class than shape/site/value) are unaffected and still surface at apply;
confirm that class still has coverage elsewhere in that file.

## Validation run (all green)
- `yarn workspace @quereus/quereus run build` → clean (tsc, exit 0)
- `yarn workspace @quereus/quereus test` → **4853 passing, 0 failing, 9 pending**
- `yarn workspace @quereus/quereus run lint` → clean (exit 0)

## Known gaps / honest flags (treat my tests as a floor)
- **`yarn test:store` (LevelDB store path) was NOT run.** Create-time validation
  lives in the **module-agnostic planner** (`buildCreateTableStmt`), so the store
  path is unaffected *by construction* — but Phase 23's round-trips
  (`schema()` / `table_info()` / `index_info()` / `unique_constraint_info()`)
  were only exercised against the memory module. The store re-run is slow /
  out-of-band; left to CI. Low risk, but unverified.
- **Out of scope (intentional, see plan ticket — do not "fix" in review):**
  - `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` — validated *lazily*
    at mutation time by design (`93.4-view-mutation.sqllogic`); eager validation
    there would break those tests. Parked in backlog
    `reserved-tag-validation-inline-constraint-and-view-eager`.
  - Catalog import / load path (`SchemaManager.buildTableSchemaFromAST` via
    `importTable` / `importCatalog`) — authoring-time gate only; failing a load
    could brick an openable DB.
  - **Inline *named* column-constraint tags** (`ColumnDef.constraints[].tags`) —
    excluded to stay symmetric with the differ (which also skips them). Same
    backlog ticket tracks closing this in both places together.
- The `expose_implicit_index` registration means a **typo of that key** now fails
  loudly on create/alter/differ where before it was silently ignored everywhere
  — intended, but it is a new hard-error surface worth a sanity check.
