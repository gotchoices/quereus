description: Checking a UNIQUE constraint in the persistent store scans the whole table for every inserted row, making bulk inserts quadratically slow; when a matching index already exists on disk, do a fast index lookup instead.
prereq: store-index-scan-read-primitive
files:
  - packages/quereus-store/src/common/store-table.ts   # checkUniqueConstraints (~1388); findUniqueConflict full-scan (~1451); uniqueEnforcementCollations use (~1467)
  - packages/quereus-store/src/common/store-module.ts   # buildIndexEntries (index-derived UC created via createIndex ~739)
  - packages/quereus/src/schema/table.ts                # UniqueConstraintSchema.derivedFromIndex / coveringStructureName / columns
  - packages/quereus-store/test/unique-constraints.spec.ts
  - packages/quereus-store/test/index-persistence.spec.ts
difficulty: hard
----

# Store: route UNIQUE enforcement through an index point-lookup

## Problem

`checkUniqueConstraints` (store-table.ts ~1388) → `findUniqueConflict` (~1451)
scans the **entire** data store (`buildFullScanBounds`) for each row checked,
once per constraint. Inserting *n* rows into a table with a UNIQUE constraint is
O(n²): row *k* re-scans the *k* already-present rows. When a physical secondary
index already covers the constraint's columns, the conflicting row can be found by
a point lookup into that index instead (O(log n)/O(1)-ish), turning bulk insert
into roughly O(n log n).

## Scope of THIS ticket (read carefully — it is deliberately narrow)

The store builds a physical index store **only** for explicit `CREATE INDEX` /
`CREATE UNIQUE INDEX` (via `StoreModule.createIndex`). A plain column- or
table-level `UNIQUE` (declared at `CREATE TABLE` or `ADD CONSTRAINT UNIQUE`) has
a `uniqueConstraints` entry but **no** backing index store — the store, unlike the
memory backend, does not materialize implicit `_uc_*` indexes (see
`schema/table.ts` `exposedIndexTags` doc comment).

Therefore this ticket speeds up **only** UNIQUE constraints that already have a
usable physical store index:

- an **index-derived** UC (`derivedFromIndex` set — from `CREATE UNIQUE INDEX`),
  whose named index is in `schema.indexes`; and
- any other UC whose exact column set matches an existing `schema.indexes` entry
  with collation-compatible columns (see the collation guard below).

For a UC with **no** usable physical index, keep the existing `findUniqueConflict`
full-scan path unchanged. Making the point-lookup universal (materializing an
implicit per-UC index in the store) is a separate, larger feature — parked in
`backlog/feat-store-implicit-unique-index`. Reference it in the handoff so the
remaining O(n²) case for plain `UNIQUE` is not mistaken for an oversight.

## Design

Add an index-point-lookup conflict finder alongside `findUniqueConflict`, and pick
it in `checkUniqueConstraints` when a usable index exists:

- `findIndexForUniqueConstraint(uc): TableIndexSchema | undefined` — return the
  `schema.indexes` entry realizing `uc`:
  - if `uc.derivedFromIndex` is set, the index of that name;
  - else the first index whose `columns.map(c=>c.index)` equals `uc.columns`
    (order-sensitive) **and** passes the collation guard.
  Return undefined otherwise.
- `findUniqueConflictViaIndex(index, uc, predicate, newRow, selfPks)` — the index
  analogue of `findUniqueConflict`, built on the scan primitive from
  `store-index-scan-read-primitive`:
  - Seek the index by the UC column values as a leading-prefix point:
    `buildIndexPrefixBounds(newRow-at-uc.columns, {collation: K}, indexDirections)`.
  - Iterate `iterateEffective(indexStore, bounds)` (read-your-own-writes over
    pending index ops).
  - Resolve each entry to its **live** row via `readEffectiveRowByKey(entry.value)`
    (the data key now stored in the index value by the prereq ticket). Skip a
    resolved-null (pending-deleted) row.
  - Re-validate exactly as `findUniqueConflict` does: skip if the resolved row's PK
    is in `selfPks`; compare each UC column under its enforcement collation
    (`uniqueEnforcementCollations(schema, uc)` — unchanged); skip if a partial
    `predicate` does not evaluate TRUE on the resolved row. Return the first real
    conflict `{pk, row}` or null.
  This keeps the *authoritative* comparison identical to the full-scan path — the
  index seek only narrows the **candidate set** to a superset; correctness comes
  from the same re-validation that already exists.
- In `checkUniqueConstraints` (store-table.ts ~1416), before calling
  `findUniqueConflict`, resolve the index: if the covering-MV route is not taken
  and `findIndexForUniqueConstraint(uc)` returns an index, call
  `findUniqueConflictViaIndex`; otherwise fall back to `findUniqueConflict`. The
  covering-MV branch (`findUniqueConflictViaCoveringMv`) keeps priority as today.

## Collation guard (mandatory — prevents missed conflicts)

The physical index-column bytes are encoded under the table key collation **K**
(default `NOCASE`), NOT the index's per-column declared collation nor the
constraint's enforcement collation. A point seek under K returns every entry
byte-equal under K. That is a safe **superset** of the true conflict set only when
K is **coarser-or-equal** to the enforcement collation for that column; if K is
**finer** than the enforcement collation, a single point seek UNDER-fetches and a
real duplicate is missed (silent wrong results / accepted duplicate).

Concretely: enforcement collation comes from `uniqueEnforcementCollations` (the
index's per-column COLLATE for a derived UC, else the declared column collation).

- Safe to use the index seek when, for every UC column, the column is non-text, OR
  K equals the enforcement collation, OR K is coarser than it (e.g. K=`NOCASE`,
  enforcement=`BINARY`).
- If K is finer than the enforcement collation for any covered column (only
  possible when the table key collation is `BINARY` and enforcement is
  `NOCASE`/`RTRIM`), **fall back to `findUniqueConflict`** for that UC.
- If K has no registered byte encoder (`getCollationEncoder(K) === undefined`),
  fall back to the full scan.

Mirror the reasoning already documented for `store-index-derived-unique-honors-
index-collation` (complete) — that ticket made the enforcement re-validation
correct; this ticket must not weaken it by under-fetching candidates.

## Edge cases & interactions

- **UNIQUE across NULLs.** SQL allows multiple NULLs. `checkUniqueConstraints`
  already `continue`s when any covered column is NULL (~1400), so the index seek is
  never reached for a NULL key — but assert it: two rows with NULL in the unique
  column must both insert. (A NULL leading key would also encode to a type-tagged
  key that must not be treated as a collision even if reached.)
- **Self-PK exclusion.** UPDATE passes `selfPks` (`[oldPk]`, or `[oldPk,newPk]` on
  a PK-change relocation). The resolved row's PK must be compared against every
  entry in `selfPks` and skipped — identical to `findUniqueConflict`. Test: UPDATE
  that keeps the unique value unchanged (same row) must not self-conflict; UPDATE
  that moves the unique value onto another row's value must conflict.
- **Read-your-own-writes.** Within a transaction: insert row A with unique value
  v; inserting row B with value v must conflict (pending-over-committed on the
  index). Delete A within the txn, re-insert B with v — must succeed. The pending
  index merge + live re-check via `readEffectiveRowByKey` deliver this; test it
  (extend `unique-constraints.spec.ts` with an in-transaction case).
- **REPLACE / IGNORE conflict actions.** The conflict `{pk,row}` returned feeds the
  existing action resolution (`effective = onConflict ?? uc.defaultConflict ??
  ABORT`) and REPLACE eviction (`deleteRowAt` + `evicted.push`) unchanged. The
  index path must return the SAME shape so REPLACE evicts the right row. Test a
  bulk INSERT ... ON CONFLICT REPLACE against a unique index.
- **Partial UNIQUE.** For a partial UC (`uc.predicate` set, backed by a partial
  `CREATE UNIQUE INDEX ... WHERE`), the index physically holds only in-scope rows,
  so a seek already excludes out-of-scope candidates; the predicate re-check on the
  resolved row is retained as defense in depth. Test that an out-of-scope duplicate
  does not conflict and an in-scope duplicate does.
- **Composite unique index.** A multi-column UC seeks a leading-prefix point over
  all its columns; ensure the seek encodes ALL uc.columns (not just the first) and
  the resolved re-check compares all columns.
- **`enforceSecondaryUniqueForMaintenance`** (store-table.ts ~1645) also calls
  `findUniqueConflict` (for MV-backing maintenance writes). Leave it on the
  full-scan path for now (backing tables keep no indexes by design — see its doc
  comment); do NOT route it through the index finder. Note this in the handoff.
- **Index maintenance ordering vs. the check.** The UNIQUE check runs BEFORE the
  row's own index put (`updateSecondaryIndexes` is called after
  `checkUniqueConstraints` in the insert/update arms). So the seeking row's own
  entry is not yet present and cannot self-match — but a prior REPLACE eviction in
  the same statement may have queued an index delete; the pending merge must
  reflect it. Covered by the effective-merge + self-PK skip; add a targeted test if
  a REPLACE-then-insert of the same value occurs in one statement.

## TODO

- Add `findIndexForUniqueConstraint(uc)` with the collation guard.
- Add `findUniqueConflictViaIndex(index, uc, predicate, newRow, selfPks)` built on
  the prereq scan primitive (`iterateEffective(indexStore, …)` +
  `readEffectiveRowByKey(entry.value)` + the same re-validation as
  `findUniqueConflict`).
- Branch `checkUniqueConstraints` to prefer the index finder when a usable index
  exists (after the covering-MV route, before the full-scan finder).
- Tests: extend `unique-constraints.spec.ts` (index-derived UC point lookup;
  in-transaction RYOW conflict; self-PK UPDATE non-conflict; REPLACE eviction via
  index; composite unique index; partial unique index scope; NULL multi-insert;
  collation-guard fallback case with a BINARY table key collation over a NOCASE
  enforcement). Add a scaling smoke test asserting a bulk insert into a
  UNIQUE-indexed table completes without the O(n²) blow-up (row-count large enough
  to be slow under full-scan but fast under the index — keep it modest to respect
  the idle-timeout).
- Run `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/store-unit.log`
  and `yarn lint`. Defer the slow `yarn test:store` SQL-logic suite to CI/reviewer
  if wall-clock is tight; say so honestly in the handoff.
