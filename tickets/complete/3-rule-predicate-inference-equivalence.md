---
description: Structural-pass rule that materializes inferred equality predicates from the cross of predicate-derived constant bindings and the source's equivalence classes, including branch injection below inner/cross joins
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts (new)
  - packages/quereus/test/logic/02-filters.sqllogic (new)
  - docs/optimizer.md
---

## What was built

`rulePredicateInferenceEquivalence` — a Structural-pass rule (priority 22)
that fires on `FilterNode`s. It crosses the predicate's
`constantBindings` (returned by `extractEqualityFds`) with the filter
source's `physical.equivClasses` and, for every EC member of a bound
column the predicate doesn't itself pin, synthesizes a new `col = value`
conjunct.

- **Simple form (always)**: the inferred conjuncts are AND-ed into the
  outer Filter's predicate.
- **Powerful form (inner/cross JoinNode source)**: single-side inferred
  conjuncts are additionally wrapped as `FilterNode`s on the matching
  branch, so subsequent `predicate-pushdown` iterations carry them into
  the branch's vtab access plan. The outer Filter still holds the
  augmented predicate.
- **Safety**: LEFT/RIGHT/FULL/SEMI/ANTI joins are guarded out of the
  branch-injection path. For LEFT/RIGHT the simple form also produces
  nothing, because `propagateJoinFds` strips the NULL-padded side's ECs
  out of the join's output, so the rule sees no cross-side EC at the
  filter's source.
- **Idempotence**: the rule's emission set is `{otherIdx ∈ EC | otherIdx
  is not already in predBoundIdx}`. After one firing the inferred
  conjuncts themselves contribute bindings, so every EC member is in
  `predBoundIdx` and the rule yields nothing further. The registry's
  per-node `markRuleApplied` is a belt-and-suspenders second guard.

Inferred predicates are constructed as `ColumnReferenceNode` +
`LiteralNode | ParameterReferenceNode` wrapped in `BinaryOpNode('=')`,
populated from the relevant `Attribute` (so the qualified `u.k` form
appears in plan output).

Registered alongside the existing predicate rules in
`Optimizer.registerRulesToPasses`. Co-existence with `scalar-cse`
(priority 22, `Project`) is safe — rules are keyed per nodeType.

## Key files

- `packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts`
- `packages/quereus/src/planner/optimizer.ts` (registration block at
  priority 22 in the Structural pass)
- `packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts`
  (11 specs)
- `packages/quereus/test/logic/02-filters.sqllogic` (4 behavioural blocks)
- `docs/optimizer.md` (rule catalog under §Predicate + cross-link from
  §Functional Dependency Tracking)

## Testing notes

- `yarn workspace @quereus/quereus run lint` — clean (exit 0, 0 output
  lines).
- `yarn workspace @quereus/quereus run test` — 2864 passing, 2 pending,
  0 failing.
- `yarn workspace @quereus/quereus run test:store` — not run (memory-vtab
  default is sufficient; no store-specific code paths touched).

## Usage

Fires automatically on the Structural pass for any
`Filter(predicate, source)` where the predicate pins a column and the
source carries an EC covering it. To disable for diagnostics:

```ts
db.optimizer.updateTuning({ ...db.optimizer.tuning,
  disabledRules: new Set([...(db.optimizer.tuning.disabledRules ?? []),
                          'predicate-inference-equivalence']) });
```

Canonical wins:

- `SELECT … FROM t JOIN u ON t.k = u.k WHERE t.k = 5` — branch
  `Filter(u.k = 5)` lands above the u-side Retrieve and is carried into
  the leaf by subsequent `predicate-pushdown` iterations. With a PK on
  `u.k` the leaf becomes `INDEXSEEK` instead of `SEQSCAN`.
- Parameter form `WHERE t.k = ?` — inferred conjunct references the same
  parameter slot (verified by `to.equal(undefined)` on a positive match
  of `:p`).
- Multi-hop `WHERE a.x = 7` over `a JOIN b ON a.x=b.x JOIN c ON b.x=c.x`
  — propagates through both equi-joins so all three columns are pinned.
- LEFT JOIN safety: `WHERE t.k = 5` over `t LEFT JOIN u` — no inferred
  `u.k = 5` (would prune NULL-padded rows).

## Review findings

### What was checked

- **Diff first**: read `git show 87f468fe` end-to-end before considering
  the implement-stage handoff. Inspected the new rule, optimizer
  registration, spec, sqllogic file, and docs.
- **Correctness — extractEqualityFds round-trip**: confirmed the rule's
  emission set is `EC × predBoundIdx`-driven and that the rule
  short-circuits on empty ECs or empty bindings. `extractEqualityFds`
  flattens AND-chains via a stack and ignores OR / non-`=` shapes, so
  the rule will not fire on disjunctions or range predicates — matching
  the ticket's scope.
- **JoinNode mechanics**: verified the rebuilt JoinNode constructor
  signature (`scope, left, right, joinType, condition?, usingColumns?`)
  is exactly what `rule-predicate-inference-equivalence.ts:175-183`
  passes. `buildJoinAttributes` for `inner` / `cross` is the unmodified
  concatenation `[...leftAttrs, ...rightAttrs]`, so the rule's split on
  `sourceColIdx < leftCount` is sound. The branch FilterNode preserves
  the wrapped source's attribute IDs (`FilterNode.getAttributes()` =
  `source.getAttributes()`), so the join's condition node — which holds
  attribute-id-keyed `ColumnReferenceNode`s — still resolves through the
  inserted Filter.
- **Outer-join safety**: traced `propagateJoinFds` (`join-utils.ts:185-
  223`). For `left`/`right`/`full`/`semi`/`anti` the right-side (or
  both-sides) EC/binding lists are dropped, so the rule's `source.
  physical.equivClasses` will not contain a cross-side EC for those join
  types — the simple form is naturally inert. The defensive
  `joinType !== 'inner' && joinType !== 'cross'` early return in
  `tryBranchInjection` is the second guard. The dedicated LEFT JOIN spec
  exercises this.
- **Pass ordering**: priority 22 sits after `predicate-pushdown` (20)
  and `filter-merge` (21). On the first Structural iteration the rule
  emits new conjuncts that pushdown won't see until the next iteration;
  the Structural pass's fixed-point loop re-runs both, so the inferred
  conjuncts reach branch-level Retrieve pipelines (verified by the
  INDEXSEEK-uplift spec). Co-priority with `scalar-cse` (also 22) is
  safe — different nodeTypes, no contention.
- **Registry / idempotence**: `applyRules` (`registry.ts:225-265`)
  only `markRuleApplied` on successful transformation. Because the new
  FilterNode has a different node ID, the rule could in principle
  re-fire on the rewrite. The convergence test in `framework.spec.ts`
  shows visited-set inheritance prevents that. Even without the
  inheritance the rule's `predBoundIdx` check makes a re-fire a no-op
  — verified by the spec's "occurrences ≤ 2" idempotence assertion.
- **Parameter handling**: `ParameterReferenceNode.nameOrIndex` is the
  bare identifier (`'p'` for `:p`, an integer for `?`). The rule's
  `synthesizeEquality` rebuilds the AST shape from `value.paramRef`
  using the right `name` / `index` slot — confirmed against
  `param.ts:30-110` (ParameterScope) and the parser at
  `parser.ts:1631-1645`.
- **Value dedup**: `seen` key is `${otherIdx}|${valueSignature(value)}`;
  `valueSignature` distinguishes literal/parameter, NULL, bigint vs
  number, and Uint8Array blobs byte-wise. Duplicate bindings
  (`t.k = 5 AND t.k = 5`) do not produce duplicate inferred conjuncts.
  Distinct values on the same other column (e.g. `t.k = 5 AND t.k = ?`)
  produce two distinct inferred conjuncts — correct.
- **JoinNode `withChildren`**: not used by the rule (it builds a new
  JoinNode directly), but the constructor call matches what
  `withChildren` would produce. No physical-state to preserve; physical
  is recomputed lazily.
- **Resource cleanup / error handling**: rule is a pure function,
  returns `null` on no-op, never throws. Logger calls are guarded by
  `createLogger`. No leak surface.
- **Docs**: `docs/optimizer.md` § Predicate gets a catalog entry; the
  FD Tracking section gets a worked-example cross-link. Both reflect
  the new reality (verified by reading the modified ranges).

### Findings — fixed in this pass

None. Implementation is sound and tests cover the documented scope.

### Findings — informational (no action)

- **Cosmetic `_OptContext` aliasing**: the rule imports
  `import type { OptContext as _OptContext } from '…/context.js'` and
  types the parameter `_context: _OptContext`. The `_` prefix on the
  parameter name is the lint-convention escape; renaming the type alias
  too is redundant. Same nit appeared in `rule-orderby-fd-pruning` and
  is again non-blocking.
- **Cross-product (comma) joins miss inference**: `FROM t, u WHERE
  t.k = u.k AND t.k = 5` plans as `Filter(t.k = u.k AND t.k = 5,
  JoinNode(t, u, 'cross'))`. The cross JoinNode has no equi-pair, so
  `source.physical.equivClasses` is empty and the rule no-ops. The EC
  is implied by the Filter's own predicate but the rule looks at
  source-level ECs (correctly — it can't safely inject below a source
  that hasn't itself proved the EC). Workaround: write the equi-join
  as `ON`. Not a defect; same opportunity exists for ON-style joins
  that happen to be wrapped under a cross/cartesian shape. Filed in
  the implement-stage handoff as a known gap.
- **Source-side `constantBindings` are not consulted**: the rule's
  `predBoundIdx` is derived purely from the outer predicate, not from
  source `constantBindings`. If a child node has already pinned a value
  the outer predicate hasn't mentioned, the rule may re-emit the same
  conjunct. This is harmless (filter-merge handles consolidation) and
  matches the implement-stage handoff's "round-trip" note. Tightening
  it is a future micro-optimization, not a correctness issue.
- **Selectivity not updated**: the augmented predicate keeps the
  Filter's heuristic 0.5 selectivity; same caveat the handoff calls
  out. Cost model is unchanged; only plan shape benefits.
- **Range / IS NULL inference deliberately out of scope**: confirmed
  via `extractEqualityFds`'s operator filter (`if (op !== '=') continue
  ;`) — no accidental support for `>`, `<`, `IS NULL`, etc.
- **Coverage that could be added later (not gating)**:
  - `USING(k)` join shape (currently only `ON` is tested).
  - Multi-EC case (`t.a = u.a AND t.b = u.b WHERE t.a = 1 AND t.b = 2`).
  - `NULL`-valued literal (`WHERE t.k = NULL` — semantically always
    false but the rule would synthesize `u.k = NULL`; harmless,
    untested).
  - Substring-based plan-text matching in the spec — robust to
    plan-formatter churn within reason; the implementer's handoff
    flagged this. The `physical.constantBindings`-based assertion style
    used by `fd-equivalence.spec.ts` is the structural alternative.
- **Branch-injection only emits inferred conjuncts**: the rule does
  not also lift original single-side conjuncts (e.g. `t.k = 5`) onto
  their branch. That's `rulePredicatePushdown`'s job; it currently
  doesn't cross `JoinNode`. The INDEXSEEK-uplift spec sidesteps this
  by comparing seek counts with and without the rule rather than
  asserting both sides become INDEXSEEK.

### Findings — major / new tickets

None. No major correctness, performance, maintainability, scalability,
or safety defects were found.
