----
description: Checking a UNIQUE constraint in the persistent store used to scan the whole table for every row inserted, making bulk inserts get slower and slower; now, when a matching index already exists, it does a fast index lookup instead.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts   # columnCanHoldText (~136); findUniqueConflictFor (~1738); findIndexForUniqueConstraint (~1774); indexSeekHonorsEnforcementCollation (~1810); findUniqueConflictViaIndex (~1855)
  - packages/quereus-store/src/common/store-module.ts   # tryIndexAccessPlan safeToHandle (~1990) — read-path guard bug fixed
  - packages/quereus-store/README.md                    # new "How a UNIQUE constraint is enforced" section
  - packages/quereus-store/test/unique-constraints.spec.ts  # 19 new tests
  - packages/quereus-store/test/pushdown.spec.ts            # 1 new read-path regression test
difficulty: hard
----

# Review: route store UNIQUE enforcement through an index point-lookup

## What shipped

`StoreTable.checkUniqueConstraints` previously answered every UNIQUE check with a
**full scan of the data store** — one scan per constrained row written, so
inserting *n* rows cost O(n²). It now picks the cheapest *sound* finder, and all
three return the identical `{pk, row}` shape so conflict resolution (ABORT /
IGNORE / REPLACE eviction) is unchanged:

1. a linked row-time covering materialized view (unchanged, still first);
2. **new** — a bounded seek into a physical secondary index realizing the
   constraint;
3. the full scan (unchanged fallback).

New code, all in `store-table.ts`:

- `findUniqueConflictFor(uc, …)` — the router. `checkUniqueConstraints` now calls
  this instead of branching inline.
- `findIndexForUniqueConstraint(uc)` — resolves the index that can serve `uc`:
  by name for an index-derived constraint (`CREATE UNIQUE INDEX`), else the first
  **full** (non-partial) index whose columns positionally equal `uc.columns`. The
  index need not itself be UNIQUE.
- `indexSeekHonorsEnforcementCollation(uc)` — the collation guard (below).
- `findUniqueConflictViaIndex(index, uc, predicate, newRow, selfPks)` — seeks
  `buildIndexPrefixBounds` over all constrained columns, iterates via
  `iterateEffective` (read-your-own-writes over pending index ops), resolves each
  entry to its live row through the data key stored as the entry's value
  (the prereq ticket's primitive), then re-validates with the *same* self-PK
  exclusion, per-column enforcement-collation compare, and partial-predicate check
  the full scan uses. The seek only narrows the candidate set; correctness still
  comes from the re-validation.

Effect: bulk insert into a UNIQUE-indexed table drops from O(n²) to roughly
O(n log n). Pinned structurally — see *Scaling* below.

## The collation guard (the load-bearing part — please attack this)

An index key's leading bytes are encoded under the **table key collation K**
(`using store(collation = …)`, default `NOCASE`) — *not* the index's declared
per-column `COLLATE`, and *not* the constraint's enforcement collation **C**
(`uniqueEnforcementCollations`: the index's per-column COLLATE for an
index-derived constraint, else the declared column collation).

So a seek fetches `{rows K-equal to newRow}` while re-validation keeps
`{rows C-equal}`. Soundness needs `{C-equal} ⊆ {K-equal}` — K must be
**coarser-or-equal** to C, per column. Admitted: non-text column; `C == K`;
`K = NOCASE` over `C = BINARY`. Everything else (`K = BINARY` over `C = NOCASE`
or `C = RTRIM`; `K = NOCASE` over `C = RTRIM`) **under-fetches** and would
silently accept a real duplicate → falls back to the full scan.

**I verified the guard is load-bearing, not decorative.** Deleting it makes three
of the new tests fail, each by *accepting a duplicate that must be rejected*:
`K=BINARY/C=NOCASE`, `K=BINARY/C=RTRIM`, `K=NOCASE/C=RTRIM`. Reviewer: this is
the one place a mistake is a silent data-corruption bug rather than a slow query.

## Extra scope: a pre-existing read-path bug found and fixed

While writing the write-side guard I found the **read-side** guard in
`StoreModule.tryIndexAccessPlan` exempted a column from the K-vs-C check with a
bare `!col.logicalType.isTextual`. That misclassifies an `ANY`-typed column: `ANY`
carries no `isTextual` marker and a NULL `physicalType`, but its `parse` is the
identity, so it stores text as text and keys it through the collation encoder.

Reproduced on plain SQL, no store internals:

```sql
create table t (id integer primary key, x ANY collate nocase) using store (collation = binary);
insert into t values (1, 'Bob');
select id from t where x = 'BOB';   -- [{id: 1}]   correct
create index ix_x on t (x);
select id from t where x = 'BOB';   -- []          WRONG — creating an index changed the answer
```

The plan marked the filter handled, seeked under `K = BINARY`, and dropped the
residual. Fixed by hoisting one shared predicate, `columnCanHoldText(col)`
(exported from `store-table.ts`, now used by both guards), which mirrors the
engine's own `isNonTextualLogicalType` — `isTextual === true || physicalType ===
TEXT || name === 'ANY'`. Both guards now agree by construction.

This is **outside the ticket's stated scope**. I fixed it inline rather than
filing a ticket because it is a reachable silent-wrong-answer, the fix is one
predicate, and it lives in the same guard family this ticket exists to get right.
Regression tests: one read-path (`pushdown.spec.ts`, pins the no-index answer as
the oracle and asserts adding an index does not change it) and one write-path
(`unique-constraints.spec.ts`). Both fail without the fix; I checked.

**A reviewer may reasonably want this split out.** If so, it is a clean revert of
the `store-module.ts` hunk + its two `ANY` tests. A DRY alternative worth
considering: export `isNonTextualLogicalType` from `@quereus/quereus` and drop
`columnCanHoldText` entirely — that is a cross-package API decision I did not want
to make unilaterally.

## Testing / validation focus

Where to push hardest, in rough priority order:

1. **The collation guard's direction.** `indexSeekHonorsEnforcementCollation`. Is
   `K = NOCASE, C = BINARY` really a superset? Is the guard missing an admitted
   case that would be *unsound* (not merely conservative)? Note `StoreTableConfig.collation`
   is typed `'BINARY' | 'NOCASE'`, so `K = RTRIM` is unreachable today — the guard
   handles it anyway by rejecting.
2. **Non-derived UC matched to an index by column set.** `findIndexForUniqueConstraint`
   requires `!ix.predicate` for that path. A partial index physically omits its
   out-of-scope rows, so seeking it for a full-table UNIQUE would miss conflicts
   among them. Test `ixq` pins this. Is the *derived* path (which allows a partial
   index, because the index's predicate is the constraint's by construction —
   `appendIndexToTableSchema`) equally safe? I believe yes; verify.
3. **Read-your-own-writes on the index store.** Pending index puts/deletes merge
   through `iterateEffective`. Tests cover: intra-transaction duplicate detected;
   in-transaction delete frees the value; a REPLACE eviction followed by a
   re-insert of the same value in one statement.
4. **Self-PK exclusion**, including the PK-change UPDATE that passes `[oldPk, newPk]`.
5. **REPLACE eviction identity** — the index finder must return the same row the
   full scan would, so `deleteRowAt` + `evicted.push` evict the right row.

New tests (19 in `unique-constraints.spec.ts` under `index-backed UNIQUE point
lookup`, 1 in `pushdown.spec.ts`): index-derived UC; non-unique index serving a
table-level UNIQUE; multiple NULLs; in-transaction RYOW conflict; in-transaction
delete-then-reinsert; self-PK UPDATE non-conflict + PK-change UPDATE; REPLACE
eviction; REPLACE-then-reinsert in one statement; composite index; DESC index
column; partial UNIQUE index scope (both directions across the predicate
boundary); partial index refused for a non-derived UC; five collation-guard cases;
the `ANY` column; and the scaling assertion.

Note that the pre-existing tests in `collation-aware UNIQUE` and `index-derived
UNIQUE honors the index per-column collation` (tables `fa`, `cb`, `cr`, `up`,
`uf`, `comp`, `pg`, `ic`) now execute the **new index path** rather than the full
scan, and all still pass unmodified. Likewise `index-persistence.spec.ts`'s
`CREATE UNIQUE INDEX survives reopen and still rejects duplicates` now exercises
the seek against a *reattached* index store.

### Scaling

Asserted structurally, not by wall-clock, so it cannot flake: a `CountingKVStore`
tallies entries yielded by each **data** store's iterators. Inserting 100 rows:

| Table | UNIQUE realized by | Data-store entries iterated |
|---|---|---|
| `bare` | table-level `UNIQUE (v)`, no index | > 1000 (Θ(n²/2)) |
| `idxd` | `CREATE UNIQUE INDEX` | **0** |

The index path resolves each candidate by data-store `get`, never by iterating it.

## Known gaps — read these before signing off

- **A plain `UNIQUE` with no matching index is still O(n²).** The store does not
  materialize an implicit per-constraint index (unlike the memory backend's
  `_uc_*`), so route 2 never applies. This is the ticket's stated scope, not an
  oversight; the remaining case is `backlog/feat-store-implicit-unique-index`.
- **`enforceSecondaryUniqueForMaintenance` is deliberately left on the full scan.**
  It serves materialized-view backing tables, which keep no secondary indexes by
  design, so there is never an index store to seek. Its doc comment now says so
  explicitly (it previously claimed parity with the DML path, which is no longer
  true).
- **The `INDEX_UNUSABLE` branch is untested.** `findUniqueConflictViaIndex` bails
  to the full scan when an index entry carries a legacy empty value (a store
  written before the prereq ticket made index values carry the data key). Skipping
  such an entry would *accept a duplicate*, so bailing is the right posture — but
  no test provider carries on-disk legacy data, so nothing exercises it. Reaching
  it requires hand-crafting an index store with an empty value. I judged that not
  worth a test given backwards compatibility is waived project-wide (`AGENTS.md`);
  disagree freely.
- **Untouched by design:** partial indexes are still never *seeked for reads*, and
  index scans still advertise no ordering. Both carried forward from the prereq.
- **JSON-typed columns** are classified never-text by `columnCanHoldText` (matching
  the engine's `isNonTextualLogicalType`). A JSON column under a UNIQUE index with
  a mismatched K/C is therefore exempted from the guard. I believe this is
  unreachable in practice and consistent with the engine, but it is the one case in
  `columnCanHoldText` I did not prove.

### Tripwire recorded (not a ticket)

- `findIndexForUniqueConstraint` re-resolves the index (and re-derives
  `uniqueEnforcementCollations`) for every constrained row written. Linear in
  `schema.indexes`, dwarfed by the seek's I/O. Parked as a `NOTE:` at the site with
  the durable fix (memoize per frozen `UniqueConstraintSchema` in a `WeakMap`, like
  the neighbouring `predicateCache`).

## Validation

All green, nothing skipped or disabled:

- `@quereus/store` unit suite: **745 passing, 0 failing** (was 725 — 20 added).
- Store-path SQL logic suite (`packages/quereus && node test-runner.mjs --store`):
  **6546 passing, 14 pending, 0 failing** — identical to the prereq baseline.
- `@quereus/isolation`: **146 passing** (its overlay merge depends on index-key
  emission order).
- `yarn test` (full monorepo, memory-backed): **0 failing** across every workspace.
- `yarn workspace @quereus/store run build` (the store's only real typecheck — its
  `lint` script is an intentional no-op): clean.
- `yarn lint`: clean.

Guard-removal checks I ran deliberately (each confirms the test is discriminating,
not merely passing): removing the collation guard fails 3 tests; removing the
`name === 'ANY'` clause fails 2 tests. Both restored.
