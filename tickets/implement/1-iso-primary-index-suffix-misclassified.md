---
description: When a table sits behind an isolation overlay and the underlying table advertises its primary-key index under a suffixed name (like "_primary_1"), a simple read-by-key throws "Secondary index not found" instead of returning the row.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts (parseIndexFromFilterInfo ~461-471, mergedQuery/mergedSecondaryIndexQuery, adaptFilterInfoForOverlay), packages/quereus/src/vtab/memory/layer/scan-layer.ts (~170-171, the throw site — reference only)
difficulty: medium
---

# quereus-isolation misclassifies suffixed primary-index names as secondary

## Problem

`IsolatedTable.mergedQuery` → `parseIndexFromFilterInfo` (`isolated-table.ts:461-471`)
treats **only the exact string `_primary_`** as the primary key. Any other name is
classified `type: 'secondary'` and routed to the overlay MemoryTable as a
secondary-index scan.

An underlying virtual table is free to advertise its PK access plan under a
different name. lamina-quereus does exactly that: its plan registry mints a
per-plan unique key by appending a monotonic counter (`_primary_` → `_primary_1`,
`_primary_2`, …) so it can recover the exact `RangePlan` later — intentional and
load-bearing on the lamina side (fixed a direction-clobber recovery bug there; do
not ask lamina to stop).

With a live overlay (any buffered write), a PK point lookup then flows:

1. Underlying advertises `indexName: '_primary_1'`; Quereus echoes it into the
   seek node's idxStr: `idx=_primary_1(0);plan=2`.
2. `parseIndexFromFilterInfo` fails the exact `_primary_` check → `'secondary'`.
3. `mergedSecondaryIndexQuery` forwards to the overlay MemoryTable, whose
   `scanLayer` has no secondary index named `_primary_1` →
   `QuereusError: Secondary index '_primary_1' not found.`

Minimal shape of the failure (over a lamina-backed table, same connection):

```sql
insert into scenario.Site (id, name) values (1, 'Scene B'); -- creates the overlay
select name from scenario.Site where id = 1;                -- throws
```

Deterministic, not a flake. Reads without a live overlay succeed (they bypass
isolation and hit the underlying's own plan recovery), which is why this hides
until a write and a PK read share a transaction.

## External repro

Traced end-to-end from SiteCAD (repo `../SiteCAD_branch`), which links this repo
via `portal:`. Failing test there:

```
yarn workspace @sitecad/site-cad test src/test/lamina-scope-switch.test.ts
```

(`lamina scope scenario-switch eviction (lens trio) > switches the scenario scope
to a fresh backend …` — 1 failed at their HEAD.) A local quereus-isolation unit
test (below) should replace that as the primary repro.

## Fix (preferred)

The isolation layer bridges two index-name vocabularies: the underlying's
(`_primary_<seq>`) and the overlay MemoryTable's (always `_primary_`). Query the
overlay in **its own** vocabulary:

- In `parseIndexFromFilterInfo`, classify base `_primary_` **plus optional numeric
  suffix** as `{ type: 'primary' }` — i.e. `/^_primary_\d*$/` — or equivalently
  strip the suffix back to `_primary_` before the overlay re-plan
  (`adaptFilterInfoForOverlay` is currently a pass-through and is the natural
  seam if stripping is chosen).

## Design constraints

- Do NOT widen so far that genuine secondary names (`_column_<n>_`,
  `_compound_<name>_`, `_nd_…`, `_intersect_…`) get misrouted to the overlay's
  primary scan — those must still hit the overlay's real secondary indexes.
  Restrict to the `_primary_` + numeric-suffix shape.
- The alternative (lamina advertises stable `_primary_` and keys its private
  registry internally) is more invasive and reopens the recovery problem its
  unique naming solved. Prefer the isolation-side fix; lamina files
  (`../lamina/packages/lamina-quereus/src/query-dispatch.ts:105`,
  `plan-types.ts:512-516 storeUnique`) are reference only.
- No persisted-state impact: planner/classification control flow only.

## Edge cases & interactions

- Suffixed PK name with a live overlay: must resolve to overlay primary scan.
- Bare `_primary_`: unchanged behavior.
- Genuine secondary index names, with and without overlay: still routed to
  overlay secondary scans.
- Name that merely starts with `_primary_` but isn't PK-family (e.g. a
  hypothetical `_primary_extra_idx`): must NOT match (`\d*` anchor, not
  `startsWith`).
- Both merged read paths: point lookup (plan=2 equality seek) and range scan over
  the PK.

## TODO

- Add failing unit test in quereus-isolation: underlying table whose
  `getBestAccessPlan` advertises `_primary_1`; insert (create overlay) then PK
  read through `IsolatedTable` — expect the row, currently throws.
- Implement PK-family classification (or suffix-strip in
  `adaptFilterInfoForOverlay`).
- Negative tests per edge cases above.
- Run the package suite; then (out-of-band) rebuild dist so linked consumers
  (SiteCAD `lamina-scope-switch.test.ts`) can confirm 1 failed → 0.
