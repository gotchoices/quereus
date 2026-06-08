---
description: Parallel-track recognition rules now refuse to fold / fork / prefetch when any participating subtree carries a write, via a single shared predicate (`PlanNodeCharacteristics.isConcurrencySafe`) that pairs with the module-level `physical.concurrencySafe` gate. The serial plan stays in place; writes execute exactly once under the connection lock.
files:
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts
  - packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts
  - packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts
  - docs/optimizer.md
  - docs/runtime.md
---

## Outcome

`PlanNodeCharacteristics.isConcurrencySafe(node)` is the connection-lock
side-effect gate. It is implemented as `!subtreeHasSideEffects(node)` and
documented as the **side-effect** gate that pairs with the module-level
`physical.concurrencySafe` gate (`'serial'` / `'reentrant-reads'` /
`'fully-reentrant'`). Every parallel-track recognition rule routes through
it:

- `ruleAsyncGatherUnionAll` — every branch must be `isConcurrencySafe`.
- `ruleAsyncGatherZipByKey` — every branch must be `isConcurrencySafe`.
- `ruleEagerPrefetchProbe` — probe AND build must be `isConcurrencySafe`.
- `ruleFanOutLookupJoin` — outer AND every spine / subquery branch must
  be `isConcurrencySafe`.
- `ruleFanOutBatchedOuter` — outer AND every branch must be
  `isConcurrencySafe`.

Behavior is identical to the pre-existing direct `subtreeHasSideEffects`
calls — single source of truth, more readable, ready to be refined when a
`'fully-reentrant'` module ships.

`packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts`
(10 tests): predicate semantics (4) + SQL-level AsyncGather(unionAll)
positive/negative/end-to-end/threshold-tuning (4) + EagerPrefetch
negative/end-to-end (2).

`docs/optimizer.md` § "Parallel-track side-effect refusal" and
`docs/runtime.md` § "Connection-lock contract under impure subtrees"
document the cross-rule discipline and why the lock is read-only
serialization.

## Review findings

**What I checked (and how):**

- **Source diff first, then the handoff.** Read the implement commit
  (51e62dfc) cold before consulting the ticket's "What changed" section.
  Confirmed the diff is a pure refactor of five rule sites onto one
  shared predicate, no behavior change on pure subtrees, no behavior
  change on impure subtrees, identical semantics to the prior direct
  `subtreeHasSideEffects` calls.
- **Coverage of all parallel-track introduction sites.** Searched for
  every `new (EagerPrefetchNode|AsyncGatherNode|FanOutLookupJoinNode|FanOutBatchedOuterNode)`
  callsite. Five rule files (the ones the ticket names) and three
  `withChildren` paths on the nodes themselves. The five rule sites all
  go through `isConcurrencySafe`; the `withChildren` paths preserve
  structure and do not introduce new subtrees, so they do not need
  re-gating.
- **No bypass paths.** Searched for other concurrent-driver sites
  (`Promise.all` in runtime, `concurrencySafe` consumers, parallel-driver
  callsites). Only the five named rules construct these parallel-track
  nodes from non-parallel inputs; nothing else needs the gate.
- **Predicate name vs. semantics.** The implementer flagged the
  `isConcurrencySafe` vs. `isSideEffectFree` naming question as a known
  gap. The doc comment on the predicate is explicit about the two-gate
  model (module-level + side-effect), and the rule-site comments echo
  it. The name reflects the intended scope (the predicate, as named,
  will be refined when `'fully-reentrant'` arrives). Not a defect.
- **Tests.** Ran `yarn run test` (full quereus suite, the agent
  default): 3670 passing, 9 pending, 0 failing in 51 s. Targeted the
  new spec with `--grep`: all 10 new tests pass in 79 ms. Spot-checked
  the spec for: predicate-contract pin (negation of
  `subtreeHasSideEffects`), positive control (pure chain MUST fold),
  threshold-tuning independence (cost gate to 0 doesn't relax the
  refusal), end-to-end exactly-once-write assertion via
  `select count(*)`. The cost-gate-independence test is a nice
  belt-and-braces against a regression where someone refactors the
  refusal into the cost path.
- **Lint.** `yarn run lint` exit 0.
- **Docs.** Read both `docs/optimizer.md` § "Parallel-track side-effect
  refusal" and `docs/runtime.md` § "Connection-lock contract under
  impure subtrees" in full. The optimizer-side section cites the new
  spec by filename — verified the file exists at the cited path. The
  runtime-side section spells out why `acquireConnectionLock` cannot
  itself permit impure subtrees concurrently — the right level of
  detail and correctly placed inside the parallel-runtime
  fork-contract section.
- **Adversarial: what could still break?** Considered a future rule
  that constructs a parallel-track node and forgets the gate. The
  audit-stage registry guardrail (`sideEffectMode` annotation on
  every rule) is the structural safety net; the per-rule call to
  `isConcurrencySafe` is the proximate gate; the regression spec pins
  the contract. If a new rule lands without the gate, the failure
  mode is observable (write fires zero or multiple times under a
  multi-branch parallel plan) and easy to add a test for. The
  current discipline is sound.

**Minor findings — fixed inline:** None. The implementation, tests, and
docs are clean. No changes needed in this pass.

**Major findings — new tickets filed:** None.

**Empty categories, with reasons:**

- **DRY / reuse.** The change *consolidates* — it replaces five
  duplicated `subtreeHasSideEffects(...)` callsites with one shared
  predicate. Nothing further to consolidate.
- **Type safety.** The predicate's signature mirrors
  `subtreeHasSideEffects(node: PlanNode): boolean`. No new `any`, no
  new generics, no widening. The test file uses
  `{...} as unknown as PlanNode` mock casts — consistent with the
  pre-existing pattern in `side-effect-audit.spec.ts:173`, and the
  only reasonable way to test a structural predicate without
  building real plan nodes.
- **Resource cleanup.** The change is pure refusal logic. Refusal
  leaves the serial plan in place, which already has correct
  resource lifecycle. No new resources allocated, none to clean.
- **Error handling.** The predicate is a pure boolean. No new error
  paths.
- **Performance.** `isConcurrencySafe` adds one method indirection
  over the prior direct call. Negligible. The five rules already
  walked the same subtree before refusing; the cost is unchanged.
- **Cross-platform.** Pure TypeScript, no platform-specific
  primitives.
- **Scalability / maintainability.** The single-predicate refactor
  *improves* maintainability — when a `'fully-reentrant'` module
  ships, the predicate can be refined in one place instead of five.

**Acknowledged gaps from the implement handoff:** The implementer
flagged three known gaps:

1. *No direct refusal test for `rule-fanout-lookup-join` /
   `rule-fanout-batched-outer`.* The shared-predicate argument is
   structural — the predicate unit tests pin the contract and the
   `AsyncGather` / `EagerPrefetch` SQL-level tests prove the
   predicate is wired through to two real rules. A hand-built
   `FanOutBranchSpec` test would be belt-and-braces over a sound
   structural argument; not worth filing as a follow-up.
2. *No `ZipByKey` refusal test.* The recognition rule for `zipByKey`
   is not yet wired in production (documented in `docs/runtime.md` §
   AsyncGatherNode). When that recognition rule lands, the refusal
   test should land with it. Will be picked up by the natural
   landing-time spec, no separate ticket needed.
3. *End-to-end tests assert symptom (exactly-once write + correct row
   count), not absence-of-concurrent-execution.* The symptom is the
   thing that would be wrong under a regression; tracer-level
   absence-of-overlap assertions would be belt-and-braces. Not worth
   a follow-up unless a future regression slips past the symptom
   test.

All three are acknowledged-and-defended in the ticket; none rise to
the level of a new ticket.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus run test` — 3670 passing, 9 pending,
  0 failing, ~51 s.
- Targeted: `yarn run test --grep "parallel-side-effect-refusal|isConcurrencySafe|Parallel-track"`
  — 10 passing.

No pre-existing failures observed; no `.pre-existing-error.md` written.
