description: Remove an unused, duplicate copy of the optimizer's rule-running code that quietly hides errors, so the codebase keeps only the one live path that surfaces them.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts
difficulty: easy
----

## Problem

The optimizer has two implementations of "apply the rule set to a node":

- The **live** path is `PassManager` (in `framework/pass.ts`), which propagates exceptions thrown by a rule.
- A **dead** path — `optimizeNode` / `optimizeChildren` in `optimizer.ts:1059-1113` — is never called. These two methods are the only consumers of the global `RuleRegistry` class (`framework/registry.ts:261`), whose `applyRules` *swallows* rule exceptions instead of propagating them.

So the repository carries two near-duplicate rule-application loops with divergent error semantics (swallow vs. propagate) and divergent ordering, one of which is unreachable. The dead one silently violates the project's no-silent-exceptions rule and is a trap for anyone who wires it back up.

## Expected behavior

One rule-application path (`PassManager`), with exceptions propagating. No dead duplicate, no unused registry class.

## Direction

Confirm `optimizeNode`/`optimizeChildren` and `RuleRegistry`/its `applyRules` truly have no live callers (search the whole `packages/quereus` tree, including tests), then delete them and any now-orphaned imports/types. If a test references them, the test is exercising dead code — remove or redirect it to the live path. This is a mechanical deletion; do not preserve the exception-swallowing behavior anywhere.

## TODO

- Verify no live callers of `optimizeNode` / `optimizeChildren` (`optimizer.ts:1059-1113`) anywhere in `packages/quereus`, including tests.
- Verify no live callers of `RuleRegistry` (`framework/registry.ts:261`) and its `applyRules`.
- Delete the dead methods, the `RuleRegistry` class, and any imports/types that become unused.
- Remove or redirect any test that only existed to cover the dead path.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` to confirm no build/type/test breakage.
