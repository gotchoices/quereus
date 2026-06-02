description: Lenient multi-side DELETE fan-out for two-table inner-join views — an ambiguous join delete (two candidate sides, no provable FK, no resolving tag) now deletes from EVERY candidate side via the both-sides-UPDATE eager key-capture plumbing, replacing the former `delete-ambiguous` reject. Reviewed and completed.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## What shipped

Under the default `lenient` policy, an *ambiguous* multi-source join delete — two
candidate sides after `target`/`exclude` narrowing, no provable single-direction FK
(`fkChildIndex === undefined`), no `delete_via` — now **fans out: it deletes the
joined row's contribution from both candidate sides** ("make this joined row not
exist"), replacing the former `delete-ambiguous` reject. `policy=strict` still rejects
residual ambiguity. The fan-out reuses the both-sides-UPDATE eager key-capture: each
affected view row's base-PK identities `(k0, k1)` are materialized ONCE before any
base op fires, and each per-side base delete addresses rows through that captured set
(`<pk> in (select k<side> from __vmupd_keys)`), so the first side's delete cannot empty
the join out from under the second side's identifying subquery. Single-side deletes
keep the live join-body subquery (no ordering hazard).

Key edits: `chooseDeleteSide → chooseDeleteSides` (returns `number[]`),
`decomposeDelete` emits one base delete per chosen side, the capture helpers were
generalized op-agnostically (`MultiSourceUpdateKeyCapture → MultiSourceKeyCapture`,
`buildMultiSourceUpdateKeyCapture(…, where) → buildMultiSourceKeyCapture`,
`makeMultiSourceUpdateKeyRef → makeMultiSourceKeyRef`), the builder's
`buildUpdateIdentityCapture → buildIdentityCapture` now also builds for a multi-side
delete, and the now-unreachable `delete-ambiguous` diagnostic reason was removed. No
emitter changes were needed (the identity capture is op-agnostic).

## Review findings

**Scope of review.** Read the full implement diff (`5954f15d`) with fresh eyes before
the handoff: `multi-source.ts`, `view-mutation-builder.ts`, `view-mutation-node.ts`,
`runtime/emit/view-mutation.ts`, `mutation-diagnostic.ts`, the `.sqllogic` goldens,
the property test, and the docs. Verified the control flow end-to-end
(`chooseDeleteSides` → `decomposeDelete` → `buildIdentityCapture` →
`withKeyCapture` → emitter materialization/finally).

**Correctness — verified sound.**
- The capture/fan-out gating is internally consistent: `decomposeDelete` uses the
  captured-key subquery iff `sides.length > 1`, and the builder builds + injects the
  capture iff `baseOps.length > 1` — and `baseOps.length === sides.length`, so the two
  conditions can never disagree.
- `chooseDeleteSides` reaches the fan-out only when `fkChildIndex` is `undefined`
  (no FK or a mutual FK), at which point the candidate list is necessarily both sides
  and `orderSides` returns `[0,1]` — consistent with the code comments.
- Emitter ordering is correct: the identity capture is materialized in the `run`
  wrapper *before* `runBody`, so both the multi-side base ops and a `pre`-timed delete
  RETURNING re-query see the pre-mutation key/view image; the capture entry is removed
  in `finally`. The fan-out delete's RETURNING re-queries the view `pre` independent of
  the captured key set (confirmed in `buildMultiSourceReturning`).
- `policy=strict` short-circuits *before* the FK heuristic, matching the documented
  "won't even fall back to FK-many" semantics.

**Minor — fixed inline this pass.**
- Stale comment: `buildMultiSourceReturning` referenced the renamed
  `buildUpdateIdentityCapture` → corrected to `buildIdentityCapture`
  (`view-mutation-builder.ts:214`).
- Coverage floor raised in `93.4-view-mutation.sqllogic` with four new goldens that
  the handoff explicitly flagged as unpinned:
  - **(fo-d)** fan-out + **body WHERE** — confirms the capture identifies rows by
    `(user WHERE ∧ body WHERE)`, sparing a body-predicate-hidden row on both sides.
  - **(fo-e)** explicit `target = 'a,b'` naming **both** tables → two candidates →
    fan out.
  - **(fo-f)** **no-FK + `policy=strict`** → rejected (the strict branch is
    FK-independent), with both base rows left intact.

**Major — filed as new ticket (not a blocker).**
- `tickets/backlog/view-delete-fanout-mutual-fk-asymmetric-cascade-ordering.md`:
  the fan-out hardcodes side order `[0,1]`. Over a **mutual FK with asymmetric
  `on delete` actions** (one CASCADE, one RESTRICT), this fixed order can
  RESTRICT-block where the reverse order would have cascaded and succeeded, surfacing
  only a raw `FOREIGN KEY constraint failed … RESTRICT` error. The handoff flagged
  this as a reviewer decision; confirmed it is a real order-dependency. Disposition:
  not a blocker (correct FK error, no data corruption; standard FK semantics) but a
  genuine UX/ordering gap whose proper fix (cascade-aware ordering and/or a structured
  diagnostic) is non-trivial — captured for a future plan pass.

**Deferred work — verified still correctly documented.**
- The `> 2`-base / n-way `decomposition.ts` delete fan-out
  (`unsupported-decomposition-predicate`) remains deferred; docs keep that explicit.
  Grep confirmed no stale `delete-ambiguous` references in src/docs/tests and that all
  remaining "deferred" doc mentions scope to the decomposition path, not the shipped
  two-table inner-join delete fan-out.

**Not done (with reason).**
- No multi-row hand-written golden (a single fan-out delete matching many joined rows
  at once); the property test (`numRuns: 60`) exercises multi-row shapes via small
  arbitraries, so the marginal value of a hand-written multi-row golden is low.

## Validation (all green after review edits)

- `yarn workspace @quereus/quereus test` — 4330 passing, 9 pending, 0 failing (count
  unchanged: the four new goldens live inside the single `93.4-view-mutation.sqllogic`
  test).
- `yarn workspace @quereus/quereus lint` — clean.
- Targeted: `node test-runner.mjs --grep "93.4-view-mutation"` and
  `--grep "no-FK join delete fans out"` — passing.
