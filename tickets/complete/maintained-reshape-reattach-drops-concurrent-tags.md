description: A reshaping maintained-table re-attach/refresh rebuilt the catalog record from the backing module's post-ALTER `TableSchema` (which carries neither `derivation` nor the catalog-only `tags`), silently dropping a concurrent SET TAGS. Fixed by a shared `graftReshapedRecord` helper that grafts both fields from the authoritative catalog record at every reshape-rebuild site. Reviewed and completed.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts
  - packages/quereus/test/mv-rename-propagation.spec.ts
----

# Maintained reshape re-attach drops concurrent SET TAGS — fixed & reviewed

## What shipped

`module.alterTable` returns only the physical column shape — it tracks neither the
catalog-only `derivation` nor the catalog-only `tags`. Every reshape-rebuild site
previously grafted `{ ...moduleSchema, derivation }`, silently dropping the table's
tags whenever a reshape ran. A concurrent `SET TAGS` (routed through `ALTER
MATERIALIZED VIEW`, ordered by the differ to land *before* the `set maintained`
re-attach) was therefore lost the instant the re-attach reshaped the backing.

The fix introduces a single shared helper:

```ts
function graftReshapedRecord(moduleSchema: TableSchema, source: MaintainedTableSchema): MaintainedTableSchema {
    return { ...moduleSchema, derivation: source.derivation, tags: source.tags };
}
```

called at all six reshape-rebuild sites — `attachMaintainedDerivation`
(pre-reconcile, post-reconcile-op, and the `restoreReshaped` failure branch),
`reshapeBackingInPlace` (pre-reconcile + per-op), and `renameShiftedBackingColumns`
(source-rename relabel). Because every source record is read from the live catalog
*after* the SET TAGS leg has already run, `.tags` already holds the declared value
when grafted.

## Review findings

**Implementation reviewed:** fix commit `fca56bad` (the implement commit `71522116`
is a board move only). Read the full code diff before the handoff.

### Correctness — verified
- **Differ ordering holds.** `schema-differ.ts:2451` emits the `ALTER MATERIALIZED
  VIEW … SET TAGS` inside the table-alter block; the `set maintained as` re-attach is
  emitted later at `:2474`. SET TAGS therefore executes first, so the live catalog
  record the reshape reads already carries the new tags.
- **`priorMaintained` is current.** Captured at `materialized-view-helpers.ts:1033`
  via `schema.getTable(name)` at the *start* of `attachMaintainedDerivation` — i.e.
  after the prior SET TAGS statement committed — so the `restoreReshaped` failure
  branch grafts current tags. The handoff flagged this; confirmed correct by
  inspection.
- **`derivation` identity preserved.** `reshapeBackingInPlace` mutates `mv.derivation`
  fields in place then grafts `mv` (same object by reference); attach sites graft
  `maintained.derivation`. No regression vs. prior behavior.
- **Single source of truth / DRY.** A whole-`src` grep for `derivation: <x>.derivation`
  returns exactly one hit (the helper body). All six sites consolidated; no straggler
  drops tags.

### Tests
- **Run green:** reshape suite (35 passing), full `tag`-grep suite (221 passing),
  `MV rename propagation` (7 passing). `yarn lint` (eslint + `tsc -p
  tsconfig.test.json --noEmit`) clean.
- **Implementer's two tests confirmed real:** the differ-coverage tag assertion and
  the in-place-reshape (`reshapeBackingInPlace`) refresh test both exercise the graft
  and would fail pre-fix.

### Findings & dispositions
- **MINOR — fixed inline.** The handoff claimed `renameShiftedBackingColumns` was
  "tested indirectly via the differ-coverage rename-list case." That is inaccurate:
  the differ-coverage `set maintained (cols) as` case routes through
  `attachMaintainedDerivation`, a *different* function. The graft at
  `materialized-view-helpers.ts:2794` (the source-column-rename relabel arm) had **no**
  test asserting tag preservation. Added `mv-rename-propagation.spec.ts` § "COLUMN
  rename preserves the MV table tags while shifting the backing column" — a regression
  test that creates a tagged `select *` MV, renames a source column, and asserts both
  the backing column rename and tag survival. Passes; fails against the pre-fix graft.
- **Checked, no action — `restoreReshaped` failure branch.** Not independently
  exercised with tags; forcing a mid-reshape `alterTable` failure *with* a concurrent
  tag change is disproportionately complex. The path is provably correct
  (`priorMaintained.tags` is current per above; the helper copies it), and the
  existing "reconcile failure AFTER the structural reshape" test already covers the
  branch's control flow. Verified by inspection.
- **Noted, out of scope — other catalog-only fields.** The rebuild still drops
  `statistics` / `estimatedRows` / `mutationContext` / `isReadOnly` (anything not on
  the module's post-ALTER schema). This is **pre-existing** — the old
  `{ ...moduleSchema, derivation }` dropped them too — and `derivation` + `tags` are
  the genuinely catalog-only fields that matter for a maintained table. Not a
  regression; no ticket filed.
- **Docs — checked, accurate.** `docs/materialized-views.md` models tags as living on
  the owning table (§ derivation record, § tags-only change ⇒ set tags). No claim
  contradicts the fix; the fix restores the invariant the docs already imply. No
  update needed.

## End
