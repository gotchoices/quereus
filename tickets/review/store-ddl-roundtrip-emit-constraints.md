description: Review the fix that makes generateTableDDL emit table-level CHECK / UNIQUE / FOREIGN KEY constraints so store-backed tables retain and keep enforcing them across closeAll() + reopen + rehydrateCatalog. The fix routes the store's schema→DDL path through the existing AST emitter (tableConstraintsToString) via a now-full-fidelity schema→AST lift, so the persistence DDL and the declarative AST→SQL DDL cannot drift. Excludes CREATE-UNIQUE-INDEX-derived UNIQUE constraints (round-trip via their index).
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts                    # CHANGED: full-fidelity lift + emitTableConstraints() + generateTableDDL emission
  - packages/quereus/src/emit/ast-stringify.ts                      # UNCHANGED: tableConstraintsToString reused (the single emitter)
  - packages/quereus/test/schema/catalog.spec.ts                    # NEW TEST: parse-back + drop/recreate constraint roundtrip
  - packages/quereus-store/test/ddl-generator.spec.ts               # NEW TESTS: per-class emit asserts + derivedFromIndex negative
  - packages/quereus-store/test/rehydrate-catalog.spec.ts           # NEW TESTS: UNIQUE/CHECK/FK reopen-survival enforcement
  - packages/quereus-store/src/common/store-module.ts               # UNCHANGED: saveTableDDL → generateTableDDL → rehydrateCatalog (the round-trip)
----

# Review: store DDL round-trip now emits table constraints

## What changed (and why it's correct)

`generateTableDDL` (the **schema→DDL** persistence emitter, distinct from the AST
stringifier) previously serialized only columns + PK + USING + WITH TAGS, silently
dropping every table-level UNIQUE / FOREIGN KEY / CHECK. Because `quereus-store`
persists that string and re-parses it on open (`saveTableDDL` → `loadAllDDL` →
`rehydrateCatalog` → `importCatalog`), all table constraints **vanished on
reconnect** — a data-integrity regression for the store backend (memory is
unaffected; it keeps the live `TableSchema` and never round-trips).

Two focused edits in `ddl-generator.ts`:

1. **`schemaConstraintToTableConstraint` made full-fidelity** — now preserves
   `name` + `tags` on the lifted `AST.TableConstraint`, and for FK reconstructs the
   deferrability clause (`deferred:true → deferrable initially deferred`). This is
   the **same single lift** already used by `constraintToCanonicalDDL`; the
   canonical consumer strips `name`/`tags`/deferrable downstream
   (`constraintBodyToCanonicalString` does `{ ...tc, name: undefined, tags: undefined }`,
   `canonicalForeignKeyClause` drops deferrable), so **canonical output is byte-unchanged**
   — verified by the green `catalog.spec` "namedConstraints definition
   canonicalization" suite.

2. **`generateTableDDL` emits constraints** — a new `emitTableConstraints()` helper
   appends CHECK → UNIQUE(non-`derivedFromIndex`) → FK (deterministic order) inside
   the column-def paren list, rendered via the reused `tableConstraintsToString`.
   `derivedFromIndex` UNIQUEs are skipped (they round-trip via their index;
   emitting them would churn a spurious DROP CONSTRAINT in the declarative differ).

The catalog differ is unaffected: it diffs constraints via the separate
`namedConstraints` channel, not the `ddl` field. Constraint emission is
session-default-independent, so the no-db (persistence) and db-context (catalog
readability) branches agree byte-for-byte.

## Use cases to validate

- **Primary (the bug):** a store-backed table created with a UNIQUE / CHECK / FK,
  then `closeAll()` + new `Database` + `rehydrateCatalog`, **still enforces** that
  constraint. Covered by 3 new `rehydrate-catalog.spec.ts` cases (in-memory KV
  provider; the persistence/rehydration code path is provider-agnostic):
  - UNIQUE: duplicate insert (against the *persisted* row) fails CONSTRAINT after reopen.
  - CHECK: predicate-violating insert fails CONSTRAINT after reopen.
  - FOREIGN KEY: orphan child insert fails (with `foreign_keys` pragma on); valid one succeeds.
  - All three also assert `result.errors` is empty — the re-parsed constraint DDL parses cleanly.
- **Generator unit (store):** `generateTableDDL` output contains `unique (email)`,
  `check ... (qty > 0)`, `foreign key (pref) references parent(pid)` + the
  `constraint <name>` prefixes; and a `derivedFromIndex` UNIQUE is **not** emitted
  (with a sanity assert that the derived constraint really exists on the schema).
- **Parse-back (quereus):** `catalog.spec.ts` builds a table with one of each named
  class plus an unnamed column CHECK (auto `_check_<col>`), then (a) `parse()`s the
  emitted DDL and structurally checks the constraint set, and (b) full drop+recreate
  and asserts the rebuilt schema's constraint arrays + canonical `namedConstraints`
  match the original.
- **Idempotency guards (must stay green — they do):** `declarative-equivalence`
  "UNNAMED column CHECK does not churn" and "CREATE UNIQUE INDEX-derived constraint
  does not churn a DROP CONSTRAINT".

## Validation run (all green)

- `yarn workspace @quereus/quereus test` — **4849 passing**, 9 pending, 0 failing.
- `yarn workspace @quereus/store test` — **292 passing**, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus build` — clean.

## Known gaps / things for the reviewer to scrutinize (treat tests as a floor)

- **Cross-schema FK fidelity (pre-existing limitation, documented in code):**
  `AST.ForeignKeyClause.table` is unqualified and cannot encode
  `ForeignKeyConstraintSchema.referencedSchema`. A FK referencing a parent in a
  *different* schema loses that qualification on persistence round-trip
  (re-parse defaults the reference to the table's own schema). Same-schema FKs
  round-trip exactly. Scope was deliberately not expanded (per ticket); cross-schema
  FKs are already excluded from catalog drop-ordering. **No test exercises a
  cross-schema FK round-trip** — a reviewer may want to confirm the behavior is
  merely lossy (not crashing) and decide whether a follow-up ticket is warranted.
- **Verbose CHECK `on insert, update` form:** a default-mask CHECK (column- or
  table-level) persists as `check on insert, update (...)` rather than bare `check
  (...)`. This is intentional — canonicalization is only for the differ's body
  compare, not for persistence — and re-parses correctly (verified). It is verbose
  but harmless; flag if you'd prefer the persistence emitter to also collapse the
  default mask.
- **FK actions always explicit:** persisted FK DDL emits `on delete restrict on
  update restrict` (the schema always stores the resolved action). Re-parses to the
  same; verbose but correct.
- **FK deferrability is lossy by schema design:** the schema collapses all
  deferrability variants to one `deferred` boolean, so only `deferrable initially
  deferred` is reconstructable; `deferrable initially immediate` / bare `deferrable`
  both reconstruct as no clause. Pre-existing model limitation, not a regression.
- **Pre-fix persisted catalogs (migration nuance, out of scope):** tables whose DDL
  was persisted *before* this fix have a constraint-free string on disk; reopening
  rehydrates them without constraints until they are re-created. The fix guarantees
  constraints for tables created/persisted *after* it. Per AGENTS ("don't worry
  about backwards compatibility yet") no migration was attempted — note it in case a
  reviewer disagrees on scope.
- **LevelDB store path not run:** `yarn test:store` / `yarn test:full` (quereus
  logic tests against the LevelDB store module) were **not** run — they are
  release/store-diagnosis runs per AGENTS, and the DDL persistence/rehydration code
  is provider-agnostic (fully exercised by the InMemoryKVStore provider here). A
  reviewer/CI could run `yarn test:store` for belt-and-suspenders LevelDB coverage.

## Downstream note (already reconciled)

The 10.3 ticket's old "ddl-generator.ts already serializes constraints" premise is
now actually true. That ticket is already in `tickets/complete/` (not pending), so
no edit was made — its assumption now holds post-fix.
