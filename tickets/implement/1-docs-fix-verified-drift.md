description: Four spots in the developer docs describe how the code works using file names and steps that no longer match the actual code, so a developer following them is sent to files that do not exist or told to copy a code example that would not compile; correct all four.
files:
  - docs/architecture.md (lines ~87, ~91-92, ~200)
  - docs/runtime.md (§ Creating an Emitter template, ~lines 240-290)
  - packages/quereus/src/runtime/register.ts (correct emitter-registration home)
  - packages/quereus/src/planner/optimizer.ts (correct rule-registration home; FanOutLookupJoin registered ~line 492)
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts (the rule that has landed)
difficulty: easy
----

## Problem

A review pass read the docs against the source and confirmed four concrete drifts.
All four are mechanical documentation edits — the code is correct, the prose is
stale. Fix the docs to match the code.

### 1. `architecture.md:87` — wrong file for emitter registration

Under "Adding a new PlanNode", step 4 reads:

> `emit/emitter.ts` — register emitter in the visitor

That file does not exist. Emitter registration lives in
`src/runtime/register.ts`. (`runtime.md` already documents this correctly.)
Fix the path to `runtime/register.ts` (and correct the description of *how*
registration happens there if "register emitter in the visitor" no longer
matches the mechanism in that file).

### 2. `architecture.md:91-92` — wrong file for optimizer-rule registration

Under "Adding an optimizer rule", step 2 reads:

> Register in `planner/framework/registry.ts`

Live rule registration is in `src/planner/optimizer.ts`. `framework/registry.ts`
is only the registry *mechanism*, and its global-registry path is itself dead
code (tracked separately in `1-planner-delete-dead-rule-registry`). Point the
step at `planner/optimizer.ts`.

### 3. `architecture.md:200` — FanOutLookupJoin recognition rule described as not-yet-built

The `FanOutLookupJoinNode` bullet ends:

> Manual-construction / hand-written tests only in this commit; the recognition
> rule and golden-plan sweep land in ticket `4.5-parallel-fanout-lookup-join-rule`.

That rule **has landed and is registered**:
`src/planner/rules/join/rule-fanout-lookup-join.ts`, registered in
`src/planner/optimizer.ts` (~line 492). Update the sentence to say the
recognition rule has landed and is registered (cite the rule file), and drop the
"manual-construction only / lands in ticket 4.5" framing.

### 4. `runtime.md` § Creating an Emitter — template declares the same const twice

The copy-from "Creating an Emitter" template declares
`const sourceInstruction = emitPlanNode(plan.source, ctx);` **twice** in the same
example function (~line 241 and again ~line 285). Anyone copying the canonical
template gets a redeclaration that will not compile. Remove the duplicate so the
template compiles — keep one declaration at the point where `sourceInstruction`
is first needed and delete the second, adjusting surrounding comments so the flow
still reads correctly.

## Expected outcome

All four doc locations match the current code: correct file paths for emitter and
rule registration, an accurate FanOutLookupJoin status, and an emitter template
that would actually compile if copied. No code changes — docs only.

## Direction

Read each cited source file before editing the prose so the corrected text
reflects the *current* mechanism, not just a swapped filename. These are the only
drifts to fix in this ticket; the review separately confirmed that many other doc
claims (sideEffectMode registration rejection, memory-vtab `reentrant-reads`
snapshot capture, `keysOf`/`isUnique` reconciliation in fd-utils, row-time MV
maintenance wiring, lens implementation + logic tests 51–55.5) *do* match code —
leave those alone.

## TODO

- `architecture.md:87` — change `emit/emitter.ts` → `runtime/register.ts`; verify the "how" description matches `register.ts`.
- `architecture.md:91-92` — change `planner/framework/registry.ts` → `planner/optimizer.ts`.
- `architecture.md:200` — rewrite the FanOutLookupJoin tail: rule landed + registered, cite `rules/join/rule-fanout-lookup-join.ts`.
- `runtime.md` emitter template — delete the duplicate `const sourceInstruction` declaration so the example compiles.
