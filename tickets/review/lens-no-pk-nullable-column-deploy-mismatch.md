description: |
  A table with NO declared primary key silently forced every column NOT NULL,
  overriding an explicit `null` declaration, because the no-PK "all columns
  become the key" synthesis fed the unconditional `notNull: isPkColumn ? true …`
  promotion in `buildColumnSchemas`. Symptom: `lens.nullability-mismatch` when
  deploying such a logical table over a nullable basis; root defect: a general
  schema-building bug that also rejected NULL inserts into no-PK storage tables.
  Fixed so a *synthesized* all-columns key preserves declared nullability; only
  an *explicitly-declared* PK forces NOT NULL. Uniform across storage + logical.
files:
  - packages/quereus/src/schema/table.ts            # findPKDefinition (now returns `synthesized`); new isSynthesizedAllColumnsKey helper
  - packages/quereus/src/schema/manager.ts          # buildColumnSchemas — notNull promotion gated on !synthesized
  - packages/quereus/src/schema/ddl-generator.ts    # generateTableDDL / formatColumnDef — omit PK clause for synthesized key
  - packages/quereus/src/schema/lens-prover.ts      # checkTypeAndNullability (UNCHANGED — correct for free once col.notNull is honest)
  - packages/quereus/test/no-pk-nullability.spec.ts # NEW — schema-building, storage NULL-insert/dup, DDL round-trip
  - packages/quereus/test/lens-prover.spec.ts       # NEW positive cases for the synthesized key
  - docs/schema.md                                  # ColumnSchema primary-key-nullability note + DDL synthesized-key omission
  - docs/lens.md                                    # Coverage checklist type/nullability conformance wording
----

# Review: no-PK synthesized key must not force columns NOT NULL

## What was changed and why

Root cause (two pieces colluding):
1. `findPKDefinition` synthesizes an **all-columns** key when no PK is declared
   (whole row = row identity). It *intended* not to force NOT NULL.
2. `buildColumnSchemas` overrode that with `notNull: isPkColumn ? true : col.notNull`.
   Because the synthesized fallback makes **every** column a key column, every
   column was forced NOT NULL — discarding an explicit `null` and rejecting NULL
   inserts. The lens prover (`checkTypeAndNullability`) then saw a forced-NOT-NULL
   logical column over a nullable basis and emitted `lens.nullability-mismatch`.

Fix (design option (a) from the plan — the behaviour was wrong end-to-end, not
just a misleading message):
- `findPKDefinition` now returns a `synthesized: boolean` discriminator — `true`
  **only** on the no-PK all-columns fallback; `false` for column-level,
  table-level, and the empty-key `primary key ()` singleton.
- `buildColumnSchemas` gates the promotion: `notNull: (isPkColumn && !synthesized) ? true : col.notNull`.
  `primaryKey` / `pkOrder` are unchanged — the synthesized columns are still the
  row-identity key, only their *nullability* is left as declared.
- The lens prover is **untouched**: it becomes correct automatically once the
  logical column's `notNull` reflects the declaration.

### Soundness of a nullable synthesized key
NULL-in-key is already supported: memory `compareSqlValuesFast` treats
`NULL == NULL` as equal (NULL sorts first); the store codec encodes
`TYPE_NULL = 0x00` first. So the all-columns key stays a valid identity with
nullable members — two fully-identical rows collide as a **duplicate key**
(ABORT), not a NOT NULL error.

## The one non-obvious decision the reviewer should scrutinize

**DDL round-trip required a second change**, and it is **shape-based, not
flag-based** — this is the highest-judgment part of the diff.

Problem: after the core fix, the in-memory schema of `create table t (a int null, b int null)`
has nullable columns + an all-columns key. But `generateTableDDL` emitted
`PRIMARY KEY (a, b)` (and, for a one-column table, an inline `PRIMARY KEY`).
Re-parsing that DDL (store persistence: `closeAll → reopen → rehydrateCatalog`)
treats the named PK as **explicitly declared** ⇒ re-forces NOT NULL ⇒ the
reopened schema would differ from the pre-close schema. A regression introduced
by the core fix.

Resolution: a new `isSynthesizedAllColumnsKey(tableSchema)` helper detects the
synthesized shape (PK covers all columns, declaration order, all ascending, no
declared PK conflict action) and `generateTableDDL` / `formatColumnDef` **omit
the PK clause entirely** for it, so the re-parse re-synthesizes the key and keeps
nullability.

Why shape-based rather than a stored `synthesized` flag on `TableSchema`:
- **Robustness over precision.** The shape is the canonical form the synthesized
  key *always* has, regardless of construction path (CREATE, store rehydrate,
  module rebuild). A stored flag would have to be set correctly by every path or
  it fails *silently* (re-forces NOT NULL).
- **Provably round-trip-correct for the ambiguous case.** The shape also matches
  an *explicitly-declared* all-columns-in-order-asc PK (and a single-column
  table's single-column PK). Omitting the clause there is still correct: a
  declared all-columns PK already forced its columns NOT NULL, so re-synthesis
  yields a **byte-identical schema**. A nullable column under this shape can only
  be a synthesized key (a declared PK can't be nullable).

**Reviewer judgment call:** this means canonical DDL now drops the explicit
`PRIMARY KEY` text for an all-columns / single-column-table PK (e.g.
`create table t (a int primary key)` persists as `create table t ("a" integer NOT NULL)`).
Functionally identical on re-parse, but confirm no consumer depends on that
clause's *text* surviving. The conflict-action guard keeps
`primary key (...) on conflict X` on its own emission path. (Note: table-level PK
`ON CONFLICT` was *already* dropped by `generateTableDDL` before this change — a
pre-existing fidelity gap, not introduced here.)

## Audit performed (assumptions that `primaryKey ⇒ notNull`)

- `runtime/emit/alter-table.ts runAlterPrimaryKey` (~903 "must be NOT NULL to
  participate in PRIMARY KEY") — **left intact**; governs an explicit re-key only,
  never the synthesized path.
- `buildShadowTableDdl` — **not affected**: its only nullable-relevant caller is
  `runAlterPrimaryKey` (which enforces NOT NULL on every new PK column), and
  `runDropColumn` rejects dropping any PK column, so a no-PK table (all columns in
  the key) never routes through the shadow rebuild.
- `quereus-store store-module.ts` "Cannot DROP NOT NULL on PRIMARY KEY column" —
  only fires when `oldCol.notNull` is true; a nullable synthesized-key column is
  already `false`, so no false trigger.
- `schema-differ.ts extractDeclaredNotNull` — "PK implies NOT NULL" only for a
  column-level `primaryKey` AST constraint, which a synthesized key never has, so
  `apply schema` idempotency is preserved (verified: no NOT NULL / ALTER PK churn).
- `planner/type-utils.ts` — adds the PK as a relation key unconditionally
  (unchanged); the all-columns key remains a sound key under NULL==NULL dedup.

## How to validate (use cases)

Build + targeted, then the suites:
- `yarn workspace @quereus/quereus run build`
- New spec: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/no-pk-nullability.spec.ts" --colors`

Behavioural use cases pinned by tests:
- **Schema building** — `create table t (a int null, b int null)`: both columns
  `primaryKey=true` but `notNull=false`. `… , primary key (a)`: `a` forced NOT
  NULL, `b` nullable. `a int null primary key`: `a` NOT NULL. Plain `a int, b int`
  (no annotation): both NOT NULL via the **session default** (not key-driven).
- **Storage** — `insert into t (a,b) values (null,5)` succeeds; a second identical
  `(null,5)` raises a **key/constraint** conflict whose message does **not** match
  `/NOT NULL/`. Single-column `create table t (a int null)` behaves the same.
- **Lens deploy** (`apply schema`) — a no-PK logical table with `null` columns
  over a nullable basis deploys **clean and writable** (was the original bug); a
  no-PK logical table over a NOT NULL basis still deploys clean; the genuine
  NOT-NULL-over-nullable case (`id primary key, note text` over nullable `note`)
  still errors `lens.nullability-mismatch` (kept green).
- **DDL round-trip** — `generateTableDDL` of a no-PK table emits `NULL`
  annotations and **no** PK clause; re-`exec`-ing the DDL in a fresh DB preserves
  `notNull=false`. A genuine single-column declared PK on a multi-column table
  still emits inline `PRIMARY KEY`.

Suites run green this implementation pass:
- memory `yarn test` — 4939 passing, 0 failing
- store mode `yarn test:store` — 4934 passing
- `@quereus/store` package — 315 passing (incl. `ddl-generator.spec.ts`)
- `@quereus/isolation` — 98 passing
- `documentation.spec.ts` — 6 passing; quereus `yarn lint` clean; full `yarn build` clean

## Known gaps / where to push (tests are a floor)

1. **No dedicated store close→reopen round-trip test** for a no-PK *nullable*
   table that holds a NULL-in-key row. The mechanism is exercised by the
   `generateTableDDL` → re-parse unit test (same path `rehydrateCatalog` uses) and
   the full `test:store` run passes, but an explicit persistent-store
   create/insert-NULL/close/reopen/assert-nullable-and-NULL-present test would
   directly pin the highest-risk path. Recommended to add.
2. **ALTER ADD COLUMN on a no-PK nullable table across a store reopen** is not
   directly tested. It routes through `module.alterTable` and persists via
   `generateTableDDL` (now fixed), so it should be sound, but it is unverified
   end-to-end.
3. **DDL canonicalization breadth** — the shape-based omission changes emitted DDL
   for *explicitly-declared* all-columns / single-column-table PKs (drops the
   clause text). Verify this is acceptable project-wide and that nothing asserts
   that specific text (existing `@quereus/store` `ddl-generator.spec.ts` does not —
   it uses non-all-columns PKs).
4. New specs are **memory-backed**; store parity rests on the suite-level
   `test:store` pass rather than per-case store assertions.
