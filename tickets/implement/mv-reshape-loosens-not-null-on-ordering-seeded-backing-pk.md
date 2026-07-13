---
description: |
  Refreshing a materialized view crashes ("Cannot DROP NOT NULL on PRIMARY KEY column") when the view's
  hidden backing table keys on a column that the user later made nullable. Teach the refresh reshape that a
  primary-key column is never-null by definition, so it never tries to drop NOT NULL on one.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # the fix sites (classifyBackingReshape.recordAttrShift, describeBackingShapeMismatch)
  - packages/quereus/src/vtab/memory/layer/manager.ts                     # alterColumn — the throw (line ~2096); leave as-is (correct guard)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts       # add the regression test here
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic    # §16a/§16d/§16e — keep green
difficulty: medium
---

# MV reshape must not drop NOT NULL on an ordering-seeded backing PK column

## Reproduced (memory backend)

The crash reproduces on Quereus's own memory backend — no lamina needed — when the backing PK column is
forced NOT NULL and the body's physical ordering seeds it into the physical PK. The memory `integer`
default (nullable) only *hides* it when the ordering isn't seeded; an explicit `order by` on a NOT NULL
source column exposes it:

```sql
create table par (id integer primary key, x integer not null);   -- x NOT NULL ⇒ backing PK col x starts notNull
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- order by x ⇒ physical.ordering=[x]
alter table par alter column x drop not null;                    -- source x now nullable; MV marked stale
insert into par (id, x) values (2, 8);
refresh materialized view par_ix;   -- ← throws: Cannot DROP NOT NULL on PRIMARY KEY column 'x'
```

Confirmed via a throwaway spec calling `deriveBackingShape` after the `alter`:

- `order by x` → `ordering=[{index:1}]` → `computeBackingPrimaryKey` seeds x → backing PK `[x, id]`;
  derived x `notNull=false` after alter, backing x `notNull=true` → reshape emits `loosenNotNull` on x →
  `MemoryTableManager.alterColumn` refuses DROP NOT NULL on a PK column → throw.
- `where x > 0` (corpus §16e) → on **memory** the optimized plan physically orders by `id`
  (`ordering=[{index:0}]`), so x is **not** seeded and no reshape op fires (this is why §16e passes on
  memory today). On **lamina** the same body orders by `x`, seeds it, and throws — same engine bug, the
  ordering choice merely differs by backend.

So the trigger is: **a physical-PK column (seeded from the body ordering, or from a proved key) whose
derived output nullability loosened after a source ALTER.**

## Root cause (all engine-side, unchanged from the fix ticket)

`classifyBackingReshape.recordAttrShift` (materialized-view-helpers.ts ~line 2090) sees the re-derived
column's `notNull === false`, and — because a mere nullability shift does not change the PK column *set* —
`describePhysicalPkChange` does not veto it. It pushes a `loosenNotNull` op, which `reshapeOpToChange` maps
to `{ alterColumn, setNotNull: false }`, and the memory manager correctly refuses to drop NOT NULL on a PK
column.

The physical PK is set by `computeBackingPrimaryKey`, which seeds the body's `order by` columns ahead of
the logical key. The seeded column is a *physical* PK member even though `keysOf` never reported it.

## Chosen direction: teach the reshape that a physical-PK column is never-null

Encode the invariant **"a physical primary-key column is NOT NULL, so the backing never drops NOT NULL on
it, and a to-nullable shift on it is not a shape difference."** This is exactly the rule
`MemoryTableManager.alterColumn` already enforces — the reshape classifier is simply out of step with it.

This was picked over the fix ticket's other two candidates because they are far more invasive:

- **Direction 2 (don't seed a nullable ordering column into the physical PK).** At create the column is
  still NOT NULL, so it *is* seeded; only after the ALTER does it go nullable. So the refresh's
  `computeBackingPrimaryKey` would now drop it, shrinking the PK `[x,id] → [id]` — and
  `describePhysicalPkChange` treats a PK-column-count change as **inexpressible**, turning the crash into a
  different hard failure. Would require the reshape to support PK-shrink, which is deliberately refused (a
  maintained table's PK is its replicated row identity).
- **Direction 3 (recreate + refill on PK nullability shift).** Loses the table incarnation / warm caches
  the whole in-place-reshape design exists to preserve. Overkill for a no-op nullability relabel.

**Do NOT** instead force `notNull=true` onto every physical-PK column at shape derivation: memory
*permits* nullable PK columns and can store null keys today, so a blanket force would change behavior for
MVs that legitimately key on a nullable column. The fix must be asymmetric — only *suppress the loosening*
of an already-NOT-NULL PK column, never *add* NOT NULL to an already-nullable one.

## Two touch points (same invariant, both needed)

1. **`describeBackingShapeMismatch`** (the positional shape compare behind `backingShapeMatches`,
   ~line 1578). A NOT-NULL difference on a column that is a physical-PK member of the *current* backing,
   where the backing is NOT NULL and the derived shape is nullable (a loosening), is **not** a mismatch.
   With this, `refreshMaintainedTable`'s fast-path gate (`backingShapeMatches` at
   materialized-view.ts:152) matches, refresh takes the data-only `rebuildBacking` path, and no reshape op
   is ever emitted. The backing keeps x NOT NULL (it is a PK); rows under `where x > 0` are never null, so
   the rebuild stores them cleanly.
   - Keep the exception tight: only ignore the diff when `current.notNull === true &&
     shape.notNull === false` **and** the current column is in `current.primaryKeyDefinition`. A tighten
     (nullable→NOT NULL) on a PK column is a no-op anyway; a diff on a non-PK column stays a real diff.

2. **`classifyBackingReshape.recordAttrShift`** (~line 2090). Defense for when reshape is entered anyway
   (some *other* genuine shape change — e.g. a trailing added column — coexists with the PK-column
   loosening in the same refresh, so `backingShapeMatches` is false). When `!backingNotNullMatches(from,to)`
   and `to.notNull !== true` (a loosening) and `from` is a physical-PK column of `current`, **skip** the
   `loosenNotNull` op rather than pushing it. Everything else about the reshape proceeds normally.

A small shared helper — `isPhysicalPkColumn(table: TableSchema, columnNameLower: string): boolean` over
`table.primaryKeyDefinition` + `table.columns[def.index].name` — keeps both sites honest and greppable.

## Why this is safe

- A physical-PK column cannot hold NULL regardless of the derived logical nullability, so keeping the
  backing column NOT NULL is *more* accurate, not less.
- Existing memory MVs with a *nullable* PK column are untouched: current and derived both read
  `notNull=false`, so there is no diff to mask and no op to skip. The change only fires on the
  NOT-NULL→nullable transition of a PK column.
- §16a / §16d alter *payload* columns (not PK-seeded), so their reshape/loosen path is unchanged — verify
  they stay green.

## Tripwire (do NOT file as a ticket)

Seeding a *nullable* ordering column into the physical PK is a latent hazard only when the body can emit a
NULL in that column (e.g. `order by x` with no `where x > 0` guard and a NULL x row): the rebuild would then
try to store NULL into a NOT-NULL PK column and fail. This is orthogonal to this crash and is already owned
by the covering ticket that replaces ordering-seeding with a proper materialized index (see the NOTE on
`computeBackingPrimaryKey`, ~line 236). Add a one-line `// NOTE:` at the fix site pointing to it; record it
in the review's `## Review findings`. Do not try to close it here.

## TODO

- Add `isPhysicalPkColumn(table, columnNameLower)` helper in materialized-view-helpers.ts.
- Fix touch point #1: `describeBackingShapeMismatch` ignores a PK-column NOT-NULL→nullable loosening diff.
- Fix touch point #2: `classifyBackingReshape.recordAttrShift` skips `loosenNotNull` for a physical-PK
  column.
- Add a `// NOTE:` tripwire line at the fix site referencing the ordering-seed / covering ticket.
- Regression test in `materialized-view-refresh-reshape.spec.ts`: the memory `order by x` +
  `alter … drop not null` + `refresh` case above → refresh succeeds, `select … from par_ix` returns the
  maintained rows, and a post-refresh in-scope insert is still maintained.
- Run the two spec homes + the sqllogic file:
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mvtest.log; tail -n 60 /tmp/mvtest.log`
  (or narrow to `materialized-view-refresh-reshape.spec.ts`, `maintained-table-refresh-revalidation.spec.ts`,
  and `logic.spec.ts` via `test:single`). Confirm §16a/§16d/§16e green.
- `yarn lint` (packages/quereus) — catches signature drift.
- On landing, `53-materialized-views-rowtime.sqllogic` goes green on the lamina backend with no corpus edit;
  lamina drops its ledger line.

## Handoff honesty

Direction and both fix sites are validated against a live memory reproduction (the `order by x` throwaway
spec). Not yet written: the production edits, the helper, or the regression test — those are this ticket's
job. The reviewer should sanity-check that touch point #1's fast-path masking does not let a *genuine*
non-PK nullability drift slip past `backingShapeMatches` (the PK-membership guard is what prevents that).
