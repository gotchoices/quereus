description: Per-DB `default_collation` session option — sets the declared collation an omitted-`COLLATE` column resolves to at CREATE time. Defaults to `BINARY` (no behavior change). Text types resolve to the default; non-text (INTEGER/REAL/BLOB) and empty-collation types (JSON/temporal) fall back to BINARY. Explicit `COLLATE` always wins. Catalog stores concrete collations; persisted DDL always emits explicit non-BINARY `COLLATE`. The declarative differ resolves the declared side via the same create-time rule (threading the live option) for create/apply parity + idempotency.
files: packages/quereus/src/schema/table.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/index.ts, packages/quereus/test/logic/43.1-default-collation.sqllogic, packages/quereus/test/schema/catalog.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/core-api-features.spec.ts, docs/sql.md, docs/schema.md
----

## What shipped

A per-DB `default_collation` option that sets the collation an omitted-`COLLATE` column resolves to
at CREATE time. `BINARY` default ⇒ zero out-of-box behavior change. A single resolution helper
`resolveDefaultCollation(logicalType, defaultCollation)` (in `schema/table.ts`, exported from
`index.ts`) drives BOTH the CREATE path (`columnDefToSchema` → `buildColumnSchemas` →
`buildTableSchemaFromAST` / `buildLogicalTableSchema`) and the declarative differ
(`extractDeclaredCollation`, plus the index-canonical-body path), so create and apply cannot drift.
The catalog always stores the concrete resolved collation; persisted DDL always carries an explicit
non-`BINARY` `COLLATE` (the existing `ddl-generator` already elides only a *literal* `BINARY`). The
`importTable` rehydrate path passes fixed `'BINARY'` so reopen relies solely on the explicit
persisted `COLLATE`. The option validates at set time (`onChange` rolls back an unknown collation).

See the source review ticket (commit `451b4265`) for the full design rationale, including the
deliberate deviation from the plan prose (the differ resolves its declared side via the *live*
default rather than fixed-BINARY — required for create/apply parity AND re-apply idempotency).

## Review findings

**Process:** Read the implement diff (`git show 451b4265`) with fresh eyes before the handoff, then
read the surrounding source (`table.ts` resolve helpers + explicit-COLLATE path, `ddl-generator.ts`
non-elision, the full differ threading for both the column-attribute AND index paths,
`manager.ts` call sites, `database.ts` option). Verified two of the implementer's flagged "attention"
items empirically with throwaway tests, ran build + lint + the full memory suite.

### Correctness — one MAJOR bug found (filed), one flagged gap proven OK

- **MAJOR (filed → `tickets/fix/alter-add-column-default-collation.md`): `apply schema` is
  non-idempotent under a non-BINARY default when it ADDs a column.** The differ now resolves the
  *declared* side of an omitted `COLLATE` via the live default (correct, for parity), but
  `ALTER TABLE ADD COLUMN` execution still creates the column as `BINARY`. Verified by repro: an
  `apply` that adds a text column under `default_collation='nocase'` lands the column as `BINARY`,
  then the next re-diff emits a spurious `ALTER COLUMN … SET COLLATE NOCASE` — non-idempotent. This
  is a regression introduced by this ticket's differ change (pre-ticket the declared side also
  resolved to BINARY, so it matched). It was *partially* anticipated by the pre-existing backlog
  ticket (framed only as a CREATE-vs-ADD "consistency footgun"); I reframed that ticket as a
  confirmed idempotency bug, added the repro, moved it `backlog/ → fix/`, and documented two fix
  approaches (A: differ emits explicit `COLLATE` on added columns — narrow, restores idempotency and
  upholds this ticket's "emitted DDL always carries explicit non-BINARY COLLATE" invariant; B: ADD/
  RENAME COLUMN honor the default at the execution layer — broader, memory+store+isolation).

- **Flagged gap PROVEN OK (minor — fixed inline): differ index-path idempotency.** The implementer
  noted no dedicated test for the index-path threading. Verified empirically that an
  inherited-collation index under `default_collation='nocase'` re-diffs to empty (no drop+recreate,
  no alter) — the threading is correct. Added a permanent regression test
  (`declarative-equivalence.spec.ts` → "an inherited-collation index is idempotent under nocase").

### Other angles checked (no change needed)

- **DRY / single source of truth:** `resolveDefaultCollation` is the sole resolver and is shared by
  CREATE and the differ — confirmed the explicit `supportedCollations?.includes()` gate (NOT
  `validateCollationForType`'s throw) is the right call: INTEGER/REAL/BLOB have
  `supportedCollations === undefined` and would otherwise be silently *accepted* for NOCASE.
- **Type safety:** non-text + JSON/temporal fall back to BINARY (sqllogic + catalog tests cover it).
- **Explicit-COLLATE path:** sets `collationExplicit = true`; the implicit default does not — DDL
  emission keys off the *value* (`collation !== 'BINARY'`), not the flag, so a default-resolved
  NOCASE still emits `COLLATE NOCASE` (catalog round-trip test confirms).
- **Rehydrate canonicality:** `importTable` passes `'BINARY'`; persisted explicit `COLLATE` is the
  single source of truth (catalog reset-roundtrip test confirms).
- **Lens path:** `buildLogicalTableSchema` now honors the default too (consistent — lens declarations
  share the CREATE surface). Untested under a non-BINARY default, but BINARY-default-safe (no
  out-of-box change); low risk, not worth a dedicated test.
- **Docs:** `sql.md` §9.2.4 (new) + §9.2.5/9.2.6 renumber is clean — no orphaned cross-references;
  `schema.md`'s `§9.2.4` pointer correctly lands on `default_collation`. `schema.md` non-elision note
  is accurate.
- **Option validation / rollback:** unknown collation throws and rolls back (core-api test). Empty
  string is rejected (`normalizeCollationName('')` → `''` → `_getCollation` undefined → throws).

### Accepted as-is (documented in the implement handoff)

- Invalid-pragma error via the `pragma` path surfaces as generic `Unknown pragma: default_collation`
  (the real cause is chained) — matches the `default_column_nullability` precedent; precise message
  asserted at the `setOption` API level. Acceptable.
- Pragma echo preserves the user's casing (`'nocase'` vs default `'BINARY'`) — cosmetic, matches the
  options-framework behavior (stores the raw string; resolution normalizes downstream). Acceptable.
- `yarn test:store` NOT run (slow; release-prep concern). The store *rehydrate* path uses `'BINARY'`
  and is exercised in memory mode; the store *ADD COLUMN* path is now owned by the filed fix ticket.

## Validation

- `yarn workspace @quereus/quereus run build` → clean (EXIT 0).
- `yarn workspace @quereus/quereus run lint` → clean (EXIT 0).
- `yarn workspace @quereus/quereus test` (full memory suite) → **5403 passing, 9 pending** (5402→5403
  from the added index regression test), no regressions.
