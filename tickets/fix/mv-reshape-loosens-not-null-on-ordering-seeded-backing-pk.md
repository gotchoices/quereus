---
description: |
  Refreshing a materialized view crashes ("Cannot DROP NOT NULL on PRIMARY KEY column") when the view
  filters on a column that was later made nullable. The reshape rebuilds the view's hidden backing table and
  tries to drop NOT NULL on a key column — because the backing's physical primary key was seeded with the
  plan's ordering column, and the reshape then wants that same column nullable. Reproduce, pick a direction,
  and fix.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # computeBackingPrimaryKey seeds ordering cols ahead of logical key; deriveBackingShapeUnguarded sets notNull from plan output type; classifyBackingReshape.recordAttrShift emits loosenNotNull with no physical-PK veto; reshapeOpToChange maps to setNotNull:false; reshapeBackingInPlace is the throw's caller
  - packages/quereus/src/vtab/memory/layer/manager.ts                # alterColumn — the throw: refuses DROP NOT NULL on a PRIMARY KEY column
  - packages/quereus/src/runtime/emit/materialized-view.ts           # refreshMaintainedTable → reshapeBackingInPlace
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # §16e — the corpus case (passes on memory, only because memory defaults columns nullable)
difficulty: medium
---

# MV reshape emits DROP NOT NULL on an ordering-seeded backing PK column

## Cross-repo origin

Filed from the lamina project, where it blocks
`tickets/blocked/quereus-mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk.md` and fails the
conformance file `53-materialized-views-rowtime.sqllogic` on the lamina backend. **The file passes on
Quereus's own memory backend** — only because the memory backend defaults `integer` columns to *nullable*,
so the backing PK column starts `notNull=false`, the user's `drop not null` is a no-op for it, and no
reshape op is emitted. A backend that defaults columns to NOT NULL (lamina does, deliberately) starts the
backing PK column `notNull=true`, so the drop-then-refresh genuinely has a NOT NULL to drop — on a PK
column — and the reshape throws. Lamina merely *exposes* a latent engine bug; nothing lamina-side
participates in the decision.

## Triggering statement (corpus §16e)

```sql
create table par (id integer primary key, x integer);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par where x > 0;
alter table par alter column x drop not null;   -- succeeds; only marks the MV stale
insert into par (id, x) values (2, 8);
insert into par (id, x) values (3, -1);
refresh materialized view par_ix;               -- ← throws
```

```
QuereusError: Cannot DROP NOT NULL on PRIMARY KEY column 'x'
 ❯ MemoryTableManager.alterColumn   vtab/memory/layer/manager.ts
 ❯ reshapeBackingInPlace            runtime/emit/materialized-view-helpers.ts
 ❯ refreshMaintainedTable           runtime/emit/materialized-view.ts
```

## Root cause (all engine-side)

1. `par_ix`'s body carries `where x > 0`, so the optimized plan is physically ordered by `x`
   (`physical.ordering = [{ index: 1 }]`).
2. `computeBackingPrimaryKey` **seeds the plan's ordering columns ahead of the logical key**, so the
   backing's physical PK becomes `[x, id]` even though `keysOf` reports the logical key as `{id}` alone. At
   the throw the backing is `id (notNull, pk)`, `x (notNull, pk)`.
3. `alter table par alter column x drop not null` makes the source column — and the MV body's derived output
   type — nullable. `deriveBackingShapeUnguarded` reads that straight off the plan output type
   (`notNull: c.type.nullable === false`).
4. On `refresh`, `classifyBackingReshape.recordAttrShift` sees `to.notNull === false` and pushes a
   `loosenNotNull` op. `describePhysicalPkChange` does **not** veto it — the PK column *set* is unchanged,
   only `x`'s nullability shifts — so `reshapeOpToChange` turns it into
   `{ alterColumn, columnName: 'x', setNotNull: false }`.
5. `MemoryTableManager.alterColumn` correctly refuses to drop NOT NULL on a PRIMARY KEY column → throw.

Sections 16a/16d run the same `alter … drop not null` + `refresh` shape without tripping it, because their
altered column is a payload column, not the ordering-seeded PK column; only §16e's partial-WHERE MV keys
its physical PK on the altered column.

## Candidate directions (pick one; engine-design call, blast radius across MV maintenance arms)

- Have `classifyBackingReshape` **veto `loosenNotNull` on any physical-PK column** (a PK column is
  non-nullable by definition), rather than relying on `describePhysicalPkChange`'s column-*set* comparison.
  (Simplest; likely correct.)
- Or stop `computeBackingPrimaryKey` from seeding a nullable ordering column into the physical PK — drop
  such columns from the PK, or keep the ordering as a non-key physical property.
- Or make the reshape recreate-and-refill the backing when a PK column's nullability shifts, instead of
  reshaping in place.

## TODO

- Reproduce with a memory-backed test that forces the backing PK column NOT NULL (the memory default hides
  it — a test module or an explicit NOT NULL source column reproduces without lamina).
- Pick a direction, implement, add regression covering §16e's partial-WHERE MV + `drop not null` + refresh.
- Confirm §16a/§16d (payload-column alters) stay green.
- On landing, `53-materialized-views-rowtime.sqllogic` goes green on the lamina backend with no corpus edit;
  lamina drops its ledger line.
