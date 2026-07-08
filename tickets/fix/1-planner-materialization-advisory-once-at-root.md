description: The optimizer step that decides where to cache intermediate results hides its own errors and re-does the same whole-query analysis many times over, making planning slow on large statements and masking real bugs.
files: packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts, packages/quereus/src/planner/optimizer.ts
difficulty: medium
----

## Problem

The materialization advisory decides where in a plan it is worth caching (materializing) intermediate results. Two issues compound:

1. **Swallowed errors.** `rules/cache/rule-materialization-advisory.ts:43-76` has a catch-all that returns `null` on any failure. That masks advisory bugs and violates the project's no-silent-exceptions rule — a broken advisory looks like "no advice" rather than an error.

2. **Quadratic-flavored re-analysis.** The rule is registered on ~12 node types (`optimizer.ts:967-1000`) and runs in a bottom-up pass, so it fires once per matching node. Its probe loop transforms each child, then throws the transformed results away and re-analyzes the whole subtree. Each firing walks the full subtree, so on statement-heavy plans the total work is O(n^2)-flavored plan time.

## Expected behavior

The advisory runs **once, at the plan root**, walking the tree a single time to place materialization points. Unexpected errors **propagate** rather than being converted to `null`. Planning time for the advisory scales linearly with plan size.

## Investigation / direction

- Confirm the advisory is genuinely idempotent per subtree — i.e., a single root-level pass can reach every placement the current 12-anchor registration reaches. Reproduce the current repeated-analysis behavior (e.g., instrument the probe loop, or count subtree walks) on a statement-heavy plan to quantify the redundancy before restructuring.
- Determine whether any of the 12 registrations exist to catch nodes that a single top-down walk would miss; if so, the root-level pass must cover them.
- Distinguish *expected* "no materialization needed here" outcomes (return no advice, fine) from *unexpected* failures (must propagate). Only the latter should stop swallowing.

## Use case

A statement with many stacked/repeated relational operators (e.g., a large multi-CTE or multi-join query) should plan in time linear in the number of nodes for this step, and an internal error inside the advisory should surface as an error during planning rather than silently producing a plan with no caching.
