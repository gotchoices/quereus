description: Fix isolation-layer flush ordering so an `INSERT OR REPLACE` that both replaces a PK-colliding underlying row AND evicts a different row on a secondary UNIQUE keeps the new row's values. Root-caused to `flushOverlayToUnderlying` applying overlay entries in PK order and silently ignoring the underlying write's constraint result.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic, packages/quereus-store/src/common/store-table.ts
----

## Root cause (confirmed)

Reproduced in store mode (`yarn test:store`) and root-caused. The defect is **not**
in the overlay merge-read path the original fix ticket suspected — the overlay ends the
statement holding the *correct* data. The bug is entirely in the **commit flush**.

Repro:

```sql
create table b (id integer primary key, email text not null, unique (email));
insert into b values (5, 'old'), (9, 'dup');
insert or replace into b values (5, 'dup');   -- pk=5 collides on PK with b(5); 'dup' collides on UNIQUE(email) with b(9)
select id, email from b order by id;
-- ACTUAL:   [{"id":5,"email":"old"}]   ← new value lost
-- EXPECTED: [{"id":5,"email":"dup"}]
```

Trace of `IsolatedTable.update()` (insert path) — all correct:
- `checkMergedPKConflict(pk=5)` → REPLACE against underlying `b(5,'old')`; surfaces it as
  `replacedUnderlyingRow` and does **not** tombstone pk=5 (relies on the overlay insert
  shadowing it, becoming an UPDATE at flush).
- `checkMergedUniqueConstraints` → finds `b(9,'dup')` on UNIQUE(email); REPLACE →
  `insertTombstoneForPK(pk=9)` and pushes `b(9,'dup')` onto `evictedRows`.
- Overlay insert of `[5,'dup',0]` succeeds (no overlay conflict; the pk=9 tombstone has
  `email=NULL`).

So at end-of-statement the overlay correctly holds `pk=5 → [5,'dup',0]` and
`pk=9 → tombstone`. The data is lost in `flushOverlayToUnderlying`
(`isolated-table.ts`, ~line 1189):

1. It collects overlay entries via a full scan, yielding them in **PK order**:
   `pk=5` (non-tombstone) **before** `pk=9` (tombstone).
2. It applies `pk=5` first: `underlyingTable.update({operation:'update', values:[5,'dup'],
   oldKeyValues:[5], preCoerced:true})` — **no `onConflict`**. The underlying store still
   holds `b(9,'dup')` at this point, so `StoreTable.checkUniqueConstraints` sees the
   `email='dup'` collision, resolves to ABORT (statement OR > per-UC default > **ABORT**;
   none set here), and **returns** `{status:'constraint', constraint:'unique', ...}`
   (`store-table.ts:1044`) — it does not throw.
3. **The flush ignores the returned `UpdateResult`** (lines ~1214/1224/1231 just `await`
   the call). So pk=5's update is silently dropped — pk=5 stays `'old'`.
4. It then applies `pk=9`'s tombstone → delete succeeds → `b(9)` evicted.

Net: `[5,'old']`, with `b(9)` gone. Two independent faults combine: **(a)** wrong apply
order (a write that collides on a secondary UNIQUE with a row that is *also* being deleted
in the same flush is applied before that delete), and **(b)** the flush silently swallows
a constraint result instead of surfacing it.

## Fix (verified — both the repro and the existing `55`/`40`/`41` store tests pass)

**Primary fix — apply deletes before inserts/updates in the flush.** In
`flushOverlayToUnderlying`, order `overlayEntries` so tombstones (deletes) are applied
before non-tombstone (insert/update) entries. This frees the secondary-UNIQUE value
(deletes pk=9) before the colliding write (updates pk=5 → `'dup'`). Each PK appears at
most once in the overlay, so reordering across PKs is safe — there is no same-PK
delete-then-insert pair to invert. Verified diff:

```ts
// in flushOverlayToUnderlying, replacing `for (const entry of overlayEntries) {`
const ordered = [...overlayEntries].sort((a, b) =>
    (a.isTombstone === b.isTombstone ? 0 : a.isTombstone ? -1 : 1));
for (const entry of ordered) {
    // ...unchanged body...
}
```

(`Array.prototype.sort` is stable in V8/Node, so original PK order is preserved within
each group; the implementer may instead do two explicit passes — tombstones, then the
rest — if they prefer not to lean on sort stability.)

**Hardening (recommended, defense-in-depth) — stop swallowing flush write results.** Even
with correct ordering, a `constraint` (or other non-ok) result coming back from an
underlying write during flush means a real invariant was violated (the overlay's
merged-view pre-checks should have caught it before commit). Today that is lost silently
and manifests as data corruption — exactly what hid this bug. Capture each
`underlyingTable.update(...)` result in the three flush branches (delete / update /
insert) and throw a `QuereusError` (INTERNAL) if `isConstraintViolation(result)` (or it is
otherwise not ok). The existing `try/catch` already rolls back the underlying flush
transaction and rethrows. This converts future silent losses into loud failures.
**Validate the full store suite** after adding this — if any legitimate flush path relied
on a swallowed result it will surface here (none is expected).

## Test

Extend `packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic` with a
co-occurrence case (it already runs under both `yarn test` and `yarn test:store`). Assert
**both** the surviving row's new values **and** that the secondary conflict was evicted;
add an FK child on the evictee to confirm the eviction still cascades, and (optionally) an
FK child whose parent is the replaced PK to confirm the replaced-row cascade path. Suggested:

```sql
-- co-occurrence: new row collides on PK with one underlying row AND on a secondary UNIQUE
-- with a DIFFERENT underlying row. The PK slot must take the NEW values while the
-- secondary conflict is evicted (and its children cascade).
create table p5 (id integer primary key, email text not null, unique (email));
create table c5 (cid integer primary key, pid integer not null, foreign key (pid) references p5(id) on delete cascade);
insert into p5 values (5, 'old'), (9, 'dup');
insert into c5 values (50, 5), (90, 9);
insert or replace into p5 values (5, 'dup');
select id, email from p5 order by id;
→ [{"id":5,"email":"dup"}]
-- pk=9 (the secondary-UNIQUE evictee) cascaded its child away; pk=5's child survives
-- (pk=5 was replaced/updated in place, not deleted, so ON DELETE CASCADE does NOT fire).
select cid, pid from c5 order by cid;
→ [{"cid":50,"pid":5}]
```

Confirm the expected `c5` contents against SQLite semantics during implementation: an
`INSERT OR REPLACE` that lands on an existing PK is a replace of that row — whether its
own children cascade depends on engine behavior. The covered-MV variant (mirroring case 4
in `55`) is also worth adding to confirm covering-MV backing stays consistent for the
co-occurrence.

## Out of scope (already noted in `internal-eviction-reporting`)

The memory/store INSERT short-circuit that skips the secondary-UNIQUE check on a PK
collision is a separate, distinct gap (SQLite would still check it). Not addressed here.

## TODO

- In `flushOverlayToUnderlying` (`packages/quereus-isolation/src/isolated-table.ts`),
  apply tombstone/delete entries before non-tombstone insert/update entries (see verified
  diff above).
- Harden the three flush write branches to capture each `underlyingTable.update(...)`
  result and throw on `isConstraintViolation(result)` (import `isUpdateOk` /
  `isConstraintViolation` as available) so future flush-time constraint losses fail loudly.
- Add the co-occurrence test to `55-internal-eviction-reporting.sqllogic` (runs under both
  memory and store modes); verify the FK-cascade expectations against SQLite semantics.
- Validate: `yarn build`, `yarn test`, `yarn test:store`, and lint
  (`yarn workspace @quereus/quereus run lint`). The store suite is the one that exercises
  the isolation flush path.
