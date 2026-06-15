description: INSERT-through into a multi-source (INNER join) leg/branch of a set-op view write — a per-leg shared-surrogate envelope (`buildMultiSourceInsert`) spliced as a nested `ViewMutationNode` child of the outer set-op write node. Lifts the three clean insert deferrals (membership `set <flag>=true`, flag-less consistent-leg INSERT, VALUES insert-through) and flips `is_insertable_into` to YES for a body whose join legs are all insertable.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/core/database.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
----

## What shipped

INSERT-through into an INNER-join leg/branch of a set-op view (membership `set <flag>=true` flip,
flag-less consistent-leg INSERT, and VALUES insert-through), built via the plan-level shared-surrogate
envelope (`buildMultiSourceInsert`) and spliced as a nested `ViewMutationNode` child of the outer
set-op write node (Route B — nested splice). `is_insertable_into` now reports YES for a set-op view
whose join legs are all insertable, re-derived dynamically by `setOpJoinLegsInsertable` (a per-leg
`analyzeMultiSourceInsert` probe), NO for a composite-key / no-default / non-equi / outer-join /
uncovered-NOT-NULL leg or a subtree operand. See the implement-stage handoff (commit
`4d6a7aff`) for the full architecture.

## Review findings

**Verdict: ship.** The implementation is correct, faithful to the plan ticket, and well-decomposed.
Build (`tsc --noEmit`), lint (eslint + test-file typecheck, exit 0), and the full quereus suite
(6314 passing, 9 pending, 0 failing) are all green at review. The implementer's "known gaps" were
each verified rather than taken on faith.

### Checked — diff & static analysis
- **Read the full implement diff** (set-op.ts, view-mutation-builder.ts, database.ts, schema.ts,
  docs, both sqllogic files) with fresh eyes before the handoff.
- **Dead code**: retired `setOpHasMultiSourceLeg` / `operandHasJoinLeg` are fully removed — grep
  confirms zero stray references; lint confirms no dangling imports.
- **DRY**: `Database._buildProbeContext()` extraction from `_buildPlan` is clean; the throwaway
  dependency tracker is correctly discarded by both the static surfaces and `_buildPlan`.
- **Probe gating**: `setOpJoinLegsInsertable` is only reached after `isSetOpBranchWritable`
  (membership) / `isSetOpFlaglessWritableBody` (flag-less) pass, so the un-try/caught
  `analyzeSetOpView` / `analyzeFlaglessSetOpView` re-derivation does not throw on body shape; only
  the per-leg `analyzeMultiSourceInsert` probe (try/caught) may. Verified `view_info` stays robust:
  a composite-PK **membership** join branch returns `NO` without throwing out of the read TVF.

### Checked — adversarial behavior probes (all confirmed correct, then pinned as regression tests)
- **Gap #3 — combined data-fan + join-flip in one UPDATE** (`set x=…, inJ=true`): the data
  assignment folds into the flip's nested-envelope projection (assigned value, not captured value),
  and the plain leg's own row is data-updated. Was untested → **added `CF` fixture to 93.4**.
- **Gap #4 — `insert or ignore` through a join leg**: `onConflict` threads into the per-leg envelope
  insert; a PK-colliding row is ignored, a fresh row still lands. Was untested → **added `or ignore`
  assertions on the `MXV` fixture in 93.6**.
- **Gap #1 justification — uncovered NOT NULL non-key column ⇒ probe `NO`**: confirmed the probe
  rejects (`… is NOT NULL with no default …`) and `is_insertable_into` reports `NO`, which is the
  exact reason the `jv2/dv2/mj2.y integer null` fixture change is load-bearing (it ships the positive
  INSERT path the ticket asked for; leaving NOT NULL would report `NO` instead). The nullability
  change is faithful and is the desired surface. Was untested → **added `NNV` fixture to 93.6**.

### Found — one major finding, filed (not a regression)
- **σ (where-clause) constants are NOT honored as insert-defaults on the multi-source envelope path**,
  unlike the single-source path (docs § Selection, line ~118). A row inserted through a *filtered*
  inner-join leg (`… where color='red'`) is written to the base with the σ column NULL and is
  consequently **invisible through the view**. Confirmed by direct repro. This is a **pre-existing**
  limitation of `buildMultiSourceInsert` (it applies to any standalone filtered inner-join view), only
  newly *reachable* via a set-op join leg now that join-leg INSERT ships — the implementer's `JV`
  fixture already documents the behavior ("σ NOT consulted on insert"). Filed as
  `tickets/backlog/multisource-insert-sigma-fd-defaulting.md`. Not blocking this ticket: the rows are
  physically inserted correctly; only view-visibility of a σ-filtered insert is at issue, and the
  fix spans the general multi-source insert path.

### Noted — accepted as-is (no action)
- **Probe cost (gap #5)**: `setOpJoinLegsInsertable` re-plans the body on every `view_info` read even
  for join-leg-free bodies (the retired AST peek was cheaper). Same re-plan-on-read posture as the
  rest of `deriveViewInfo` (`deriveBackingShape`); acceptable per the existing surface contract. A
  cheap "has any join leg?" AST pre-check could restore the fast path for the common non-join case —
  left as a possible future micro-optimization, not worth a ticket.
- **Error-assertion substrings (gap #2)**: the sqllogic harness matches `Error.message` (the human
  text), not the reason-code slug, so the CV/SJ rejects assert message fragments. Correct and
  intentional; the new `NNV` reject likewise asserts a message fragment.
- **Mixed-body fan order**: `buildSetOpMutation` runs all single-source base ops before all nested
  envelope children. Fine for the independent-table shapes shipped; the MXV test confirms both legs
  land. No FK-ordering hazard across legs in the tested shapes.

### Tests
- Full suite re-run after edits: **6314 passing, 9 pending, 0 failing**; lint exit 0; `tsc --noEmit`
  clean.
- Added regression coverage (all green): `CF` (combined data-fan + join-flip, 93.4), `MXV` `or ignore`
  (93.6), `NNV` (uncovered-NOT-NULL reject, 93.6).
- No pre-existing failures encountered (`.pre-existing-error.md` not written).
