description: Three small, unrelated optimizer housekeeping tasks — document an unwritten rule-engine rule, replace loose typing in a debug file, and delete an unused context helper.
prereq:
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/debug.ts, docs/optimizer.md, packages/quereus/src/planner/framework/README.md
difficulty: easy
----

Three independent mechanical cleanups pulled out of the parent plan ticket `5-planner-selectivity-and-cleanups`. None depend on the filter-selectivity work; they are chained ahead of it (`prereq`) only because both touch `docs/optimizer.md` (and possibly `optimizer.ts`), so landing them sequentially avoids two agents editing the same doc file in one run.

## Item 1 — Document the convergence-model contract

The pass engine silently prevents a rule from being re-offered its own output. Concretely, in `PassManager.applyPassRules` (`packages/quereus/src/planner/framework/pass.ts:562-623`): when a rule fires and returns a new node, `markRuleApplied(currentNode.id, rule.id, context)` marks the *old* node id, then `inheritVisitedRules(currentNode.id, result.id, context)` copies that applied-rule set forward onto the *new* node's id. So on the next fixpoint iteration `hasRuleBeenApplied` short-circuits — the rule never fires on the node it just produced.

Consequence for rule authors: a rule that needs to reach a fixpoint over its *own* rewrites must loop internally; it cannot lean on the engine to re-invoke it. `rule-filter-merge` (`packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts`) is the live example — it merges a stack of nested Filters in one invocation precisely because it will not be re-offered its merged result. This is today an unwritten contract that traps new rule authors.

Tasks:
- Add a `NOTE:` comment at the convergence site in `pass.ts` (at the `markRuleApplied` / `inheritVisitedRules` pair inside `applyPassRules`) stating plainly: a rule is not re-offered its own output; a rule that needs a fixpoint over its own rewrites must self-loop.
- Add a short paragraph to `docs/optimizer.md` capturing the same contract. Natural home: the **Pass Framework** section (around line 131) or **Best Practices** (around line 588). Reference `rule-filter-merge` as the canonical self-looping example.

## Item 2 — Remove `any` from `planner/debug.ts`

`packages/quereus/src/planner/debug.ts` opens with `/* eslint-disable @typescript-eslint/no-explicit-any */` and uses `any` throughout (`PlanNodeDebugInfo.type`, `processValue`, `isAstNode`, `Record<string, any>`, the `(node as any)` / `(physical as any)` casts, the `scheduler: any` in `generateInstructionProgram`). Project rule is no-`any`.

Replace with correct types and drop the file-level eslint-disable:
- `PlanNodeDebugInfo.type` → the return type of `PlanNode.getType()` (a `RelationType` / whatever `getType()` declares). `properties: Record<string, unknown>`.
- `isAstNode(value: unknown): value is AST.AstNode` and `processValue(value: unknown): unknown` — narrow with `typeof`/`in` guards instead of `any`.
- `(node as any).estimatedRows`, `(node as any).physical`, `(physical as any)` — these read optional members off `PlanNode`. Prefer a typed narrowing (e.g. a small local interface or an `in` guard) over `as any`. Check whether `estimatedRows` / `physical` are already declared on `PlanNode` / `RelationalPlanNode` — if so, cast to the right node interface (`isRelationalNode`) rather than `any`.
- `scheduler: any` in the `subProgramMap` and `generateInstructionProgram` → use the actual scheduler type (the element type of `Instruction.programs`).
- If a narrow, unavoidable `any` remains at one spot, use a single localized `// eslint-disable-next-line` with a one-line justification — not a file-level disable.

## Item 3 — Remove the dead `OptimizationContext` helper surface

Confirmed dead (grepped across `packages/quereus/src` and `test`, excluding the runtime's unrelated `RuntimeContext.context`): the `OptimizationContext` **class helper methods and the `context` bag they operate on are unused**. The `OptContext` *interface* and the class as the concrete context are very much live (`context.stats`, `context.tuning`, `context.diagnostics`, `context.visitedRules`, `context.optimizedNodes`, `context.db` all used) — do **not** touch those.

Specifically dead (no non-test, non-self references found):
- `OptimizationContext.withPhase`, `.withContext`, `.getContext`, `.hasContext`, `.setContext`, `.deleteContext`, `.clearContext`, `.getContextSnapshot`, and the private `.copyTrackingState`.
- The `context: Map<string, unknown>` field on both the `OptContext` interface and the class (nothing reads `context.context` in the planner; verify once more before removing the interface member).
- The `isOptContext` type guard (exported, no callers).

Tasks:
- Re-confirm each of the above has zero references outside `framework/context.ts` itself (a fresh grep — `find_references` on each symbol). The runtime has its own `context` map on `RuntimeContext`; do not conflate.
- Remove the confirmed-dead members. Keep the interface fields that are used (`optimizer`, `stats`, `tuning`, `phase`, `diagnostics`, `db`, `visitedRules`, `optimizedNodes`). Note: `phase` IS read (`optimizer.ts` reads `entry.phase` on manifest entries and the context carries a `phase`) — verify whether the *context's* `phase` field specifically is consulted; if not, it may also be dead, but confirm separately and conservatively (leave it if in doubt and note why).
- `framework/README.md:64` shows `optimizer.getContext()` — verify whether that method exists on `Optimizer` (distinct from the removed `OptimizationContext.getContext`). If the README refers to a now-removed surface, fix or delete that doc line.
- If any member turns out to have a live use after all, leave it and add a one-line comment documenting why it stays (per the parent ticket's "remove it, or document why it must stay").

## Edge cases & interactions

- **Item 1 doc vs. Item in sibling ticket:** the filter-selectivity ticket also edits `docs/optimizer.md` (heuristic-fallback note). Landing this ticket first means the sibling rebases onto the convergence paragraph — no logical conflict, just keep edits in different sections.
- **Item 2:** removing the file-level `no-explicit-any` disable must not surface *new* lint errors elsewhere in `debug.ts`. Run `yarn workspace @quereus/quereus run lint` (it type-checks too) after the change.
- **Item 2:** `debug.ts` is EXPLAIN/plan-display + tracing only — no query hot path. Behavior must be byte-identical; this is a typing-only change. Confirm `serializePlanTree` / `formatPlanTree` output is unchanged (an existing plan/EXPLAIN test exercises these).
- **Item 3:** the `OptContext` type guard `isOptContext` and the `context` Map are part of a public-ish interface shape — grep `test/` too (the plan-time tests build fake contexts, e.g. `test/optimizer/pass-manager.spec.ts` constructs `{ stats: {} as StatsProvider, ... }`). If a test constructs an object against the `OptContext` interface, removing an interface field it sets will surface as a type error under `tsc -p tsconfig.test.json` — fix those call sites.
- **Item 3:** do not remove `OptimizationContext`, `createOptContext`, or the `OptContext` interface themselves — only the dead members.

## TODO

- Item 1: add `NOTE:` at the `pass.ts` convergence site; add convergence paragraph to `docs/optimizer.md` referencing `rule-filter-merge`.
- Item 2: retype `planner/debug.ts`, drop the file-level eslint-disable, run lint.
- Item 3: re-grep each dead symbol; remove confirmed-dead `OptimizationContext` members, the `context` Map field (interface + class), and `isOptContext`; fix `README.md:64` if stale; fix any test call sites.
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test` (stream output with `tee`); green before handoff.
