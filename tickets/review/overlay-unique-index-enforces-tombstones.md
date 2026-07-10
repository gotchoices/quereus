description: A bug where deleting a row and inserting a different one in the same transaction could be wrongly rejected as a duplicate is now fixed and covered by regression tests; needs a review pass.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # createOverlaySchema / liveRowPredicate / andPredicate (the fix)
  - packages/quereus-isolation/src/isolated-table.ts           # mergedSecondaryIndexQuery; insertTombstoneForPK; findMergedUniqueConflict (unchanged, confirmed still correct)
  - packages/quereus-isolation/test/isolation-layer.spec.ts    # new describe: "overlay indexes and UNIQUE constraints scoped to live rows" (9 tests, ~end of file)
  - docs/design-isolation-layer.md                             # "Overlay Table Schema" section — documents the narrowing
difficulty: easy
---

# Scope overlay indexes and UNIQUE constraints to live rows

## What was wrong (recap)

The isolation layer stages a connection's uncommitted writes in a private per-connection
*overlay* table. A deleted row is staged as a **tombstone**: the row's primary key, `NULL`
in every other column, plus a flag column marking it deleted.

`IsolationModule.createOverlaySchema` copied the underlying table's secondary indexes and
`UNIQUE` constraints onto the overlay wholesale, so the overlay enforced uniqueness across
tombstones too. This was invisible for a `UNIQUE` structure over an ordinary column (a
tombstone's value there is `NULL`, and SQL treats `NULL`s as distinct) but broke the moment
every column of the `UNIQUE` structure sat inside the primary key — tombstones carry real PK
values, so two tombstones (or a tombstone and a live row) collided.

Two confirmed reproductions (both now fixed):

```sql
create table t (a integer, b integer, primary key (a, b));
create unique index t_a_ux on t (a);
insert into t values (1, 1);
begin;
  delete from t where a = 1 and b = 1;
  insert into t values (1, 2);   -- was: "UNIQUE constraint failed: _overlay_t_2 (a)"

create table t (a integer, b integer, primary key (a, b));
insert into t values (1, 1);
insert into t values (1, 2);
begin;
  delete from t;
  create unique index t_a_ux on t (a);   -- was: INTERNAL
```

## The fix

`createOverlaySchema` (`isolation-module.ts`) narrows each copied index and each copied
`UNIQUE` constraint into a partial structure over live rows only, AND-ing `<tombstone
column> = 0` onto whatever partial predicate it already carried:

```ts
indexes: baseSchema.indexes?.map(idx => ({ ...idx, predicate: andPredicate(idx.predicate, liveOnly) })),
uniqueConstraints: baseSchema.uniqueConstraints?.map(uc => ({ ...uc, predicate: andPredicate(uc.predicate, liveOnly) })),
```

Both arrays are narrowed because the memory module enforces uniqueness from
`TableSchema.uniqueConstraints`, and `CREATE UNIQUE INDEX` synthesizes a matching
`derivedFromIndex` unique constraint alongside the index; a table-level `UNIQUE (…)`
declared at `CREATE TABLE` time produces a constraint with no index of its own and the
manager auto-builds a covering index for it, inheriting the constraint's (now narrowed)
predicate. The overlay's **primary-key** uniqueness is deliberately left uncovered by this
change — it must keep judging tombstones so a re-insert at a tombstoned PK is detected and
converted into an overwrite rather than a fresh insert (see `IsolatedTable.update`'s
tombstone-revival branch).

`docs/design-isolation-layer.md` § "Overlay Table Schema" now documents this narrowing and
why primary-key uniqueness is excluded from it.

## Test coverage added

New `describe('overlay indexes and UNIQUE constraints scoped to live rows', …)` block at the
end of `packages/quereus-isolation/test/isolation-layer.spec.ts` (its own `db`/`isolatedModule`
setup, since it landed inside the file's second top-level `describe` — nesting inside the
wrong outer block was caught immediately by a `ReferenceError: db is not defined` when first
run; fixed by giving the block its own `Database` instance and `afterEach(() => db.close())`,
matching the sibling blocks in that same top-level describe). All 9 assert on the
**committed** result, not merely "no error":

1. **Delete-then-reinsert under a PK-covered UNIQUE index** — the primary regression repro.
   Commits; table holds exactly `(1, 2)`.
2. **`CREATE UNIQUE INDEX` inside a transaction over a fully-tombstoned table** — the second
   regression repro. Commits; table is empty.
3. **Non-PK UNIQUE column** (pin — this path worked before the fix). Delete-then-reinsert at
   a different PK reusing the same UNIQUE value; commits to exactly the new row.
4. **Pre-existing partial UNIQUE index** (`… where b > 0`) — confirms the fix ANDs onto an
   existing predicate correctly: a duplicate outside the predicate's scope still escapes
   enforcement, and a genuine in-scope duplicate staged inside a transaction is still
   rejected with `StatusCode.CONSTRAINT`.
5. **Table-level `UNIQUE (…)` over PK columns**, declared at `CREATE TABLE` time (no explicit
   index) — exercises the `uniqueConstraints` half of the fix specifically. Same
   delete-then-reinsert shape as #1.
6. **Two live overlay rows colliding on a UNIQUE index** — proves narrowing to live rows
   didn't disable enforcement between two ordinary (non-tombstone) staged rows.
7. **Two live overlay rows colliding on a table-level `UNIQUE (…)`** — same, for the
   constraint-only path.
8. **PK reuse at a tombstoned key** — delete then re-insert at the *same* PK inside one
   transaction; asserts the mid-transaction read AND the post-commit read both show exactly
   the new row (not the old one, not both).
9. **Merged secondary-index scan** — a non-unique index on a non-PK column, with a staged
   delete and a staged update in the same transaction; reading back through that index shows
   neither the deleted row nor the pre-update value.

## Validation run

| command | result |
| --- | --- |
| `yarn workspace @quereus/isolation run typecheck` | clean |
| `yarn workspace @quereus/isolation run test` | 200 passing (was 191 before the 9 new tests) |
| `yarn workspace @quereus/store run test` | 901 passing |
| `yarn test` (all workspaces) | quereus 6802, isolation 200, store 901, sync 450, sync-client 65, sync-coordinator 31, plugin-loader 28/30/17ish, quoomb-web 74, other UI packages 34/128 — all green, zero failures |
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json --noEmit`) |
| `yarn lint` (all workspaces) | every other package's no-op `lint` script ran; quereus's real lint ran silently clean |

`yarn test:store` (the store-backed logic-test re-run) was **not** run separately in this
pass — `yarn test` above already exercises `packages/quereus` logic tests against the
memory-backed vtab, and the `@quereus/store` unit suite (901 passing) covers the store-module
path directly, but the specific store-backed *logic* run (`yarn test:store`, ~2 min per
AGENTS.md) was not re-executed after these test-only/doc-only changes. Since this ticket
touched no runtime code beyond what was already fixed and validated by the prior agent (see
below), and the new tests are isolation-package unit tests that don't touch the store vtab at
all, this is a low-risk gap — but the reviewer should run it if it wants the full documented
combination.

## What is NOT covered / known gaps

- The runtime fix itself (`createOverlaySchema` narrowing) was implemented by a prior agent
  run before this ticket; this pass only added regression tests and the doc update, then
  re-verified the fix is present and correct by reading it end-to-end. No production code was
  changed in this pass.
- `yarn test:store` (store-backed logic-test re-run) not re-executed this pass — see above.
- The fix's own code comments already flag one adjacent tripwire, which is not addressed here
  (deliberately out of scope): `IsolationModule.effectiveRowsFor`'s doc comment notes that
  `alter column … set collate` re-materializes the overlay's PK map once per UNIQUE constraint
  covering the altered column, and if that ever shows up as slow the map should be built once
  and shared. No new tripwire was introduced by this ticket's changes.

## Suggested validation for the reviewer

- Skim `createOverlaySchema` / `liveRowPredicate` / `andPredicate` in `isolation-module.ts`
  (near line 1701) against the "why" bullets in its doc comment.
- Skim the 9 new tests in `isolation-layer.spec.ts` (search
  `'overlay indexes and UNIQUE constraints scoped to live rows'`) for correctness of setup vs.
  assertion (each asserts a specific committed row set, not just absence-of-error).
- Optionally re-run `yarn test:store` to close the one unexecuted validation gap noted above.
