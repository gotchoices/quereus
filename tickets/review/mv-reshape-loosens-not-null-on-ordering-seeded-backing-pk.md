---
description: |
  Refreshing a materialized view used to crash ("Cannot DROP NOT NULL on PRIMARY KEY column") when the
  view's hidden backing table keyed on a column the user later made nullable; the refresh now knows a
  primary-key column is never-null and stops trying to drop NOT NULL on it. Review the fix.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # helper + both fix sites
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts        # regression test
difficulty: medium
---

# Review: MV reshape must not drop NOT NULL on an ordering-seeded backing PK column

## What the bug was

A materialized view's hidden backing table can key on a column that the *body's* `order by` seeds into the
physical primary key (`computeBackingPrimaryKey` leads the key with the ordering columns). Example:

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- source x now nullable
insert into par (id, x) values (2, 8);
refresh materialized view par_ix;   -- OLD: throws "Cannot DROP NOT NULL on PRIMARY KEY column 'x'"
```

After the `alter`, the re-derived body shape reports `x` nullable, but the backing keeps `x` NOT NULL (it is
a physical-PK member; the memory manager refused to loosen it, which is why the `alter` itself did not
throw). The refresh saw a NOT-NULL→nullable skew, classified it as a shape difference, and emitted a
`loosenNotNull` op — which `MemoryTableManager.alterColumn` (manager.ts ~line 2096) correctly refuses on a
PK column.

## The fix (all in materialized-view-helpers.ts)

Invariant encoded: **a physical-PK column is NOT NULL by definition, so the backing never drops NOT NULL on
it, and a to-nullable shift on it is not a shape difference.** Asymmetric on purpose — only *suppress the
loosening* of an already-NOT-NULL PK column, never *add* NOT NULL to an already-nullable one (memory permits
nullable PK columns).

1. **`isPhysicalPkColumn(table, columnNameLower)`** — new shared helper over `primaryKeyDefinition` +
   `columns[def.index].name`. Keeps both sites honest and greppable.
2. **`describeBackingShapeMismatch`** (~line 1588) — a NOT-NULL→nullable *loosening*
   (`current.notNull === true && derived.notNull !== true`) on a current physical-PK column is no longer a
   mismatch. This lets `backingShapeMatches` return true, so refresh takes the data-only `rebuildBacking`
   fast path and never enters reshape / emits a reshape op. Tight guard: a *tighten*, or any non-PK column,
   stays a real diff.
3. **`classifyBackingReshape.recordAttrShift`** (~line 2093) — defense for when reshape is entered anyway
   (some *other* genuine shape change coexists with a PK-column loosening in the same refresh). Skips the
   `loosenNotNull` op for a physical-PK column of `current` (matched by pre-rename name).

`// NOTE:` tripwire lines at both fix sites point at the ordering-seed source (`computeBackingPrimaryKey`,
~line 236) and the covering ticket that replaces ordering-seeding with a materialized index.

## Validation performed

- **Regression test** `materialized-view-refresh-reshape.spec.ts` → new case *"a source DROP NOT NULL on an
  ordering-seeded backing PK column refreshes without dropping the backing PK NOT NULL"*: asserts the
  backing keeps `x` NOT NULL and the seeded `[x, id]` PK after the source `drop not null`, refresh succeeds,
  both rows materialize, and a **post-refresh** in-scope insert is still maintained.
- **Bug-guard proof**: temporarily forced `isPhysicalPkColumn` to `return false` (disables both sites) and
  re-ran the spec — reproduced the exact `QuereusError: Cannot DROP NOT NULL on PRIMARY KEY column 'x'` at
  refresh. Restored. So the test genuinely fails without the fix, not just passes with it.
- **Full quereus suite**: `yarn test` → **6984 passing, 0 failing, 13 pending** (~4m). Covers the sqllogic
  corpus (`logic.spec.ts`) including `53-materialized-views-rowtime.sqllogic` §16a/§16d/§16e, the
  refresh-reshape spec, and the maintained-table revalidation spec — all green.
- **Lint**: `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + `tsc -p tsconfig.test.json`, so
  spec call-site signatures type-check).

## Reviewer: where to push

- **Fast-path masking soundness (the load-bearing concern).** Touch point #2 (`describeBackingShapeMismatch`)
  makes a *genuine* nullability difference invisible to `backingShapeMatches`. Confirm the PK-membership
  guard is what prevents a *non-PK* nullability drift from slipping past: the mask only fires when the column
  is in `current.primaryKeyDefinition` AND the transition is NOT-NULL→nullable. A non-PK loosening still
  returns a mismatch → still reshapes → still emits (a legal) `loosenNotNull`. Verify the existing test
  *"a non-PK attribute shift (source set collate) reshapes in place"* and *"a NOT NULL trailing add"* cover
  the non-PK path staying live (they pass).
- **Precondition surprise worth knowing.** A source `drop not null` does NOT mark this MV stale — it is
  recompiled live (`tryRecompileMaterializedViewLive`, a body-relevant change recompiles in place, returns
  non-stale). The crash reproduces at `refresh` regardless of staleness, because refresh always re-derives
  the shape and runs `backingShapeMatches` (materialized-view.ts:137,152). The regression test therefore
  asserts backing `x` NOT NULL *post-alter* (the skew) rather than staleness.
- **Asymmetry check.** Confirm the guard never *adds* NOT NULL: the tighten branch
  (`to.notNull === true → tightenNotNull`) is untouched, and touch point #1's mask requires
  `b.notNull !== true`. An MV that legitimately keys on a nullable column reads `notNull=false` on both
  sides → no diff to mask, no op to skip.

## Review findings

- **Tripwire (parked, not a ticket):** seeding a *nullable* ordering column into the physical PK is a latent
  hazard — if the body can emit a NULL in that column (e.g. `order by x` with no guard and a NULL-x row),
  the rebuild would try to store NULL into a NOT-NULL PK column and fail. Orthogonal to this crash; already
  owned by the covering ticket that replaces ordering-seeding with a proper materialized index. Parked as
  `// NOTE:` lines at both fix sites and at `computeBackingPrimaryKey` (~line 236, pre-existing).
- **Cross-backend note (no action here):** on the lamina backend the same body physically orders by `x`
  (memory's optimizer orders `where x > 0` bodies by `id`, hiding it) — same engine bug, different ordering
  choice. Ticket predicts `53-materialized-views-rowtime.sqllogic` §16e goes green on lamina with no corpus
  edit once this lands; that lamina-side confirmation is out of scope for the memory-backed suite run here
  and left for the lamina package's own validation.
