description: Review the CREATE-time store PK collation reconciliation — implicit-default text PK collation normalized up to the fixed table key collation K, explicit divergent text PK collation rejected with a sited UNSUPPORTED (mirror of the shipped ALTER guard).
files: packages/quereus/src/schema/column.ts, packages/quereus/src/schema/table.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/test/create-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, docs/module-authoring.md, docs/schema.md
prereq:
----

## What shipped

Closed the CREATE-time analogue of the store PK-collation silent-divergence gap that
the ALTER `SET COLLATE` guard (`store-module.ts` `alterColumn` arm) already closed.
Before this change, `create table t (x text primary key) using store` declared the
`BINARY` default for `x` while the store enforced PK uniqueness physically under its
fixed table key collation K (= `config.collation || 'NOCASE'`). `table_info()` reported
`BINARY`; uniqueness / point-lookup / ordering ran under `NOCASE` — a declared≠enforced
split. Now reconciled at both schema entry points with full ALTER symmetry.

### Engine signal (additive)
- `packages/quereus/src/schema/column.ts` — new optional `ColumnSchema.collationExplicit?: boolean`.
  Absent ⇒ implicit default; `true` ⇒ a user-written `COLLATE` clause. Left out of
  `createDefaultColumnSchema` (undefined == implicit).
- `packages/quereus/src/schema/table.ts` — `columnDefToSchema` sets `collationExplicit = true`
  in the `collate` case only. Purely additive; the memory module and every other consumer
  ignore it.

### Store reconciliation
- `packages/quereus-store/src/common/store-module.ts`:
  - New module-level helper `reconcilePkCollations(schema, keyCollation, { reject })`.
    Walks `primaryKeyDefinition`; for each **text** PK member (`col.logicalType.isTextual`)
    whose declared collation (upper-cased) diverges from K:
    - `reject: true` + `collationExplicit` → throws sited `QuereusError(UNSUPPORTED)`
      (names the column, table, K, and the fixed-key-collation rationale — mirrors the
      ALTER guard message).
    - else → normalizes the column's `collation` to K (rebuilds `columns` + `columnIndexMap`).
    Returns the input schema unchanged when nothing diverges. Non-text PK columns and
    non-PK columns are passed through untouched.
  - `create` calls it with `{ reject: true }` **before** any storage side-effect (so a
    reject leaves no dangling store), passes the reconciled schema to `new StoreTable`
    and to the `emitSchemaChange` DDL. The reconciled schema is what
    `finalizeCreatedTableSchema` registers, so `table_info` reports K with no engine change.
  - `connect` calls it with `{ reject: false }` (normalize, never throw — a persisted DDL
    must stay loadable) and logs when it actually coerces a divergent legacy collation.

### Docs
- `docs/schema.md` § "Fixed physical key collation …" — rewritten to cover CREATE/connect
  reconciliation alongside the existing ALTER contract.
- `docs/module-authoring.md` — added a note under the PK-column `setCollation` arm that the
  same gap is closed at CREATE, with the implicit-normalize / explicit-reject split.

## How to validate

Fast lane (memory-backed in-memory KV provider, no LevelDB):
- `packages/quereus-store/test/create-table-conformance.spec.ts` (new, 9 cases) — the
  primary behavioral floor. Run:
  `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/create-table-conformance.spec.ts" --reporter spec`

Key cases asserted:
- `create table t (x text primary key)` → `table_info('t').collation` for `x` == `NOCASE`
  (no BINARY-declared/NOCASE-enforced split); `insert 'a'` then `'A'` → CONSTRAINT.
- `x text collate nocase primary key` (explicit == K) → honored, NOCASE, table exists.
- `x text collate binary primary key` (explicit ≠ K) → sited `UNSUPPORTED`, table NOT
  created, connection still usable (a consistent create succeeds afterward).
- `x text collate rtrim primary key` (third collation ≠ K) → `UNSUPPORTED`.
- composite PK `(a text collate binary, b integer)` → rejected on `a`.
- composite PK `(a text, b integer)` → `a` normalized to NOCASE, `b` (integer) stays BINARY.
- `integer primary key` → stays BINARY (negative guard against over-normalizing non-text).
- non-PK text column → untouched (BINARY default).
- after a default text-PK create, `alter … set collate binary` is now a genuine divergent
  change and rejects via the existing ALTER guard (no perpetuated divergence).

Full validation actually run during implement (all green):
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` (store package suite) — **379 passing**.
- `yarn workspace @quereus/quereus run test` (memory leg) — **5367 passing, 9 pending, 0 failing**.
- `node test-runner.mjs --store` from `packages/quereus` (full store leg, LevelDB) —
  **5362 passing, 14 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean.
- Grepped store-leg sqllogic collation assertions: all are on integer PKs (`id`) or
  non-PK text columns (`name`/`email`/`code`) — none on a text PK, so none shifted.
  `41.7.2-alter-column-collate-unique-store.sqllogic` §9 (`text primary key` consistent
  SET COLLATE) still passes: post-fix the default PK is already NOCASE, so the ALTER is a
  no-op with the same end-state.

## Honest gaps / things for the reviewer to probe

1. **connect-path normalization is instance-only and is overwritten by rehydrate.**
   `connect` normalizes the `StoreTable` instance's cached schema, but
   `rehydrateCatalog` afterward calls `table.updateSchema(fresh)` where `fresh` is
   re-parsed from the persisted DDL. For a **legacy** persisted DDL carrying an explicit
   divergent text-PK collation (only producible by pre-fix data — post-fix `create`
   persists `collate <K>`), `table_info()` would therefore still report the divergent
   collation after a full reopen. No engine-side import-path normalization was added
   (out of scope per the ticket; the connect leniency is best-effort/cosmetic and the
   CREATE fix is the complete one). The new tests do not cover this legacy-reopen path.

2. **No LevelDB reopen assertion for the normalized DDL.** The CREATE conformance spec
   uses the in-memory KV provider and asserts in-session `table_info`. The full store leg
   (LevelDB) passed but does not specifically assert that a normalized text-PK collation
   survives close→reopen as `NOCASE`. A reviewer may want a LevelDB round-trip test
   (`create table t (x text primary key)` → reopen → `table_info` still NOCASE). Expected
   to hold because the normalized create persists `collate nocase` in its DDL.

3. **`collationExplicit` provenance is threaded only through `columnDefToSchema`.**
   Programmatically-built schemas (`createBasicSchema`, MV backing tables) leave it
   undefined ⇒ treated as implicit ⇒ normalize, never reject. That is the safe default,
   but worth a glance that no path which *should* reject an explicit divergence is
   silently downgraded to implicit. The store CREATE path receives the AST-derived schema
   via `columnDefToSchema`, so real `create table … collate …` statements thread it faithfully.

4. **Temporal/JSON PK columns are intentionally NOT normalized.** DATE/TIME/DATETIME/
   TIMESPAN store as TEXT physically and are encoded under K, but `isTextual` is false, so
   they keep declared BINARY (and `validateCollationForType` already forbids a non-BINARY
   collation on them). NOCASE-encoding canonicalized ISO strings is a no-op (no letters),
   so there is no behavioral divergence — but `table_info` reports BINARY while the key
   bytes are K-encoded. Consistent with the ticket's "text only" scope and benign; flagged
   for completeness. Same reasoning excludes JSON PKs.

5. **Intended query-layer convergence (not a regression).** Under the store leg a text PK
   column now reports/uses K (NOCASE) at the query layer (`ORDER BY`, `=`) instead of the
   old declared BINARY. The full store leg (5362 passing) confirms no cross-module sqllogic
   depended on the old BINARY query-layer behavior for a text PK — consistent with the fact
   that case-only-distinct text PK values could never coexist in store storage (NOCASE keys
   collide), so such fixtures are memory-only. This is the intended fix: the query layer now
   matches physical enforcement.
