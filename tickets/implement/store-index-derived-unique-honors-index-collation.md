description: The store module enforces index-derived UNIQUE (CREATE UNIQUE INDEX … (col COLLATE x)) under the column's DECLARED collation, ignoring the index's per-column COLLATE clause — diverging from the memory module (which enforces under the index collation) and from the store's OWN index-build dedup (buildIndexEntries already honors the index collation). Align the store DML/maintenance UNIQUE enforcement to the index per-column collation so the relation-key gate's index-collation assumption holds uniformly across both modules.
difficulty: medium
files:
  - packages/quereus-store/src/common/store-table.ts                 # findUniqueConflict / findUniqueConflictViaCoveringMv / enforceSecondaryUniqueForMaintenance — the DML+maintenance enforcement sites that use declared collation
  - packages/quereus-store/src/common/store-module.ts                # buildIndexEntries (already correct — reference) / validateUniqueOverExistingRows (table-level UNIQUE — leave as-is)
  - packages/quereus/src/vtab/memory/layer/manager.ts                # checkUniqueViaIndex — the reference implementation (index.specColumns[i]?.collation ?? schema.columns[col].collation)
  - packages/quereus/src/planner/type-utils.ts                       # enforcementCollationCoversDeclared — the gate; AUDIT CONCLUSION: no change needed
  - packages/quereus-store/test/unique-constraints.spec.ts           # store-side collation enforcement specs — extend here
  - packages/quereus/test/logic/05-vtab_memory.sqllogic              # memory index-collation pin (§ Explicit unique-index collation); add a parity file that runs under both harnesses
  - packages/quereus/test/planner/collation-soundness.spec.ts        # finer-index promotion / NOCASE-PK soundness shapes to mirror onto store
----

# Store: index-derived UNIQUE must enforce under the index's per-column collation

## Audit result (the plan-stage finding)

The cross-module audit traced every uniqueness-enforcement site against the
relation-key promotion gate (`enforcementCollationCoversDeclared`,
`type-utils.ts:86`). Enforcement-collation map:

| Constraint source | Memory enforcement | Store enforcement | Output (declared) | Sound key? |
|---|---|---|---|---|
| **PRIMARY KEY** | `pkDef.collation` = declared col collation | per-PK-column key bytes via `resolvePkKeyCollations` = `col.collation` | declared | ✅ both = declared |
| **table-level / column `UNIQUE`** | `schema.columns[col].collation` (declared) | `findUniqueConflict` compares under `schema.columns[idx].collation` (declared) | declared | ✅ both = declared |
| **`CREATE UNIQUE INDEX … (col COLLATE x)`** (`derivedFromIndex`) | **index's per-column collation** (`checkUniqueViaIndex`: `index.specColumns[i]?.collation ?? schema.columns[col].collation`) | **declared col collation** — index COLLATE *ignored* | declared | ⚠️ **divergent** |

Two facts the audit established that need **no code change**:

- **PK is sound on the store.** `reconcilePkCollations` (store-module.ts
  `~2476`) rewrites an *implicit*-default text PK column's `collation` to the
  store's key collation K on the CREATE path (so declared == key bytes ==
  enforcement), and the reload path round-trips a non-BINARY collation as an
  explicit `COLLATE` clause (`collationExplicit: true`, declared == key). So
  store PK enforcement always equals the column's declared/output collation —
  the ticket's "session-default-NOCASE vs store-default-BINARY makes the PK
  finer" worry does not materialise: reconcile forces the column's *declared*
  collation to the key collation, keeping output == enforcement. The gate's
  "PK needs no gate" assumption holds for the store.

- **The relation-key gate is sound across both modules — leave it as-is.**
  Memory enforces index-derived UNIQUE under the index collation, which is
  exactly what the gate models. The store today enforces under the *declared*
  collation, which equals the *output* collation — so any constraint the gate
  promotes trivially holds on the store (store enforcement is never *finer*
  than output; if anything the gate under-promotes a `(col COLLATE BINARY)`
  index over a NOCASE column that the store would in fact key as a relation
  key — a missed optimisation, never an over-claim). **No over-claim exists on
  either module; `enforcementCollationCoversDeclared` requires no change.**

The one real defect: **store index-derived UNIQUE enforcement ignores the
index's per-column COLLATE clause.** This is

1. a **user-visible cross-module divergence** — the same DDL accepts different
   data depending on the storage module, and
2. an **internal store inconsistency** — `buildIndexEntries`
   (store-module.ts `~769`) already dedups existing rows under
   `col.collation ?? tableSchema.columns[col.index].collation` (index
   collation), but the DML write path (`findUniqueConflict`) compares under the
   declared column collation. So `CREATE UNIQUE INDEX` over pre-existing data
   and subsequent `INSERT`s disagree on what collides.

Concrete failures (SQLite semantics: a unique index enforces under the
**index's** collation, so memory is correct and the store is wrong):

```sql
-- (A) FINER index over a NOCASE column — should admit both variants
CREATE TABLE t (id integer primary key, b text collate nocase) using store;
CREATE UNIQUE INDEX ix ON t (b collate binary);
INSERT INTO t VALUES (1, 'Bob');
INSERT INTO t VALUES (2, 'bob');   -- memory: OK (BINARY-distinct)
                                   -- store TODAY: rejected (NOCASE declared)  ← BUG

-- (B) COARSER index over a BINARY column — should unify case-variants
CREATE TABLE u (id integer primary key, b text) using store;   -- b is BINARY
CREATE UNIQUE INDEX ix ON u (b collate nocase);
INSERT INTO u VALUES (1, 'Bob');
INSERT INTO u VALUES (2, 'BOB');   -- memory: rejected (NOCASE index)
                                   -- store TODAY: OK (BINARY declared)        ← BUG
```

## Resolution (decided — no open options)

Make the store's **DML and maintenance** UNIQUE enforcement resolve each
constrained column's comparison collation the way memory's `checkUniqueViaIndex`
and the store's own `buildIndexEntries` already do:

```
enforcement collation for uc.columns[i]
  = (uc.derivedFromIndex
       ? schema.indexes.find(ix => ix.name === uc.derivedFromIndex)?.columns[i]?.collation
       : undefined)
    ?? schema.columns[uc.columns[i]].collation
```

Positional alignment is guaranteed: `appendIndexToTableSchema` builds the
derived UC with `columns = indexSchema.columns.map(c => c.index)`, so
`uc.columns[i]` aligns with `index.columns[i]` (same contract memory's
`findIndexForConstraint` relies on). When the index metadata is absent (a
constraint that survived without its index entry — the same case the gate
handles with `if (!index) return true`), fall back to the declared column
collation. A column-position with no explicit `COLLATE` in the index
(`index.columns[i].collation` undefined) also falls back to declared — so
behaviour is unchanged for every constraint that does not carry an explicit
index COLLATE.

Add a small private helper on `StoreTable`, e.g.
`uniqueEnforcementCollations(uc): (string | undefined)[]`, returning one
collation name per `uc.column`, and use it in:

- **`findUniqueConflict`** (`store-table.ts:1450`, the `matches` closure's
  `compareSqlValues(newRow[idx], candidate[idx], schema.columns[idx].collation)`).
- **`findUniqueConflictViaCoveringMv`** (`store-table.ts:1509`, the re-validation
  `uc.columns.some(c => compareSqlValues(... this.tableSchema!.columns[c].collation) !== 0)`).
- **`enforceSecondaryUniqueForMaintenance`** (`store-table.ts:1616`) — already
  routes through `findUniqueConflict`, so it inherits the fix; verify, don't
  duplicate.

Leave **`validateUniqueOverExistingRows`** (store-module.ts `~875`) as-is: it
serves `ADD CONSTRAINT UNIQUE` and `ALTER COLUMN … SET COLLATE`, both
*table-level* (non-derived) UNIQUE where the declared collation IS the
enforcement collation. The `CREATE UNIQUE INDEX`-over-existing-rows path is
`buildIndexEntries`, which is already correct.

**Do not change** `enforcementCollationCoversDeclared` — the audit confirmed it
is sound on both modules and becomes uniformly exact once the store enforces
under the index collation.

## Edge cases & interactions

- **Missing index metadata** (`derivedFromIndex` set, no matching
  `schema.indexes` entry): fall back to declared collation per column — must not
  throw. Mirror the gate's `if (!index) return true` tolerance.
- **No explicit index COLLATE** (`index.columns[i].collation` undefined):
  resolves to the declared column collation → byte-for-byte unchanged behaviour
  for the common case. Regression-guard a plain `CREATE UNIQUE INDEX ix ON t(b)`
  over a NOCASE column still enforces NOCASE on the store.
- **Composite index with mixed per-column collations**
  (`(a COLLATE binary, b COLLATE nocase)`): each position resolves
  independently; the helper returns per-column collations, never one
  table-level collation.
- **Covering-MV conflict path** (`findUniqueConflictViaCoveringMv`): the
  *re-validation* comparison must use the index collation (the fix). Separately
  audit candidate **generation** — `_lookupCoveringConflicts` (engine side):
  if it narrows candidates under a *finer* collation than the index's, it could
  miss a coarser-index collision before re-validation ever runs. Verify the
  candidate set is a superset of index-collation matches; if it is not, either
  widen generation or document that an explicit covering MV over a
  coarser-collation derived UNIQUE is out of scope and falls back to the
  per-scan path. Name the outcome in the review handoff.
- **Internal consistency** (the headline regression): pre-load rows via
  `buildIndexEntries` (CREATE UNIQUE INDEX over existing data) then DML — both
  must agree on what collides. Test both directions (finer + coarser index).
- **NULL columns**: SQL UNIQUE admits multiple NULLs — the per-column-NULL skip
  is unchanged and runs before any collation compare.
- **Partial UNIQUE** (`uc.predicate`): predicate-scope skip is orthogonal and
  unchanged; collation only governs the value comparison for in-scope rows.
- **Conflict resolution** (`ABORT` / `IGNORE` / `REPLACE`): all three must act
  on the index-collation conflict — e.g. `INSERT OR REPLACE` of a case-variant
  under a NOCASE index evicts the prior row on the store exactly as on memory.
- **`ALTER COLUMN … SET COLLATE` on a column under a derived index**: the
  index's own per-column collation is independent of the table column's
  collation, so enforcement stays under the index collation after the column
  collation changes. Confirm the helper reads the index entry, not the
  (possibly re-collated) column.
- **Isolation overlay** (`isolated-table.findMergedUniqueConflict`): the
  isolation layer wraps store enforcement; confirm the merge path also routes
  through the index-collation comparison (it should, if it reuses the same
  conflict scanners — verify, and extend the isolated suite if it has its own
  compare).
- **Other storage plugins**: leveldb / indexeddb / react-native-leveldb /
  nativescript-sqlite are all `KVStoreProvider`s feeding the same
  `StoreModule`/`StoreTable`; none enforce uniqueness themselves. Fixing the
  store module fixes all four — no per-plugin work, but state this explicitly in
  the handoff so the reviewer does not re-audit them.

## Tests

Key cases (TDD — write these to fail against current `main`, pass after the fix):

- **Store finer-index (case A)** — `unique-constraints.spec.ts`: NOCASE column,
  `CREATE UNIQUE INDEX (b collate binary)`; `'Bob'` then `'bob'` both insert;
  `SELECT count(*)` = 2. Cover both store scanners (plain `findUniqueConflict`
  and the covering-MV variant), mirroring the existing
  "collation-aware UNIQUE (honors column collation)" describe block that already
  exercises both.
- **Store coarser-index (case B)** — `unique-constraints.spec.ts`: BINARY
  column, `CREATE UNIQUE INDEX (b collate nocase)`; `'Bob'` then `'BOB'` →
  `UNIQUE constraint failed`; a distinct value still inserts.
- **Internal consistency** — pre-insert `'Bob'`/`'bob'` THEN
  `CREATE UNIQUE INDEX (b collate binary)` succeeds (build-time dedup under
  BINARY), and a later `INSERT 'BOB'` succeeds too (DML under the same BINARY) —
  proving build and DML agree.
- **Cross-module parity (sqllogic)** — the memory pin lives in
  `05-vtab_memory.sqllogic` (§ "Explicit unique-index collation governs
  enforcement"). Add the case-A + case-B shapes to a logic file that runs under
  **both** the default harness and `yarn test:store` (so a single assertion set
  proves parity). Verify whether `05-vtab_memory.sqllogic` itself runs under
  `test:store`; if it is memory-only, place the parity cases in a module-neutral
  logic file (e.g. a `*-unique-collation.sqllogic` exercised by both runs)
  rather than the memory-tagged file.
- **Soundness regression** — confirm `collation-soundness.spec.ts`
  (finer-index promotion / NOCASE-PK conflict) still passes; the gate is
  unchanged, but the store now matches its index-collation premise. Consider a
  store-targeted mirror of the NOCASE-PK-conflict shape if the spec is
  memory-only.

## TODO

- [ ] Add `StoreTable.uniqueEnforcementCollations(uc)` helper resolving
      per-`uc.column` collations (index per-column → declared fallback;
      tolerate missing index metadata).
- [ ] Apply it in `findUniqueConflict` and `findUniqueConflictViaCoveringMv`;
      verify `enforceSecondaryUniqueForMaintenance` inherits it.
- [ ] Audit `_lookupCoveringConflicts` candidate generation for coarser-index
      completeness; widen or document the outcome.
- [ ] Verify the isolation merge path (`findMergedUniqueConflict`) routes
      through the index-collation comparison; extend the isolated suite if not.
- [ ] Add store specs (finer / coarser / internal-consistency) to
      `unique-constraints.spec.ts`.
- [ ] Add cross-module parity sqllogic that runs under default + `test:store`.
- [ ] Leave `enforcementCollationCoversDeclared`, `reconcilePkCollations`, and
      `validateUniqueOverExistingRows` unchanged; note the audit conclusion in
      the review handoff (PK + table-level UNIQUE + the relation-key gate are
      already sound).
- [ ] Run `yarn test` (memory) and `yarn test:store` (store path); stream output
      with `tee`. Update `docs/schema.md` store-collation note if it states the
      old declared-collation enforcement for index-derived UNIQUE.
