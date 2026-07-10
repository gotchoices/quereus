----
description: On tables backed by the persistent store, an ALTER TABLE that rewrites the stored rows (adding or dropping a column, changing the primary key, or changing a primary-key column's text-comparison rule) ignores rows written earlier in the same still-open transaction, so on commit those rows are corrupted, lost, or stored where nothing can find them.
files:
  - packages/quereus-store/src/common/store-module.ts  # alterTable: addColumn (~1259), dropColumn (~1360), alterPrimaryKey (~1467), setCollate PK arm (~1772); renameTable DDL-commit precedent (~1870)
  - packages/quereus-store/src/common/store-table.ts   # migrateRows (~534), rekeyRows (~483) — both scan/write the committed store directly
  - packages/quereus-store/test/alter-table.spec.ts    # in-memory provider harness to copy
  - packages/quereus-store/test/transaction.spec.ts    # coordinator/txn test shapes
  - docs/store.md                                      # transaction section (~344) — needs the DDL-commit note
difficulty: medium
----

# Physical-rewrite `ALTER TABLE` arms must DDL-commit the store coordinator first

## Reproduced

All four rewriting arms of `StoreModule.alterTable` corrupt or drop rows that the open
transaction wrote before the ALTER. Repro (in-memory provider, harness copied from
`test/alter-table.spec.ts`):

| arm | setup | after `commit` |
| --- | --- | --- |
| `alter primary key (b)` | committed `(1,10)`, pending `insert (2,20)` | row present in a full scan but `where b = 20` returns **nothing** — it sits under the old `a`-keyed bytes |
| `alter primary key (b)` | committed `(1,10),(2,20)`, pending `delete where a = 1` | **both rows still there** — the delete addressed a key that no longer exists |
| `alter column id set collate binary` (id is PK) | committed `'A'`, pending `delete id='A'` | **row survives** — same reason |
| `add column w integer default 7` | committed `(1,10)`, pending `insert (2,20)` | row 2 comes back **without `w`** — its buffered value bytes are still the old 2-column layout |
| `drop column w` | committed `(1,10,100)`, pending `insert (2,20,200)` | row 2 comes back with a **phantom `col_2` = 200** — old 3-column layout |

Note the ticket's suggested `set collate nocase` repro does *not* fire: the store's default
key collation is already `NOCASE` (`rekeyRows` → `resolvePkKeyCollations(..., this.encodeOptions.collation ?? 'NOCASE')`),
so `nocase` changes no key bytes and `rekeyRows` skips every row (`bytesEqual(oldKey, newKey)`).
Use `set collate binary` on a `text` primary-key column to force a real re-key.

## Cause

`TransactionCoordinator` buffers pending ops as `(keyBytes, valueBytes, store)` triples
(`src/common/transaction.ts`). The key bytes and the serialized row bytes are both computed at
DML time, against the *pre-ALTER* schema. `rekeyRows` and `migrateRows` iterate and batch-write
the **committed** store directly (`store.iterate(...)` / `store.batch()`), bypassing the
coordinator entirely. Nothing reconciles the two. On commit the stale-schema ops are replayed
over the rewritten store.

`renameTable` already recognises this class (`store-module.ts:1859-1872`) and DDL-commits the
module coordinator before moving the directory, with a comment that reads, accurately,
"ALTER TABLE is effectively DDL-committing on a store-backed table". The four rewriting
`alterTable` arms never got the same treatment.

## Chosen posture: DDL-commit, matching `renameTable`

Re-encoding the buffered ops in place (the other option) is not viable: a pending **delete**
carries only key bytes, no row, so its new key cannot be recomputed without first reading the
row it is about to delete — and a pending **put**'s value bytes would need re-serializing under
the new column layout. Both would have to be repeated for every secondary-index store's pending
ops, which `rebuildSecondaryIndexes` then clears and rebuilds anyway. DDL-commit is two lines
per arm, consistent with the module's existing story, and it makes the subsequent scans see
every live row.

Consequences to document rather than avoid:

- The coordinator is module-wide, so this commits **every** table's pending ops, not just the
  altered table's. Same as `renameTable` — an ALTER cannot half-commit some sibling tables.
- `rekeyRows`' duplicate-key check is its own first pass, and it *must* see the pending rows
  (a pending insert can itself be the duplicate). So the commit necessarily precedes it, and a
  `CONSTRAINT` throw from `rekeyRows` now fails a statement whose enclosing transaction has
  already been flushed. The store is still left unmutated; only the enclosing transaction is
  gone. `renameTable` has the same shape (its physical relocation can fail post-flush).
- Validation that can throw *without* seeing pending rows should stay **before** the commit so
  the transaction survives it — specifically the non-PK UNIQUE re-validation loop in the
  `setCollate` arm (`store-module.ts:1748-1760`), which is already positioned first.
- The `addConstraint` UNIQUE arm is validate-only (it writes nothing physical) and already
  reads `iterateEffectiveEntries`. Leave it alone — no commit there.
- `createIndex` likewise already builds from `iterateEffectiveEntries`. Leave it alone.
- `rebuildSecondaryIndexes` reads `dataStore.iterate(...)` (committed-only) and writes index
  stores outside the coordinator. That is *correct once the commit has happened* — but it is
  only ever called from the two re-key arms, so it inherits their guarantee rather than
  establishing its own.

## Verification performed

Prototype (a `moduleCoordinator.commit()` guarded by `isInTransaction()` immediately before
`rekeyRows` in both arms) turned all three re-key repro cases green and left the store suite at
**811 passing, 0 failing** (`yarn workspace @quereus/store test`). The two `migrateRows` cases
were found afterwards and are not covered by that prototype — they need the same treatment at
their own call sites.

## TODO

- Add a private helper on `StoreModule` — e.g. `ddlCommitPendingOps()` — that performs the
  `if (this.moduleCoordinator?.isInTransaction()) await this.moduleCoordinator.commit();`
  dance, with the explanatory comment currently inlined in `renameTable`. Have `renameTable`
  call it too, so the reasoning lives in exactly one place (DRY).
- Call it from `alterTable` in each of the four rewriting arms, immediately before the first
  physical write and after any throw-only validation that does not depend on pending rows:
  - `addColumn` — before `table.migrateRows(...)` (`~1259`). The `NOT NULL` backfill evaluator
    runs inside `migrateRows`, so pending rows must already be committed for it to see them.
  - `dropColumn` — before `table.migrateRows(remap, null)` (`~1360`).
  - `alterPrimaryKey` — before `table.rekeyRows(newPkColumns)` (`~1467`).
  - `setCollate` PK arm — before `table.rekeyRows(...)` (`~1772`), i.e. *after* the non-PK
    UNIQUE re-validation loop above it.
- Leave the `addConstraint` and `renameColumn` / `setDefault` arms untouched: they write no
  rows. Add a one-line comment on the `addConstraint` UNIQUE arm saying so, since a reader
  arriving from this fix will wonder why it is exempt.
- Add regression tests to `packages/quereus-store/test/alter-table.spec.ts` (or a new
  `alter-pending-ops.spec.ts` if that file is getting long) covering, for each of the four
  arms, a pending `insert` and a pending `delete` that is then observed after `commit`:
  - `alter primary key` — assert the moved row is reachable by a point lookup on the **new**
    key (`where b = 20`), not merely present in a full scan; a full scan hides the orphan.
  - `set collate binary` on a `text` PK column — a pending delete of an upper-case key must
    stay deleted. (`nocase` is a no-op; see above.)
  - `add column` with a `default` — the pending row must carry the new column.
  - `drop column` — the pending row must not resurrect the dropped column as `col_N`.
  - Also assert the DDL-commit itself: after the ALTER, a `rollback` must not restore the
    pre-ALTER rows (the transaction is gone). That pins the documented posture so a future
    change to it is a deliberate test edit.
- Note in `docs/store.md`, in the transaction section (~344, near the commit/rollback
  numbering), that `ALTER TABLE ... RENAME TO` and any row-rewriting `ALTER TABLE` implicitly
  commit the module-wide transaction before touching storage, and that the commit spans every
  table the coordinator is buffering.
- Tripwire, worth a `NOTE:` at the `rebuildSecondaryIndexes` definition
  (`store-module.ts:1083`): it reads committed-only and writes index stores outside the
  coordinator, which is sound only because both callers DDL-commit first. If it ever gains a
  caller that does not, its rebuilt index will omit that transaction's pending rows.
- Run `yarn workspace @quereus/store test` and `yarn test`; `yarn test:store` if touching
  anything the shared logic tests exercise.
