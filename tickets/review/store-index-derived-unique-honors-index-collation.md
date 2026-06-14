description: Store DML + isolation-merge UNIQUE enforcement for a CREATE UNIQUE INDEX … (col COLLATE x)-derived constraint now resolves each column's comparison collation from the index's per-column COLLATE (falling back to the declared column collation), matching the memory module (checkUniqueViaIndex), the store's own buildIndexEntries build-time dedup, and SQLite. A discovered prerequisite — the store's ALTER COLUMN SET COLLATE did not propagate the new collation into derived-index columns (memory does) — was also fixed, since the stale index metadata would otherwise mis-enforce after an ALTER.
files:
  - packages/quereus-store/src/common/store-table.ts                  # uniqueEnforcementCollations helper; findUniqueConflict + findUniqueConflictViaCoveringMv use it; enforceSecondaryUniqueForMaintenance inherits via findUniqueConflict
  - packages/quereus-store/src/common/store-module.ts                 # alterColumn SET COLLATE now propagates the new collation into derived-index columns (metadata-only)
  - packages/quereus-isolation/src/isolated-table.ts                  # uniqueEnforcementCollations helper; findMergedUniqueConflict uses it
  - packages/quereus-store/test/unique-constraints.spec.ts            # new "index-derived UNIQUE honors the index per-column collation" describe block
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic       # new §9 cross-module parity (per-scan path)
  - docs/schema.md                                                    # store-collation § new "Index-derived UNIQUE enforcement collation" note
  - tickets/backlog/covering-mv-index-derived-unique-collation.md     # follow-up filed for the engine-side covering-MV residuals
----

# Review: store index-derived UNIQUE honors the index's per-column collation

## What changed

A `CREATE UNIQUE INDEX ix ON t (col COLLATE x)` synthesizes a `derivedFromIndex` UNIQUE
constraint. The store's DML write path compared constrained columns under the **declared
column collation**, ignoring the index's `COLLATE` — diverging from (a) the memory module,
which enforces under the index collation (`checkUniqueViaIndex`), (b) SQLite (a unique index
enforces under the index's collation), and (c) the store's OWN `buildIndexEntries`, which
already dedups existing rows under the index collation. So `CREATE UNIQUE INDEX`-over-existing
rows and subsequent INSERTs disagreed on what collides.

**Fix.** A new private helper resolves one comparison collation per `uc.column`:

```
uc.derivedFromIndex
  ? schema.indexes.find(ix => ix.name === uc.derivedFromIndex)?.columns[i]?.collation
  : undefined
  ?? schema.columns[uc.columns[i]].collation
```

Applied at three enforcement sites:

- `StoreTable.findUniqueConflict` — the per-scan DML path (also inherited by
  `enforceSecondaryUniqueForMaintenance`, verified — it routes through `findUniqueConflict`).
- `StoreTable.findUniqueConflictViaCoveringMv` — the covering-MV re-validation.
- `IsolatedTable.findMergedUniqueConflict` — the isolation overlay's merge-view check, which
  has its OWN compare (does not reuse the store scanners), so it needed its own copy of the
  helper to stay in lockstep.

Positional alignment of `uc.columns[i]` ↔ `index.columns[i]` is guaranteed by
`appendIndexToTableSchema` (`columns = indexSchema.columns.map(c => c.index)`). Missing index
metadata or a column with no explicit index COLLATE both fall back to the declared column
collation, so behavior is byte-for-byte unchanged for every constraint that does not carry an
explicit, differing index COLLATE.

### Discovered prerequisite: ALTER COLUMN SET COLLATE index-collation propagation (store)

`buildIndexSchema` **stamps** each index column's resolved collation at creation (explicit
COLLATE → column collation → BINARY); it is never left undefined. Memory's
`ALTER COLUMN … SET COLLATE` handler propagates the new column collation into index columns
that order by the column (`manager.ts:1909`); the **store's did not**, leaving the derived
index's stamped collation stale. The old store enforcement masked this by reading the *live
column* collation; once enforcement reads the *index* collation, the stale metadata mis-enforces
after an ALTER. So `store-module.ts`'s `setCollation` branch now propagates the new collation
into derived-index columns too — **metadata-only** (the store's index *key* bytes use the
table-level collation K, so no entry re-encode), mirroring memory. This is what makes
`41.7.2-alter-column-collate-unique-store.sqllogic` §4/§6 pass under the new enforcement.

## Use cases / behavior to validate

| DDL | Insert sequence | Expected | Why |
|---|---|---|---|
| `b text collate nocase`, `unique index (b collate binary)` | `'Bob'`, `'bob'` | both admitted (count 2) | finer index keeps case-variants distinct |
| `b text` (BINARY), `unique index (b collate nocase)` | `'Bob'`, then `'BOB'` | second rejected | coarser index folds case |
| `b text collate nocase`, pre-insert `'Bob'`,`'bob'`, THEN `unique index (b collate binary)`, then `'BOB'` | build ok; `'BOB'` admitted | build + DML agree under BINARY (internal consistency) |
| `b text collate nocase`, `unique index (b)` (no COLLATE) | `'Bob'`, `'bob'` | second rejected | falls back to declared NOCASE (regression guard) |
| `unique index (a collate binary, b collate nocase)` | `('x','Y')`, `('x','y')` | second rejected; `('X','y')` admitted | per-column collations resolved independently |
| coarser index + `INSERT OR IGNORE` / `OR REPLACE` of a case-variant | ignore drops / replace evicts | conflict resolution acts on the index-collation conflict |
| `unique index (col)`; `ALTER COLUMN col SET COLLATE nocase`; insert case-variant | rejected | ALTER propagates NOCASE into the index → enforcement follows |

## Tests added / exercised

- `packages/quereus-store/test/unique-constraints.spec.ts` — new describe block (7 cases:
  finer plain-scan, finer covering-MV, coarser plain-scan, build-vs-DML internal consistency,
  no-COLLATE regression guard, composite mixed collations, OR IGNORE/REPLACE). Covers both
  store scanners (`findUniqueConflict` + `findUniqueConflictViaCoveringMv`).
- `packages/quereus/test/logic/102.2-unique-collation.sqllogic` §9 — cross-module parity
  (finer 9a, coarser 9b, no-COLLATE fallback 9c) via the **per-scan / auto-index path**, run
  under both `yarn test` (memory) and `yarn test:store`. In store mode the logic suite runs
  through the **isolation layer**, so §9 also exercises the `findMergedUniqueConflict` fix.

### Full test results (all green)
- `yarn test` (memory, all logic + unit): **6231 passing**, 9 pending.
- `yarn test:store` (full store-mode logic): **6227 passing**.
- `@quereus/store` package suite: **570 passing**. `@quereus/isolation`: **126 passing**.
- store + isolation `tsc` build & `typecheck`: clean.

## Honest gaps / where to push (reviewer: treat tests as a floor)

1. **Covering-MV path for an index-derived UNIQUE is only partially aligned — backlog filed
   (`covering-mv-index-derived-unique-collation`).** The store's MV *re-validation* now uses
   the index collation, but:
   - the engine candidate generator (`lookupCoveringConflicts`) still narrows under the
     **declared** collation. For a *finer* index that is a superset → store end-to-end correct;
     for a *coarser* index it is a **subset** → a covering-MV-enforced coarser derived UNIQUE
     can miss a conflict. (The per-scan path — no covering MV — is fully correct.)
   - **memory's** `checkUniqueViaMaterializedView` re-validates under the **declared** collation,
     so for a *finer* index-derived UNIQUE enforced through a covering MV, **store now admits a
     case-variant memory rejects** — a divergence I introduced by following the ticket's
     instruction to fix the store MV path. The `fam` spec asserts the store (correct) side and
     is commented as store-only. Reviewer decision point: keep the store ahead (and let the
     backlog ticket bring memory + candidate-gen in line) vs. revert the store MV path to
     declared collation to stay lockstep with memory until the engine fix lands. I judged
     "keep + document + file follow-up" most faithful to the ticket, but it is the one place the
     change is debatable.

2. **ALTER COLUMN SET COLLATE clobbers an explicit, differing index COLLATE.** The store
   propagation (like memory's) re-collates **every** index column referencing the altered
   column, including one with an explicit `COLLATE` that differs from the column. No surface
   preserves a differing index COLLATE across an `ALTER COLUMN SET COLLATE` on its column — on
   **either** module (memory has done this all along). Acceptable for parity; flagged in case
   the intended semantic is "explicit index COLLATE is independent." No test pins the
   clobbering direction either way.

3. **`validateUniqueOverExistingRows` (ALTER-time existing-row re-validation) unchanged** — per
   the audit it serves table-level UNIQUE where declared == enforcement, and after the new
   propagation the index collation == column collation post-ALTER, so it stays consistent. Left
   as-is per the ticket.

## Audit conclusions (no code change — confirm and move on)

- **`enforcementCollationCoversDeclared` (the relation-key gate) is unchanged and sound.** It
  under-promotes (a `(col COLLATE BINARY)` index over a NOCASE column), never over-claims; store
  enforcement is now uniformly at-or-coarser-than output, so any promoted constraint trivially
  holds. The gate's index-collation premise is now exactly met on the store per-scan path.
- **PK enforcement (`reconcilePkCollations`) unchanged and sound** — reconcile forces an
  implicit text PK column's declared collation to the key collation, so declared == key ==
  enforcement; the reload path round-trips a non-BINARY PK collation as an explicit COLLATE.
- **Table-level / column UNIQUE unchanged** — declared IS the enforcement collation (helper
  returns the declared collation for any non-`derivedFromIndex` constraint).
- **`collation-soundness.spec.ts` unchanged and green** (memory gate tests; the store now
  matches its index-collation premise).

## Other storage plugins — no per-plugin work

leveldb / indexeddb / react-native-leveldb / nativescript-sqlite are all `KVStoreProvider`s
feeding the same `StoreModule` / `StoreTable`; none enforce uniqueness themselves. Fixing the
store module fixes all four. (The store-mode logic suite runs over LevelDB and is green.)
