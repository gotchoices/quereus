description: Give `alter table … set maintained as` a reshape-on-attach capability for IMPLICIT-shape (sugar) maintained tables, so a body that renames an output column (`select id, x` → `select id, y`) reshapes the backing to follow the body instead of erroring at the strict shape check. Reuses the refresh-path reshape machinery; gated to the implicit form and the attach verb.
prereq: maintained-reattach-columns-parity
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation — add allowReshape; classifyBackingReshape integration; reshapeOpToChange/module.alterTable reuse
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — pass allowReshape=true
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # new: reshape-on-attach verb cases (rename, add/drop trailing, inexpressible reject)
  - packages/quereus/test/declarative-equivalence.spec.ts            # new/updated: a sugar MV output-column rename now applies via apply schema
difficulty: hard
----

# Re-attach reshape-on-attach for implicit (sugar) maintained tables

## The limitation

`alter table … set maintained as <body>` runs a STRICT declared-shape check
(`describeAttachShapeMismatch`, names included) and has no rename-list syntax.
So on a sugar maintained table a body change that renames an output column
errors:

```
create materialized view m as select id, x from src;   -- m columns [id, x]
-- declared body changes to:    select id, y from src
-- differ emits: alter table m set maintained as select id, y from src
--   → "cannot attach derivation … body output column 2 is named 'y'
--      but the table declares 'x'"
```

The differ is **plan-free** and a declared sugar MV normalizes with
`columns: []` (the body owns the shape), so the differ cannot derive the body's
output shape to know a reshape is needed — it compares only `bodyHash`, sees the
body changed, and emits a plain `set maintained as`. **The reshape therefore has
to happen verb-side.** (This is the only viable option for this case — the
"differ detects + emits column-rename ops" alternative applies only to the
explicit rename-list case, which is the sibling backlog ticket
`maintained-reattach-explicit-rename-list-reshape`.)

The engine already has the reshape machinery — the **refresh** path
(`materialized-view.ts` → `reshapeBacking` → `classifyBackingReshape` →
`reshapeBackingInPlace`) reshapes a maintained table whose re-derived body shape
shifted (the canonical "a widened `select *` reshapes on reopen" behavior). This
ticket reuses that classifier and op-execution to reshape **on attach** for the
implicit form.

## Design

Add a parameter to the shared attach core:

```ts
export async function attachMaintainedDerivation(
  db, table, select, insertDefaults, recordedColumns,
  positionalRename = false,
  allowReshape = false,        // NEW
): Promise<MaintainedTableSchema>
```

- `runSetMaintained` (the verb path — manual `set maintained as` AND the
  differ-emitted re-attach) passes `allowReshape = true`.
- `createMaintainedTable` leaves the default `false`: a freshly-created table is
  built to its declared shape, so a body mismatch there stays the sited create
  error (the explicit form already positionally-renames via `positionalRename`).

**Gate.** Reshape engages only when ALL hold:
1. `allowReshape` is set (verb path), AND
2. the recorded form is implicit — `recordedColumns === undefined` /
   `!positionalRename` (after the parity ticket the verb always records
   `undefined`), AND
3. `describeAttachShapeMismatch(table, shape, /*skipNames*/ false)` reported a
   mismatch.

When engaged, classify the delta with `classifyBackingReshape(table, shape)`:

- **expressible** (trailing add/drop, positional rename, per-column
  type/collation/not-null change, PK unchanged) → reshape in place around the
  attach reconcile (below);
- **inexpressible** (interleaving reorder, physical-PK-definition change) → throw
  `inexpressibleReshapeError` (the existing "alter the table to the new shape and
  re-attach, or drop and recreate" sited error). These genuinely need
  drop+recreate; do NOT silently re-key.

**Reshape-around-reconcile sequencing.** The attach core's contract is
verify-by-diff: a minimal keyed diff (`'replace-all'`) that reports only the
genuine row changes and cascades them to consumers. Preserve that — do NOT
substitute the refresh path's wholesale `rebuildBacking`. Instead splice the
reshape's two op batches around the existing reconcile:

```
… gates (shape-mismatch→classify, cycle, must-be-a-set) all run BEFORE mutation …
attachDerivation + registerMaterializedView (create-time gates; throw → restorePrior)
→ apply plan.preReconcileOps (rename/add/loosen/drop — none throw on data) via module.alterTable
→ re-resolve the reshaped backing + reconcile by diff ('replace-all', shape-keyed)
→ validateDeclaredConstraintsOverContents
→ apply plan.postReconcileOps (retype/recollate/tightenNotNull — validate the reconciled rows)
→ link covers, cascade genuine changes, fire materialized_view_modified
```

Reuse `reshapeOpToChange` + `module.alterTable` exactly as `reshapeBackingInPlace`
does; carry the shape-derived key/ordering/sourceTables onto the derivation
(`logicalKey`/`coarsenedKey`/`ordering`/`sourceTables`) the same way.

## Critical correctness points (write these as tests)

- **Shape-indexed PK for the set check and the reconcile.** Today
  `assertDerivedRowsAreSet(rows, table, …)` keys the duplicate check by
  `table.primaryKeyDefinition`. When a reshape drops/adds a (trailing) column the
  derived rows are indexed by `shape`, not `table` — a non-leading PK index could
  misalign. Key the duplicate check (and the reconcile) by
  `computeBackingPrimaryKey(shape)` instead. `classifyBackingReshape` forbids
  PK-definition changes, so the PK *columns* are identical; only their indices
  may shift, which the shape-derived PK accounts for.
- **`rename` is schema-only; the data change rides the reconcile.** For the
  headline case `select id, x` → `select id, y`, the rename op relabels backing
  column 2 (x→y) carrying the OLD values, then the `'replace-all'` diff updates
  every row whose value actually changed — so the reported changes are the
  genuine per-row value diffs (NOT a spurious full-table churn from the relabel).
  Assert the dispatched diff is the minimal set.
- **Consumer staleness on a SHAPE change.** A re-attach normally fires
  `materialized_view_modified` and cascades only ROW changes (consumers reading
  an unchanged shape stay live). A reshape changes the table's column SHAPE, so a
  consumer reading the reshaped column must invalidate. Ensure the reshape path
  re-registers the new-shape schema in the catalog AND that consumers go stale
  (the refresh reshape fires `table_modified` for exactly this). Decide and
  document whether reshape-on-attach fires `table_modified` IN ADDITION to
  `materialized_view_modified`, or relies on the modified event's cascade —
  verify a consumer MV over the reshaped table re-derives the renamed column
  correctly after the attach.
- **Partial-failure / rollback of the structural ops.** `module.alterTable`
  mutates the module's live schema immediately (not via the pending connection
  layer the reconcile uses). The `restorePrior` rollback restores the catalog
  RECORD but does not undo a module rename. Mitigate by ordering so every
  data-throwing gate (`registerMaterializedView`, the must-be-a-set reject,
  cycle check) runs BEFORE `preReconcileOps`, and the data-validating
  `postReconcileOps` run only after the reconcile + constraint validation
  succeeded — mirroring `reshapeBackingInPlace`'s two-phase split, which exists
  precisely so a throw cannot strand catalog/module divergence. If a residual
  divergence window remains, document it explicitly (the table is left coherent
  and re-runnable) rather than papering over it. VERIFY the memory backing-host's
  `alterTable` behavior; if the store module path differs, note it for
  `yarn test:store` (do not run the slow store suite inside this ticket — flag it
  via `tickets/.pre-existing-error.md` only if a store-specific failure surfaces).

## Edge cases & interactions

- **Implicit gate is mandatory.** An explicit-recorded maintained table
  (`positionalRename`/`recordedColumns` set — only `createMaintainedTable`'s
  explicit form today) must NOT reshape: the rename list is the authoritative
  arity-locked interface. The gate (`!positionalRename`) enforces this.
- **`create table … maintained as` (implicit, no list) on `createMaintainedTable`
  is NOT reshaped** — `allowReshape` defaults false there; the table is built to
  match its body, so a mismatch is a genuine authoring error. Keep its sited
  create error.
- **Fresh attach (plain → maintained) with a shape difference.** Via the differ
  this normally arrives with ordinary column ops already on the diff (when the
  declared TABLE-FORM columns differ); for a SUGAR fresh-attach (declared
  columns `[]`) there are no column ops, so reshape-on-attach handles it — the
  plain table's rows are discarded by the reconcile anyway, so following the body
  is correct. Cover a plain-table fresh attach whose body names differ from the
  plain columns.
- **Inexpressible reshape leaves the table untouched** and surfaces the sited
  error — assert nothing partially mutated (catalog record unchanged; for a
  re-attach the prior derivation/plan restored via `restorePrior`).
- **Identical-content reshape.** A pure rename whose values are unchanged
  (`select id, x` aliased to `y` but reading the SAME source column) reshapes the
  schema yet reports ZERO row changes — assert the dispatch is empty.
- **`coarsenedKey` / ordering** carried by the new shape must land on the
  derivation (the refresh reshape sets these); a coarsened re-attach still warns
  via the existing `warnKeyCoarsening` tail.
- **NOT NULL tighten over divergent rows.** A reshape that tightens NOT NULL must
  validate the RECONCILED body rows (post-reconcile batch), not the stale backing
  — exactly the reason `reshapeBackingInPlace` defers those ops. Mirror it.

## Acceptance

- `alter table m set maintained as select id, y from src` on a sugar MV `m`
  declared `select id, x` reshapes `m` (column 2 renamed x→y, values updated) and
  succeeds, dispatching only the genuine row diffs.
- The same change driven declaratively (`apply schema` over a sugar MV whose body
  output column was renamed) applies instead of erroring — update/add the
  `declarative-equivalence.spec.ts` coverage accordingly.
- An interleaving / PK-changing body still errors with the sited inexpressible
  reshape message, table untouched.
- All existing attach/detach fidelity, lifecycle-event, and round-trip pins stay
  green; the full declarative suite stays green.

## TODO

- Thread `allowReshape` into `attachMaintainedDerivation`; pass `true` from
  `runSetMaintained`, leave default in `createMaintainedTable`.
- Replace the unconditional `describeAttachShapeMismatch` throw with: on mismatch
  + implicit + `allowReshape`, `classifyBackingReshape(table, shape)`; expressible
  → remember the plan, inexpressible → `inexpressibleReshapeError`.
- Key `assertDerivedRowsAreSet` and the `'replace-all'` reconcile by
  `computeBackingPrimaryKey(shape)` when a reshape is in play (or always — it is
  equivalent when shapes match).
- Apply `plan.preReconcileOps` (via `module.alterTable` + `reshapeOpToChange`)
  after `registerMaterializedView` and before the reconcile; re-resolve the
  reshaped backing; apply `plan.postReconcileOps` after the constraint validation.
  Carry `shape.primaryKey`/`coarsenedKey`/`ordering`/`sourceTables` onto the
  derivation.
- Decide + implement consumer-staleness on shape change (additional
  `table_modified`, or confirm the `materialized_view_modified` cascade suffices);
  cover with a consumer-MV test.
- Add `maintained-table-attach-detach.spec.ts` cases: output-column rename
  (values change → minimal diff), pure relabel rename (zero diff), trailing
  add/drop, NOT-NULL tighten over reconciled rows, inexpressible reject
  (interleave + PK change), plain-table fresh attach with differing names.
- Add/adjust `declarative-equivalence.spec.ts`: a sugar MV output-column rename
  now `apply schema`s cleanly (sibling to the still-pinned explicit rename-list
  limitation test).
- Run: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/reshape.log; tail -n 60 /tmp/reshape.log`
  and lint (single-quote globs on Windows).
