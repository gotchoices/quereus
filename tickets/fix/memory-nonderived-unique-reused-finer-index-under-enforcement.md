description: Memory under-enforces a NON-derived (table-level / column) UNIQUE constraint when a FINER same-column-set `CREATE UNIQUE INDEX` already exists at the time the constraint is realized — the constraint is physically realized by (and `findIndexForConstraint` resolves to) that reused finer index, so DML enforces under the index's collation instead of the column's declared collation. Reachable via `CREATE UNIQUE INDEX … (col COLLATE binary)` followed by `ALTER TABLE … ADD CONSTRAINT … UNIQUE (col)` on a NOCASE column: both `'Bob'` and `'bob'` insert (must reject). Memory diverges here from both the shared `uniqueEnforcementCollations` helper (returns the declared collation for a non-derived UC) and the store module.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # ensureUniqueConstraintIndexes reuse (~line 154-199) + findIndexForConstraint non-derived column-set scan (~line 1034-1044)
  - packages/quereus/src/schema/unique-enforcement.ts                  # uniqueEnforcementCollations: non-derived ⇒ declared collation (~line 66-74)
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # add a §12 covering this shape (both modules)
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # add a non-derived + finer-same-column-set-index shape
difficulty: medium
----

# Fix: non-derived UNIQUE under-enforces when realized by a pre-existing finer same-column-set index

## Symptom (reproduced)

```sql
create table t (id integer primary key, b text collate nocase);
create unique index ix_binary on t (b collate binary);   -- FINER than declared, created first
alter table t add constraint uq unique (b);              -- non-derived NOCASE UNIQUE
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- ADMITTED (count=2) — must be REJECTED (NOCASE UNIQUE)
```

Observed under memory: `select count(*) from t` → 2, second insert NOT rejected.
SQLite (and the store module, which enforces via the by-name `uniqueEnforcementCollations`
helper) reject the second insert: the table-level `unique (b)` over a NOCASE column folds
`'Bob'`/`'bob'`.

The mirror order — `create table … unique (b)` first, THEN `create unique index ix_binary` —
enforces correctly (count=1, rejected), because the auto-built `_uc_b` index (declared NOCASE)
is created first and `findIndexForConstraint`'s column-set scan finds it before `ix_binary`.
So the bug is **order-sensitive**, exactly like the sibling
`memory-multi-index-unique-collation-resolution` was for two *derived* indexes — but this one
survives that fix because it is a **non-derived** UC (no `derivedFromIndex`), so it is not
rerouted by the by-name resolution that fix added.

## Root cause

Two reinforcing memory-module behaviors:

1. **`ensureUniqueConstraintIndexes` (manager.ts ~line 162-191) reuses ANY matching
   column-set index** as the constraint's realizing structure, *regardless of collation*:

   ```ts
   const matchingIndex = existingIndexes.find(idx =>
       idx.columns.length === uc.columns.length &&
       idx.columns.every((col, i) => col.index === uc.columns[i]));
   if (matchingIndex) indexName = matchingIndex.name;   // reuses ix_binary — no _uc_b built
   ```

   When the constraint is added (via `ALTER … ADD CONSTRAINT`) *after* a finer
   `CREATE UNIQUE INDEX` over the same column-set already exists, the non-derived UC is
   physically realized by that finer index — no `_uc_*` carrying the declared collation is
   built.

2. **`findIndexForConstraint` (manager.ts ~line 1034-1044)** — for a non-derived UC
   (`derivedFromIndex` unset) — falls to the column-set scan, which returns that same reused
   finer index. `checkUniqueViaIndex` then compares under `index.specColumns[i].collation`
   (BINARY) and generates candidates from the BINARY-keyed BTree, so a NOCASE duplicate is
   neither found nor bucketed.

Meanwhile the shared `uniqueEnforcementCollations(schema, uc)` helper returns the **declared**
column collation for a non-derived UC (NOCASE). So memory's live-index path and the helper
**diverge** for this shape — the exact divergence the
`unique-enforcement-collation.spec.ts` conformance lock is meant to catch, but no test shape
exercises a non-derived UC sharing a column-set with a differently-collated index.

## Expected behavior

A non-derived (table-level / column) UNIQUE must always enforce under its **declared column
collation**, independent of any user index that happens to cover the same column-set, and
independent of DDL order. `'Bob'` then `'bob'` on a NOCASE-column `unique (b)` rejects the
second insert; memory and store agree; SQLite parity.

## Notes for the implementer

- Decide where to cut it. Two candidate fixes (pick one, or combine):
  - **Realization fix:** `ensureUniqueConstraintIndexes` should not reuse a same-column-set
    index whose per-column collations differ from the constraint's declared collations — build
    a distinct `_uc_*` carrying the declared collation instead (and let the user index coexist
    as an independent, stricter/looser constraint, matching SQLite where both indexes enforce).
    Consider the interaction with the covering-MV path and DROP CONSTRAINT/DROP INDEX
    lifecycle (a reused index's name currently doubles as the constraint's realizing name).
  - **Resolution fix:** give the non-derived UC a stable realizing-structure name
    (the `implicitCoveringStructures` map already keys `uc.name ?? indexName`) and have
    `findIndexForConstraint` resolve non-derived UCs by that name too, rather than a
    first-match column-set scan. But this only helps if a correctly-collated index actually
    exists — if reuse already collapsed onto the finer index, there is no NOCASE structure to
    find, so the realization fix is likely necessary.
- Verify the store module is actually correct for this shape (it enforces via the helper, which
  returns the declared collation — but confirm its candidate generation / realizing structure
  doesn't have the analogous reuse). The 102.2 §11 store run passes for two *derived* indexes;
  add the non-derived + finer-index shape under store too.
- Tests: add a §12 to `102.2-unique-collation.sqllogic` (both creation orders, runs under
  memory AND store), and a non-derived-UC-with-finer-same-column-set-index shape to
  `unique-enforcement-collation.spec.ts` so the conformance lock covers the divergence.
- This was uncovered during review of `memory-multi-index-unique-collation-resolution`; it is a
  **pre-existing** latent bug (the non-derived path was unchanged by that fix), not a
  regression introduced there.
