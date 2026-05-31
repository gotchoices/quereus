description: Forward-only independent-channel singleton property law + reconciliation of five leaf ≤1-row producers (Pragma, Analyze, ExplainSchema, SingleRow carve-out, TableLiteral). Reviewed and accepted.
files: packages/quereus/test/property.spec.ts, packages/quereus/src/planner/nodes/pragma.ts, packages/quereus/src/planner/nodes/analyze-node.ts, packages/quereus/src/planner/nodes/declarative-schema.ts, packages/quereus/src/planner/nodes/single-row.ts, packages/quereus/src/planner/nodes/values-node.ts, docs/optimizer.md
----

## Summary

A new forward-only property law (`checkIndependentSingletonChannels`) in `test/property.spec.ts` pins the two *independent* ≤1-row encoding channels — the declared empty key in `RelationType.keys` and the `∅ → all_cols` singleton FD in `physical.fds` — directly (not through `keysOf`), so it can fail on producer drift. Five leaf producers were reconciled to satisfy it (one — `TableLiteralNode` — discovered by the law itself). The implementer also fixed two latent bugs the reconciliation surfaced: a bare-`ANALYZE` ≤1-row over-claim, and the FD-only consumers (`guaranteesUniqueRows` / join-greedy-commute `isSingleton`) silently missing the ≤1-row-ness of `Pragma`/`Analyze(single)`/`ExplainSchema`.

The implement handoff was accurate and honest about its gaps. Review confirmed the design (forward-only, not `⟺`) is the correct and only *sound* scope.

## Review findings

### Checked — and found sound

- **Diff read first, fresh eyes** (commit `32f09b50`), before the handoff summary. All six changed files read in full plus their consumers (`fd-utils.ts` read surface, `characteristics.ts` `guaranteesUniqueRows`/`estimatesRows`, base `PlanNode.physical` getter / `computePhysical` contract).
- **Forward-only law is the correct scope (the headline review point).** Verified the reverse (`FD ⇒ declared empty key`) is genuinely *unsound* as a universal invariant: derived nodes (Filter over a covered key, `LIMIT 1`, scalar aggregate, single-row VALUES, full-PK seek) add the singleton FD physically in `computePhysical` without rewriting their inherited logical `RelationType.keys`, so the FD channel is legitimately richer. Asserting the reverse would red on every such node. Forward-only is right.
- **Completeness of the producer reconciliation.** Grepped every `keys: [[]]` declarer in `src/planner` — exactly four nodes declare an empty key: `ExplainSchemaNode`, `PragmaPlanNode`, `AnalyzePlanNode` (now conditional), and `SingleRowNode` (zero-column carve-out). All four are reconciled. No producer was missed. `TableLiteralNode` inherits the empty key via const-fold and is reconciled separately. No node declares an empty key without a matching FD (or the documented zero-column / bare-ANALYZE carve-outs).
- **Law has teeth (mutation-verified, not just by-construction).** Temporarily dropped the FD from `PragmaPlanNode.computePhysical` → the targeted test **red** with `independent-channel drift: Pragma[5] … declares the empty key but lacks the ∅→all_cols FD`. Reverted; working tree clean. The negative self-test (`checkNoOverClaim`-style) additionally guards against a vacuous green run.
- **`AnalyzePlanNode` conditional key is sound.** Bare `ANALYZE` now declares `keys: []` (was over-claiming `[[]]`) and emits no FD. Its `isSet: true` + all-columns fallback in `keysOf` is still sound (per-table rows have unique `table` names ⇒ the `(table, rows)` tuple is genuinely a set), so this is an *under*-claim relative to the real `[table]` key — sound, never an over-claim.
- **No soundness risk from the new FDs.** `hasSingletonFd` means "≤1 row", which is a sound basis for DISTINCT / whole-Sort elimination and join driver preference (a ≤1-row relation is trivially distinct and sorted). PRAGMA-write yields 0 rows; `0 ≤ 1` holds. `readonly` semantics left untouched (the `SinkNode` wrapping is unchanged).
- **Cost-model delta is an improvement.** `estimatedRows` now reports the true 1/10 for these nodes instead of falling back to `DEFAULT_ROW_ESTIMATE = 1000`. Full suite (incl. plan-shape, statistics, cost-based rule specs) green ⇒ no plan regressed.
- **Docs.** `docs/optimizer.md` "Singleton equivalence" section accurately describes the new law, the forward-only rationale, the reconciled producers, and the conditional-ANALYZE note. The prior "tracked separately (singleton-channel-independent-law)" future-work phrasing was correctly removed. No other doc or code comment carries a stale "future work" reference to this law.
- **Lint / typecheck / tests.** `yarn typecheck` clean; `eslint` on all six changed files clean; full `yarn test` suite **4124 passing, 9 pending, 0 failures**; targeted `property.spec.ts` 59 passing.

### Minor — assessed, no change made (with reason)

- **Behavioral end-to-end guard for the new FD-enabled rewrites (implement gap #4).** Assessed and *deliberately not added*: a `select distinct * from (select 1)` test would not isolate the new behavior, because `TableLiteralNode` already carries the *declared* empty key, so `isAtMostOneRow` (via `keysOf` → declared key) already drove DISTINCT/Sort elimination *before* this change. The genuinely new surface is the FD-only consumers (`guaranteesUniqueRows`, join-commute `isSingleton`), which the full suite already exercises and whose result is trivially sound. Adding a test that passes both before and after the fix would be noise.
- **`override` keyword inconsistency.** `TableLiteralNode.computePhysical` and `ValuesNode.computePhysical` omit `override` while the three new sites include it. Pre-existing in the codebase (`ValuesNode` already omitted it); `computePhysical` is declared optional on the base, so `tsc`/`eslint` are clean either way. Not introduced by this ticket; not worth churning.

### Major — none

No findings warranting a new fix/plan/backlog ticket. The reverse-implication question (should the engine *also* guarantee physically-≤1-row nodes declare the empty logical key?) was raised by the implementer as a possible larger design change; review concludes it is **not** desirable — it would force derived nodes to rewrite their logical `keys` and would be unsound to assert today. Closed as intentional non-goal, not deferred work.

## Validation performed (review)

- `yarn typecheck` — clean (exit 0).
- `eslint` on all six changed files — clean (exit 0).
- `yarn test` (full quereus mocha suite) — 4124 passing, 9 pending, 0 failures.
- `property.spec.ts` in isolation — 59 passing.
- Mutation test: dropped Pragma's FD → targeted law reds as expected; reverted, tree clean.
