description: CREATE-time physical store-name collision detection in StoreModule — rejects (StatusCode.ERROR, sited) when a new table's data store / new index's index store / rename target maps to a physical store name already occupied by an existing data or index store, closing the silent shared-storage corruption (index `archive` on `t` vs sibling table `t_idx_archive`). Reviewed and accepted.
files:
  - packages/quereus-store/src/common/store-module.ts        # collectOccupiedStoreNames + assertStoreNameFree; guards in create / createIndex / renameTable
  - packages/quereus-store/src/common/key-builder.ts         # buildDataStoreName / buildIndexStoreName (unchanged; imported by store-module)
  - packages/quereus-store/test/store-name-collision.spec.ts # fast-lane spec (in-memory provider), 8 cases
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # +2 persistent reject cases
  - tickets/backlog/store-rename-produces-colliding-index-store-name.md # parks the rename-produces-colliding-index-store variant (still unguarded)
----

# Complete: CREATE-time physical store-name collision detection

## What shipped

Physical store names are built by concatenation with an `_idx_` delimiter that is
itself a legal identifier substring, so two distinct logical objects can collapse to
one physical store and silently corrupt each other (index `archive` on `t` and a
sibling table `t_idx_archive` both → `main.t_idx_archive`). `StoreModule` now rejects
the colliding CREATE/RENAME up front via two private helpers in `store-module.ts`:

- `collectOccupiedStoreNames(db, schemaName)` — physical-store occupancy map (name →
  human description), built as the union of `this.tables` (every store table touched
  this session, robust to the isolation wrapper) and the target schema's
  `getAllTables()` filtered to `vtabModule === this && !isView` (store-backed tables
  not yet lazily connected). Names embed the schema prefix, so cross-schema entries
  cannot collide; memory-backed siblings and views own no store and are excluded.
- `assertStoreNameFree(db, schemaName, candidate, desc)` — throws `StatusCode.ERROR`
  with a sited, actionable message when `candidate` is occupied.

Wired in **before** the storage side-effect at each entry point (load-bearing —
`getStore`/`getIndexStore`/relocation open/create eagerly):
- `create` — candidate `buildDataStoreName(schema, table)` (data-vs-index).
- `createIndex` — candidate `buildIndexStoreName(schema, table, index)`
  (index-vs-sibling-data and index-vs-index).
- `renameTable` — candidate `buildDataStoreName(schema, newName)`, after the existing
  `tables.has(newKey)` check.

The implementer dropped the plan's floated self-exclusion param: without it, renaming
`t` into `t`'s own index-store name is cleanly **rejected** before relocation rather
than sent into the provider's relocation path (which transiently aliases and loses
data). I reviewed and **agree** — rejecting the self-rename is strictly safer than the
parked-hazard data loss, and matches the plan's literal pseudocode.

## Review findings

### What was checked

- **Implement diff read first, fresh eyes** (`git show e41ec8d1`), before the handoff.
- **Correctness of the occupancy model** — verified every referenced engine API
  exists and behaves as assumed: `SchemaManager.getSchemaOrFail` (lowercases),
  `Schema.getAllTables`, `TableSchema.vtabModule` (optional; `undefined` for logical
  tables → excluded), `TableSchema.isView`. Confirmed candidate and occupancy names
  are **both lowercased** (key-builder `.toLowerCase()`), so matching is consistent /
  case-insensitive.
- **Stale-occupancy / false-positive paths** — `destroy` deletes the dropped table
  from `this.tables` (line ~445) and `dropIndex` updates the cached schema to remove
  the dropped index (`table.updateSchema`, line ~594) **before** teardown, so
  DROP-then-recreate of a colliding name is correctly allowed (no phantom entries).
- **Guard coverage of store-creating DDL** — the three guarded entry points
  (`create`, `createIndex`, `renameTable`) are the only paths that materialize a new
  physical store name; DROP / ADD COLUMN / rehydrate-on-reopen do not create new
  names, so no additional guard is required.
- **Negative-control semantics** — memory-backed sibling excluded via
  `vtabModule !== this`; view excluded via `!isView`; an MV *backing* table
  (`vtabModule === this`, `isView === false`) is correctly **included** (it owns a
  real store) — no false exclusion.
- **Reserved names** — user tables always carry a `{schema}.` prefix, so they can
  never collide with the prefix-less `__catalog__` / `__stats__` stores (by
  construction).
- **Type safety / error handling / DRY** — no `any`; `s.indexes ?? []` guards
  undefined; `QuereusError(StatusCode.ERROR)` is preserved + sited by the
  `SchemaManager` wrapper; the three call sites share `assertStoreNameFree` with no
  duplication. `collectOccupiedStoreNames` rebuilds per DDL call only (DDL is rare —
  no perf concern).
- **Lint** — no `packages/quereus` files changed (only that package has a lint
  script); none required. Confirmed via `git show --stat -- packages/quereus/*`
  (empty).

### Tests run (all green)

- `store-name-collision.spec.ts` — **8/8** passing (re-ran, `--reporter spec`).
- Full `@quereus/store` suite — **393 passing** (incl. `isolated-store.spec.ts`; the
  "Failed to rehydrate" log lines are intentional negative-test output, not failures).
- `@quereus/plugin-leveldb` suite — **16 passing** (incl. the +2 persistent reject
  cases asserting byte-identical directory snapshots before/after a rejected op).
- `yarn workspace @quereus/store typecheck` — clean.
- No pre-existing failures encountered; `.pre-existing-error.md` not written.

### Findings

- **MAJOR (filed, NOT fixed here): rename produces a colliding *index* store name.**
  `renameTable` guards only the new *data* store name, not the new *index* store names
  the rename re-derives. Concrete silent-corruption repro (table `t` w/ index
  `archive`; sibling table `foo_idx_archive`; `rename t → foo` relocates
  `main.t_idx_archive → main.foo_idx_archive`, clobbering the sibling). This is a
  **real, silent data-loss path**, not a future nicety — the create-time variant of
  the *same* contrivance was deemed worth fixing in this very ticket. It is fully
  specified (reproduction + required behavior + acceptance) in
  `tickets/backlog/store-rename-produces-colliding-index-store-name.md`. I left it in
  `backlog/` to respect the plan's deliberate CREATE-only scoping, but flag it here as
  **high-priority** — it warrants promotion to active work soon, and the fix needs the
  self-exclusion the create-time path deliberately omitted (the backlog ticket calls
  this out).

- **MINOR (noted, not actionable here): commit hygiene.** The implement commit
  (`e41ec8d1`) bundles unrelated work — `docs/materialized-views.md` (MV maintenance
  prose) and several new `tickets/implement/*-mv-*.md` decomposition tickets — swept in
  from the working tree. None touch the shipped code path; the store/LevelDB suites and
  typecheck are green regardless. Not fixable from the review stage (the runner owns
  commits and the MV work is legitimate separate work); recorded for traceability.

- **MINOR (noted, no change): in-memory harness `renameTableStores`.** The handoff
  called it "now dead" for these tests. It is **not** dead globally — it is reused by
  `alter-table.spec.ts:61` and exercised by the LevelDB suite's successful
  `rename t → t2` case. Retaining it is correct; no action.

### Disposition

No minor findings required inline code changes — the shipped implementation is
correct, well-decomposed, typed, and tested at every angle checked (happy path, both
collision orderings, index-vs-index, three negative controls, rename collisions, plus
persistent on-disk no-stray-directory assertions). The one major finding is a
pre-scoped, fully-specified residual hazard tracked in backlog (flagged above as
deserving prompt promotion). Accepted.
