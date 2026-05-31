description: Isolation merged-view UNIQUE detection raises a false-positive conflict against a committed row whose constrained value was already changed (moved off the value) earlier in the SAME transaction. A legitimate cross-row UNIQUE-value swap within one txn is wrongly rejected.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## Symptom

A UNIQUE-value swap across two rows inside a single transaction is rejected with a
spurious `UNIQUE constraint failed` even though the final (and intermediate merged)
state is conflict-free. SQLite accepts this.

Reproduction (drive through the isolation+store harness in
`packages/quereus-store/test/isolated-store.spec.ts`, in-memory KV provider):

```sql
create table sw (id integer primary key, email text not null, unique (email)) using store;
insert into sw values (1, 'a'), (2, 'b');
begin;
update sw set email = 'tmp' where id = 1;   -- frees 'a'
update sw set email = 'a'   where id = 2;    -- id=2 now holds 'a', frees 'b'
update sw set email = 'b'   where id = 1;    -- 'b' is free in the merged view → SHOULD pass
commit;
```

The third `update` throws `ConstraintError: UNIQUE constraint failed: sw (email)` at
**statement time** (from `processUpdateRow` in `dml-executor.ts`, because the isolation
layer's `IsolatedTable.update()` returned `{status:'constraint', constraint:'unique'}`).
Expected: rows end as `[[1,'b'],[2,'a']]`.

## Root cause

`IsolatedTable.findMergedUniqueConflict` (`packages/quereus-isolation/src/isolated-table.ts`,
~lines 1064–1096) scans the **underlying** (committed) table for a row matching the new
value on the UNIQUE columns. For each underlying candidate it:

- skips `selfPks`,
- skips the candidate **only if** the overlay has a *tombstone* for that PK
  (`overlayRow && overlayRow[tombstoneIndex] === 1`),
- otherwise compares `newRow[col]` against **`underlyingRow[col]`** (the stale committed
  value).

The gap: when the overlay holds a *non-tombstone update* for the candidate PK that has
**changed the constrained column**, the merged-view value for that row is the overlay's,
not the underlying's — but the code still compares against the underlying's stale value.
In the repro, scanning for id=1→'b' finds committed `id=2:'b'`; the overlay has a
non-tombstone update `id=2:'a'`, so it is not skipped, and the stale `'b'` matches,
yielding a false conflict.

## Expected fix (research / specification — leave design to implement stage)

When an overlay non-tombstone entry exists for a scanned underlying PK, the conflict
check must evaluate the UNIQUE columns from the **overlay** row (the row's current
merged value), not the underlying row — i.e. the merged view, not the committed view.
A candidate whose overlay-superseded value no longer matches must not count as a
conflict. (Overlay-only rows inserted in the same txn are already enforced separately by
the overlay memory module during `overlay.update()`, so this fix is specifically about
underlying rows that have been *updated* in the overlay.)

Watch for interaction with partial-UNIQUE predicates (evaluate the predicate against the
merged/overlay row too) and with collation-aware comparison (already handled via
`compareSqlValues(..., column.collation)`).

## Scope / provenance

Discovered during review of `isolation-replace-pk-and-unique-cooccurrence`. It is a
**separate, pre-existing** bug (not introduced by that change) and was explicitly left
out of scope there. Note the flush-ordering hardening throw added by that ticket is
**not** reachable via this path — the over-strict statement-time check rejects the swap
before it could ever reach the commit flush.

## Acceptance

- The swap repro above commits successfully → `select id,email from sw order by id` is
  `[[1,'b'],[2,'a']]`, on the isolation/store path.
- Add a regression test in `isolated-store.spec.ts` (store/isolation-only; the memory
  module's merged-view path differs).
- `yarn build`, `yarn test`, `yarn test:store`, and `yarn workspace @quereus/quereus run lint`
  stay green.
