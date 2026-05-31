description: Fix the isolation merged-view UNIQUE false-positive on an in-txn cross-row value swap. Two coordinated parts: (1) statement-time merged-view check must evaluate the overlay (merged) row, not the stale committed value; (2) commit-time flush must apply the already-validated final state without re-enforcing UNIQUE per write (a value-swap cycle cannot be applied row-by-row).
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/vtab/table.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/isolated-store.spec.ts
effort: high
----

## Summary

A UNIQUE-value swap across two rows inside one transaction is wrongly rejected on the
isolation+store path. SQLite accepts it. Final state should be `[[1,'b'],[2,'a']]`.

```sql
create table sw (id integer primary key, email text not null, unique (email)) using store;
insert into sw values (1, 'a'), (2, 'b');
begin;
update sw set email = 'tmp' where id = 1;   -- frees 'a'
update sw set email = 'a'   where id = 2;    -- id=2 holds 'a', frees 'b'
update sw set email = 'b'   where id = 1;    -- 'b' free in merged view → SHOULD pass
commit;
```

The fix-stage investigation confirmed this is **two coordinated bugs**, not one. The
original fix ticket assumed only the statement-time check was wrong and that the
commit-flush hardening throw was "not reachable via this path." That assumption is
**false once the statement-time check is relaxed**: relaxing it lets the swap reach the
commit flush, which then fails because the flush applies the overlay's final state to the
underlying store **row-by-row**, and the underlying store re-enforces UNIQUE on each
write — so an intermediate state (`id=1→'b'` while `id=2` still holds `'b'`) collides.
Both parts must land together; either alone leaves the repro failing (part 1 alone merely
moves the failure from a clean statement-time `CONSTRAINT` to an `INTERNAL`
"isolation-layer invariant violation" at commit).

## Part 1 — statement-time merged-view check (isolated-table.ts)

`IsolatedTable.findMergedUniqueConflict` (~lines 1064–1096) scans the **underlying**
(committed) table for rows matching the new value, skips `selfPks`, skips candidates with
an overlay *tombstone*, and otherwise compares `newRow[col]` against the **stale
underlying value**. The gap: when the overlay holds a *non-tombstone update* that already
moved a candidate off the constrained value, the row's current merged-view value is the
overlay's, not the underlying's — but the code still compares the underlying's stale
value, yielding a false conflict.

Fix: when a non-tombstone overlay entry supersedes the scanned underlying PK, evaluate the
UNIQUE columns **and** any partial-UNIQUE predicate against the overlay (merged) row. The
overlay row carries the appended tombstone column at `tombstoneIndex`, so slice it back to
schema shape first. (Verified during fix stage: this change keeps all existing
quereus-store tests green — 281 passing.)

Exact diff (the block inside the `for await (... underlyingRow ...)` loop):

```ts
			const overlayRow = await this.getOverlayRow(overlay, pk);
			if (overlayRow && overlayRow[tombstoneIndex] === 1) continue;

			// When a non-tombstone overlay entry supersedes this committed row, the
			// row's current merged-view value is the overlay's — not the stale
			// underlying value. Evaluate the UNIQUE columns (and any partial
			// predicate) against the merged row so a candidate that was moved off
			// the value earlier in this txn no longer counts as a conflict
			// (isolation-merged-unique-stale-underlying-false-positive). The overlay
			// row carries the appended tombstone column; strip it back to schema shape.
			const mergedRow: Row = overlayRow ? (overlayRow.slice(0, tombstoneIndex) as Row) : underlyingRow;

			const matches = constrainedCols.every(idx => {
				if (newRow[idx] === null || mergedRow[idx] === null) return false;
				return compareSqlValues(newRow[idx], mergedRow[idx], this.tableSchema!.columns[idx].collation) === 0;
			});
			if (!matches) continue;
			if (predicate && predicate.evaluate(mergedRow) !== true) continue;
			return { pk, row: mergedRow };
```

Returning `mergedRow` (instead of `underlyingRow`) is also correct for the genuine-conflict
cases: it is the row's true current value, used as `existingRow` in the constraint error and
pushed onto `evicted` for REPLACE eviction.

## Part 2 — commit-time flush (table.ts + store-table.ts + isolated-table.ts)

`IsolatedTable.flushOverlayToUnderlying` (~lines 1198–1269) applies overlay entries to the
underlying one at a time: tombstones (deletes) first, then non-tombstone insert/update
writes via `this.underlyingTable.update({... preCoerced: true})`. The store table's
`update()`/`insert()` (`store-table.ts`, `update()` ~line 618) re-runs
`checkUniqueConstraints` on every write. Because the secondary index keys embed the PK
(`buildIndexKey(values, pk, ...)`), transient duplicate values do **not** collide
physically — UNIQUE is enforced *logically* by that scan. A value-swap is a cycle:
no row-by-row ordering can avoid a transient duplicate, so the scan raises a spurious
conflict and `assertFlushWriteOk` (~line 1281) converts it to an `INTERNAL` throw.

The overlay's merged-view pre-checks (Part 1, plus `checkMergedPKConflict`) are the sole
authority for constraint validity, and they validate the **final** committed state. The
flush is pure persistence of that already-validated state. Therefore flush writes should
be applied as **trusted writes** that skip the underlying's PK/UNIQUE re-validation.

Recommended design (chosen over alternatives — see Trade-offs):

- Add an optional `trustedWrite?: boolean` to `UpdateArgs` (`packages/quereus/src/vtab/table.ts`,
  alongside `preCoerced`), documented as: "the caller has already validated all PK/UNIQUE
  constraints for the final committed state; skip constraint re-checks and just persist.
  Used only by the isolation overlay→underlying flush."
- In `store-table.ts` `update()`:
  - INSERT case: when `args.trustedWrite`, skip the PK-existence conflict block and the
    `checkUniqueConstraints` call. Still do index maintenance + `put` + event. (Note: under
    the flush, `rowExistsInUnderlying` already routed truly-new PKs to insert, so a trusted
    insert never overwrites; an `existing` here would itself be an isolation invariant
    violation — keep a cheap guard/log rather than silent overwrite if practical.)
  - UPDATE case: when `args.trustedWrite`, skip the `pkChanged` new-key conflict block and
    the `checkUniqueConstraints` call. Keep the secondary-index delete-old/add-new
    maintenance and the single `update` event so the store event stream stays correct
    (one `update`, not delete+insert).
- In `flushOverlayToUnderlying`, pass `trustedWrite: true` on the insert and update writes
  (keep `preCoerced: true`). Leave the delete (tombstone) write and its
  `assertFlushWriteOk` as-is.
- `assertFlushWriteOk` stays — for trusted writes it never trips (no constraint result is
  produced), but it remains a guard for the delete path and any non-trusted future caller.

Why this is safe: each per-row update maintains the secondary index incrementally
(remove old `(value,pk)`, add new `(value,pk)`), so the transient state `email='b' →
{pk1,pk2}` is fine and the final state `email='b'→{pk1}`, `email='a'→{pk2}` is correct.
The overlay already proved the final state is globally unique.

### Trade-offs / alternatives considered

- **Reorder-only flush** — cannot resolve a cycle (a 2-row swap has no conflict-free
  serial order without a temporary value). Rejected.
- **Two-phase delete-then-reinsert of the conflict component** — would change the store's
  emitted events from a single `update` to `delete`+`insert` for swapped rows
  (store-table emits its own data-change events per write, ~lines 681–710), corrupting the
  store event stream / change-data-capture. Rejected.
- **Trusted-write flag (chosen)** — keeps event semantics correct, minimal surface. Cost:
  weakens the flush-time UNIQUE re-validation safety net for trusted writes; mitigated by
  the fact that the overlay merged-view check is already the authority and the flag is set
  only by the flush. Document this clearly.

Only the **store** module needs to honor the flag: the isolation layer wraps the store
module; the memory module has its own merged-view (layer manager) and is not flushed
through this path. Adding an optional field to the shared `UpdateArgs` is inert for
modules that ignore it.

## Acceptance

- The swap repro commits → `select id,email from sw order by id` is `[[1,'b'],[2,'a']]`
  on the isolation/store path.
- Regression test added in `packages/quereus-store/test/isolated-store.spec.ts` (in the
  `cross-layer UNIQUE / PK conflict detection` describe block; store/isolation-only):

```ts
		it('UNIQUE-value swap across two rows within one txn commits (no stale-underlying false positive)', async () => {
			// Regression: isolation-merged-unique-stale-underlying-false-positive.
			await db.exec(`CREATE TABLE sw (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO sw VALUES (1, 'a'), (2, 'b')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE sw SET email = 'tmp' WHERE id = 1`); // frees 'a'
			await db.exec(`UPDATE sw SET email = 'a'   WHERE id = 2`); // id=2 holds 'a', frees 'b'
			await db.exec(`UPDATE sw SET email = 'b'   WHERE id = 1`); // 'b' free in merged view
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, email FROM sw ORDER BY id`));
			expect(rows.map(r => [r.id, r.email])).to.deep.equal([[1, 'b'], [2, 'a']]);
		});
```

- Consider adding a partial-UNIQUE variant (a swap where both rows satisfy the predicate)
  to exercise the merged-row predicate evaluation in Part 1.
- `yarn build`, `yarn test`, `yarn test:store`, and
  `yarn workspace @quereus/quereus run lint` stay green.

## TODO

- Add `trustedWrite?: boolean` to `UpdateArgs` in `packages/quereus/src/vtab/table.ts` with doc comment.
- Apply Part 1 statement-time fix in `findMergedUniqueConflict` (`isolated-table.ts`).
- Honor `trustedWrite` in `store-table.ts` `update()` INSERT and UPDATE cases (skip PK/UNIQUE re-checks; keep index maintenance + single event).
- Pass `trustedWrite: true` on the insert/update flush writes in `flushOverlayToUnderlying` (`isolated-table.ts`); leave delete + `assertFlushWriteOk` unchanged.
- Add the regression test (and optional partial-UNIQUE variant) in `isolated-store.spec.ts`.
- Run `yarn build`, `yarn test`, `yarn test:store`, lint; confirm all green.
