description: Removed an unused, duplicate copy of the optimizer's rule-running code that quietly hid errors, keeping only the one live path that surfaces them.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/README.md, docs/optimizer.md, packages/quereus/test/planner/framework.spec.ts
difficulty: easy
----

## What shipped

Pure deletion of the dead, duplicate rule-application path in the optimizer. Two rule-running code paths existed; only `PassManager.applyPassRules` (`framework/pass.ts`) was live. The other — `Optimizer.optimizeNode`/`optimizeChildren` plus the module-scope `RuleRegistry` class and its `globalRegistry` singleton in `framework/registry.ts` — had zero live callers and *swallowed* rule exceptions (`catch … continue`), diverging from the live path which propagates them.

Deleted (in `bfe1d355`, the implement commit):
- `Optimizer.optimizeNode` / `optimizeChildren` and their now-dead imports (`applyRules`, `traceNodeStart`/`traceNodeEnd`, `OptContext` type).
- `RuleRegistry` class, `globalRegistry`, and free-function wrappers `registerRule`, `rulesFor`, `getRegistryStats`, `getAllRules`, `registerRules`, `createRule`, `applyRules`.

Kept live: types (`RuleFn`, `RulePhase`, `SideEffectMode`, `RuleHandle`), `hasRuleBeenApplied`/`markRuleApplied` (rewritten as plain functions over `context.visitedRules` — behaviorally identical, the class layer was pure indirection), and `validateSideEffectMode` (the audit gate `PassManager.addRuleToPass` calls).

Docs (`framework/README.md`, `docs/optimizer.md`) updated from the deleted `registerRule(createRule(...))` global API to the live `passManager.addRuleToPass(...)` form.

## Review findings

**Scope reviewed:** the implement diff (`bfe1d355`) with fresh eyes, then the handoff. Checked dead-code completeness (repo-wide), orphaned state, behavioral equivalence of the kept helpers, doc accuracy, and test coverage. Ran lint + optimizer/planner test suites.

**Dead-code completeness — CONFIRMED clean.** `find_references` repo-wide for `RuleRegistry|globalRegistry|registerRule|createRule|applyRules|getRegistryStats|getAllRules|registerRules|rulesFor|optimizeNode|optimizeChildren` — zero live references. Remaining hits are all benign: conceptual code comments ("in the same applyRules loop"), the updated README/docs, and the *unrelated* `sync-coordinator` package's own `globalRegistry` (a metrics registry — different module, file-scoped imports, no collision risk).

**Orphaned state — CONFIRMED none.** The `optimizedNodes` context field consumed by the deleted `optimizeNode` is still heavily live in `PassManager` (`finalizeNode`, `traverseTopDown`, `traverseBottomUp`, `executeUpTo` cache-clear). `visitedRules` still live. Neither orphaned.

**Behavioral equivalence — CONFIRMED.** `hasRuleBeenApplied`/`markRuleApplied` in their new standalone form touch only `context.visitedRules`, exactly as the old `globalRegistry`-delegated versions did; the deleted class's `rules` map was never involved for these two.

**Found + fixed in this pass (minor):**
- `framework/registry.ts` — the `SideEffectMode` doc comment still said "The registry validates the choice at registration time"; no `RuleRegistry` exists anymore. Rewritten to name the live gate (`PassManager.addRuleToPass` via `validateSideEffectMode`).
- `optimizer.ts` — removed the orphaned dead `private static globalRulesRegistered = false;` field and its stale "Legacy method removed; keep empty" comment. Pre-existing (not in the implement diff) but zero reads (lint's `tsc` confirms — clean removal) and thematically the same legacy rule-registration scaffolding this ticket targets.

**Docs — CONFIRMED accurate.** README/optimizer.md snippets match the real `registerRulesToPasses()` registration form. Implementer also correctly dropped the stale "Rules execute in priority order" README bullet — pass rules fire in *registration* order, not by `priority` (the `priority` value is now documentation only, per the rule-file comments).

**Tests — CONFIRMED green.** No test covered the deleted symbols specifically. `test/planner/framework.spec.ts`'s `describe` was renamed `RuleRegistry (visited rules)` → `Visited-rule tracking` (the tests only ever exercised the still-live helpers). Ran: `framework.spec.ts` (74 passing), full `test/optimizer/**` + `test/planner/**` (2136 passing), lint (eslint + `tsc -p tsconfig.test.json`) clean. Implementer's full-suite run was 6464 passing / 9 pre-existing pending.

**Tripwire (recorded, not filed):** ~10 rule files and `optimizer.ts` carry comments saying "…threads into them in the same `applyRules` loop/pass". `applyRules` is no longer a symbol — but the phrasing describes the *concept* (per-pass rule-application fixpoint via `PassManager.applyPassRules`) and is not wrong, just stale terminology. Not worth a cross-file comment sweep now; if a future edit touches those rules, prefer "the same pass" or "`applyPassRules` loop". Parked here in findings only (no single code site to anchor a `NOTE:`).

**No major findings — no new tickets filed.** This was a pure deletion with no behavior change on the live path; the only surviving semantic difference (dead path swallowed rule exceptions, live path propagates) is a strict improvement.
