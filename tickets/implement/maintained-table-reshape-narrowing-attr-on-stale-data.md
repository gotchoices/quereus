description: A refresh reshape applies survivor type/collation shifts to the PRE-reconcile (stale, about-to-be-discarded) backing rows, throwing a spurious MISMATCH/CONSTRAINT on a reshape the fresh body would satisfy — and the partial failure additionally DIVERGES the catalog schema from the backing module's live schema (corrupting the table, non-converging). Fix: defer narrowing attribute shifts (retype/recollate) past the data reconcile, mirroring the existing NOT NULL tighten deferral, so they validate against the reconciled body rows, not the discarded data.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # classifyBackingReshape (recordAttrShift / ReshapePlan / plan.ops ordering), reshapeBackingInPlace (the ops-loop-then-rebuildBacking-then-tightenNotNull sequence)
  - packages/quereus/src/vtab/memory/layer/manager.ts                        # alterColumn (~L1760 setDataType physical-convert → MISMATCH; ~L1826 setCollation → rebuildAllSecondaryIndexesStrict → CONSTRAINT); replaceBaseLayer (~L1233 — does NOT validate values, just PK-extracts + inserts: deferral is sound)
  - packages/quereus-store/src/common/store-module.ts                       # alterColumn (~L1313 setDataType physical-convert → MISMATCH; setCollation re-key) — same hazard, durable path; covered by the engine-level fix
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts          # add narrowing-retype + recollate-collision + convergence-after-throw cases
  - packages/quereus-store/test/mv-store-backing.spec.ts                     # store reshape narrowing parity (durable path)
difficulty: medium
----

# Reshape attribute shifts must validate against the reconciled body, not the discarded backing

## Root cause (confirmed by reproduction)

`reshapeBackingInPlace` (in `materialized-view-helpers.ts`) reshapes a maintained
table in place by:

1. applying every `plan.ops` entry through the host module's `alterTable`
   (`renames → adds → attribute shifts (retype/recollate/loosen) → drops`) — **a
   loop that mutates the backing module's live `TableSchema` in place**, then
2. `schema.addTable(live)` — re-register the reshaped catalog schema, then
3. `rebuildBacking` — re-run the body and `replaceContents`, **fully discarding the
   old rows**, then
4. assert the deferred NOT NULL tightenings (`plan.tightenNotNull`).

Because step 3 replaces the data wholesale, step 1's *only* job is to morph the
schema; the pre-reconcile rows are about to be thrown away. The 6.5 implementer
recognised this for **ADD NOT NULL** and deferred it to step 4. The **same hazard
applies to narrowing type and collation shifts**, but those are NOT deferred — they
run in step 1 against the live, soon-to-be-discarded rows:

- `MemoryTable.alterColumn` / `setDataType` (physical conversion, `manager.ts`
  ~L1760-1787) iterates the primary tree and `validateAndParse`s every existing
  value, throwing **MISMATCH** on the first non-convertible one.
- `setCollation` (`manager.ts` ~L1826-1830) runs `rebuildAllSecondaryIndexesStrict`,
  throwing **CONSTRAINT** on a stale-data UNIQUE collision under the new collation.
- The store module (`store-module.ts` ~L1313) has the identical arms (durable path).

So a maintained passthrough column whose source type/collation narrows — where the
**stale backing** still holds pre-narrowing values but the **re-derived body**
produces conforming ones — errors on a reshape that should succeed.

### Two distinct bugs, one cause

Reproduced (memory module) with: a `select *` MV over `t(id, v text)` holding
`'abc'`; mark the MV stale with an unrelated source change (`add column w`) so a
subsequent source data-fix is **not** maintained into the backing (writes during
staleness are unmaintained — the backing keeps `'abc'`); clean+narrow `t.v` to
`integer`; `refresh`. Observed:

1. **Spurious throw** — refresh #1: `Cannot convert value in 'v' to INTEGER`. The
   body is integer-clean; only the discarded backing held `'abc'`. (The ticket's
   reported symptom.)
2. **Catalog/module divergence on partial failure** — refresh #2:
   `Duplicate column name: w`, and the MV is left **corrupted**:
   `{"id":1,"v":"abc","col_2":null}`. Because step 1 throws *mid-loop* (the `add w`
   op already mutated the backing module's live schema to 3 columns) but step 2's
   `schema.addTable(live)` **only runs after the whole loop completes**, the catalog
   `TableSchema` stays 2-column while the module's live schema is 3-column. A
   `select *` then yields 3 values under a 2-name catalog (the mystery `col_2`), and
   a re-run's classifier re-emits `add w` against a backing that already has it.

   This directly contradicts the 6.5 doc/handoff claim that a re-run "re-derives the
   residual delta and converges" — it holds for the NOT NULL tighten fast-path but
   **not** for a mid-sequence attribute-shift throw, which is non-converging and
   corrupting.

## Fix

Defer the **throwing-on-data** attribute shifts (retype, recollate) past the
reconcile, joining the existing `tightenNotNull` deferral, so every op that can fail
on data validates against the **reconciled body rows** (which satisfy the new
attribute) rather than the discarded backing.

This is sound because neither base-layer insert path validates values:
`MemoryTable.replaceBaseLayer` (`manager.ts` ~L1233-1261) only PK-extracts and
inserts each body row raw; the store backing-host `replaceContents` likewise
puts serialized rows by keyed diff. So a body value that conforms to the NEW
type/collation enters the still-OLD-typed column unvalidated, and the post-reconcile
`alterColumn` then converts/re-keys the clean body data successfully.

Generalize the `ReshapePlan` deferral mechanism instead of special-casing each kind:

- Split the plan into a **pre-reconcile** op list (`renames`, `adds`, `drops`, and
  `loosenNotNull` — none of which throw on data) and a **post-reconcile** op list
  (`retype`, `recollate`, then `tightenNotNull`). Cleanest shape: fold
  `tightenNotNull: string[]` into a single `postReconcileOps: ReshapeColumnOp[]` by
  adding a `{ kind: 'tightenNotNull'; name }` op variant lifted in
  `reshapeOpToChange` to `{ type: 'alterColumn', setNotNull: true }` — so all four
  deferred classes flow through one mechanism.
- `recordAttrShift` routes `retype`/`recollate` into the post-reconcile list (today
  they go into `attrs`, which feeds `plan.ops`); `loosenNotNull` stays pre-reconcile
  (it never throws); `tightenNotNull` stays post-reconcile (unchanged semantics).
- `reshapeBackingInPlace`: apply pre-reconcile ops → `addTable(live)` →
  `rebuildBacking` → apply post-reconcile ops → re-register the final schema → fire
  the single `table_modified`.

**This also closes the divergence/corruption bug**: after the split, the only ops
that run *before* `schema.addTable(live)` are the structural ones that cannot throw
on data, so a partial-failure window where the catalog and module schemas diverge no
longer arises in practice; and a genuine mid-sequence throw (a body the new
attribute still can't satisfy) now happens *after* the catalog is consistently
re-registered, so the table is left in a coherent, re-runnable state that **converges**
once the underlying data is fixed.

### PK-column *type* change sub-case (flagged, untested today)

`describePhysicalPkChange` rejects PK set/order/direction/collation changes but
**permits a PK-column type change** (a retype is not a PK-definition change). With
the deferral, a PK-column retype would run post-reconcile — but `replaceBaseLayer`
keys the body rows under the *old* column type's comparator during the reconcile,
which may mis-key new-typed PK values. This route is untested. Add the test (below);
if it cannot be made to pass cleanly within this ticket's scope (it likely needs a
metadata-only type set on the PK column *before* the reconcile, or to keep PK-column
retype pre-reconcile against the freshly-keyed-then-converted rows), **file a
`tickets/backlog/` follow-up** rather than expanding scope here, and document the
deferral in this ticket's handoff.

## Recoverability note

The 6.5 ordering comment ("data-lossless ops first so a mid-sequence failure leaves a
state a re-run re-derives") is now accurate for the *pre-reconcile* batch only. Keep
the rename/add-before-drop ordering within the pre-reconcile list. Update the
`reshapeBackingInPlace` and `classifyBackingReshape` docstrings to reflect the two-
phase split and the corrected recoverability story.

## TODO

### Phase 1 — fix
- In `materialized-view-helpers.ts`, change `ReshapePlan` to carry a post-reconcile
  op list (fold `tightenNotNull` into it via a new `tightenNotNull` op kind, or keep
  a parallel list — prefer the unified list).
- Add the `{ kind: 'tightenNotNull' }` arm (or keep the existing string list) and the
  `retype`/`recollate` deferral in `recordAttrShift`; assemble `plan.ops` (pre) and
  the post list in `classifyBackingReshape`.
- Lift the new/relocated ops in `reshapeOpToChange`.
- Rework `reshapeBackingInPlace` to apply pre-reconcile ops → register → reconcile →
  apply post-reconcile ops → re-register → notify; ensure the catalog schema is
  re-registered consistently so no catalog/module divergence survives a throw.
- Update the docstrings on `classifyBackingReshape` / `reshapeBackingInPlace` (two-
  phase split, corrected recoverability).

### Phase 2 — memory tests (`materialized-view-refresh-reshape.spec.ts`)
- **Narrowing retype on stale backing**: backing holds a non-convertible value, the
  re-derived body is clean → refresh reshapes in place (value under the right label,
  column type updated, `table_modified` only), **no MISMATCH**. (Use the staleness
  window to leave the backing dirty, as in the reproduction.)
- **Survivor recollate with a stale-data unique collision** but a clean body →
  reshape succeeds (no CONSTRAINT).
- **Convergence after an actual mid-sequence throw**: force a real reshape failure
  (a narrowing even the body can't satisfy), assert the table is left coherent and
  stale (no `col_2`-style divergence, no spurious extra columns), then fix the
  underlying data and re-refresh → assert it converges (the recovery leg the 6.5
  suite documents but never exercises beyond the NOT NULL second-refresh).
- **PK-column type change** route (see sub-case above): add the test; on failure,
  file a backlog follow-up and document.

### Phase 3 — store parity (`mv-store-backing.spec.ts`)
- Mirror the narrowing-retype reshape on the durable store backing, ideally inside an
  explicit transaction (multiple `alterTable` + one `replaceContents`), to pin
  `store-module.ts`'s `alterColumn` arms under the same narrowing.

### Phase 4 — validate
- `yarn workspace @quereus/quereus test` and the store backing suite
  (`yarn workspace @quereus/quereus-store test`); stream with `tee`.
- Note: `mv-rename-propagation.spec.ts:70` ("TABLE rename re-keys … regenerated DDL
  re-parses") fails at HEAD, unrelated to this work (MV DDL stringify round-trip) —
  see `tickets/.pre-existing-error.md`. Do not chase it here.
