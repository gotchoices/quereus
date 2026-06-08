description: Add a per-DB `default_collation` option (`pragma default_collation = '<name>'` / `db.setOption`) setting the default declared collation for columns with no explicit `COLLATE`. Defaults to `BINARY` (no behavior change out of the box); opt into `NOCASE`/`RTRIM`/custom per database. Mirrors `default_column_nullability`.
prereq:
files: packages/quereus/src/core/database.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/types/logical-type.ts, packages/quereus/test/schema/catalog.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/core-api-features.spec.ts, docs/sql.md, docs/schema.md
----

## Summary

The engine hardcodes the default declared column collation to `BINARY`
(`schema/column.ts:67`, `schema/table.ts:220`/`:253`). Add a per-DB session option
`default_collation` (default `'BINARY'` ⇒ no behavior change) that sets the collation a
column with **no explicit `COLLATE`** resolves to. An explicit `COLLATE` always wins. The
option is a **create-time authoring convenience**; the catalog always stores concrete,
canonical collations, and persisted/rehydrated schemas resolve omitted-`COLLATE` columns to
fixed canonical `BINARY` regardless of the live pragma.

Full motivation and the rejected alternative (hardcoding the engine default to `NOCASE`) are
in the originating plan; do not re-litigate. The design below is settled.

## Architecture

### The single resolution helper (DRY — load-bearing)

Both the CREATE path and the declarative differ must resolve an omitted `COLLATE` to **exactly
the same** effective collation, or `apply schema` will not be idempotent (see the differ note
below). Factor the rule into one shared, exported helper in `schema/table.ts`:

```ts
/**
 * Effective collation for a column that carries NO explicit COLLATE clause, given
 * the session default_collation. The default applies only when the column's logical
 * type supports it; otherwise BINARY (so a non-text column under a non-BINARY default
 * stays creatable / canonical). Used by columnDefToSchema (create) AND the schema
 * differ's extractDeclaredCollation (apply) so the two never drift.
 */
export function resolveDefaultCollation(logicalType: LogicalType, defaultCollation: string): string {
  const normalized = normalizeCollationName(defaultCollation);
  if (normalized === 'BINARY') return 'BINARY';
  // Apply only when the type explicitly supports this collation. INTEGER/REAL/BLOB
  // have `supportedCollations === undefined` (validateCollationForType would NOT
  // reject them — see below), so we must gate on explicit support here, not on a
  // throw. TEXT supports BINARY/NOCASE/RTRIM; JSON/temporal have an empty list.
  if (logicalType.supportedCollations?.includes(normalized)) return normalized;
  return 'BINARY';
}
```

Why the explicit support check (not reuse `validateCollationForType`'s throw): a column with
`supportedCollations === undefined` (INTEGER/REAL/BLOB) is **accepted** by
`validateCollationForType` for any collation (the guard `if (supportedCollations && !includes)`
is falsy). So applying a `NOCASE` *default* to an INTEGER via that path would silently give the
INTEGER column `collation: 'NOCASE'` — wrong. The plan requires non-text columns to fall back
to `BINARY` under a non-BINARY default. The explicit `?.includes()` gate delivers exactly that
and is the SAME predicate the differ uses, guaranteeing create/apply parity.

> Pre-existing quirk, OUT OF SCOPE: an *explicit* `COLLATE NOCASE` on an INTEGER column is
> currently accepted (because `supportedCollations` is undefined for INTEGER). This ticket does
> NOT change explicit-COLLATE handling — only the implicit default. Leave the explicit path as-is.

### The option (`core/database.ts`)

Register alongside `default_column_nullability` (see `database.ts:239`):

```ts
this.options.registerOption('default_collation', {
  type: 'string',
  defaultValue: 'BINARY',
  description: 'Default declared collation for columns with no explicit COLLATE (e.g. "BINARY", "NOCASE", "RTRIM", or any registered collation)',
  onChange: (event) => {
    const value = event.newValue as string;
    const normalized = normalizeCollationName(value);
    // Validate at set time so a typo fails loudly, not at first comparison. The
    // options framework rolls the value back when onChange throws (see the
    // default_column_nullability rollback test in core-api-features.spec.ts).
    if (this._getCollation(normalized) === undefined) {
      throw new QuereusError(`Unknown collation '${value}' for default_collation`, StatusCode.ERROR);
    }
    log('Default collation changed to: %s', normalized);
  }
});
```

`_getCollation(name)` (`database.ts:1182`) returns the registered comparator or `undefined`.
`normalizeCollationName` is already imported in `database.ts`'s neighbours — import from
`../util/comparison.js` if not already present.

### Application point — CREATE only

`columnDefToSchema` (`schema/table.ts:209`) gains a parallel param
`defaultCollation: string = 'BINARY'` (mirroring the existing `defaultNotNull`). When the
column carries **no `collate` constraint**, the initial `collation` becomes
`resolveDefaultCollation(logicalType, defaultCollation)` instead of the hardcoded `'BINARY'`.
The explicit-`COLLATE` `case 'collate'` branch is unchanged (always wins, sets
`collationExplicit = true`).

Thread the session option through the CREATE path, and the canonical default through the
rehydrate path — this split is the whole point:

| Call site | `defaultCollation` to pass | Why |
|---|---|---|
| `manager.ts buildTableSchemaFromAST` (via `buildColumnSchemas`) — called by `createTable` | **session** `default_collation` | user-authored CREATE |
| `manager.ts buildTableSchemaFromAST` — called by `importTable` (rehydrate) | `'BINARY'` | persisted DDL already made non-BINARY explicit; omitted ⇒ canonical |
| `manager.ts buildLogicalTableSchema` (declare-logical / lens) | **session** `default_collation` | user-authored declaration, same surface as CREATE |
| `vtab/memory/layer/manager.ts addColumn`/`renameColumn`, `quereus-store store-module.ts addColumn`/`renameColumn` | leave as `'BINARY'` (default param) — DO NOT thread | ALTER ADD/RENAME COLUMN is OUT OF SCOPE this pass (see below) |

Concretely: add `defaultCollation: string` to `buildTableSchemaFromAST` and `buildColumnSchemas`;
`createTable` (`manager.ts:2236`) reads
`normalizeCollationName(this.db.options.getStringOption('default_collation'))` and passes it;
`importTable` (`manager.ts:2468`) passes `'BINARY'`. `buildLogicalTableSchema` reads the session
option the same way it already reads `default_column_nullability`.

### The declarative differ — RESOLVED DEVIATION FROM PLAN PROSE (read carefully)

The plan text says the "declarative-differ" path should keep resolving omitted-`COLLATE` to
fixed canonical `BINARY`. **That is correct for rehydration/import and for export elision, but
NOT for the differ's declared-side resolution.** Here is the reasoning the implementer must
preserve:

- `apply schema` for a NEW table emits `createTableToString(declaredStmt)` (`schema-differ.ts:386`),
  which faithfully preserves the COLLATE omission, then runs it through `createTable` → session
  default. So a fresh apply under `default_collation = nocase` yields `name: NOCASE`, matching
  direct DDL (parity — good).
- On the NEXT `apply`, `computeTableAlterDiff` compares the declared column against the live
  catalog via `extractDeclaredCollation` (`schema-differ.ts:1352`), which currently hardcodes
  `'BINARY'` for an omitted `COLLATE`. The live catalog column is `NOCASE`. If the differ
  resolves declared ⇒ `BINARY`, it sees drift and emits `SET COLLATE BINARY`, reverting the
  column and breaking both parity and idempotency on every re-apply.

Therefore `extractDeclaredCollation` MUST resolve an omitted `COLLATE` via the **same**
`resolveDefaultCollation(inferType(col.dataType), defaultCollation)` helper, with
`defaultCollation` threaded in from the session. This keeps create/apply parity AND idempotency,
and is the only internally-consistent choice under a non-BINARY default.

This does NOT reintroduce the cross-session hazard the plan warns about: the differ always runs
in the live session against the live declared schema; the cross-session-reopen concern is purely
about *persisted-DDL rehydration*, which stays fixed-`BINARY` (the `importTable` path above) and
relies on `generateTableDDL` emitting explicit `COLLATE` for any non-BINARY collation.

Plumbing:
- `computeSchemaDiff` (`schema-differ.ts:156`) gains `defaultCollation: string = 'BINARY'`
  (trailing, after `policy`), threaded down through `computeTableAlterDiff` to
  `extractDeclaredCollation`. The `'BINARY'` default keeps existing direct-call tests (which run
  under the BINARY session default) byte-for-byte unchanged.
- The two emitters in `runtime/emit/schema-declarative.ts` (`emitApplySchema` line 190,
  `emitDiffSchema` line 113) pass
  `rctx.db.options.getStringOption('default_collation')`.

### Canonical persistence / export — NO elision of the session default

`ddl-generator.ts formatColumnDef` (`:382`) already elides only a *literal* `BINARY`
(`normalizeCollationName(col.collation) !== 'BINARY'` ⇒ emit `COLLATE`). **Keep this exactly.**
Do NOT add session-`default_collation`-aware elision to `resolveEmitContext`/`EmitContext` — a
column resolved to `NOCASE` must always emit `COLLATE NOCASE` so it round-trips unambiguously
under any reopen default. (Contrast with nullability/USING, which DO elide the session default —
collation deliberately does not.) This is likely a zero-code-change requirement; verify with a
test rather than editing the generator.

## Edge cases & interactions

- **Non-text fallback:** `pragma default_collation = nocase; create table t (id integer primary key, name text)`
  ⇒ `id` collation `BINARY` (INTEGER doesn't support NOCASE), `name` collation `NOCASE`.
- **JSON / temporal:** `supportedCollations: []` ⇒ a non-BINARY default falls back to `BINARY`
  (same gate as non-text). Confirm a `json`/`date` column stays `BINARY` under `nocase`.
- **Explicit `COLLATE binary` under `nocase` default:** stays `BINARY`, sets `collationExplicit`,
  emits `COLLATE`? No — `BINARY` is elided by the generator (correct). Re-parse ⇒ omitted ⇒
  re-resolves under the *then-current* default. This is acceptable: an explicit `COLLATE BINARY`
  and an omitted COLLATE are semantically identical w.r.t. the default mechanism. (The differ
  already treats absent ≡ explicit BINARY — see the existing "absent COLLATE and an explicit
  COLLATE BINARY are equal" test.)
- **PRIMARY KEY interaction:** `default_collation = nocase; create table t (x text primary key)`
  ⇒ `x` declared `NOCASE`. `findColumnPKDefinition`/`findConstraintPKDefinition`
  (`table.ts:775`,`:806`) derive the PK column's `collation` from `col.collation || 'BINARY'`,
  so the PK key collation follows the resolved column collation automatically — no extra change.
  (This also lines up a store-backed PK with the store's `NOCASE` physical key — but the store's
  physical key default is OUT OF SCOPE; this ticket only moves the *declared* collation.)
- **Idempotent re-apply under `nocase`:** the new differ test (below) must show the second
  `computeSchemaDiff` produces zero `tablesToAlter` for an omitted-COLLATE text column.
- **`default_column_nullability` + `default_collation` together:** both session column-shaping
  defaults must apply together in `buildColumnSchemas`. Add a combined assertion.
- **Invalid collation name:** `pragma default_collation = 'no_such'` throws at set time and the
  option value rolls back to its prior value (framework behavior; mirror the existing
  `default_column_nullability` rollback test).
- **Out of box (regression guard):** with the option unset (`BINARY`), every existing collation
  behavior is byte-for-byte unchanged — `where x = 'A'` is case-sensitive, `table_info` shows
  `BINARY`. The full existing suite passing is the primary guard.

## Out of scope (do NOT do here)

- ALTER `ADD COLUMN` / `RENAME COLUMN` honoring `default_collation` (memory + store paths). Keep
  the `'BINARY'` default param there. **Park a `backlog/` ticket** noting the CREATE-vs-ADD-COLUMN
  inconsistency so a follow-up can decide whether ADD COLUMN should follow the session default.
- The store's physical key collation default (`store-table.ts` `|| 'NOCASE'`) and per-column PK
  physical re-key — owned by `store-pk-collate-physical-rekey` / `store-pk-collate-create-time-divergence`.
- Changing explicit-`COLLATE`-on-non-text-type acceptance.

## Key tests (TDD targets)

Put logic-shaped behavior in `test/logic/` (a new `*.sqllogic` or extend an existing collation
file) and structural/round-trip assertions in the named `.spec.ts` files.

- **`columnDefToSchema` / table_info (sqllogic or unit):**
  - `pragma default_collation = nocase; create table t (x text); ...` ⇒ `table_info('t')` shows
    `x` collation `NOCASE`; `select count(*) from t where x = 'A'` matches a row inserted as `'a'`.
  - Without the pragma (default): `x` is `BINARY`, `where x = 'A'` does NOT match `'a'`.
  - `create table t2 (id integer primary key, name text)` under `nocase` ⇒ `id` BINARY, `name`
    NOCASE.
- **`catalog.spec.ts` (mirror the existing `default_column_nullability` roundtrip test ~line 343):**
  - Under `default_collation = nocase`, a `create table` of an omitted-COLLATE text column emits
    `COLLATE NOCASE` in the catalog DDL; drop + re-exec that DDL (under the SAME and under a
    RESET-to-BINARY session) yields a column whose collation is `NOCASE` both times (explicit
    COLLATE in the persisted DDL wins over the live default — proves canonical persistence).
- **`declarative-equivalence.spec.ts`:**
  - New case (or a dedicated `it`) under `default_collation = nocase`: direct `create table t (name text)`
    and `declare schema main { table t { ... name text } } ; apply` produce the same
    `ColumnSchema.collation` (`NOCASE`) — extend the dual-DB harness or add a focused test that
    sets the option on both DBs.
  - Idempotency: after the first `apply` under `nocase`, a second `computeSchemaDiff(declared,
    catalog, /* defaultCollation */ 'NOCASE')` produces `tablesToAlter: []` (no spurious SET
    COLLATE). Guards the differ resolution.
- **`core-api-features.spec.ts`:** `default_collation` set/get; invalid value throws and rolls
  back (clone the `default_column_nullability` rollback test).

## TODO

### Phase 1 — option + resolution helper
- Add `resolveDefaultCollation(logicalType, defaultCollation)` to `schema/table.ts`; export it
  from `src/index.ts` next to `validateCollationForType`.
- Register the `default_collation` option in `core/database.ts` with set-time validation via
  `_getCollation` + `normalizeCollationName`.

### Phase 2 — CREATE path
- Add `defaultCollation: string = 'BINARY'` to `columnDefToSchema`; use the helper for the
  no-explicit-COLLATE branch.
- Add `defaultCollation` to `buildColumnSchemas` and `buildTableSchemaFromAST`; pass the session
  option from `createTable` and `buildLogicalTableSchema`, and `'BINARY'` from `importTable`.

### Phase 3 — differ parity
- Add `defaultCollation` param to `extractDeclaredCollation`, `computeTableAlterDiff` (and any
  intermediate), and `computeSchemaDiff` (default `'BINARY'`); resolve omitted COLLATE via the
  shared helper using `inferType(col.dataType)`.
- Pass `db.options.getStringOption('default_collation')` from both emitters in
  `runtime/emit/schema-declarative.ts`.

### Phase 4 — verify persistence (likely no code change)
- Confirm `ddl-generator.ts` still emits explicit `COLLATE` for any non-BINARY collation and does
  NOT elide the session default; add the catalog round-trip test rather than editing the generator.

### Phase 5 — tests + docs
- Write the tests above; run `yarn workspace @quereus/quereus run build` then
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/dc.log; tail -n 80 /tmp/dc.log` and lint.
- Update `docs/sql.md` (pragma list) and `docs/schema.md` (the collation-elision note around
  line 203 — document `default_collation`, its `BINARY` default, the create-time-only semantics,
  and that persisted DDL always carries explicit non-BINARY collation).
- File the `backlog/` ticket for ALTER ADD COLUMN `default_collation` consistency.
