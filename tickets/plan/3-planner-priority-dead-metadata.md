description: Optimizer rules carry a "priority" label that looks like it controls the order they run in, but on the live code path it does nothing — decide whether to make it real or remove it.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts
difficulty: medium
----

## Problem

Optimizer rules are annotated with a `priority` field. On the live path the pass iterates rules in *registration order* — `framework/pass.ts:520` — and never consults `priority`. Priority-based sorting exists only in the dead `RuleRegistry` path (see the separate ticket removing that dead path). Comments in the code already admit the field is inert. So `priority` is misleading metadata: a reader tuning a rule's priority would change nothing.

## Expected behavior

Either the priority annotations govern execution order, or they don't exist. No field that pretends to control ordering while being ignored.

## Direction (design decision — resolve before implementing)

Two options; pick one:

- **Make it real**: sort `pass.rules` by `priority` at pass-build time so the annotations actually determine order. This changes current behavior — the existing registration order becomes the *tiebreak*, and any rule whose correctness silently depends on running before/after another (via registration order today) must be verified against the new sorted order. Enumerate those ordering dependencies before committing.
- **Remove it**: delete the `priority` field and rely on explicit registration order, which is what actually runs today. Lower risk; makes the real contract (order = registration order) honest.

Note interaction with the dead-registry removal ticket: if that lands first, the only remaining consumer of `priority` is already gone, which favors removal — but that is a judgment for this ticket to settle with a documented rationale, not to punt.

## Related refactor (fold in)

`registerRulesToPasses` in `optimizer.ts` (~900 lines, around `optimizer.ts:117,413`) is a long imperative block. Convert it to a table-driven manifest (data describing which rules go in which pass, in what order/priority), with a startup assertion enforcing the chosen ordering invariant (e.g. priorities non-decreasing within a pass). This makes the ordering contract inspectable and guards against future drift regardless of which option above is chosen.
