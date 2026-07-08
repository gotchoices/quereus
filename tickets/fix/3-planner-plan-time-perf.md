description: The optimizer wastes time during planning by re-running expensive analyses it has already done and re-scanning lists it could look up directly, making planning slow on non-trivial queries.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts
difficulty: medium
----

## Problem

Three independent plan-time inefficiencies, all in the hot optimizer path:

**(a) Declining rules are retried.** Only *transforming* rules are marked as applied (`framework/pass.ts:508-544`). A rule that inspects a node and declines to transform is re-run on every subsequent iteration. So one transform on a `FilterNode` re-runs its full ~9-rule battery — including the ~1300-line query-rewrite matcher — even though most of those rules already declined and nothing changed to make them newly applicable. Fix: track per-`(node, rule)` declines so a rule that declined on an unchanged node is not re-offered.

**(b) `FilterNode.computePhysical` recomputes on every re-mint.** `nodes/filter.ts:59-165` re-runs constraint extraction (a ~1457-line module) 3-4 times per pass because the node is re-minted, and it hand-builds an attribute index instead of using the existing attribute cache. Fix: reuse cached constraint-extraction results across re-mints of an equivalent node, and use the existing attribute index/cache rather than rebuilding one.

**(c) Residual O(n) attribute scans.** Several `findIndex`-in-loop attribute lookups survive (`framework/physical-utils.ts:41`, `rules/parallel/rule-async-gather-zip-by-key.ts:581`) despite `getAttributeIndex()` existing precisely to make these O(1). Fix: replace the linear scans with `getAttributeIndex()`.

## Expected behavior

Planning does not re-run a rule that already declined on an unchanged node; constraint extraction for a filter is computed once per logically-distinct node rather than per re-mint; attribute lookups are O(1) via the existing index.

## Investigation / direction

- Measure current redundancy before changing: count rule invocations per node across a pass, and count constraint-extraction runs per filter, on a representative multi-filter/multi-join query. Keep these as regression signals.
- For (a), decide where the per-`(node, rule)` decline state lives (keyed by node identity/fingerprint) so re-mints don't spuriously clear or spuriously keep it — a re-minted node that genuinely changed *should* re-offer rules. This is the subtle part; verify a transform that changes a node still lets previously-declined rules re-fire on the new node.
- (b) and (c) are largely mechanical once the caching key/attribute-index usage is confirmed correct.

## Use case

Optimizing a query with several stacked filters over a joined source should show each declining rule evaluated about once per distinct node state (not once per pass iteration), and constraint extraction running once per filter rather than 3-4 times.
