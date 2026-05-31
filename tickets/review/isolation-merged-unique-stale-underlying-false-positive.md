description: Review the fix for the isolation merged-view UNIQUE false-positive on an in-txn cross-row value swap. Two coordinated parts landed — (1) statement-time merged-view UNIQUE check now evaluates the overlay (merged) row instead of the stale committed value; (2) commit-time overlay→underlying flush applies the already-validated final state as "trusted writes" that skip the underlying's per-write PK/UNIQUE re-enforcement (a value-swap cycle has no conflict-free row-by-row order).
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus/src/vtab/table.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What changed (all edits verified present in tree)

### Part 1 — statement-time merged-view check (`isolated-table.ts` `findMergedUniqueConflict`, ~line 1080-1102)
When a non-tombstone overlay entry supersedes the scanned committed row, build
`mergedRow = overlayRow.slice(0, tombstoneIndex)` and evaluate the UNIQUE columns,
the collation comparison, AND the partial-UNIQUE predicate against `mergedRow`
(not the stale `underlyingRow`). The returned conflict row is `mergedRow` — also
correct for genuine conflicts (used as `existingRow` and pushed onto `evicted`).

### Part 2 — commit-time trusted-write flush
- `UpdateArgs` gained optional `trustedWrite?: boolean` (`packages/quereus/src/vtab/table.ts`,
  alongside `preCoerced`): "caller already validated all PK/UNIQUE for the final committed
  state; skip re-checks and just persist." Inert for modules that ignore it.
- `store-table.ts` `update()` honors it (4 guard sites — INSERT pk-existence + checkUniqueConstraints,
  UPDATE pkChanged-conflict + shouldCheckUniques):
  - INSERT trusted: skips PK-existence conflict block and `checkUniqueConstraints`. A trusted
    insert that finds an existing PK **throws `QuereusError(INTERNAL)`** (the flush routes
    existing PKs to update, so this is an isolation invariant violation; the flush try/catch
    rolls back). Index maintenance + single insert/update event preserved.
  - UPDATE trusted: skips the pkChanged new-key conflict block and `checkUniqueConstraints`
    (`shouldCheckUniques = !trustedWrite && (...)`). Keeps secondary-index delete-old/add-new
    maintenance and the **single** `update` event (CDC stays one update, not delete+insert).
- `flushOverlayToUnderlying` passes `trustedWrite: true` (+ `preCoerced: true`) on the insert and
  update writes (2 sites). The delete (tombstone) write and `assertFlushWriteOk` are unchanged.

Why safe: each per-row update maintains the secondary index incrementally, so a transient
duplicate value during the swap is fine; the overlay merged-view check already proved the
final state is globally unique.

## Validation status (IMPORTANT — read before trusting)

The session that implemented this hit a flaky tool-I/O environment; treat these results as a
floor and re-run to confirm:

- `yarn build` — **exit 0** (verified; all packages compile with every edit, including the
  shared `UpdateArgs` change and the store-table throw).
- `yarn test` (all workspaces) — quereus core **4124 passing**, other workspaces green; the
  ONLY failure observed was the new `partial-UNIQUE` test using an unsupported inline
  `UNIQUE (email) WHERE ...` table constraint.
- `yarn workspace @quereus/quereus run lint` — **exit 0** (verified).
- The required core test — **`UNIQUE-value swap across two rows within one txn commits`** —
  **passed** (it was among the 282 passing in the store suite; only the partial variant failed).

### Action taken on the failure
The partial-UNIQUE test was rewritten to declare the partial index the supported way —
`CREATE TABLE psw (...); CREATE UNIQUE INDEX psw_email_active ON psw (email) WHERE active = 1;`
(inline `UNIQUE (cols) WHERE pred` is NOT accepted by the CREATE TABLE parser; partial UNIQUE
is only via `CREATE UNIQUE INDEX ... WHERE`, mirroring the existing passing tests in
`packages/quereus-store/test/column-default-conflict.spec.ts`). This DDL fix is in the tree but
its green run could **not be re-confirmed before handoff** due to the I/O issue.

**Reviewer: first re-run `yarn workspace @quereus/store test` and confirm it is fully green
(expect 283 passing, 0 failing). If the partial-UNIQUE test is red for any reason, it is
OPTIONAL per the original ticket — either fix it or delete it; do not let it block the core fix.**

## Use case (repro — now commits, final state `[[1,'b'],[2,'a']]`)

```sql
create table sw (id integer primary key, email text not null, unique (email)) using store;
insert into sw values (1, 'a'), (2, 'b');
begin;
update sw set email = 'tmp' where id = 1;   -- frees 'a'
update sw set email = 'a'   where id = 2;   -- id=2 holds 'a', frees 'b'
update sw set email = 'b'   where id = 1;   -- 'b' free in merged view → passes
commit;
```

The test suite wraps `MemoryStoreModule` in `IsolationManager`, so the new tests exercise the
real isolation→store flush path including `trustedWrite`. The pre-existing
`detects/INSERT/REPLACE UNIQUE/PK conflict ...` tests in the same describe block still pass,
confirming genuine conflicts (the merged-view check is now the sole authority) are still rejected.

## Reviewer focus / known gaps (tests are a floor, not a finish line)

- **Re-run all four commands** (`yarn build`, `yarn test`, `yarn test:store`, lint) — the
  implement session's results were collected under a degraded tool-I/O environment.
- **`test:store` was not re-run post-fix.** It runs the store module WITHOUT isolation, so it
  never exercises `trustedWrite` (all guarded branches take the normal path) — the trusted-write
  path is covered only by the two new isolation tests. Still worth a confirming run.
- **PK-value swap not covered.** This ticket fixed only the secondary non-PK UNIQUE merged scan
  (`findMergedUniqueConflict`). `checkMergedPKConflict` and the flush PK handling were not
  touched. A txn that swaps two rows' PRIMARY KEYs is a distinct scenario — verify or file a
  follow-up. (Flush updates never change a row's PK, so `pkChanged` is always false there; the
  `&& !trustedWrite` guard on that block is defensive, not exercised.)
- **Weakened flush-time safety net (documented trade-off).** Trusted writes skip the underlying's
  UNIQUE/PK re-validation, making the overlay merged-view pre-checks (Part 1 +
  `checkMergedPKConflict`) the SOLE authority. A latent bug in those pre-checks would no longer
  be caught at flush.
- **Only the store module honors `trustedWrite`.** If another underlying module is ever wrapped
  by `IsolationManager` and flushed, it ignores the flag and could re-hit the row-by-row UNIQUE
  problem. Today only the store module is wrapped this way.
