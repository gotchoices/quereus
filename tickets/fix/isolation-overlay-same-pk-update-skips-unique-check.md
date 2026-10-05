description: Inside a transaction on a store-backed (persistent) table, changing a UNIQUE column on a row that was itself written earlier in the same transaction is never checked against already-committed rows, so the commit can save two rows with the same "unique" value; and when the primary key declares its own conflict action, that action is wrongly applied to the UNIQUE column too, silently deleting a row instead of reporting an error.
architecture: docs/runtime.md
files:
  - packages/quereus-isolation/src/isolated-table.ts                 # update arm, existing overlay row, same PK (~L1315 "Same PK — update the overlay row in place"); sibling arms run checkMergedUniqueConstraints
  - packages/quereus-store/src/common/store-table-constraints.ts     # uniqueColumnsChanged — reference gate
  - packages/quereus/src/vtab/memory/layer/manager.ts                # uniqueColumnsChanged — reference gate
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic   # neighbouring in-transaction cases; a pin for this could sit here or in a new file
repro: verified
----

# Isolation layer: same-PK UPDATE of an overlay-resident row skips the merged UNIQUE check

## Problem

The isolation layer (`IsolatedTable.update`, `packages/quereus-isolation/src/isolated-table.ts`) stages a transaction's writes in a private in-memory "overlay" table and flushes them to the underlying store at commit with `trustedWrite` (the store skips its own UNIQUE re-check, trusting the isolation layer to have validated the merged view).

Every write arm runs `checkMergedUniqueConstraints` — which looks at overlay rows **and** committed underlying rows — except one: an UPDATE whose target row is already live in the overlay and whose primary key does not change. That arm calls `overlay.update(...)` directly. The overlay's own memory module only sees overlay rows, so a collision with a committed row is never detected, and the flush writes it without a check.

Found while working `memory-vtab-pk-replace-skips-unique-check` (which fixed the analogous INSERT-over-live-overlay-row REPLACE arm in the same function).

## Reproduced

Store mode (`QUEREUS_TEST_STORE=true yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep <file>`), scratch sqllogic:

```sql
create table x (id integer primary key, v text unique);
insert into x values (2, 'b');
begin;
insert into x values (1, 'a');
update x set v = 'b' where id = 1;   -- expected: UNIQUE constraint failed: x (v)
commit;
select * from x order by id;          -- store mode: both rows, both v = 'b'
```

Memory mode raises `UNIQUE constraint failed: x (v)` on the update, as SQLite does. Store mode accepts the update and the commit stores the duplicate.

### Second arm, same site: the PK's default action leaks onto the secondary UNIQUE

Found in review of `memory-vtab-pk-replace-skips-unique-check`. The same arm hands the overlay `argsForOverlay`, whose `onConflict` is the **primary key's** `on conflict` default folded in as if it were the statement's OR clause. The overlay's memory module then applies that action to every secondary UNIQUE too — so a conflict between two overlay-only rows is resolved by the PK's action instead of the UNIQUE's own. Verified with a scratch isolation spec (memory underlying, `USING isolated`):

```sql
create table t (id integer primary key on conflict replace, v text unique);
begin;
insert into t values (1, 'a'), (2, 'b');
update t set v = 'b' where id = 1;   -- expected: UNIQUE constraint failed (v has default ABORT)
commit;
select * from t order by id;          -- isolation: [{"id":1,"v":"b"}] — row 2 silently deleted, no error
```

Memory mode and SQLite raise the UNIQUE error. Running the merged check (with the original `args.onConflict`) before the overlay write fixes this arm as well, because it rejects the conflict before the overlay sees it — the same reason the sibling arms are unaffected.

## Expected behaviour

The same-PK overlay-row UPDATE enforces every secondary UNIQUE against the merged view under its own action (statement OR > constraint default > ABORT), exactly like the sibling arm that handles an UPDATE of a row not yet in the overlay — including REPLACE evictions reported via `evictedRows` and IGNORE skipping the row.

## Notes for the fix

- `checkMergedUniqueConstraints` scans the whole overlay per UNIQUE constraint. Running it unconditionally here would make a bulk `update t set <non-unique col> = ...` over N rows staged in the transaction cost O(N²). Gate it on "a UNIQUE (or partial-UNIQUE predicate) column changed" — memory and store each already have a `uniqueColumnsChanged`; the isolation layer has none. Prefer sharing one implementation over a third copy.
- The overlay is handed the PK-resolved action (`argsForOverlay.onConflict`, which folds in a PK-level `on conflict` default) as if it were the statement's OR clause; the merged check must use the original `args.onConflict` so each UNIQUE resolves its own default.
- Add a regression pin in store mode (sqllogic) and in `packages/quereus-isolation/test/isolation-layer.spec.ts` (runs under plain `yarn test`), covering ABORT, IGNORE and REPLACE.
