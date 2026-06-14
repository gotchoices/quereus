----
description: Review the fix that grafts catalog-only tags back onto maintained table records in every reshape-rebuild arm, preventing concurrent SET TAGS from being silently dropped.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts
difficulty: easy
----

# Review: reshaping re-attach drops concurrent SET TAGS — fix

## What was changed

A shared helper `graftReshapedRecord` was added to `materialized-view-helpers.ts` and called at every reshape-rebuild site that previously used `{ ...moduleSchema, derivation: source.derivation }` (which dropped `.tags`):

- `attachMaintainedDerivation` — three rebuild sites (pre-reconcile, post-reconcile-op, and the `restoreReshaped` failure branch)
- `reshapeBackingInPlace` — pre-reconcile and per-op rebuilds
- `renameShiftedBackingColumns` — source-rename relabel

All source records are read from the live catalog **after** any SET TAGS leg has already run (differ ordering ensures SET TAGS precedes the `set maintained` block), so `.tags` already holds the declared value when grafted.

## Test coverage added / tightened

- `maintained-table-differ-coverage.spec.ts` § "a concurrent tag change + rename-list change…": removed the KNOWN GAP placeholder and now asserts `mv.tags['team.owner'] === 'new'` plus convergence (`tableTagsChange` undefined on re-diff).
- `materialized-view-refresh-reshape.spec.ts` § "an in-place reshape preserves the MV table tags": new test covering the refresh arm (`reshapeBackingInPlace`).

## Validation run

| Suite | Result |
|---|---|
| `yarn test` (full monorepo) | 6218 quereus + 1210 other packages — all passing |
| `yarn lint` (packages/quereus) | clean |

## Known gaps / reviewer focus areas

- The `renameShiftedBackingColumns` arm is tested indirectly via the differ-coverage suite's rename-list case; there is no dedicated refresh test for that specific path. A reviewer should confirm the indirect coverage is sufficient or add a targeted test.
- The failure / `restoreReshaped` branch that uses `graft(moduleSchema, priorMaintained)` is not independently exercised by the new tests — it is hit only when the backing ALTER fails mid-reshape. Confirm the source record (`priorMaintained`) is captured before the failing operation so its tags are current.
