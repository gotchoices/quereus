description: Implemented — `alter table … set maintained as` now reshapes the backing in place to follow the body when the IMPLICIT form holds (verb call has no rename list AND the prior record is implicit), reusing the refresh path's classifier and op machinery. A sugar MV output-column rename now applies via `apply schema` instead of erroring at the strict shape check; inexpressible deltas (interleave / physical-PK change) keep the sited error with the table untouched; explicit-recorded tables never reshape.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation — allowReshape param, gate, classify, two-phase splice, shape-keyed set check, failure handlers
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — passes allowReshape=true
  - packages/quereus/src/planner/building/alter-table.ts             # setMaintained — build-time ARITY gate removed (would block reshapes; full check is runtime)
  - packages/quereus/src/planner/nodes/alter-table-node.ts           # setMaintained action docstring
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # new describe 'reshape-on-attach (implicit form)' — 10 cases
  - packages/quereus/test/declarative-equivalence.spec.ts            # new: sugar-MV output-column rename applies + converges; limitation-test comment updated
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # section 8: arity-error pin → reshape success + inexpressible-reorder error pin
  - docs/materialized-views.md                                       # SET MAINTAINED AS — Reshape-on-attach subsection; declarative-integration bullets
----

# Review: reshape-on-attach for implicit (sugar) maintained tables

## What landed

`attachMaintainedDerivation` gained `allowReshape = false`. `runSetMaintained`
(the verb path — manual AND differ-emitted) passes `true`;
`createMaintainedTable` leaves the default (a create-time mismatch stays the
sited create error).

**Gate** (all must hold, else the strict declared-shape error stands):
1. `allowReshape` — the verb path;
2. implicit call — `!positionalRename && recordedColumns === undefined`;
3. implicit prior record — the live table is plain, or
   `derivation.columns === undefined`. This third condition goes beyond the
   ticket's literal `(!positionalRename)` wording and is load-bearing: the verb
   always calls with `positionalRename=false`, so without it a re-attach of an
   EXPLICIT-recorded table (`maintained (a, b)`) would classify the name delta
   as a rename and reshape the table to the body's NATURAL names — abandoning
   the authored interface and breaking the pinned explicit-rename-list
   limitation test. With the gate, that case still errors strictly (pinned).

On a gated mismatch: missing `module.alterTable` →
`inexpressibleReshapeError`; `classifyBackingReshape(table, shape)`
inexpressible (interleave / physical-PK change incl. an `order by`-seeded key)
→ `inexpressibleReshapeError`, table untouched; expressible → the two-phase
plan splices around the existing verify-by-diff reconcile:

```
gates (classify, cycle, must-be-a-set) — all before any mutation
→ attachDerivation + registerMaterializedView   (throw → restorePrior; catalog-only)
→ preReconcileOps via module.alterTable          (rename/add/loosen/drop)
→ schema.addTable(reshaped + new derivation)
→ re-resolve host → 'replace-all' reconcile      (keys by the module's CURRENT physical PK)
→ validateDeclaredConstraintsOverContents
→ [postOps only] conn.commit() → postReconcileOps, catalog re-registered per op
→ db.registerMaterializedView(live)              (re-bind the row-time plan to the reshaped record)
→ unlink/link covers → table_modified → cascade genuine changes → materialized_view_modified/added
```

`buildTableDerivation(def, shape)` already carries the shape-derived
`logicalKey`/`coarsenedKey`/`ordering`/`sourceTables`, and the
`warnKeyCoarsening` tail reads the new derivation — no extra carrying needed.

**Shape-keyed set check.** `assertDerivedRowsAreSet` now takes the
shape-derived physical PK (`computeBackingPrimaryKey(shape)` + per-column shape
collations) instead of `table.primaryKeyDefinition` — always, since the two are
identical when shapes match (the strict check verifies index/desc/collation).
The reconcile itself keys correctly by re-resolving the backing host AFTER the
pre-ops (the memory manager's `primaryKeyFunctions` re-key on alterTable).

## Decisions a reviewer should scrutinize

1. **Consumer staleness ⇒ `table_modified` fires IN ADDITION.** Verified the
   modified-event channel has NO maintenance listener
   (`database-materialized-views.ts` — staleness cascades on
   `table_removed`/`table_modified` only), so "relying on the modified event's
   cascade" was not an option. A reshape fires exactly one `table_modified`
   (mirroring `reshapeBackingInPlace`) BEFORE the row cascade, so consumer
   plans are released first and never receive shape-shifted (re-indexed) rows;
   the cascade loop still runs (observable dispatch, lands nowhere for stale
   consumers). A same-shape attach fires no table event (existing pins green).
   Covered: consumer over `select * from base` goes stale, then its own
   `refresh` re-derives the renamed column via the refresh reshape.

2. **Eager commit before postReconcileOps.** The ticket's "VERIFY the memory
   backing-host's alterTable" flag was the crux: memory's
   `alterColumn`/`addColumn` validate/convert the COMMITTED base layer
   (`manager.ts` — tightenNotNull scans `baseLayer.primaryTree`), while the
   attach reconcile lands in the connection's PENDING layer. Running the
   data-validating ops over a pending reconcile would spuriously throw (e.g. a
   trailing-added NOT NULL column is all-NULL in base until commit). So when —
   and only when — `postReconcileOps` is non-empty, the reconcile commits
   eagerly (`conn.commit()`; the statement-end coordinated commit then no-ops,
   per `MemoryTableConnection.commit`'s pending-null guard). Rationale: the
   structural module ops are already non-transactional, so a reshaping attach
   is DDL-grade atomicity regardless; this matches the refresh reshape's
   commit-first (`replaceContents`) semantics. A reshape WITHOUT attribute ops
   (the headline rename) keeps the fully-pending lockstep discipline.
   *Residual:* inside an explicit user transaction carrying earlier writes to
   the same table, the eager commit publishes those too — but memory's
   alterTable already BUSYs/consolidates in that scenario; documented, not
   papered over.

3. **Failure windows (documented residual divergence).**
   - Gates + early registration: catalog-only, `restorePrior` — no divergence.
   - A throw after any module op applied but before the commit
     (`restoreReshaped`): the catalog is re-pointed at the module's last-good
     schema; fresh attach reverts to a PLAIN reshaped table, re-attach restores
     the prior derivation STALE over the reshaped backing (a later refresh
     reshapes it back). Coherent + re-runnable; the prior shape is NOT restored
     (module ops can't be undone).
   - A throw after the eager commit (mid-postOps / final re-registration):
     data is the committed reconciled set, catalog tracks the module per-op;
     the NEW record is marked stale and the error propagates. Re-running the
     same `set maintained as` re-classifies the remaining attribute delta.
   - No lifecycle event fires on the failure paths, so a STORE-hosted backing's
     persisted DDL could lag the module reshape until the next successful
     persist-triggering event (memory-hosted: no persistence, no gap).

4. **Early registration is a gate, not a binding.** The create-time gates run
   before any mutation (ticket requirement), but the plan builders resolve the
   backing from the CATALOG (pre-reshape record), so the interim plan may
   classify into the full-rebuild floor (arm builders `return null` on
   index/projector misalignment — they don't throw). The post-reshape
   `registerMaterializedView(live)` rebuilds the correct binding; nothing can
   exercise the interim plan inside the DDL statement. One theoretical residue:
   the lateral-TVF arm's INTERNAL collation assertion
   (`database-materialized-views.ts` ~line 2253) reads backing-PK columns by
   index and could in principle fire against misaligned old indices during the
   gate pass — it requires a lateral-TVF body + a reshape + index aliasing, and
   no test reaches it; flagged for the reviewer's judgement.

5. **Build-time ARITY gate removed** (`planner/building/alter-table.ts`). It
   would have rejected trailing add/drop reshapes before the runtime ever saw
   them, and it checked a possibly-stale cached-statement snapshot. The runtime
   strict check (count included) still covers every non-reshape path with the
   same wording. The DML-body, generated-column, and backing-host build gates
   stay. Consequence: the sqllogic pin "arity mismatch on attach → error" became
   the new behavior — a plain-table fresh attach with differing arity now
   reshapes (the ticket's explicit fresh-attach requirement); the sqllogic block
   was rewritten to pin the reshape success + an inexpressible-reorder error.

## Test coverage (use cases for validation)

`maintained-table-attach-detach.spec.ts` → `reshape-on-attach (implicit form)`:
- headline rename `select id, x` → `select id, y`: backing column relabels
  carrying old values; dispatch is ONLY the rows whose value actually changed
  (a row with `x == y` does not report); maintenance live post-reshape.
- pure relabel (`x as renamed`): schema reshapes, ZERO dispatched changes.
- trailing add of a NOT NULL column: succeeds (discriminates the eager-commit —
  without it memory throws "contains NULL" on the all-NULL base); per-row
  updates dispatch; column lands `notNull`.
- trailing drop with unchanged survivors: ZERO dispatched changes.
- NOT NULL tighten over divergent rows (backing holds a NULL the new body
  resolves): validates the RECONCILED rows; minimal one-row dispatch.
- interleave + PK-definition change: sited `changed incompatibly` error,
  columns/bodyHash/rows untouched, prior maintenance still live.
- plain-table fresh attach with differing names: reshapes (a→x), plain rows
  discarded by reconcile; exactly one `materialized_view_added` + one
  `table_modified`, no table_removed/added (same incarnation).
- consumer MV (`select *`) over the reshaped table: goes stale via the single
  `table_modified`; its refresh re-derives the renamed column correctly.
- explicit-recorded table via the verb: strict error stands, nothing reshapes.

`declarative-equivalence.spec.ts`: a sugar-MV output-column rename re-declared
and `apply schema`'d now applies (single re-attach, no detach leg, no drop),
values preserved, maintenance live, re-diff converges. The explicit rename-list
limitation test stays pinned (comment updated to name the gate + the sibling
backlog ticket).

`51.7-…attach-detach.sqllogic` section 8: plain-table reshape success pin +
inexpressible reorder error pin.

## Validation performed

- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full memory-backed suite (`yarn test`): **6026 passing, 9 pending, 0
  failing** (6015 before the ticket; +11 = 10 new spec cases + 1 declarative).
- No pre-existing failures surfaced (no `.pre-existing-error.md`).

## Known gaps / deferred

- **`yarn test:store` not run** (slow; per ticket instruction). Store-specific
  risk to verify out-of-band: (a) the store backing-host's `alterTable`
  committed-vs-pending validation discipline may differ from memory's — the
  eager `conn.commit()` assumes a store connection's commit mid-DDL-statement
  is safe and that the later coordinated commit no-ops; (b) the failure paths
  fire no persistence event, so a mid-reshape failure leaves the store catalog
  DDL lagging the physically reshaped table until the next persist.
- The **explicit rename-list reshape** (differ-detected, rename-op-emitting)
  remains the sibling backlog ticket
  `maintained-reattach-explicit-rename-list-reshape`; this ticket's gate
  deliberately refuses it.
- The redundant-explicit→implicit churn edge from the parity review is
  unchanged (subsumed by the same backlog ticket).
