---
description: Inside a transaction, reads over a storage module's own index now also show the transaction's uncommitted changes, including reads over an index (such as a multi-dimensional one) whose row order cannot be described; staged rows are matched against the module's filters as a strict "all must hold" list.
prereq: module-listed-seek-arguments-planner
architecture: docs/design-isolation-layer.md#key-ordering
files:
  - packages/quereus-isolation/src/isolated-table.ts      # IndexScanInfo 'unordered'; OverlayDelta; resolveScanIndex; mergedUnorderedQuery; collectOverlayDelta; buildConstraintMatcher; constraintComparator; satisfiesBound (EQ arm)
  - packages/quereus-isolation/test/module-seek-overlay.spec.ts
  - docs/design-isolation-layer.md
  - docs/module-authoring.md
---

# Module-listed seek arguments — isolation overlay half

## What landed

The prereq lets a module list the filters it enforces inside its own index (`BestAccessPlanResult.moduleSeekFilters`, plan kind `moduleSeek`, `plan=8`); a plan over an index the engine cannot resolve that claims no order arrives as the access path `{ kind: 'unorderedIndex' }`. `IsolatedTable` (the wrapper that merges a transaction's staged rows — "the overlay" — into the underlying module's stream) now handles both:

- `unorderedIndex` maps to a set merge (`mergedUnorderedQuery`): stream the underlying, drop rows whose primary key the overlay touched, then append the overlay's in-window live rows. No sort, no interleave, never the primary-key `mergeStreams`.
- Step 1 of the secondary merge (full overlay scan collecting shadowed keys and in-window rows) was factored into `collectOverlayDelta`, shared by both merges.
- `buildConstraintMatcher` accepts `unorderedIndex`; for `moduleSeek` every EQ is a must-hold bound (conjunction) instead of an IN-set member, and the comparator uses the index key column's collation, else BINARY — matching the planner's collation cover (`moduleSeekCover`, which also reads undefined key collation as BINARY).

Tests: `packages/quereus-isolation/test/module-seek-overlay.spec.ts` — a box read over an undescribable index with staged inserts/updates/deletes equals the post-commit answer; `x = ? and x = ?` with `[1, 2]` over a resolved index returns nothing inside or after the transaction.

## Review findings

Read the `ticket(implement): module-listed-seek-arguments-isolation-overlay` diff first, then the handoff.

- **Correctness — checked, no defect.** Routing in `mergedQuery`/`resolveScanIndex` (exhaustive switch kept); `mergedUnorderedQuery` widens `requiredColumns` with the primary key via `underlyingFilterInfoForMerge(filterInfo, [])` before shadow probing; the no-`overlay.query` fallback passes the original FilterInfo, which is fine since nothing is probed. Tombstones are added to the shadow set before the live-row check. Null run-time arguments fail every bound (`value === null`) and null row values fail the window, matching the documented module contract. Role-primary `moduleSeek` takes `mergeStreams`; the memory overlay treats `plan=8` as an unbounded primary walk (`buildScanPlanFromFilterInfo` has no plan-8 branch) and `queryOverlayAsMergeEntries` re-applies the conjunctive matcher — confirmed by reading `packages/quereus/src/vtab/memory/layer/scan-plan.ts`.
- **Collation agreement — checked, no defect.** The planner (`resolveIndexKeyCollations` → `key.collation ?? 'BINARY'`; unresolved index or undescribed column → BINARY) and the matcher (`index?.keyColumns…collation ?? undefined` → BINARY for `moduleSeek`) agree on every case. Non-`moduleSeek` kinds keep the table-column fallback unchanged.
- **Docs — gap found, fixed.** `docs/module-authoring.md`'s module-listed-seek **Order** paragraph said nothing about emission order over a *resolved* index, though the overlay relies on it (and for a role-primary index, `mergeStreams` mis-shadows on an out-of-order stream). Added a sentence: over `_primary_`, a schema index, or a described index, a module-listed seek owes that index's key order whether or not it claims one, as a multi-seek does; only `unorderedIndex` is merged as a set. This closes the handoff's "known gaps" 1 and 2 as a contract statement; no runtime check added (`debt-nothing-checks-advertised-row-order` already proposes that check in `mergeStreams` / `mergedSecondaryIndexQuery`, so no new ticket). `docs/design-isolation-layer.md` changes read correctly against the code.
- **Tests — kept both.** Each pins a named piece of the contract on branching logic. Re-ran the implementer's IN-set mutation (`conjunctive = false`): the conjunction test fails with `[3]` vs `[]`; source restored. No test added for BINARY-when-undescribed: unreachable from SQL because the planner declines a non-BINARY listed filter on an undescribed index before the overlay sees it.
- **Test double — checked.** Extends `MemoryTableModule` and overrides `query` on created/connected instances; it emits in descending primary-key order, so a merge leaning on primary-key order would fail test 1. Acceptable for a fixture.
- **Source hygiene / size.** `isolated-table.ts` is 2,298 lines (`wc -l`); it is already listed in `tickets/backlog/debt-oversized-source-files.md`, whose count I updated from 2,077. Comments in the diff state why, not what; the moved full-overlay-scan `NOTE:` tripwire travelled with `collectOverlayDelta` and was reworded to "non-primary read".
- **Performance / resource cleanup — no new concern.** The unordered merge buffers only the in-window overlay rows (same as the secondary merge) and streams the underlying; the per-read full overlay scan is the existing `NOTE:` tripwire.
- **Type safety — checked.** `buildMergeConfig` narrowed to `Exclude<IndexScanInfo, { type: 'unordered' }>`; `buildMultiRangeWindowMatcher` and `constraintComparator` accept `IndexDescriptor | undefined` with no casts.
- **Tripwires added: none.** No major findings, no tickets filed.

## Validation

`yarn workspace @quereus/isolation run typecheck` green; `yarn workspace @quereus/isolation test` 455 passing. This pass changed only docs and a ticket line count, so the implementer's full `yarn build` / `yarn test` run (all green) stands.
