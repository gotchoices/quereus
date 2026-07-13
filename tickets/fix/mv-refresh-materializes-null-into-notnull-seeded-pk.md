---
description: |
  A materialized view that orders by a column can end up silently storing a NULL in that column even
  though the view's hidden storage still marks it "must not be null" — so the stored data quietly
  contradicts its own schema. Reproduce and pin down the right fix.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # computeBackingPrimaryKey (~236), rebuildBacking, describeBackingShapeMismatch, classifyBackingReshape
  - packages/quereus/src/vtab/memory/layer/manager.ts                # replaceContents / replaceBaseLayer — bulk insert path that does not enforce NOT NULL
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # where a regression case belongs
difficulty: hard
---

# MV refresh silently materializes NULL into a NOT-NULL ordering-seeded backing PK column

## What happens

A materialized view whose body carries `order by <col>` seeds `<col>` into the backing table's
**physical** primary key (`computeBackingPrimaryKey`, ~line 236 — the ordering columns lead the key so the
btree clusters in body order). A physical-PK column is stored NOT NULL, and the memory manager refuses to
DROP NOT NULL on a PK column. Sibling ticket `mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk`
(now landed) stopped `refresh` from emitting a doomed `loosenNotNull` op on such a column, so the refresh
takes the data-only rebuild path instead of crashing.

That fix is correct for the common case, but it exposes a latent data-integrity hole. Reproduction:

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- source x now nullable
insert into par (id, x) values (2, null);                              -- a real NULL x
refresh materialized view par_ix;                                      -- succeeds — no error
select id, x from par_ix;                                              -- returns {1,5} and {2, NULL}
```

The refresh **succeeds and stores `x = NULL`** into `par_ix`, even though `par_ix`'s backing schema still
declares column `x` NOT NULL (it can't be loosened — it's a physical-PK member). Verified empirically: the
refresh throws nothing and the NULL row materializes.

## Why it is wrong

Two invariants are broken silently:

- **The backing schema lies.** `par_ix.columns['x'].notNull === true` while the table holds a row with
  `x = NULL`. Any consumer that trusts the declared NOT NULL flag (the optimizer eliminating null checks,
  catalog introspection, a downstream MV deriving non-null facts) can miscompile against data that violates
  the flag.
- **A NULL sits in a declared-NOT-NULL physical PK.** The primary key `[x, id]` now has a NULL key
  component in a column the schema says is NOT NULL. (Memory *does* permit NULL in a column declared
  nullable — that is fine — but here the column is declared NOT NULL, so this is a genuine invariant
  violation, not the permitted case.)

The rebuild path never checks it: `rebuildBacking` → memory `replaceContents`/`replaceBaseLayer`
PK-extracts and inserts raw without validating values against the column schema (documented in
`reshapeBackingInPlace`'s docstring as intentional for the reshape case). So NOT NULL is simply never
enforced on the bulk-replace path.

Before the sibling fix, this exact sequence threw `Cannot DROP NOT NULL on PRIMARY KEY column 'x'` at
`refresh` — loud, and it blocked the NULL from ever landing. The sibling fix removed that crash (a good
thing for the no-NULL case) and, in doing so, made this silent-NULL path reachable via plain SQL.

## Root cause

Ordering-seeding puts a column into the *physical* PK that is not part of the view's *logical* key and may
be logically nullable. The backing then pins it NOT NULL (PK columns can't hold NULL by the memory
manager's rule) while the derived logical shape says nullable — a standing contradiction the moment a NULL
flows through the ordering column.

The clean resolution is the already-referenced rework that **replaces ordering-seeding with a proper
materialized index** (the `computeBackingPrimaryKey` NOTE at ~line 236 and the two `// NOTE:` sites in
`materialized-view-helpers.ts` both point at it): once ordering is expressed as a secondary index rather
than by inflating the physical PK, the physical PK stays the logical key, no logically-nullable column is
pinned NOT NULL, and the contradiction disappears.

Note: that referenced "covering ticket" does not currently exist as a filed ticket in `tickets/` — the
NOTE comments are aspirational. Part of this ticket's fix stage is to decide whether to (a) do the
ordering-seed → materialized-index rework, or (b) land a narrower guard first: reject (sited error) or
otherwise correctly handle a `refresh`/rebuild that would store a NULL into a NOT-NULL physical-PK column,
so the failure is loud and correct rather than silent, until the rework lands.

## Expected behavior

A `refresh` must never leave the backing holding data that violates its own declared column constraints. At
minimum, storing a NULL into a NOT-NULL physical-PK column must be a loud, correctly-attributed error (not
a silent success); ideally the ordering-seed rework removes the pinned-NOT-NULL column entirely so a
logically-nullable ordering column simply keys as nullable.

## Repro harness

The landed sibling test file `materialized-view-refresh-reshape.spec.ts` is the natural home for a
regression case. The reproduction above was confirmed to return `REFRESH_ERR: NONE` and
`ROWS: [{"id":1,"x":5},{"id":2,"x":null}]` on the post-sibling-fix tree.
