description: The live CREATE INDEX path rejects an explicit per-column COLLATE (`create index ix on t (col collate nocase)`) as an "expression index", and the persistence emitter drops the trailing `desc` for that form. Surfaced by the canonical-body-collation differ work (2.1), which now EMITS such recreate DDL on an explicit-index-COLLATE change — producing a migration that fails to apply.
prereq:
files:
  - packages/quereus/src/schema/manager.ts            # buildIndexSchema (~2046-2070, throws on indexedCol.expr); resolveImportedIndexColumn (~2506) is the working reference
  - packages/quereus/src/emit/ast-stringify.ts        # indexedColumnsToString (persistence renderer — drops desc for the collate-folded form); createIndexToString
  - packages/quereus/src/parser/parser.ts             # indexedColumn() ~3804 — folds `col COLLATE x` into {expr: collate-expr, direction}
  - packages/quereus/test/index-ddl-roundtrip.spec.ts # has a PENDING (it.skip) guard tied to this slug; "adding an explicit index COLLATE recreates" asserts only the diff decision, not apply
----

# Live CREATE INDEX does not support explicit per-column COLLATE

## Problem

The parser folds an indexed column written as `col COLLATE x` into an indexed
column of the shape `{ expr: <collate-expr over column>, direction }` — there is
no bare `col.name` and no `col.collation` (the collation sits on
`col.expr.collation`). See `parser.ts` `indexedColumn()`.

Two downstream paths do not understand that folded form:

1. **`buildIndexSchema` (the LIVE create path)** throws
   `Indices on expressions are not supported yet.` whenever `indexedCol.expr` is
   set (manager.ts ~2053). Because the parser folds *every* explicit COLLATE into
   an `expr`, this means `create index ix on t (col collate nocase)` always fails
   to execute. (It also reads `indexedCol.collation`, which is `undefined` for the
   folded form, so even without the throw it would silently drop the collation.)
   The catalog-IMPORT path (`importIndex` → `resolveImportedIndexColumn`,
   manager.ts ~2506) already unwraps the folded form correctly and is the
   reference implementation.

2. **`indexedColumnsToString` (the persistence emitter, via `createIndexToString`)**
   drops the trailing `desc` for the folded form: `create index ix on t (email
   collate nocase desc)` re-emits as `create index ix on t (email collate nocase)`
   (verified). So even once (1) is fixed, a descending explicit-COLLATE column
   would not round-trip its direction.

## Why this surfaced now (relation to ticket 2.1)

Before 2.1, the schema differ EXCLUDED collation from the index canonical body,
so an explicit-index-COLLATE change produced no diff and no recreate — the broken
apply path was never reached via the differ. Ticket 2.1 (correctly) includes
per-column collation in the canonical body, so the differ now detects the change
and emits a recreate:

```
DROP INDEX ix
create index ix on t (email collate nocase)   <-- fails: buildIndexSchema throws
ALTER TABLE t ALTER COLUMN email SET COLLATE NOCASE   (only if the column changed too)
```

End-to-end repro (memory backend), confirmed during 2.1 review:

```
declare schema main { table t { id integer primary key, email text } index ix on t (email) }
apply schema main
declare schema main { table t { id integer primary key, email text } index ix on t (email collate nocase) }
apply schema main
-- => Failed to execute DDL: create index ix on t (email collate nocase)
--    Error: Indices on expressions are not supported yet.
```

Contrast — the COLUMN-collation-driven recreate (plain index form, the index
inherits the column's collation) applies cleanly, because the emitted recreate is
`create index ix on t (name)` with no folded expr:

```
declare ... name text ... index ix on t (name)        -> apply
declare ... name text collate nocase ... index ix on t (name)  -> apply  (OK)
```

Note this limitation is not *exclusively* a 2.1 regression: a brand-new declared
index carrying an explicit COLLATE (`index ix on t (email collate nocase)`) has
always produced unapplicable create DDL via the same `createIndexToString` →
`buildIndexSchema` path. 2.1 merely extends the blast radius to RECREATES of
existing indexes.

## Requirements / expected behavior

- `create index ix on t (col collate <c>)` (and the `… collate <c> desc` form)
  must build a valid `IndexSchema` through the live path, resolving the column +
  per-column collation exactly as `resolveImportedIndexColumn` / `importIndex`
  already do (explicit index COLLATE → table column collation → BINARY; normalized).
- `createIndexToString` / `indexedColumnsToString` must emit the trailing
  `asc`/`desc` for the collate-folded form so the persistence round-trip preserves
  direction.
- After the fix, the differ-emitted explicit-COLLATE recreate from 2.1 must apply
  end-to-end (memory and store backends), and an unchanged explicit-COLLATE index
  re-declared verbatim must produce zero churn AND apply.
- Re-enable the PENDING (`it.skip`) test in `index-ddl-roundtrip.spec.ts`
  ("an explicit COLLATE on a descending column (collate-folded form), re-declared
  verbatim, does not churn") and add an APPLY-level assertion to the existing
  "adding an explicit index COLLATE recreates the index" case (it currently checks
  only the diff decision, not that the migration applies).

## Secondary: migration apply ordering (collation-driven recreate)

`generateMigrationDDL` emits `indexesToCreate` (in the "Create new items" block)
BEFORE the "Alter existing tables" loop that emits `ALTER COLUMN … SET COLLATE`.
So a column-collation-driven recreate runs `CREATE INDEX` (which inherits the
column's OLD collation) before the column's `SET COLLATE`. Observed emitted order:

```
DROP INDEX IF EXISTS ix
create index ix on t (name)
ALTER TABLE t ALTER COLUMN name SET COLLATE NOCASE
```

Currently benign: the memory backend returns correct collation-aware query
results after this sequence (verified — a NOCASE lookup found the case-differing
row), and the store backend keys secondary indexes under a single TABLE-LEVEL
collation (`encodeOptions`), not per-column, so a per-column SET COLLATE does not
re-key indexes at all (a separately-deferred limitation; see the
`store-set-collate-pk-physical-rekey` note in quereus-store). The ordering becomes
a real stale-key hazard only on a future backend that keys secondary indexes by
per-column collation AND resolves index collation from the column at CREATE INDEX
time. Two candidate fixes, to weigh against blast radius:
  (a) order a collation-driven index recreate's `CREATE INDEX` AFTER the column
      `SET COLLATE`; or
  (b) have the collation-driven recreate emit an explicit `COLLATE <resolved>` so
      it is order-independent — which DEPENDS on the explicit-COLLATE apply-path
      fix above, and must be scoped to the recreate (not the shared persistence
      emitter).
