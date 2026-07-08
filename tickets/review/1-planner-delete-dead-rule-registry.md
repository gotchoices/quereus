description: Removed an unused, duplicate copy of the optimizer's rule-running code that quietly hid errors, keeping only the one live path that surfaces them.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/README.md, docs/optimizer.md, packages/quereus/test/planner/framework.spec.ts
difficulty: easy
----

## What changed

Confirmed (via `find_references` across `packages/quereus`, including tests) that `Optimizer.optimizeNode` / `Optimizer.optimizeChildren` (`optimizer.ts`, formerly lines 1059-1113) had zero live callers, and that the module-scope `RuleRegistry` class + `globalRegistry` singleton in `framework/registry.ts` were reachable only from those two dead methods.

Deleted:
- `Optimizer.optimizeNode` / `Optimizer.optimizeChildren` from `optimizer.ts`, plus the now-dead `applyRules` import and the `traceNodeStart`/`traceNodeEnd` imports (only call sites were inside the deleted methods) and the now-unused `OptContext` type import.
- The `RuleRegistry` class, `globalRegistry` singleton, and its free-function wrappers `registerRule`, `rulesFor`, `getRegistryStats`, `getAllRules`, `registerRules`, `createRule`, and `applyRules` from `framework/registry.ts`.

Kept in `registry.ts` (still live, consumed by `PassManager` in `framework/pass.ts`):
- Types `RuleFn`, `RulePhase`, `SideEffectMode`, `RuleHandle`.
- `hasRuleBeenApplied` / `markRuleApplied` — rewritten as plain functions operating directly on `context.visitedRules` (previously delegated through `globalRegistry`, which never actually needed the deleted class's `rules` map for these two).
- `validateSideEffectMode` — the audit gate `PassManager.addRuleToPass` calls on every rule registration.

The one rule-application path is now unambiguously `PassManager.applyPassRules` (`framework/pass.ts`), which propagates rule exceptions — no more swallow-vs-propagate divergence.

## Docs updated

`packages/quereus/src/planner/framework/README.md` and `docs/optimizer.md` both had "Rule Registration" example snippets using the deleted `registerRule(createRule(...))` global API. Replaced with the actual live mechanism: `this.passManager.addRuleToPass(PassId, { id, nodeType, phase, fn, sideEffectMode, priority })`, matching how every real rule in `optimizer.ts`'s `registerRulesToPasses()` is registered. Also removed the stale "(or the global `registerRule`)" aside in the § Audit discipline section of `docs/optimizer.md`.

## Test changes

`test/planner/framework.spec.ts` had a `describe('RuleRegistry (visited rules)', ...)` block — its tests only ever exercised `hasRuleBeenApplied`/`markRuleApplied` (both still live), not the deleted class, so the tests themselves needed no change. Renamed the misleading `describe` title (and its preceding comment) from `RuleRegistry (visited rules)` to `Visited-rule tracking`, since no `RuleRegistry` class exists anymore. No test was covering `optimizeNode`/`optimizeChildren`/the deleted registry functions specifically — nothing to redirect or remove there.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`). Caught two follow-on unused-import errors (`OptContext` in `optimizer.ts`) from the initial mechanical deletion; fixed.
- `yarn test` (from `packages/quereus`) — full suite green: 6464 passing, 9 pending (pre-existing skips, unrelated to this change). No new failures.

## For the reviewer

This is a pure deletion — no behavior change on the live path. The main things worth double-checking:
- That `hasRuleBeenApplied`/`markRuleApplied`'s new standalone-function form is behaviorally identical to the old `globalRegistry`-delegated form (it is — both only ever touched `context.visitedRules`, never the registry's own `rules` map, so the class layer was pure indirection for these two).
- That no external package (outside `packages/quereus`) imported anything from `framework/registry.ts` — only searched within `packages/quereus`; a repo-wide grep for `RuleRegistry`/`registerRule`/`createRule`/`applyRules`/`globalRegistry` outside `packages/quereus` would be a cheap extra check if paranoid (the sibling `sync-coordinator` package has an unrelated same-named `globalRegistry` for metrics — different module, not a false negative risk since imports are file-scoped, but worth knowing it showed up in the search).
