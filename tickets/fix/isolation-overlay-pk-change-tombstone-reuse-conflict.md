description: A PK-changing UPDATE whose new PK was freed (tombstoned) earlier in the same txn fails with a spurious overlay PK conflict. Blocks PK swaps and any PK reuse within one transaction.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## Symptom

Inside a single transaction, moving a row onto a primary-key value that was vacated
earlier in the *same* transaction throws:

```
ConstraintError: UNIQUE constraint failed: _overlay_<table>_<n> PK.
```

This blocks the common "swap two PKs via a temporary" idiom and any PK-reuse-within-txn
pattern.

### Minimal repro (fails today)

```sql
create table t (id integer primary key, name text not null) using store;
insert into t values (1, 'a'), (2, 'b');
begin;
update t set id = 9 where id = 1;   -- frees PK 1 (overlay tombstones PK 1)
update t set id = 1 where id = 2;   -- reuse freed PK 1  → THROWS _overlay_t PK
commit;
-- expected final state: [[1,'b'],[9,'a']]
```

Full PK swap (`1↔2` via a temp PK) fails the same way on the second statement.

## Root cause

In `IsolatedTable.update()` (`packages/quereus-isolation/src/isolated-table.ts`), the
two PK-changing-UPDATE branches write the relocated row at the **new** PK via
`overlay.update({ operation: 'insert', ... })`:

- the `existingOverlayRow && pkChanged` branch (~line 738), and
- the no-existing-overlay-row `pkChanged` branch (~line 775).

`checkMergedPKConflict` already returns `{}` ("overlay handles it") for the new PK when
the overlay holds a **tombstone** there — so the relocation is *allowed* to proceed. But
the subsequent `operation: 'insert'` into the overlay collides with that pre-existing
tombstone row, because the overlay is itself a `StoreTable` and its `update()` treats a
tombstone row at the target key as a live PK conflict
(`packages/quereus-store/src/common/store-table.ts` ~line 757, the `pkChanged` new-key
conflict block — and the INSERT pk-existence block ~line 648).

The plain-INSERT path already handles this correctly: `isolated-table.ts` ~line 649–659
detects a tombstone at the target PK and converts it via `operation: 'update'`
(overwrite the tombstone) instead of inserting. The PK-change-UPDATE branches were never
given the same tombstone-aware write.

## Expected behavior

A PK-changing UPDATE (and any write) whose destination PK currently holds an overlay
**tombstone** must overwrite that tombstone (logical reuse of a freed PK), not collide
with it. A destination PK holding a **live** overlay row must still conflict (genuine
duplicate) per the resolved `ON CONFLICT` action. The fix should mirror the INSERT
path's tombstone-conversion: when the overlay already has a tombstone at `newPK`, issue
an `operation: 'update'`/overwrite rather than `operation: 'insert'`.

## Acceptance

- The minimal repro above commits with final state `[[1,'b'],[9,'a']]`.
- A two-row PK swap (`update set id=99 where id=1; update set id=1 where id=2;
  update set id=2 where id=99;`) commits with the two rows' names swapped.
- A PK-change UPDATE onto a PK holding a **live** overlay row still raises the correct
  UNIQUE/PK conflict (or honors IGNORE/REPLACE) — i.e. the tombstone special-case must
  not weaken genuine PK-conflict detection.
- Add regression tests in `packages/quereus-store/test/isolated-store.spec.ts`
  (the `cross-layer UNIQUE / PK conflict detection` describe block wraps the store module
  in `IsolationManager`, exercising the real overlay→underlying flush path).

## Notes / scope

- Discovered during review of `isolation-merged-unique-stale-underlying-false-positive`,
  which fixed the analogous stale-value problem for **secondary non-PK UNIQUE** merged
  scans. That fix is correct and complete for its scope; this PK-reuse defect is a
  separate, pre-existing bug in the overlay PK-change write path.
- Verify the secondary-UNIQUE flush interaction: a PK reuse combined with a freed
  secondary-UNIQUE value in the same txn should also commit (the merged-view check and
  the trusted-write flush are already in place from the prior ticket).
