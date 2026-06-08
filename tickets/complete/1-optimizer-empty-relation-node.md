---
description: Schema-polymorphic EmptyRelationNode + const-fold rules. Anti-join-fk-empty now emits EmptyRelation directly; six fold rules cascade Filter / Project / Sort / LimitOffset / Distinct / Join into EmptyRelation. Cascade is limited by the Structural pass's single top-down traversal — runtime is still correct because EmptyRelation yields no rows.
files:
  - packages/quereus/src/planner/nodes/empty-relation-node.ts                   # NEW
  - packages/quereus/src/planner/nodes/plan-node-type.ts                        # +EmptyRelation enum
  - packages/quereus/src/runtime/emit/empty-relation.ts                         # NEW
  - packages/quereus/src/runtime/register.ts                                    # +emitter
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts # NEW
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts      # Filter(L, false) → EmptyRelation
  - packages/quereus/src/planner/optimizer.ts                                   # +6 rules at Structural
  - packages/quereus/test/optimizer/empty-relation.spec.ts                      # 13 specs
  - packages/quereus/test/optimizer/ind-existence.spec.ts                       # +EMPTYRELATION assertions
  - docs/optimizer.md                                                           # IND tail rewrite + new "Empty-relation folding" subsection
---

## Review findings

### Scope of pass

Read the implement diff (`git show 45b50699`) first, then re-traced control flow through `applyPassRules` (`planner/framework/pass.ts:368`), `traverseTopDown` (`planner/framework/pass.ts:289`), and the rule registrations in `planner/optimizer.ts:300-348`. Inspected `EmptyRelationNode`, all six fold rule functions, the `ruleAntiJoinFkEmpty` rewrite, the `emitEmptyRelation` emitter, and both test specs (`empty-relation.spec.ts`, `ind-existence.spec.ts`). Confirmed via `git grep` that no other rule expects `EmptyResultNode`-specific properties on the rewrite sites; no docs were silently stale.

### Correctness — checked

- **Anti-join schema match.** `buildJoinAttributes` (`join-utils.ts:39`) returns `leftAttrs.slice()` for semi/anti, and `buildJoinRelationType` (`join-utils.ts:65`) returns left's column / key / rowConstraint shape. So `rule-anti-join-fk-empty`'s use of `node.left.getAttributes()` / `node.left.getType()` and `rule-empty-relation-folding`'s use of `node.getAttributes()` / `node.getType()` for anti folds are equivalent — both preserve attribute IDs.
- **`isEmpty` peeling Alias.** Confirmed sound: when the host node (Join, Filter, Project, Sort, LimitOffset, Distinct) supplies its OWN attributes/type to the new `EmptyRelationNode`, the alias rename is discarded along with the alias. For Sort / Distinct / LimitOffset, the rule returns `node.source` directly (which preserves an outer Alias wrapper if any); that's correct because those operators don't change column shape.
- **Outer-join asymmetry.** `JoinFoldEmpty` correctly abstains on `LEFT(L, empty)`, `RIGHT(empty, R)`, `ANTI(L, empty)`, and single-side-empty `FULL`. Verified against `buildJoinRelationType` nullable padding. Tests cover both the abstain (LEFT empty-right keeps the join, null-pads) and the fold-through (LEFT empty-left runtime zero).
- **WHERE truthiness.** `isLiteralFalsy` covers `false`, `null`, `0`, `0n`. `''` and `0.0` are NOT covered — same conservative scope as documented; gap is expected to close once ticket 2 (`predicate-contradiction-detection`) normalizes contradictory predicates into `LiteralNode(false)`.
- **Cascade limits.** Verified the Structural pass is single-pass TopDown (`pass.ts:127-136`). `traverseTopDown` calls `applyPassRules(node)` BEFORE recursing into children and does not re-fire on the parent after `withChildren` (`pass.ts:289-323`). So `Sort(Filter(L, false))` keeps the Sort in the plan; runtime is still correct (`EmptyRelation` yields nothing). The handoff and `docs/optimizer.md` § Cascade limits document this honestly; the inline test comments are consistent. Tightened the misleading "cascades to a fixed point via the pass loop" line in the rule's header docstring to point at this.
- **`computePhysical` fabricates no FDs.** Returns `{ estimatedRows: 0, ordering: undefined }` only. Downstream rules see no synthetic constraints from the zero-row source — correct (a zero-row relation trivially satisfies anything, but emitting a fake `∅ → all_cols` FD would have misled rules expecting a singleton-yielding subquery).
- **`EMPTYRELATION` op string.** `explain.ts:145` derives it via `node.nodeType.replace(/Node$/, '').toUpperCase()`; `PlanNodeType.EmptyRelation = 'EmptyRelation'` → `'EMPTYRELATION'`. Matches what tests assert.

### Style / DRY (minor)

- `EmptyRelationNode` re-implements `getChildren` / `getRelations` / `withChildren` that `ZeroAryRelationalBase` (`plan-node.ts:667`) already provides. **Not fixed**: every other `ZeroAryRelationalNode` (`TableReferenceNode`, `SingleRowNode`, `ValuesNode`, `TableLiteralNode`, `TableFunctionReferenceNode`) also extends `PlanNode` directly rather than the base — the new node matches the existing convention. Cleanup would belong to a broader refactor of `ZeroAryRelationalBase` adoption, not this ticket.

### Pre-existing oddity (not introduced here, surfaced for the record)

- **Pass-level priority is push-order, not numeric.** `PassManager.addRuleToPass` does `pass.rules.push(rule)` (`pass.ts:214`) and `applyPassRules` iterates `pass.rules` in insertion order (`pass.ts:378`). The `priority: 27` field on the six new fold rules is documentation-only — they execute after the IND rules at priority 26 because they are pushed to the pass array later in `optimizer.ts`, not because the framework sorts. The same is true for every other `addRuleToPass` call in the file. Worth a separate hygiene ticket if pass-rule ordering ever becomes load-bearing across files, but this implementation is not affected.

### Test coverage assessment

- 13 specs in `empty-relation.spec.ts` plus 2 strengthened assertions in `ind-existence.spec.ts`. Categories covered: literal-false / literal-null / count-of-empty / project alias / inner / cross / left (both sides) / anti (empty right) / FK-IND-anti / cascade-through-sort-limit.
- **Weak assertion**: the "Project preserves its attribute IDs when folding (aliased column name survives)" test (`empty-relation.spec.ts:141`) only asserts row count = 0 and EMPTYRELATION presence — it does NOT actually verify the alias `y` survives. With zero rows there's no row-level evidence either way. Documented under the test's existing comment; **not strengthened inline** because the runtime path with > 0 rows is already exercised by every other Project plan in the suite. A future tightening would query the prepared statement's column metadata; that's a separate test-infra change.

### Major findings → spawned tickets

None. The two follow-up items the handoff already documented (Structural cascade fix + PostOptimization cleanup-fold pass + Alias-of-EmptyRelation peeling) are not regressions of this ticket — they are scope-extensions parked for separate work. No new tickets opened.

### Inline fixes applied

- `rule-empty-relation-folding.ts` header docstring: replaced the misleading "cascades to a fixed point via the pass loop" line with a precise statement of the bounded cascade behavior, pointing at `docs/optimizer.md` § Cascade limits.

### Validation

- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus test --grep "Empty-relation folding"` — 13 passing.
- `yarn workspace @quereus/quereus test --grep "IND-driven existence folding"` — 13 passing.
- `yarn workspace @quereus/quereus test` — 3098 passing, 2 pending, 0 failing.
- `yarn test:store` deferred (storage path unchanged; new node is plan-time only with no rows emitted).
