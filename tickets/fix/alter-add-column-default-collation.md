description: `apply schema` is NON-IDEMPOTENT under a non-BINARY `default_collation` whenever it ADDs a column — the differ resolves the declared side to the default (e.g. NOCASE) but ALTER ADD COLUMN creates the column as BINARY, so every re-apply emits a spurious `SET COLLATE`. Fix the differ↔ADD-COLUMN collation mismatch (and decide whether ADD/RENAME COLUMN should honor `default_collation` generally).
prereq: default-collation-pragma
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus-store/src/store-module.ts, packages/quereus-isolation/src/isolation-module.ts
----

## Confirmed bug (regression introduced by `default-collation-pragma`)

`default-collation-pragma` made the declarative differ resolve an omitted `COLLATE` on the
**declared** side via the live `default_collation` (so a fresh whole-table `apply` matches direct
DDL and re-applies idempotently). But the **ALTER TABLE ADD COLUMN** execution path was left
resolving omitted `COLLATE` to fixed `BINARY`. These two now disagree, so an `apply` that needs to
*add* a column to an existing table is non-idempotent.

### Repro (verified during review)

```
db.setOption('default_collation', 'nocase');
await db.exec('create table t (id integer primary key, name text)');
await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT, extra TEXT } }');
await db.exec('apply schema main');        // adds column `extra`
// → catalog `extra.collation === 'BINARY'`  (ADD COLUMN ignores the default)

// re-diff under the same nocase default:
computeSchemaDiff(declared, collectSchemaCatalog(db,'main'), 'allow', 'nocase')
// → tablesToAlter: [{ tableName:'t', columnsToAlter:[{ columnName:'extra', collation:'NOCASE' }] }]
//   i.e. a spurious `ALTER TABLE t ALTER COLUMN extra SET COLLATE NOCASE` on every apply.
```

Before the pragma ticket this was idempotent (declared side also resolved to BINARY → matched the
BINARY-added column). The whole-table-create path is idempotent because `createTable` DOES honor
the default; only the ADD-COLUMN path drifts.

## Two fix approaches (decide)

**A. Differ-local (narrow, restores idempotency regardless of the broader decision).**
In `computeTableAlterDiff`, the `columnsToAdd` loop emits the raw `columnDefToString(col)` with no
`COLLATE`. For a column with no explicit `COLLATE` whose
`resolveDefaultCollation(inferType(col.dataType), defaultCollation) !== 'BINARY'`, emit the ADD
COLUMN DDL with an **explicit** resolved `COLLATE` (clone the `ColumnDef`, append a
`{ type:'collate', collation: resolved }` constraint, then `columnDefToString`). The memory/store
ADD COLUMN paths already honor an *explicit* `COLLATE`, so the added column lands as NOCASE and the
re-diff is empty. This also upholds the design invariant this ticket established — *emitted DDL
always carries an explicit non-BINARY `COLLATE`* — which the differ's ADD COLUMN emission currently
violates. `defaultCollation` is already threaded into `computeTableAlterDiff`, so the value is in
hand.

**B. Make ADD/RENAME COLUMN honor `default_collation` at the execution layer (broader).**
`ALTER TABLE t ADD COLUMN c text` is user-authored DDL too; under `default_collation = nocase` a
CREATE-d text column becomes `NOCASE` while an ADD-COLUMN-ed one stays `BINARY` — the original
"consistency footgun". The four call sites resolve omitted `COLLATE` to fixed `BINARY`:

- `vtab/memory/layer/manager.ts` `addColumn` / `renameColumn` — `columnDefToSchema(def, defaultNotNull)`
- `quereus-store` `store-module.ts` `addColumn` / `renameColumn`

Thread the session option through all four (via the shared `resolveDefaultCollation` helper) and
verify round-trip: the store persists the column DDL, so a non-BINARY collation must emit explicit
`COLLATE` for a stable reopen (same canonical-persistence rule as CREATE). Edge cases: non-text ADD
COLUMN under a non-BINARY default must fall back to BINARY via the helper; the isolation layer's
`deriveAddColumnBackfill` (`quereus-isolation/isolation-module.ts`) independently recomputes the new
column via `columnDefToSchema` and needs the same arg to stay consistent.

Note A and B are **independent and composable**: A fixes the `apply` idempotency at the emit layer
(explicit COLLATE wins regardless), B fixes the direct-`ALTER` CREATE-vs-ADD inconsistency. Doing A
alone restores idempotency without resolving B; doing B alone fixes the inconsistency but A is still
the cleaner guarantee for emitted DDL. Recommend A as the minimum, plus a decision on B.

## Tests to add

- declarative-equivalence: an `apply` that ADDs a text column under `default_collation='nocase'`
  re-diffs to empty `tablesToAlter` (the failing case above).
- If B: a sqllogic case asserting `ALTER TABLE … ADD COLUMN name TEXT` resolves to NOCASE under the
  default (text) and BINARY for non-text, plus a store-mode reopen round-trip.

Spans memory + store + isolation packages — size accordingly. Approach A alone is small and
self-contained in `schema-differ.ts` + `ast-stringify` (or local clone).
