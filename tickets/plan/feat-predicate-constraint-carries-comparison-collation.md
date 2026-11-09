description: Tell table modules which collation each filter comparison uses, so a module stops offering index plans for case-insensitive filters that the planner will reject anyway, and so the planner stops choosing plans on the strength of those rejected offers.
architecture: docs/module-authoring.md
files: packages/quereus/src/vtab/best-access-plan.ts (`PredicateConstraint`), packages/quereus/src/planner/analysis/constraint-extractor.ts (constraint minting; the "optional follow-up" note in the OR-collapse collation gate), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`effectivePredicateCollation`), packages/quereus/src/vtab/memory/module.ts (`collectEqualityBoundColumns`), docs/module-authoring.md
tradeoffs: Nothing returns wrong rows without it (the engine's own collation checks decline the bad plans), so the gain is plan quality and a cleaner module contract, paid for with a new public field every module author has to learn about.
----

Split from the fix ticket `bug-collated-equality-keeps-an-ordering-claim-the-plan-cannot-serve` (filed from Optimystic). The correctness half of that ticket is the implement ticket `collation-checks-resolve-the-chosen-index-like-the-rest-of-the-planner`. This ticket is the module-facing half, which is no longer needed for correctness.

## Problem

A module's `getBestAccessPlan` cannot tell which collation a filter compares under. Constant folding turns `'x' collate nocase` into a literal whose type carries NOCASE, so `b = 'x' collate nocase` reaches `request.filters` as an ordinary `=` on `b`. `PredicateConstraint` has no collation field. Reading it off `sourceExpression` would need planner-internal node types and the comparison-collation rules, which the engine does not export, so each module would carry its own copy of those rules and the copies would drift from the engine's.

As a result a module:

- offers a seek of a BINARY index for a NOCASE equality, which `rule-select-access-path` then declines (`MISMATCH_UNSAFE`) to a sequential scan plus a re-check;
- treats the column as pinned to one value and claims the index delivers `order by` on the next key column, which `orderingClaimSurvivesCollation` then refuses.

The answers are correct, but the planner is choosing among offers that will not be used as priced. Observed at HEAD on a 305-row memory table with `idx_bc(b, c)`: `rule-grow-retrieve` accepted the index-style plan for `where b = 'x' collate nocase` at the module's seek cost of 30.5 against 1000 for a scan, and physical selection then replaced the seek with a full sequential scan. The memory module's `buildMonotonicAdvertisement` and `adjustPlanForOrdering` both rely on `collectEqualityBoundColumns`, so they have the same blind spot.

## Expected behaviour

- `PredicateConstraint` gains an optional `collation?: string`: the normalized effective collation the comparison uses at runtime, the same value `effectivePredicateCollation` computes for the cover check. It is filled for every constraint the engine sends to a module. Omitting it means BINARY, so an older module that ignores it behaves as it does today.
- A module treats an equality as pinning its column for ordering purposes only when the comparison's collation is at least as fine as the index column's collation (`collationRefines(constraint.collation ?? 'BINARY', indexColumnCollation)`). The memory module's `collectEqualityBoundColumns` follows this rule, and its seek candidates for a non-refining equality are either not offered or priced as the scan they will become.
- `docs/module-authoring.md` documents the field next to the other `PredicateConstraint` fields and explains the pinning rule.
- The engine keeps its own collation checks. The new field is advice to the module, not something the engine trusts.

Open question for whoever plans this: compute the collation once where constraints are minted (`constraint-extractor.ts`, which would also let the OR-collapse note there be retired) or where requests are built. The value must come from the same function the cover check uses, so the two cannot disagree.
