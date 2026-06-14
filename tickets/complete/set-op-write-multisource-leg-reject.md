description: Reject a multi-source (JOIN / comma) leg of a set-op view write — in BOTH the static `view_info`/`column_info` surfaces and the dynamic write — with a clean structured diagnostic, replacing the un-diagnosed internal `k.k0_0 isn't a column` error and the static `is_*=YES` over-claim. Restores static/dynamic agreement (conservative all-`NO`). The join-leg write-through *unlock* stays deferred to `set-op-write-multisource-leg-compose`.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped

A writable set-op leg/branch body must be **single-source**. A multi-source leg (FROM is an
explicit `join` — `isJoinBody(selectAst)`) is now **rejected** in both recognizers so the
static surfaces and the dynamic write cannot drift:

- `set-op.ts`: `isWritableLeafLeg` (flag-less), `isOperandWritable` (membership static), and
  the dynamic `buildBranch` (membership dynamic) all gate on `isJoinBody`. The flag-less route
  drops a join-leg body out via `flaglessShape`'s per-leg walk → conservative all-`NO` +
  `propagate`'s clean `unsupported-set-op` reject. The membership route rejects with a specific
  `multi-source (join) leg` diagnostic.
- `multi-source.ts`: `isJoinBody` now returns `false` when `selectAst.compound` is present — a
  compound (set-op) body is never a join body even though its top-level `select` carries the
  left-most leg's `from`. This is the routing fix that makes the flag-less spine actually reach
  the single-source reject (the intent already documented at `propagate.ts:251-257`) instead of
  the multi-source join path silently mishandling the compound.

Both surfaces now report conservative all-`NO`; writes reject with a `cannot write through
view …` diagnostic (never `k.k0_0 isn't a column`); base tables untouched. The join-leg
write-through unlock remains `set-op-write-multisource-leg-compose` (filed in `backlog/`).

## Review findings

### Reviewed (with disposition)

- **Implement diff, fresh eyes** — `set-op.ts`, `multi-source.ts`, both `.sqllogic` files, and
  `docs/view-updateability.md`. Logic is sound: the gate fires in every recognizer.
- **`isJoinBody` blast radius (the flagged high-value target)** — traced all callers:
  `propagate.ts:272` (routing now correct for compounds), `view-mutation-builder.ts:89/132/170`
  (insert / msAnalysis / selfCapture — compounds now skip the join paths and reach `propagate`'s
  reject), `schema.ts:817/847/1258` (a compound body flows to the per-column walk and falls out
  all-`NO` via `targetIds.size === 0`). All consistent with conservative all-`NO`. **No defect.**
- **Compound-body reject is robust, not silent** — confirmed `classifyViewBody`
  (`propagate.ts:101`) rejects a `SetOperation` node with `unsupported-set-op` *before* any base
  op is produced, so a compound that falls through the single-source spine always rejects cleanly.
- **Flag-less every-depth claim** — `flaglessShape`'s loop calls `isWritableLeafLeg` on every
  flat leg, so a join at any chain depth is caught. **Verified by added test** (depth-2 case).
- **Membership every-depth claim** — nested subtree leaves reach `buildBranch` via
  `analyzeSetOpBranches`; the `!isNested && isJoinBody` gate plus the new compound-exclusion in
  `isJoinBody` catches them. Covered by construction (no fragile nested-membership test added —
  it would entangle `set-op-membership-nested` behavior orthogonal to this ticket).
- **Lint + full memory-mode suite** — `yarn lint` exit 0 (eslint + `tsc`); `yarn test` →
  **6273 passing, 9 pending, 0 failing**. No regressions.

### Found & fixed inline (minor)

- **Comma-join leg is unreachable — not just untested.** The implementer flagged "comma-join
  legs (`from a, b`) covered by `isJoinBody` (`from.length > 1`) but untested." Probing it
  revealed the engine rejects multiple FROM sources at *build* time (`select.ts:74`, "SELECT
  with multiple FROM sources (joins) not supported"), so a comma-join body cannot even be
  created/read — the `from.length > 1` arm of `isJoinBody` is **dead/defensive** for any
  readable view and there is nothing for the write path to gate. Replaced the (impossible)
  comma-join test with a documenting NOTE in `93.6`.
- **Added depth-2 join-leg coverage** (`DV` in `93.6`): a flag-less `union all` chain whose
  third leg is a JOIN → static all-`NO` + clean reject. Verifies the every-depth claim the
  implementer's depth-1-only tests did not. Passes.

### Found, not actioned (rationale given)

- **Handoff reasoning inaccuracy (no code defect).** The handoff stated the `selfCapture` gate
  "is gated to non-ephemeral views anyway"; it is actually gated to **ephemeral** CTE targets
  (`!!view.ephemeral && !!view.cteTarget`, `view-mutation-builder.ts:167`). The real delta: for
  an ephemeral CTE-target compound body whose left leg is a join, the change now *enables*
  building a `selfCapture` that previously was skipped — but it is then unused because
  `propagate` rejects the compound via `classifyViewBody`. Harmless wasted read-path work; the
  reject still fires. No change made.
- **Subquery-source legs (`from (select …)`)** — not join bodies, so not gated here; they do
  not reach the `k0_0` collision (the multi-source capture keys on join sides, not a derived
  source). Consistent with the implementer's explicit deferral. Genuinely orthogonal to this
  ticket; left as-is.

### Majors / new tickets

None. No major findings. The deferred join-leg write-through unlock
(`set-op-write-multisource-leg-compose`) already exists in `tickets/backlog/`.

### Pre-existing failures

None. Full suite green at HEAD after the change; no `tickets/.pre-existing-error.md` written.
