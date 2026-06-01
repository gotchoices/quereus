description: The `view_info()` TVF — per-view updateability introspection surface (`is_insertable_into` / `is_updatable` / `is_deletable` / `effective_targets`) realizing `docs/view-updateability.md` § Information Schema Surface as a read-only static projection over the planned view body's `updateLineage` / `attributeDefaults` + base-column flags.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/quereus/view-info.spec.ts, docs/view-updateability.md
----

# Complete: view_info() — view updateability introspection surface

A read-only TVF (`*_info` family) projecting the four view-level updateability
columns over plain (non-materialized) views, derived **statically** from the
planned body's backward `updateLineage` / `attributeDefaults` plus base-column
not-null/default/generated flags. No dry-run mutation; `propagate()` remains the
authoritative dynamic check, cross-checked (not duplicated) by test.

Columns: `schema`, `name`, `is_insertable_into`, `is_updatable`, `is_deletable`
(`'YES'`/`'NO'` TEXT), `effective_targets` (JSON-array TEXT). `numArgs:-1`
(0-arg enumerates all schemas; optional 1-arg name filter, mirroring
`function_info`). See `docs/view-updateability.md` § Information Schema Surface.

## Review findings

### What was checked
- **Implement diff** (`066c2db8`) read first with fresh eyes, then the handoff.
- **Architecture / safety:** traced every plan node that threads `updateLineage`
  through `computePhysical` — only TableReference / Project / Filter / Join /
  Alias / Retrieve / table-access nodes do. Sort / Distinct / Limit / Aggregate /
  SetOp / CTE / Window **drop** it, so those view shapes fall to the conservative
  all-`NO` row. Confirmed this makes the surface *safe by construction*: a
  non-threading node anywhere on the spine yields `undefined` lineage at its
  parent (per-node `computePhysical` reads only direct children), so no
  in-scope shape can produce a false positive.
- **Whole-spine `defaultable` walk (reviewer focus #4):** verified no false
  positives. `defaultable` is keyed by `TableReferenceNode` plan-node id and only
  consulted for ids already in `effective_targets` (root output lineage). A
  correlated scalar subquery's inner table is a *distinct* node id reached only
  through a scalar child (not `getRelations()`), so it can never leak into a
  target's defaultable set. Locked with a new regression test.
- **DRY / SPP / types / cleanup:** helpers are small and single-purpose
  (`baseSiteOf`, `collectBodyNodes`, `deriveViewInfo`, `yesNo`); mirrors the
  `function_info` idiom; no `any`; per-view `try/catch` logs rather than eating;
  no resource handles to clean up (`_buildPlan` allocates no cursors). The
  `_buildPlan` (logical) over `getPlan` (optimized) choice is correct and
  cheaper — verified the optimizer degrades a join's top-node lineage to
  `computed`, which `_buildPlan` avoids, and that `effective_targets` agrees with
  `propagate()` (spec cross-check).
- **Docs:** read the full `docs/view-updateability.md` § Information Schema
  Surface + § Implementation Surface diff; column table, static-derivation note,
  MV exclusion, and the parked per-column forward-pointer all reflect the landed
  reality. `getAllViews()` confirmed to enumerate plain views only (MVs live in a
  separate map), matching the doc's MV-exclusion claim.
- **Lint / typecheck / tests:** `yarn lint` ✓, `yarn typecheck` ✓,
  full `node test-runner.mjs` ✓ — **4149 passing / 9 pending / 0 failing** after
  the added tests.

### Minor — fixed in this pass
- **Test gap: the headline feature was not actually exercised.** The
  `adults_bare` case used a **nullable** `country`, so `is_insertable_into='YES'`
  fell out trivially (a nullable omitted column just takes NULL) — the
  projected-away constant-FD recovery that the whole-spine walk exists for was
  never load-bearing. Added `nn_pinned` (a `not null`, no-default, projected-away
  column pinned by the predicate ⇒ `YES` *only if* the spine walk recovers it)
  plus the `nn_unpinned` negative control (same column, no pin ⇒ `NO`). These now
  genuinely test the crux; both pass, confirming the implementation is correct and
  the original test was merely weak.
- **Added a correlated-scalar-subquery regression** (`subq_v`): a `not null`
  outer column unrecoverable, the subquery's inner table neither in
  `effective_targets` nor rescuing insertability ⇒ `is_insertable_into='NO'`,
  `effective_targets=["subq_outer"]`. Locks reviewer focus #4's no-leak reasoning.

### Major — filed as new ticket
- **`tickets/backlog/view-info-dynamic-truth-alignment.md`** captures the two
  genuine surface ≠ dynamic-truth divergences found:
  1. **`default_for` tag-defaults** are never threaded onto `attributeDefaults`
     (only `constant-fd` / `base-default` are), so a view whose insertability
     depends on a `default_for` tag covering a not-null projected-away column
     under-reports `is_insertable_into='NO'` (safe, NO-when-YES). Reviewer
     focus #2.
  2. **Outer-join `null-extended` columns** are unwrapped by `baseSiteOf` and
     counted as updatable / as effective targets, but null-extended write
     materialization is an unimplemented later phase — a potential false positive
     (YES-when-NO). Unreachable today (outer-join views are out of the landed
     scope, no test), but the dangerous direction, so it is tracked for when
     outer-join mutation lands. Reviewer focus #5.
  Both require non-trivial work (threading lineage / deciding the outer-join
  contract) and are independently shippable, hence a ticket rather than an inline
  fix.

### Accepted as-is (conservative, faithful to the ticket contract)
- **Multi-source `is_deletable` per-base rule** (reviewer #3): `ms_jv` reports
  `'NO'` because the parent PK is hidden, even though `delete from ms_jv` works
  dynamically (FK-child default). This is the ticket's explicit "PK constructible
  at *every* reachable base" contract — under-reports, never over-reports.
- **No caching** (reviewer #6): re-plans each body per call; deferred by the
  ticket; fine for small catalogs.
- **Unqualified `effective_targets` names** (reviewer #7): bare `tableSchema.name`,
  ambiguous only for same-named base tables across schemas referenced from one
  view — a multi-schema edge case, not present today. Noted; not worth a format
  change now (would complicate the SQL-standard-ish array). Re-raise if/when
  cross-schema view bodies become common.

### Not checked / empty categories
- **Performance under large catalogs:** not benchmarked. The N-re-plans-per-call
  cost is real but the ticket explicitly deferred caching; no regression risk to
  existing paths (the TVF is opt-in, touches no execution path).
- **Store-backed path (`test:store`):** not run — `view_info()` reads schema +
  planner surfaces only (no vtab data path), so the LevelDB store code path is
  not exercised by this change; the memory-backed suite is representative.

## Out of scope (parked)
- Per-column `information_schema.columns.is_updatable` →
  `tickets/backlog/view-column-updateability-surface.md`.
- Dynamic-truth alignment (tag-default + outer-join) →
  `tickets/backlog/view-info-dynamic-truth-alignment.md`.
- Materialized views: read-only at the write boundary; `view_info()` walks
  `getAllViews()` (plain views) only.
