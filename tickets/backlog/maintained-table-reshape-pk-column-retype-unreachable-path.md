description: `describePhysicalPkChange` treats a PK-column *type* change as an expressible reshape (a retype routed to the post-reconcile batch), but no supported source ALTER can produce one — `alter column … set data type` is rejected outright on a PK column ("Cannot SET DATA TYPE on PRIMARY KEY column"). So the post-reconcile PK-column-retype path is currently dead code, and IF a future feature ever makes a PK-column type change reachable, its interaction with the reconcile (which keys body rows under the OLD PK comparator before the retype runs) is untested and may mis-key new-typed PK values.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # describePhysicalPkChange (permits PK-column type change); reshapeBackingInPlace (reconcile keys under current/old comparator, retype runs post-reconcile)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # ~L702 runAlterColumn — rejects SET DATA TYPE on a PRIMARY KEY column
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # where a PK-column-retype reshape test would live
difficulty: medium
----

# PK-column type-change reshape is an unreachable (and untested) post-reconcile path

## Context

Spun out of `maintained-table-reshape-narrowing-attr-on-stale-data` (the
two-phase reshape that defers data-validating attribute shifts past the data
reconcile). That ticket flagged a sub-case to validate: a **PK-column type
change**.

`describePhysicalPkChange` deliberately permits a PK-column *type* change — it
only rejects key set / order / direction / collation changes, treating a retype
as "not a PK-definition change". So a PK-column retype is classified
**expressible** and routed to the post-reconcile op batch, where it runs *after*
`reshapeBackingInPlace`'s data reconcile.

## The problem

Two things make this path both dead and hazardous today:

1. **Unreachable via supported ops.** The only way a re-derived backing shape can
   present a PK-column type change (vs the live backing) is if the source PK
   column's type changed — i.e. `alter table … alter column <pk> set data type …`.
   That source ALTER is **rejected outright**: `runAlterColumn`
   (`alter-table.ts` ~L702) raises *"Cannot SET DATA TYPE on PRIMARY KEY column
   '<c>'"*. So no supported source ALTER can produce a PK-column-type shift in the
   body shape; the post-reconcile PK-retype branch never fires in practice.
   (Confirmed empirically: a `select *` MV over `t(id text primary key, …)` with
   `alter table t alter column id set data type integer` throws at the source,
   before refresh.)

2. **Untested keying hazard if it ever becomes reachable.** The reconcile
   (`reshapeBackingInPlace` → `rebuildBacking` → `replaceBaseLayer` /
   `replaceContents`) keys the body rows under the **current** (pre-retype) PK
   column comparator, because the retype is deferred to post-reconcile. For a
   non-PK column that is fine (the PK is unchanged). For a **PK** column whose
   type is changing, the body's new-typed PK values would be keyed/sorted under
   the OLD column type's comparator during the reconcile, which can mis-key or
   mis-order (e.g. text-vs-integer ordering of `'10'` vs `'9'`), and a later
   re-key would be needed. None of this is exercised.

## What a fix/decision looks like

Pick one, deliberately:

- **Reject it explicitly.** Make `describePhysicalPkChange` treat a PK-column
  *type* change as a PK-definition change too (inexpressible → the sited
  "alter and re-attach, or drop and recreate" error), matching the source's own
  refusal to retype a PK column in place. Cleanest if PK-column retype is never
  intended to be in-place.
- **Support it properly** (only if a future feature makes PK-column retype a real
  source operation): keep PK-column retype expressible but handle the keying —
  e.g. a metadata-only type set on the PK column *before* the reconcile so rows
  key under the new comparator, or keep PK-column retype in the pre-reconcile
  batch against freshly-keyed-then-converted rows. Requires a test with
  sort-order-diverging values (`'9'`/`'10'` → `9`/`10`) across multiple rows.

Either way, add a test (or an explicit `inexpressible` assertion) so the branch
is no longer silently dead.

## Use cases / acceptance

- A reshape whose only delta is a PK-column type change has a **defined,
  tested** outcome (either a sited inexpressible error, or a correct in-place
  re-key + reconcile).
- If rejected: the existing `inexpressible → sited error` suite gains a
  PK-column-type-change case; the table is left untouched and `stale`.
- If supported: a multi-row PK-column retype with sort-order-diverging text→int
  values reshapes correctly (no mis-keyed/duplicate rows, `read(MV) ==
  eval(body)`).
