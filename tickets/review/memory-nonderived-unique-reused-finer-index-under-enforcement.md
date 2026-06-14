description: Review the memory-module fix for a non-derived UNIQUE under-enforcing when a pre-existing FINER same-column-set `CREATE UNIQUE INDEX` already covers the column-set. Realization now refuses to reuse a collation-mismatched index (builds the constraint's own `_uc_*`), and `findIndexForConstraint` resolves a non-derived UC to its OWN realizing structure by name. Store was already correct; memory-only fix + cross-module sqllogic.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # indexCollationsMatchDeclared helper (~219); ensureUniqueConstraintIndexes guard (~177); addUniqueConstraint guard (~2410); findIndexForConstraint non-derived by-name resolution (~1054)
  - packages/quereus/src/schema/unique-enforcement.ts                  # uniqueEnforcementCollations (reference; unchanged)
  - packages/quereus/src/util/comparison.ts                            # normalizeCollationName (now imported into manager.ts)
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # §12 added (both orders + BINARY-index survives + drop lifecycle); runs under memory AND store
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # resolveLiveIndex mirrors new resolution; two non-derived+finer-index shapes added
difficulty: medium
----

# Review: non-derived UNIQUE under-enforcement when realized by a pre-existing finer same-column-set index

## What the bug was

Under the **memory** module only, this DDL order silently admitted a duplicate:

```sql
create table t (id integer primary key, b text collate nocase);
create unique index ix_binary on t (b collate binary);   -- FINER, created FIRST
alter table t add constraint uq unique (b);              -- non-derived NOCASE UNIQUE
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- was ADMITTED (count=2); must be REJECTED (NOCASE)
```

A non-derived (table-level / column) UNIQUE must always enforce under its **declared
column collation** (NOCASE here), independent of any user index and of DDL order. The
mirror order (constraint first, index second) already enforced correctly, so the bug was
**order-sensitive**. SQLite and the store module reject the second insert. The sibling fix
`memory-multi-index-unique-collation-resolution` only rerouted *derived* UCs (by
`uc.derivedFromIndex`); this UC is **non-derived**, so it survived that fix.

## Root cause (three reinforcing spots in the memory module)

1. **`addUniqueConstraint`** (the `ALTER TABLE … ADD CONSTRAINT … UNIQUE` path) reused any
   *unique* same-column-set index as the constraint's realizing structure **regardless of
   collation** — registering `ix_binary` (BINARY) as the covering structure and never
   building a NOCASE `_uc_*`.
2. **`ensureUniqueConstraintIndexes`** (constructor / rebuild path) reused **any**
   same-column-set index with the same collation-blindness (reachable when a manager is
   reconstructed from a schema already carrying both index and constraint).
3. **`findIndexForConstraint`** resolved a non-derived UC by a column-set scan returning the
   **first** same-column-set index — so even after a correct `_uc_*` exists, the
   earlier-listed `ix_binary` won, and `checkUniqueViaIndex` compared under BINARY (the
   wrongly-keyed BTree generates no NOCASE candidates).

## The fix (memory-only; store unchanged)

- **Realization guard** — new private helper `indexCollationsMatchDeclared(idx, uc)`
  (manager.ts ~219): per-column `normalizeCollationName(idx.columns[i].collation ?? declared)
  === normalizeCollationName(declared)`. Both reuse sites (`addUniqueConstraint`,
  `ensureUniqueConstraintIndexes`) now reuse an existing same-column-set index **only when
  collation-equivalent**; otherwise they fall through to build the constraint's own
  declared-collation `_uc_*` index and let the user index coexist as an independent
  constraint (matches SQLite — both indexes enforce). A plain index column
  (`collation === undefined`) falls back to the declared collation, so the common case is
  reuse-safe and unaffected.
- **Resolution** — `findIndexForConstraint` (manager.ts ~1054) now resolves a non-derived UC
  to its OWN realizing structure **by name** via `getImplicitCoveringStructure(uc)` before
  the column-set scan (the scan is kept as a defensive fallback). Robust to `schema.indexes`
  ordering once the realization guard has built `_uc_*`.
- `normalizeCollationName` imported into manager.ts.

Both halves are required: realization alone leaves `findIndexForConstraint` returning the
earlier-listed `ix_binary`; resolution alone has no NOCASE structure to find if reuse already
collapsed onto the finer index.

## How to validate / use cases exercised

Memory **and** store (sqllogic `102.2-unique-collation.sqllogic §12`):
- **12a** index-first: `create unique index ix_binary (b collate BINARY)` then
  `alter table … add constraint uq unique (b)` → `'Bob'` then `'bob'` REJECTED; a distinct
  `'Carol'` still inserts.
- **12b** constraint-first: `create table (… unique (b))` then the finer index → same NOCASE
  enforcement (order-independence).
- **12c** lifecycle: `alter table mif drop constraint uq` leaves the user's BINARY index
  (`mif_binary`) enforcing — a NOCASE-variant `'BOB'` is now ADMITTED while a byte-exact
  `'Bob'` duplicate is still REJECTED (proof the user index survived; the "reused name doubles
  as the realizing name" ambiguity is gone because the named constraint built its own index).

Conformance lock (`unique-enforcement-collation.spec.ts`):
- `resolveLiveIndex` updated to mirror the new non-derived by-name resolution (via
  `manager.getImplicitCoveringStructure`).
- Two new shapes: `non-derived + finer index, same column-set` in both creation orders.
  Each asserts the derived UC (`ix_binary`) enforces BINARY and the non-derived UC enforces
  NOCASE, with `live-index path == uniqueEnforcementCollations(schema, uc)` per column.

### Commands
- `yarn workspace @quereus/quereus run test` → **6285 passing, 9 pending** (full memory suite).
- `yarn workspace @quereus/quereus run lint` → clean (eslint + tsc test-file type-check).
- `yarn workspace @quereus/quereus run test:store --grep "102.2-unique-collation"` → 1 passing
  (store rejects both orders + drop lifecycle, unchanged).

## Known gaps / where to probe (treat tests as a floor)

- **No MV variant in §12.** This shape has no materialized view; the covering-MV eligibility
  gate (`coveringMvHonorsIndexCollation`) keys off the declared collation, so it is unaffected
  by reasoning — but I added no §12 row-time-covering-MV case. A reviewer wanting full coverage
  could add a covering MV over the §12 table and confirm enforcement still routes correctly
  (the non-derived UC's declared NOCASE must win regardless of the MV).
- **OR REPLACE / OR IGNORE with two coexisting unique structures.** After the fix a NOCASE
  `_uc_*` and a finer BINARY user index both enforce. §12 only exercises default-ABORT
  inserts. Worth probing OR REPLACE / OR IGNORE on a value that is NOCASE-duplicate but
  BINARY-distinct (the NOCASE structure should drive the conflict; the BINARY index should not
  raise a false conflict) and a byte-exact value (both conflict). Expected to match SQLite's
  "all conflicting rows evicted" semantics, but not directly asserted here.
- **Named-constraint name collision** (a pre-existing user index already named like the new
  constraint) is a known out-of-scope edge — not expanded, and believed not regressed (the
  named constraint now builds its own index named after the constraint), but not tested.
- **Conformance-lock coupling.** `resolveLiveIndex` was edited to mirror the source; the
  spec therefore locks `helper == live-path-mirror`, not the source directly. The
  *behavioral* guard against a source revert is the §12 sqllogic (count would go to 2 on
  index-first). Both layers are green.
- The realization guard assumes positional alignment of `idx.columns[i]` with `uc.columns[i]`,
  which holds because the column-SET predicate (`.every((col,i) => col.index === uc.columns[i])`)
  short-circuits to the left of the helper call in both `.find(...)` predicates. Confirm this
  ordering is preserved if either predicate is refactored.
