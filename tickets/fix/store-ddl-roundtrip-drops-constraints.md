description: Store-backed tables silently lose ALL table constraints (UNIQUE / FOREIGN KEY / CHECK) across a cold reopen, because the store persists schema by serializing `generateTableDDL(tableSchema)` — which emits only columns + PRIMARY KEY + USING + tags and NO constraint clauses — then re-parses that DDL on `rehydrateCatalog`. In-session behavior is correct; durability is not. Surfaced by review of 10.25 (module ADD CONSTRAINT for UNIQUE/FK): the feature installs/enforces constraints correctly in a live session but they vanish on reconnect for the store backend. Pre-existing and broader than 10.25 — it also affects constraints declared at CREATE TABLE time and the already-shipped DROP/RENAME CONSTRAINT.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts                # generateTableDDL: emits columns/PK/USING/tags only — no UNIQUE/FK/CHECK (table- OR column-level)
  - packages/quereus-store/src/common/store-module.ts           # saveTableDDL (serializes via generateTableDDL) + rehydrateCatalog/loadAllDDL (re-parses on open)
  - packages/quereus/src/schema/manager.ts                      # extractUniqueConstraints/extractForeignKeys + check-constraint extraction (the inverse: DDL → schema)
  - packages/quereus/src/emit/ast-stringify.ts                  # the OTHER, full-fidelity DDL path (AST → SQL) used by declarative round-trip — reference for correct constraint emission
  - packages/quereus-store/test/ddl-generator.spec.ts           # store DDL round-trip tests (currently do not assert constraint survival)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts
----

# Store DDL round-trip drops table constraints (UNIQUE / FOREIGN KEY / CHECK)

## Problem

The store persists each table's schema as a single DDL string produced by
`generateTableDDL(tableSchema)` (`store-module.ts → saveTableDDL`), stored in the catalog
store, and re-materializes tables on open by re-parsing those strings
(`loadAllDDL` → `rehydrateCatalog`).

`generateTableDDL` only emits:

- column definitions (type, NULL/NOT NULL, single-column PRIMARY KEY, DEFAULT, column tags),
- a table-level PRIMARY KEY clause (empty `()` singleton or composite),
- a `USING` clause when the module differs from the session default,
- table-level `WITH TAGS`.

It emits **no** UNIQUE, FOREIGN KEY, or CHECK clause — neither table-level nor inline on a
column. A grep of `ddl-generator.ts` for `UNIQUE|CHECK|FOREIGN|REFERENCES|checkConstraints|
foreignKeys|uniqueConstraints` returns nothing. Therefore any such constraint — whether declared
at CREATE TABLE, added via `ALTER TABLE ADD CONSTRAINT` (10.25), or renamed — is silently dropped
from a store-backed table the next time the database is reopened.

This is a **data-integrity** issue: a user who relies on a persisted UNIQUE / FK / CHECK to guard
their data loses that guard on reconnect, with no error.

## Why it was not caught

- The memory backend keeps the live `TableSchema` and never round-trips through `generateTableDDL`,
  so memory is unaffected.
- The `declarative-equivalence` round-trip tests use the **AST→SQL** path (`emit/ast-stringify.ts`),
  which *does* emit constraints faithfully — a different code path from the store's **schema→DDL**
  `generateTableDDL`. So those green tests do not exercise the lossy path.
- 10.25's suites assert in-session enforcement only; they never close + reopen a store DB.

## Note for the downstream 10.3 ticket

`tickets/implement/10.3-alter-constraint-body-change-drop-add.md` currently states (≈line 45) that
`ddl-generator.ts` "already serializes constraints inside `generateTableDDL`." That premise is
false as of this writing and should be reconciled with this fix (10.3's persistence assumption
depends on it).

## Expected behavior

- `generateTableDDL` round-trips a table's full constraint set: table-level (and/or canonicalized)
  UNIQUE, FOREIGN KEY (with referenced table/columns, ON DELETE/UPDATE actions, deferrability), and
  CHECK constraints, including user names where present and the engine auto-names where not, such
  that re-parsing the emitted DDL reconstructs an equivalent `TableSchema`.
- A store-backed table created/altered with UNIQUE / FK / CHECK constraints retains and enforces
  them after `closeAll()` + reopen + `rehydrateCatalog`.
- UNIQUE constraints derived from a `CREATE UNIQUE INDEX` continue to round-trip via their index
  (not double-emitted as a table constraint), preserving idempotency with the declarative differ.

## Scope / decisions to make

- Whether to emit constraints inline on columns vs. as table-level clauses (table-level is simpler
  and matches how the schema stores them; column-level single-column UNIQUE/CHECK is cosmetic).
- Reuse the canonical emission already implemented in `emit/ast-stringify.ts` rather than writing a
  second emitter, to stay DRY and avoid format drift (the two DDL paths should not diverge).
- Add store reopen coverage (a `closeAll` + fresh module + `rehydrateCatalog` assertion that a
  UNIQUE/FK/CHECK still enforces) to `packages/quereus-store/test`, plus a `generateTableDDL`
  unit round-trip for each constraint class.
