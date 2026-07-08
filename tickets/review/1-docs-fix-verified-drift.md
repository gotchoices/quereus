description: Fixed four spots in developer docs that pointed at wrong files or gave a broken code example, so a developer following them lands in the right place and gets code that compiles.
files:
  - docs/architecture.md
  - docs/runtime.md
difficulty: easy
----

## What changed

Docs-only, four edits, no code touched:

1. `docs/architecture.md` "Adding a new PlanNode" step 4: `emit/emitter.ts — register emitter in the visitor` → `runtime/register.ts — register the emitter: registerEmitter(PlanNodeType.MyNode, emitMyNode)`. Verified against `packages/quereus/src/runtime/register.ts` — emitters are registered by flat `registerEmitter(PlanNodeType.X, emitX)` calls inside `registerEmitters()`, not "in a visitor."

2. `docs/architecture.md` "Adding an optimizer rule" step 2: `Register in planner/framework/registry.ts` → `Register in planner/optimizer.ts (this.passManager.addRuleToPass(...))`. Verified against `packages/quereus/src/planner/optimizer.ts:488-498` (the `fanout-lookup-join` registration is a concrete example of the pattern). `framework/registry.ts` is only the registry mechanism; its global-registry path is dead code tracked separately in ticket `1-planner-delete-dead-rule-registry` — untouched here.

3. `docs/architecture.md` `FanOutLookupJoinNode` bullet: dropped the "manual-construction / hand-written tests only ... lands in ticket 4.5-parallel-fanout-lookup-join-rule" tail. Verified the rule has landed: `packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts` exists and is registered at `planner/optimizer.ts:488` (`id: 'fanout-lookup-join'`, priority 23, `sideEffectMode: 'aware'`), with a golden-plan test at `test/optimizer/parallel-fanout.spec.ts` referenced in a comment right above the registration. New text cites the rule file and registration site instead of the stale ticket reference.

4. `docs/runtime.md` § "Creating an Emitter" template: removed the duplicate `const sourceInstruction = emitPlanNode(plan.source, ctx);` (was declared once at the top of `emitMyOperation` and again right before the `return` — a copy-paste of this template would fail to compile with a redeclaration error). Kept the first declaration; deleted the second along with its now-redundant "Emit child instructions" comment.

## How to verify

Read-diff only — no build/runtime surface changes since only prose changed. Confirmed by re-reading:
- `packages/quereus/src/runtime/register.ts` (registration mechanism matches new text)
- `packages/quereus/src/planner/optimizer.ts:480-498` (rule registration mechanism + FanOutLookupJoin entry)
- `packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts` (rule exists, header comment describes what it clusters)
- `docs/runtime.md`'s corrected template now declares `sourceInstruction` exactly once before use.

No test suite exercises doc prose directly; ran no build/test since nothing under `packages/*/src` changed. If the reviewer wants a sanity check, `yarn workspace @quereus/quereus run lint` type-checks source but won't catch doc-only drift — the only real verification is reading the four sites, which this ticket already did against current code.

## Known gaps / out of scope (per ticket's own "Direction" note)

The ticket explicitly scoped these four drifts only. It also names several claims a prior review pass already confirmed as accurate and NOT to touch: `sideEffectMode` registration rejection, memory-vtab `reentrant-reads` snapshot capture, `keysOf`/`isUnique` reconciliation in `fd-utils`, row-time materialized-view maintenance wiring, and lens implementation + logic tests 51–55.5. None of those were re-verified here (by design) and none were edited.

The `framework/registry.ts` dead-code cleanup referenced in drift #2 is tracked separately (`1-planner-delete-dead-rule-registry`) and intentionally left alone.
