description: Fixed spots in developer docs that pointed at wrong files or gave a broken code example, so a developer following them lands in the right place and gets code that compiles.
files:
  - docs/architecture.md
  - docs/runtime.md
difficulty: easy
----

## What changed

Docs-only. Implement stage landed four edits; review added a fifth (a missed sibling of drift #2).

Implement-stage edits (commit `275dbb2b`):

1. `docs/architecture.md` "Adding a new PlanNode" step 4: `emit/emitter.ts — register emitter in the visitor` → `runtime/register.ts — register the emitter: registerEmitter(PlanNodeType.MyNode, emitMyNode)`.
2. `docs/architecture.md` "Adding an optimizer rule" step 2: `Register in planner/framework/registry.ts` → `Register in planner/optimizer.ts (this.passManager.addRuleToPass(...))`.
3. `docs/architecture.md` `FanOutLookupJoinNode` bullet: dropped the stale "manual-construction / tests-only, lands in ticket 4.5" tail; rule has landed. New text cites the rule file + registration site.
4. `docs/runtime.md` "Creating an Emitter" template: removed a duplicate `const sourceInstruction = emitPlanNode(...)` that would fail to compile (redeclaration).

Review-stage edit (this pass):

5. `docs/architecture.md:79` narrative "Key relationships" sentence: `Optimizer rules ... registered via planner/framework/registry.ts` → `... registered in planner/optimizer.ts (via this.passManager.addRuleToPass(...))`. Same drift as edit #2 — the implement pass fixed the step-list entry but left the identical wrong claim in the prose paragraph above it.

## Review findings

Adversarial pass over the implement diff. Read every touched doc site + the current source it describes.

**Accuracy of the four implement-stage edits — all CONFIRMED against current code:**
- Edit #1: `packages/quereus/src/runtime/register.ts` registers emitters as flat `registerEmitter(PlanNodeType.X, emitX)` calls in `registerEmitters()` (incl. `registerEmitter(PlanNodeType.FanOutLookupJoin, emitFanOutLookupJoin)`) — not "in a visitor." Doc text correct.
- Edit #2: `planner/optimizer.ts` registers rules via `this.passManager.addRuleToPass(...)`. Correct.
- Edit #3: `planner/rules/join/rule-fanout-lookup-join.ts` exists; imported and registered at `optimizer.ts:488` (`id: 'fanout-lookup-join'`, priority 23, `sideEffectMode: 'aware'`, `nodeType: Project`). The new bullet's scope wording ("FK→PK join-spine and correlated scalar-aggregate subquery branches") matches the rule's own header doc (join-spine + subquery branches). Correct.
- Edit #4: `docs/runtime.md` template now declares `sourceInstruction` exactly once (line 241) before its use (line 285). Copy-paste of the template compiles. Correct.

**Missed site — FOUND & FIXED (minor, fixed inline):** `docs/architecture.md:79` prose carried the same `framework/registry.ts` registration drift that edit #2 fixed in the step-list. Grepped all of `docs/` for the four stale patterns (`emit/emitter.ts`, `register emitter in the visitor`, `framework/registry.ts`, `4.5-parallel-fanout`, `hand-written tests only`); this line 79 was the only live doc still wrong. Fixed to match edit #2. `docs/review.html:337-338` also names `framework/registry.ts` but is a frozen prior-review report artifact describing the *pre-fix* state — correctly left untouched.

**Lint / tests:** Not run. Change touches only `docs/*.md` prose — nothing under `packages/*/src`, no build or runtime surface, no test exercises doc text. `yarn lint` type-checks source and would not detect doc drift; the only real verification is reading the sites against current code, which this pass did. No pre-existing-failure file written (nothing run).

**Out of scope / not re-verified (by design):** the ticket named several claims a prior review already confirmed and told this ticket not to touch — `sideEffectMode` registration rejection, memory-vtab `reentrant-reads` snapshot capture, `keysOf`/`isUnique` in `fd-utils`, row-time materialized-view maintenance, lens implementation + logic tests 51–55.5. Left alone. The `framework/registry.ts` dead-code cleanup is tracked separately in `1-planner-delete-dead-rule-registry` — untouched here.

**Tripwires:** none. No conditional/latent concerns surfaced — the change is inert prose with no runtime coupling.

**New tickets filed:** none. The one miss was a minor doc fix applied inline; no major or deferred work discovered.
