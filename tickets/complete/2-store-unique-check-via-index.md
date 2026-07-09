----
description: Checking a UNIQUE constraint in the persistent store used to scan the whole table for every row inserted, making bulk inserts get slower and slower; now, when a matching index already exists, it does a fast index lookup instead.
files:
  - packages/quereus-store/src/common/store-table.ts   # columnCanHoldText; findUniqueConflictFor; findIndexForUniqueConstraint; indexSeekHonorsEnforcementCollation; findUniqueConflictViaIndex
  - packages/quereus-store/src/common/store-module.ts  # tryIndexAccessPlan safeToHandle; createIndex; buildIndexEntries
  - packages/quereus-store/README.md                   # "How a UNIQUE constraint is enforced"
  - packages/quereus-store/test/unique-constraints.spec.ts  # 23 new tests
  - packages/quereus-store/test/pushdown.spec.ts            # 1 read-path regression test
----

# Complete: route store UNIQUE enforcement through an index point-lookup

## What shipped

`StoreTable.checkUniqueConstraints` used to answer every UNIQUE check with a full
scan of the data store — one scan per constrained row written, so inserting *n*
rows cost O(n²). It now routes each constraint to the cheapest **sound** finder,
all three returning the same `{pk, row}` shape so conflict resolution (ABORT /
IGNORE / REPLACE eviction) is unchanged:

1. a linked row-time covering materialized view (unchanged, still first);
2. a bounded seek into a physical secondary index realizing the constraint (new);
3. the full scan (unchanged fallback).

The seek only *narrows the candidate set*; correctness still comes from
re-validating each candidate exactly as the full scan does — self-PK exclusion,
per-column enforcement-collation compare, partial-predicate check.

The load-bearing piece is `indexSeekHonorsEnforcementCollation`. Index-key bytes
are encoded under the **table key collation K**, while the constraint is enforced
under collation **C**. A seek fetches `{rows K-equal to the new row}` and
re-validation keeps `{rows C-equal}`, so soundness requires `{C-equal} ⊆
{K-equal}` — K must be coarser-or-equal to C per column. When it is not, the
constraint falls back to the full scan.

Effect: bulk insert into a UNIQUE-indexed table drops from O(n²) to roughly
O(n log n), pinned structurally by a counting KV store rather than by wall-clock.

Also fixed during implement (outside the ticket's stated scope, kept inline
because it is the same guard family): the read-side guard in
`StoreModule.tryIndexAccessPlan` exempted an `ANY` column from the K-vs-C check,
so creating an index changed the answer to `select … where x = 'BOB'`.

## Review findings

### Checked and clean

- **Guard direction.** `K = NOCASE ⊇ C = BINARY` verified: BINARY-equality is
  byte-identity, so every BINARY-equal pair is NOCASE-equal; the seek window is a
  superset and the BINARY re-validation narrows it back. No admitted case is
  unsound. `K = RTRIM` is unreachable (`StoreTableConfig.collation` is typed
  `'BINARY' | 'NOCASE'`) and rejected anyway. A custom registered collation for C
  matches no admitted case and falls back to the full scan.
- **Derived-UC path with a partial index.** Sound. `appendIndexToTableSchema`
  copies the index's columns *and* its predicate onto the derived constraint, so
  `uc.predicate === index.predicate` and `uc.columns[i] === index.columns[i].index`
  by construction. `checkUniqueConstraints` has already skipped an out-of-scope new
  row before the seek, and the index physically holds every in-scope row. The
  positional alignment `findUniqueConflictViaIndex` relies on (values from
  `uc.columns`, DESC flags from `index.columns`) is guaranteed by the same
  construction; the non-derived path checks it explicitly.
- **Non-derived UC matched by column set.** Requires `!ix.predicate`, correctly —
  a partial index omits its out-of-scope rows. The index's own per-column `COLLATE`
  is irrelevant to the seek (index bytes use K, not the index collation), so
  ignoring it is right. Verified `drop index` reverts the constraint to the full
  scan and still rejects duplicates.
- **Byte windows.** `buildIndexPrefixBounds` over all constrained columns is a
  correct prefix of the full index key (self-delimiting per-column encodings; DESC
  inversion and per-column collation apply column-locally). An all-`0xff` prefix
  drops the upper bound, which is a superset — safe. NULL keys never reach the seek:
  `checkUniqueConstraints` skips a constraint whose new row has a NULL in any
  covered column.
- **Read-your-own-writes**, self-PK exclusion (including the PK-change UPDATE that
  passes `[oldPk, newPk]`), and REPLACE eviction identity: all exercised by the
  implementer's tests and re-read against `iterateEffective`'s merge. A UNIQUE
  constraint admits at most one conflicting row, so the index finder and the full
  scan cannot pick different victims.
- **Lint, build, and every suite** pass (see *Validation*). Docs: the README section
  added by implement was read and is accurate; it has been extended for the two
  findings below. `enforceSecondaryUniqueForMaintenance`'s doc comment correctly
  states why it stays on the full scan.

### Major — found, fixed inline

Both are silent data-corruption bugs, both narrow one-site fixes, both now pinned by
regression tests that were confirmed to fail before the fix.

- **Regression introduced by this ticket: `CREATE INDEX` inside an open transaction
  left the transaction's own rows unindexed, and the new seek trusts the index.**
  `buildIndexEntries` populated the new index from the raw committed row stream.
  Before this ticket that only produced a stale index (a read-path bug); now the
  UNIQUE check *seeks* that index, so:

  ```sql
  begin;
  insert into t values (1, 'a');
  create unique index ix on t (v);   -- doesn't see row 1
  insert into t values (2, 'a');     -- silently ACCEPTED
  ```

  Pre-ticket the full scan merged pending writes and rejected this. Fixed by having
  `createIndex` pass the table's **effective** row stream
  (`StoreTable.iterateEffectiveEntries` — committed merged with pending) to
  `buildIndexEntries`; `rebuildSecondaryIndexes` keeps the raw stream, because it
  runs right after an ALTER re-encodes the data store and any pending ops still
  address the pre-ALTER key bytes. `CREATE UNIQUE INDEX` over pending duplicates now
  fails its in-pass check too. Entries written for rows a later `ROLLBACK` discards
  are harmless — every reader resolves an entry to its live row and drops it when the
  row is gone or no longer matches — and there is a test for exactly that.
  `packages/quereus-store/src/common/store-module.ts`,
  three tests under *an index created mid-transaction indexes the pending rows*.

- **The collation guard exempted `JSON` columns, which do hold text.** The
  implementer flagged this as "the one case in `columnCanHoldText` I did not prove"
  and believed it unreachable. It is reachable, and it accepts a duplicate:

  ```sql
  create table j (id integer primary key, j json) using store (collation = binary);
  create unique index ixj on j (j collate nocase);
  insert into j values (1, '"Bob"');
  insert into j values (2, '"BOB"');   -- was ACCEPTED; C = NOCASE says it is a dup
  ```

  `JSON_TYPE.parse` passes a JSON scalar string through unchanged, so the column
  stores the plain string `Bob` and keys it through the collation encoder — exactly
  like `ANY`. (A column-level `collate` on a JSON column is rejected by DDL, which is
  why the implementer read it as unreachable; an *index*-level `collate` is not.)
  Fixed by rewriting `columnCanHoldText` as an allow-list over physical
  representation — `INTEGER`, `REAL`, `BLOB`, `BOOLEAN` are provably never strings;
  everything else (`TEXT`, `ANY`'s `NULL`, `JSON`'s `OBJECT`) may be. This also
  retires the `name === 'ANY'` escape hatch, which would have needed a new clause for
  every future string-capable type. The store's predicate is now deliberately
  *stricter* than the engine's `isNonTextualLogicalType`; erring conservative costs an
  index seek, never correctness. `packages/quereus-store/src/common/store-table.ts`,
  one test in *collation guard*.

### Major — filed as new tickets

- `backlog/bug-ddl-validation-ignores-uncommitted-rows` — the same
  committed-only-read the fix above corrected in the store's `createIndex` still
  exists in the **memory** backend's `populateNewIndex` (reproduced: it accepts a
  duplicate under a freshly created UNIQUE index) and in the store's
  `validateUniqueOverExistingRows` (the `ADD CONSTRAINT … UNIQUE` validator). Neither
  is in this ticket's diff. The ticket also asks for the underlying decision — whether
  DDL is auto-committing or participates in the transaction — to be made explicitly.

- `backlog/bug-json-columns-classified-as-non-textual` — the engine's
  `isNonTextualLogicalType` has the same JSON hole the store's copy just had. Its
  caller decides whether an equality may mint value-level planner facts, which is
  unsound under a collation that is not byte-identity. I did not construct a wrong
  query result from the planner path; the store-side analogue is proven. The ticket
  also carries the DRY follow-up: once the engine's predicate is correct, export it
  and delete the store's copy.

### Speculative / conditional — recorded, not ticketed

- The implementer's tripwire stands: `findIndexForUniqueConstraint` re-resolves the
  index and re-derives `uniqueEnforcementCollations` for every constrained row
  written. Linear in `schema.indexes`, dwarfed by the seek's I/O. Parked as a `NOTE:`
  at the site, with the durable fix (memoize per frozen `UniqueConstraintSchema` in a
  `WeakMap`, like the neighbouring `predicateCache`).

### Deliberately not addressed

- **A plain `UNIQUE` with no matching index is still O(n²).** The store materializes
  no implicit per-constraint index, so route 2 never applies. This is the ticket's
  stated scope; the remaining case is `backlog/feat-store-implicit-unique-index`.
- **The `INDEX_UNUSABLE` branch stays untested.** It fires when an index entry
  carries a legacy empty value (a store written before index values carried the data
  key). Bailing to the full scan is the right posture — skipping the entry would
  accept a duplicate — but no test provider carries on-disk legacy data, and
  backwards compatibility is waived project-wide (`AGENTS.md`). Reaching it needs a
  hand-crafted index store; not worth a test.
- **Partial indexes are still never seeked for reads, and index scans still advertise
  no ordering.** Both carried forward from the prereq ticket, unchanged here.
- **A `BLOB` column under a mismatched K/C is exempt from the guard.** Confirmed safe
  by oracle: `BLOB.parse` coerces a string to bytes, so the column never holds text,
  and the index path and the full scan agree.

## Validation

All green, nothing skipped or disabled.

- `@quereus/store` unit suite: **749 passing, 0 failing** (was 745 at implement; 4
  added by review).
- Store-path SQL logic suite (`packages/quereus && node test-runner.mjs --store`):
  **6546 passing, 14 pending, 0 failing** — identical to the implement baseline.
- `yarn test` (full monorepo): **0 failing** across every workspace.
- `yarn lint`: clean. `yarn workspace @quereus/store run build` (the store's only real
  typecheck): clean.

Both fixes were confirmed discriminating: each new regression test was run against the
unfixed code and observed to fail — the mid-transaction index test by accepting a
duplicate, the JSON test by accepting a duplicate.
