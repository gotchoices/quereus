description: COMPLETE — `alter table … set maintained as` now reshapes the backing in place to follow the body when the IMPLICIT form holds (verb call has no rename list AND the prior record is implicit), reusing the refresh path's classifier and op machinery. Reviewed: code re-read with fresh eyes, all reasoned-about residuals independently verified, one untested failure-restore path covered with a new test, full suite + lint + build green.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation — allowReshape param, gate, classify, two-phase splice, shape-keyed set check, failure handlers
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — passes allowReshape=true
  - packages/quereus/src/planner/building/alter-table.ts             # setMaintained — build-time ARITY gate removed (full check is runtime)
  - packages/quereus/src/planner/nodes/alter-table-node.ts           # setMaintained action docstring
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # reshape-on-attach (implicit form) — 11 cases (10 original + 1 added in review: post-mutation failure-restore)
  - packages/quereus/test/declarative-equivalence.spec.ts            # sugar-MV output-column rename applies + converges
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # section 8: reshape success + inexpressible-reorder error pin
  - docs/materialized-views.md                                       # SET MAINTAINED AS — Reshape-on-attach subsection; declarative-integration bullets
----

# Review: reshape-on-attach for implicit (sugar) maintained tables

The implementation landed as described in the implement handoff and survives an
adversarial pass. The reshape follows the body in place over the implicit form,
reusing the refresh path's `classifyBackingReshape` / `reshapeOpToChange` /
`computeBackingPrimaryKey` / `inexpressibleReshapeError`; inexpressible deltas
keep the sited error with the table untouched; explicit-recorded tables never
reshape. See the implement commit (`ticket(implement):
maintained-reattach-implicit-reshape`) for the full mechanics.

## Review findings

### Verified (held up under scrutiny)

- **Reshape gate (three-part) is correct.** `allowReshape` (verb-only) AND
  implicit call (`!positionalRename && recordedColumns === undefined`) AND
  implicit prior record (`!isMaintainedTable(table) || derivation.columns ===
  undefined`). The third condition is load-bearing: without it a re-attach of an
  `maintained (a, b)` table would classify the name delta as a positional rename
  and silently abandon the authored interface. The explicit-recorded refusal is
  tested and the strict error message is asserted verbatim.
- **`buildTableDerivation(def, shape)` carries the shape-derived
  `logicalKey`/`coarsenedKey`/`ordering`/`sourceTables`** (helpers.ts:382), so
  `live.derivation` and the `warnKeyCoarsening` tail read correct values without
  the in-place `mv.derivation.*` mutation the refresh path needs (the attach
  path builds the derivation fresh). No staleness bug there.
- **Consumer-staleness ordering is real, not assumed.** `table_modified` is
  fired (helpers.ts:1078) BEFORE the row cascade; the MV manager's schema-change
  listener (`database-materialized-views.ts:449`) is *synchronous* and calls
  `releaseRowTime` on every consumer that names the reshaped table, removing its
  plan from `rowTime`/`rowTimeBySource`. The subsequent
  `_maintainRowTimeCoveringStructures` then finds no plan for the stale consumer
  and skips it — so a released consumer never receives shape-shifted rows. The
  modified-event channel has no maintenance listener, so this firing is the only
  thing that invalidates consumers; "rely on the cascade" was genuinely not an
  option. A same-shape attach fires no table event (no `reshapePlan`).
- **Eager-commit blast radius is bounded.** `conn.commit()` resolves to
  `MemoryVirtualTableConnection.commit` → `MemoryTableConnection.commit`
  (`vtab/memory/layer/connection.ts:68`), which commits ONLY this backing
  table's pending layer, not the coordinated transaction; other tables' pending
  writes in a user transaction are on separate connections and untouched. The
  later coordinated commit no-ops (the inner `commit` guards on
  `pendingTransactionLayer || readLayer !== currentCommittedLayer`, both false
  post-commit). The documented residual (a user transaction that already queued
  maintenance writes to *this* MV's backing would have those published by the
  eager commit) is correctly scoped to the same backing connection.
- **Build-time ARITY gate removal is safe.** Only the `setMaintained` attach
  build gate was removed; the CREATE-form arity gate (`planner/building/ddl.ts`)
  is untouched, and the sqllogic create-arity pin (51.7 line 62, `create table …
  maintained as`) still fires through it. The runtime strict-shape check
  (`describeAttachShapeMismatch`, count included) covers every non-reshape attach
  path. Loss of the build-time sited line/col on the explicit-attach error is a
  minor UX regression, acceptable (the build snapshot could be stale anyway).
- **Lint, build, full memory suite all clean** — `yarn build` (tsc) clean,
  `yarn lint` clean, `node test-runner.mjs`: **6027 passing, 9 pending, 0
  failing** (6026 before review + 1 added test). No `.pre-existing-error.md`
  surfaced.

### Fixed in this pass (minor)

- **Added test coverage for the post-mutation failure-restore path
  (`restoreReshaped`)** — the riskiest, most-reasoned-about code in the change
  had *zero* test coverage: the two inexpressible-error tests both throw BEFORE
  any mutation (the classifier rejects pre-splice), so neither
  `restoreReshaped` nor the post-commit mark-stale branch was ever exercised.
  New case in `maintained-table-attach-detach.spec.ts`: a trailing-add reshape
  (a `preReconcileOp` ⇒ module mutated) whose reconciled body violates a
  declared CHECK throws pre-commit; the test asserts the documented restore —
  backing physically reshaped (`z` added, module ops are non-transactional),
  prior derivation rides it marked **stale**, `derivation.columns` still
  implicit, reads serve the coherent prior backing — and then asserts
  re-runnability: fix the offending source row, re-run the SAME verb, and it
  reconciles cleanly and converges (`stale === false`, derived content wins).

### Not fixed — documented residual gaps

- **The `reconcileCommitted` (post-eager-commit) mark-stale branch remains
  untested.** Triggering it requires a `postReconcileOp`
  (retype/recollate/tightenNotNull) to throw AFTER the eager commit, which in
  practice needs the reconciled body to violate a column attribute the shape
  analyzer inferred — something the type system largely prevents through SQL
  (a body value conforming to the new attribute is what produced the shape). It
  is defensively coded and structurally mirrors the now-tested
  `restoreReshaped` sibling and the well-tested `reshapeBackingInPlace`
  recoverability. Reaching it would likely require fault injection; left
  uncovered by deliberate judgement, not oversight.
- **`insert defaults (col = expr)` is not validated against a reshape that
  drops/renames the referenced column.** `runSetMaintained` records the verb's
  `insertDefaults` verbatim and a reshape can remove the named column. Exotic
  (the verb has insert-defaults syntax, but combining it with a reshaping body
  is unusual), and there is no pre-existing validation of insert-defaults
  column references either, so this is a latent observation rather than a
  regression. Not blocking; flagged for a future hardening pass if insert
  defaults gain reference validation.
- **The two-phase splice is duplicated, not extracted.** The pre-op/post-op
  loops with per-op re-registration mirror `reshapeBackingInPlace`. Extraction
  was considered and declined: the attach path reconciles by verify-by-diff
  (`replace-all` returning `changes` to cascade) while the refresh path uses
  `rebuildBacking` (no change reporting), and their commit/failure-window
  semantics differ enough that a shared helper would couple two genuinely
  distinct flows. Both copies are heavily commented and now both tested.

### Out of scope (already filed)

- **Explicit rename-list reshape** (differ-detected, rename-op-emitting) — the
  gate deliberately refuses it; tracked in backlog as
  `maintained-reattach-explicit-rename-list-reshape`. The
  redundant-explicit→implicit churn edge is subsumed by the same ticket.
- **`yarn test:store` not run** (slow; per ticket instruction). Store-specific
  risk to verify out-of-band, unchanged from the implement handoff: (a) the
  store backing-host's committed-vs-pending `alterTable` validation discipline
  vs memory's, on which the eager commit relies; (b) the failure paths fire no
  persistence event, so a mid-reshape failure can leave a STORE catalog's
  persisted DDL lagging the physically reshaped table until the next
  persist-triggering event (memory-hosted: no persistence, no gap).

## End
