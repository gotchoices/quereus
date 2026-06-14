description: A reshaping re-attach (and refresh-driven reshape) on a maintained table rebuilt the live catalog record from the backing module's post-ALTER `TableSchema` — derivation-less AND tag-less — silently dropping a concurrent SET TAGS (declarative apply) or any existing tags (refresh). Fix grafts the catalog-only tags back alongside the derivation in every reshape arm. The code change and its regression tests are already applied and green; this stage validates the full suite and hands off to review.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # new graftReshapedRecord helper; all reshape-rebuild sites carry tags
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts   # tightened "concurrent tag change + rename-list" test asserts the tag lands
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # new test: in-place refresh reshape preserves MV tags
difficulty: easy
----

# Reshaping re-attach drops a concurrent SET TAGS on a maintained table — FIX APPLIED

## What was wrong

`module.alterTable` returns a fresh `TableSchema` carrying only the physical
column shape — neither the catalog-only `derivation` nor the catalog-only
`tags`. Every reshape arm rebuilt the live record as
`{ ...current, derivation }`, grafting the derivation back but **dropping the
tags**. So:

- **Declarative apply:** a reshaping re-attach (`set maintained (cols) as …`)
  ran AFTER the `ALTER MATERIALIZED VIEW … SET TAGS` leg the differ routed onto
  the same diff (DDL order: SET TAGS in the table-alter block precedes the
  `set maintained` block). The reshape then overwrote the just-set tags with a
  tag-less record, so the SET TAGS was silently lost and never converged.
- **Refresh:** a refresh-driven in-place reshape (`reshapeBackingInPlace`,
  `renameShiftedBackingColumns`) wiped any existing tags on every reshape — a
  latent, previously-uncovered bug.

A non-reshaping (body-only) re-attach keeps the whole `maintained` record, tags
included, so the gap was scoped strictly to the reshape rebuild sites.

## What was done

Added a shared helper in `materialized-view-helpers.ts`:

```ts
function graftReshapedRecord(moduleSchema: TableSchema, source: MaintainedTableSchema): MaintainedTableSchema {
	return { ...moduleSchema, derivation: source.derivation, tags: source.tags };
}
```

Routed every reshape-rebuild site through it (was `{ ...current, derivation: … }`):

- `attachMaintainedDerivation` — pre-reconcile rebuild (`graft(current, maintained)`),
  post-reconcile-op rebuild (`graft(current, maintained)`), and the
  `restoreReshaped` failure branch (`graft(moduleSchema, priorMaintained)`).
  All three source records were captured from the live catalog AFTER the SET
  TAGS leg ran, so their `.tags` already hold the declared tags.
- `reshapeBackingInPlace` — pre-reconcile and per-post-op rebuilds
  (`graft(current, mv)`).
- `renameShiftedBackingColumns` — the source-rename backing relabel
  (`graft(current, mv)`).

Tests:

- Tightened `maintained-table-differ-coverage.spec.ts` § "a concurrent tag
  change + rename-list change…": removed the KNOWN GAP note and now asserts
  `mv.tags['team.owner'] === 'new'` plus tag-leg convergence (`tableTagsChange`
  undefined on the re-diff).
- Added `materialized-view-refresh-reshape.spec.ts` § "an in-place reshape
  preserves the MV table tags" — covers the refresh arm
  (`reshapeBackingInPlace`).

## Verification already run

- `materialized-table-differ-coverage.spec.ts` — 12 passing.
- `materialized-view-refresh-reshape.spec.ts` — 13 passing (incl. the new test).
- `maintained-table-attach-detach`, `-migration-capstone`, `-refresh-revalidation`,
  `materialized-view-cascade` — 79 passing.
- `yarn typecheck` (quereus) — clean.

## TODO (this stage → review handoff)

- Run the full `yarn test` once to confirm no cross-suite regression.
- Run `yarn lint` in `packages/quereus` (eslint + `tsc -p tsconfig.test.json`)
  to catch any spec call-site signature drift.
- Write the `tickets/review/` handoff summarizing the change and the suites run.
