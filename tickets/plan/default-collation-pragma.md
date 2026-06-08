description: Add a per-DB `default_collation` option (`pragma default_collation = '<name>'` / `db.setOption`) that sets the default declared collation for columns with no explicit `COLLATE`. Defaults to `BINARY` (SQLite-conventional — no behavior change out of the box), opt into `NOCASE`/`RTRIM`/custom per database. Mirrors `default_column_nullability`. Chosen (human, 2026-06-08) over hardcoding the engine default to NOCASE.
files: packages/quereus/src/core/database.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/ddl.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/, packages/quereus/test/declarative-equivalence.spec.ts, docs/sql.md, docs/schema.md
----

## Why

The engine hardcodes the default declared column collation to `BINARY`
(`schema/column.ts:59` — `collation: 'BINARY', // SQLite's default`; catalog fallback
`catalog.ts:219`). That is the right *default* (SQLite/Postgres-conventional, case-sensitive),
but some databases want case-insensitive text by default. Flipping the hardcoded default to
`NOCASE` was rejected: it changes `where name = 'John'` to match `'JOHN'`/`'john'` on **every
table on every module**, perturbs ORDER BY / DISTINCT / GROUP BY / uniqueness / index order, and
makes case-insensitive PRIMARY KEYs the default (a footgun for codes/hashes/identifiers).

The right mechanism is a **per-DB option**, exactly like the existing
`default_column_nullability` (which overrides the Third-Manifesto NOT-NULL default). Out of the
box the default stays `BINARY`; a database opts into `NOCASE` (or any registered collation) with
one `pragma`.

This also gives the store divergence (`store-pk-collate-create-time-divergence`) a clean exit:
the store's physical key collation already defaults `NOCASE`, so a database that sets
`default_collation = nocase` gets columns declared `NOCASE` that match the store's enforced
`NOCASE` — consistent, no store change, no migration.

## Design

**The option.** Register `default_collation` alongside `default_column_nullability` in
`core/database.ts` (string option; default unset ⇒ `'BINARY'`). Validate the value is a
*registered* collation at set time (reuse `db._getCollation` / the collation registry) so a typo
fails loudly rather than at first comparison.

**Application point — `columnDefToSchema` (`schema/table.ts:209`).** This is the single column
builder; it already takes a `defaultNotNull` param. Add a parallel `defaultCollation: string =
'BINARY'` param. When a `ColumnDef` carries **no explicit `COLLATE`**, the resolved column
collation becomes `defaultCollation` instead of the hardcoded `'BINARY'`. An explicit `COLLATE`
on the column always wins.

**Type compatibility (edge case — must handle).** `validateCollationForType` (`table.ts:178`)
rejects a collation a logical type does not support. A `default_collation = nocase` must **not**
break `create table t (n integer, b blob)` — apply the default only where the collation is valid
for the column's logical type (text-category), else fall back to `BINARY`. Do not let a session
default make an INTEGER/BLOB column un-creatable.

**The load-bearing subtlety — session default vs. canonical persistence.** `default_collation`
must shift resolution **only for user-authored CREATE** (`planner/building/ddl.ts`, where the
CREATE-TABLE builder calls `columnDefToSchema` — thread the session option in there). The
**catalog-canonical / rehydration / declarative-differ** paths must keep resolving an
omitted-`COLLATE` column to the **fixed canonical `BINARY`**, NOT the session option. Otherwise a
schema authored under one session default and reopened under another would silently change
meaning (and on the store, silently re-key). Concretely:

- The persisted/export DDL elides only **literal `BINARY`** today (`docs/schema.md:203` — "the
  default `BINARY` is elided, so a `COLLATE NOCASE` column survives a persistence re-parse"). Keep
  that — a column resolved to a non-BINARY collation (via the pragma or explicit) emits its
  `COLLATE` explicitly and round-trips unambiguously. **Do not** additionally elide the session
  `default_collation` in `ddl-generator.ts` (that would reintroduce the ambiguity).
- Rehydration (`schema/manager.ts` catalog import, the store's `columnDefToSchema` call at
  `store-module.ts`) passes the canonical `'BINARY'` default, so an omitted-`COLLATE` column
  always rehydrates `BINARY` regardless of the live session pragma.

Net: the pragma is a *create-time authoring convenience*; the catalog always stores concrete,
canonical collations.

## Edge cases & interactions

- `default_collation = nocase` then `create table t (x text primary key)` → column declared
  `NOCASE`; on a `using store` table this now **matches** the store's `NOCASE` key collation (no
  divergence); the saved DDL emits `COLLATE NOCASE` and survives reopen.
- Non-text columns under a non-BINARY default stay `BINARY` (compatibility fallback) — verify
  `create table t (id integer primary key, name text)` under `default_collation = nocase` gives
  `id` BINARY, `name` NOCASE.
- An explicit `COLLATE binary` column under `default_collation = nocase` stays BINARY and emits
  explicitly (round-trips).
- `export_schema` round-trip is stable under BOTH session defaults (reparse ≡ original schema) —
  extend the AST/declarative round-trip coverage.
- Declarative-schema equivalence (`declarative-equivalence.spec.ts`): a `declare schema` with no
  per-column COLLATE produces the same `ColumnSchema.collation` as direct DDL under the same
  session default.
- Interaction with `default_column_nullability` (both session column-shaping defaults applied
  together in the CREATE builder).
- Store PK `SET COLLATE` reject path (`store-module.ts:1133`) is unaffected — it compares against
  the store's physical K, which this ticket does not touch.

## Out of scope

- The store's physical key collation default (`store-table.ts:173` `|| 'NOCASE'`). Changing it is
  migration-unsafe (default-created tables omit `collation` from persisted DDL, so reopen
  re-derives the default) and belongs with `store-pk-collate-physical-rekey`. This ticket only
  moves the **declared** column default; the store keeps enforcing its fixed K.
- Per-column PK key collation on the store (physical re-key).

## Key tests (TDD targets for the implement pass)

- `pragma default_collation = nocase; create table t (x text); ...` → `table_info('t').collation`
  for `x` is `NOCASE`; a `where x = 'A'` matches `'a'`. Without the pragma it is `BINARY` and
  case-sensitive (the out-of-box default — guard against regression).
- Reopen / `export_schema`+reparse stability under both defaults.
- Non-text column compatibility fallback under a non-BINARY default.
- Declarative-equivalence parity.
