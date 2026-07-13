----
description: Schema changes used to silently escape the surrounding transaction. This adds an official way for storage backends to declare how their DDL behaves in a transaction, plus an opt-in strict mode that refuses in-transaction schema changes on backends that can't roll them back.
files:
  - packages/quereus/src/vtab/capabilities.ts                     # DdlTransactionality type + ddlTransactionality flag (live)
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # NEW: resolveDdlTransactionality, isExplicitTransactionOpen, assertDdlTransactionPolicy
  - packages/quereus/src/core/database.ts                         # registers ddl_transaction_policy option (~after default_column_nullability)
  - packages/quereus/src/runtime/emit/create-index.ts            # gate
  - packages/quereus/src/runtime/emit/drop-index.ts              # gate (scans schema for owning table)
  - packages/quereus/src/runtime/emit/create-table.ts           # gate (module by using/default name)
  - packages/quereus/src/runtime/emit/drop-table.ts             # gate
  - packages/quereus/src/runtime/emit/alter-table.ts            # gate at run() top (covers all ALTER arms)
  - packages/quereus/src/runtime/emit/add-constraint.ts         # gate (ADD CONSTRAINT is a separate node)
  - packages/quereus/src/runtime/emit/materialized-view.ts      # NOTE only — MV verbs deliberately NOT gated (see debt ticket)
  - packages/quereus/src/vtab/memory/module.ts                  # declares 'non-transactional'
  - packages/quereus-store/src/common/store-module.ts           # declares 'auto-commit'
  - packages/quereus-isolation/src/isolation-module.ts          # forwards underlying tier via spread (comment only)
  - packages/quereus/test/capabilities.spec.ts                  # declared value + helper resolution + gate unit tests
  - packages/quereus-store/test/isolated-store.spec.ts          # store 'auto-commit' + isolation-forwarding assertions
  - packages/quereus/test/logic/10.1.4-ddl-transaction-policy.sqllogic  # NEW end-to-end (memory + store)
  - docs/module-authoring.md, docs/memory-table.md, docs/store.md, docs/architecture.md
----

# Review handoff: DDL transaction capability — declared tiers + strict gate

## What was built

A storage module now declares how its DDL behaves inside a transaction via a new
`ModuleCapabilities.ddlTransactionality` flag with three tiers (`DdlTransactionality`
in `capabilities.ts`):

- `transactional` — schema change is part of the transaction (buffered, visible, atomic
  at commit, discarded on rollback). **No built-in module reaches this today.**
- `non-transactional` — schema change escapes the transaction (survives rollback) but
  buffered DML still rolls back. **Memory declares this.**
- `auto-commit` — certain DDL commits the module's whole buffered transaction (schema
  change AND buffered writes) at DDL time; a later rollback undoes nothing. **Store
  declares this** (worst-case summary — much of the store's DDL is only
  non-transactional, but the row-rewriting arms force-commit).

Default when the flag is absent (or `getCapabilities` is missing): `non-transactional`.
A module must *explicitly* claim `transactional`.

A new `ddl_transaction_policy` option/pragma gates enforcement:
- `permissive` (**default**) — unchanged behavior; the flag is never consulted.
- `strict` — a statement dispatching to a module DDL surface (CREATE/DROP TABLE/INDEX,
  every ALTER TABLE arm including ADD CONSTRAINT) while an **explicit** transaction is
  open, on a module whose tier is not `transactional`, raises a sited `QuereusError`
  *before* any dispatch or catalog mutation. The transaction (and savepoints) stay open
  and usable.

The gate is one shared helper, `assertDdlTransactionPolicy(db, module, moduleName, label)`,
called at the top of each module-dispatching DDL emitter, before `_ensureTransaction()`.

## The one subtle design decision (please scrutinize)

The ticket said "key off the transaction manager's autocommit state." The naive reading —
gate when `!db.getAutocommit()` — is **wrong** for nested DDL. In autocommit mode a DDL
statement lazily starts an *implicit* transaction (`_ensureTransaction()`), so nested DDL a
statement issues (the ALTER-rebuild `_execWithinTransaction` path, and `apply schema`'s
per-statement DDL, both route through the gated emitters) would see `getAutocommit() ===
false` and be wrongly refused under strict.

So `isExplicitTransactionOpen(db)` is `!db.getAutocommit() && !db._isImplicitTransaction()`
— i.e. "an explicit `BEGIN` is open", which is what the ticket actually intends. This makes
the ticket's own edge cases fall out correctly:
- autocommit `apply schema` under strict → its implicit-tx nested DDL is NOT gated;
- `begin; apply schema …` under strict → the first module-dispatching nested DDL IS refused.

If the reviewer disagrees with this predicate, that is the load-bearing line to challenge
(`ddl-transaction-policy.ts` `isExplicitTransactionOpen`).

## Use cases to validate

**Declared values (unit):** `test/capabilities.spec.ts` — memory `'non-transactional'`,
default resolution for `undefined` / flagless-stub / getCapabilities-without-the-flag all
`'non-transactional'`; the gate throws under strict+explicit, no-ops under permissive and
under strict+autocommit. `packages/quereus-store/test/isolated-store.spec.ts` — store
`'auto-commit'`, isolation-wrapped store forwards `'auto-commit'` (never upgrades).

**End-to-end (memory AND store):** `test/logic/10.1.4-ddl-transaction-policy.sqllogic`:
- permissive default: DDL inside a transaction still works;
- strict refuses `create index` / `alter table add constraint` / `drop index` /
  `create table` inside `begin`; allows the same statements in autocommit;
- transaction survives a refusal (insert-again-then-commit → both rows present, no index);
- a refusal inside a savepoint leaves the savepoint usable (rollback-to then commit).

Run: `yarn test` (memory) and `yarn test:store` (runs the file against the isolation-wrapped
LevelDB store — strict refuses there too, since store is not `transactional`).

## Validation performed

- `yarn build` — clean.
- `yarn test` — all workspaces green (quereus 6977 passing; store/isolation vitest green).
- `yarn lint` — clean (quereus eslint + `tsc -p tsconfig.test.json`, which type-checks the
  new spec call sites).
- `yarn test:store` spot-check on `10.1.4-…` — passing (memory + store both verified via
  filtered mocha runs).

## Known gaps / where to push (treat my tests as a floor)

1. **Materialized-view verbs are NOT gated.** `create/drop/refresh materialized view` are
   separate module-dispatching emitters (`emitCreateMaterializedView`, etc.) that create/
   drop a backing memory/store table — a schema change that escapes rollback exactly like
   `CREATE TABLE`. The ticket enumerated the plain-DDL emitters and did not list MVs, so I
   left them out, added a greppable `NOTE:` at `emitCreateMaterializedView`, and filed
   `backlog/debt-strict-ddl-gate-materialized-views.md`. This is a real hole in strict's
   coverage — decide whether it belongs in this ticket or the debt follow-up. (`refresh`
   is arguably DML, not DDL — that judgment is in the debt ticket.)

2. **The gate covers ALL ALTER arms, including catalog-only ones** (SET/DROP TAGS,
   SET/DROP MAINTAINED) that do NOT dispatch to the module. Rationale: those still mutate
   the engine catalog, which is transient (not transaction-scoped), so the change escapes
   rollback and strict *should* refuse it. This is intentional but broader than the literal
   phrase "module-dispatching" — confirm it's the behavior you want, or narrow the ALTER
   gate to the data-affecting arms.

3. **The nested-DDL-under-strict path is not directly exercised by a test.** No strict test
   triggers the store's `rebuildViaShadowTable` (`_execWithinTransaction`) path — memory's
   ALTER PRIMARY KEY rebuild goes straight through `module.create` (no emit gate) and the
   store re-keys in place. Confidence that strict does not wrongly refuse autocommit nested
   DDL rests on (a) the whole suite passing under permissive, (b) the `isExplicitTransactionOpen`
   analysis above, and (c) the `apply schema` routing (`_execWithinTransaction` →
   emit → gate). A targeted test — e.g. autocommit `apply schema` under strict, or a
   non-memory/non-store module whose ALTER PRIMARY KEY falls to the shadow-rebuild — would
   harden it. Worth a skeptical read of whether any autocommit nested-DDL path can reach a
   gate while `_isImplicitTransaction()` is somehow false.

4. **`drop-index` resolves the owning table by scanning the schema** (duplicating the small
   scan `SchemaManager.dropIndex` does), because `DropIndexNode` carries only the index
   name. If the index has no owner the gate is skipped and `dropIndex` handles IF EXISTS /
   not-found as before. Low risk, but a shared `schemaManager.findIndexOwner(...)` helper
   used by both sites would be cleaner (not done to keep the change small).

5. **Isolation forwarding is via the existing `...underlyingCaps` spread** — no functional
   code change there beyond a clarifying comment. Verified by the store test. If a future
   underlying ever declares `transactional`, the wrapper would forward it verbatim; the
   comment explains why the overlay asymmetry makes that the honest (not upgraded) choice,
   and raising native backends to `transactional` is the separate backlog ticket
   `feat-transactional-ddl-native-backends`.
