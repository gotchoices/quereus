----
description: On persistent-store tables, changing a primary key (or the text-comparison rule of a primary-key column) rewrites the stored rows under new keys while writes buffered by the still-open transaction are still addressed to the old keys, so those writes may land as orphaned rows when the transaction commits.
files:
  - packages/quereus-store/src/common/store-module.ts  # alterTable 'alterPrimaryKey' (~1421), 'setCollate' PK arm (~1718), renameTable DDL-commit (~1806)
  - packages/quereus-store/src/common/store-table.ts   # rekeyRows
difficulty: medium
----

# Store `ALTER` re-key runs against committed bytes while pending ops hold old keys

## What was noticed

Two `alterTable` arms physically re-encode the data store in place:

- `alterPrimaryKey` → `table.rekeyRows(newPkColumns)` then `rebuildSecondaryIndexes`
- `alter column … set collate` on a primary-key member → `table.rekeyRows(...)` then
  `rebuildSecondaryIndexes`

Both rewrite the **committed** key-value store. Meanwhile the module-wide
`TransactionCoordinator` may be holding buffered puts and deletes for that same table,
keyed under the *pre-ALTER* key bytes. Nothing flushes or rewrites them. On `commit`, those
ops are applied against the re-keyed store: a pending put lands as a row under a key
nobody will look up again, and a pending delete silently matches nothing.

`renameTable` is the only DDL path that recognises this class of problem — it calls
`moduleCoordinator.commit()` before moving the directory, with a comment explaining that
ALTER is effectively DDL-committing on a store-backed table (`store-module.ts:1806`). The
re-key arms never got the same treatment.

This was spotted while fixing `validateUniqueOverExistingRows`
(`bug-store-add-constraint-unique-ignores-pending-rows`); it was deliberately left out of
that ticket's scope. It has **not** been reproduced yet — that is this ticket's first job.

## Expected behavior

Either the re-keying ALTER participates in the transaction (pending ops are re-encoded under
the new key bytes along with the committed rows), or it DDL-commits first — flushing the
coordinator exactly as `renameTable` does — and that choice is documented. Silently applying
old-key ops to a new-key store is not an acceptable third option.

## Suggested starting point

Reproduce with a store-backed `Database` (see `packages/quereus-store/test/alter-table.spec.ts`
for the harness):

```sql
begin;
insert into t values ('a', 1);
alter table t alter column id set collate nocase;  -- id is the primary key
commit;
select * from t;   -- does the pending row survive, and under which key?
```

Repeat for `alter table t alter primary key (…)`, and for a pending `delete` rather than a
pending `insert`.

Then decide between the two postures above. The `renameTable` precedent argues for the
DDL-commit; it is a two-line change and consistent with the module's existing story. Whichever
is chosen, note it in `docs/store.md` alongside the rename's DDL-commit note.
