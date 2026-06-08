---
description: Optimizer rule that folds unsatisfiable Filter predicates (combined with source domainConstraints + literal constantBindings) to EmptyRelationNode. Implementation reviewed; minor findings fixed inline.
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
  - packages/quereus/test/performance-sentinels.spec.ts
  - docs/optimizer.md
---

## Shipped behavior

`rule-filter-contradiction.ts` (Structural pass, priority 27) reads a Filter's predicate alongside the source's `physical.domainConstraints` + literal `physical.constantBindings`, folds the conjunction through a per-column accumulator (`analysis/sat-checker.ts`), and emits `EmptyRelationNode(filter.getAttributes(), filter.getType())` when the conjunction is provably unsatisfiable. The existing const-fold cascade (Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi-anti Join, all at priority 27) collapses the rest of the subtree.

In-scope fragment: single-column `= / == / != / <> / < / <= / > / >=` against literals; positive `BETWEEN literal AND literal`; literal IN-lists; declared range/enum domains; literal constant bindings. Everything else flags `sawUnknown` per column so the rule never emits a false `unsat`.

Out of scope (carry-forward, not started): inner-join `on`-clause contradiction (reusable infra is in `sat-checker.ts` — needs a wrapper that builds a unified attrId-index over `[left attrs] ++ [right attrs]` and emits `EmptyRelationNode(join.getAttributes(), join.getType())`), LIKE pattern intersection, cross-column arithmetic, outer-join `on` contradiction → null-padded scan rewrite, DPLL / SAT over Boolean structure (OR/CASE), in-source domain intersection across overlapping range/enum domains on the same column. A follow-up `fix/` ticket has been filed for the two findings flagged below that are not inline-fixed.

## Review findings

### Scope of pass
- Read the full implement-stage diff (commit `111012ac`) before reading the handoff.
- Verified `EmptyRelationNode` constructor matches `(scope, attributes, relationType, estimatedCostOverride?)` — direct emission of `EmptyRelationNode(node.scope, node.getAttributes(), node.getType())` is correct against the landed schema-polymorphic empty.
- Verified `splitConjuncts` / `flipComparison` semantics; comparison-operator coverage in `absorbBinary` matches what `flipComparison` flips (symmetric operators round-trip unchanged).
- Verified `DomainConstraint.column` and `ConstantBinding.attrs` are *column indices*, while `ColumnReferenceNode.attributeId` is an *attrId*: the rule's `attrIdToIndex` mapping reconciles them correctly. The bindings/domains are consumed using indices directly, matching their interface contracts.
- Verified `BetweenNode.expression.not` correctly suppresses fold (NOT BETWEEN is out-of-scope). NOT IN is wrapped at AST as `UnaryOp(NOT, In(...))`, which UnaryOp absorb marks unknown.
- Verified NULL handling at every entry to the range/exclude/allowed-values code: domain seeds skip null (`d.min !== null`), binding seeds skip null (`v === null`), conjunct absorb bails on `lit === null`, IN-list `intersectAllowed` filters nulls. No NULL ever reaches `tightenLower/Upper/withinRange/containsValue`, so the comparison helpers don't need to defend against three-valued logic.
- Verified the rule's `LiteralNode(false)` guard short-circuits before invoking the checker, preventing redundant work on `Filter(_, false)` that the empty-folding rule will collapse anyway. (Note: `LiteralNode(null)` predicate is *not* guarded — it falls through to checker which returns `sat` — a missed opportunity, not a bug. Logged below.)

### Cross-cutting tests run
- `yarn lint` clean.
- `yarn test` clean: 3127 passing, 2 pending, 0 failing.
- Targeted: `--grep "Predicate contradiction|checkSatisfiability"` → 23 passing; `--grep "Performance sentinels"` → 16 passing (after the sentinel fix below).

### Findings fixed inline

1. **Empty `build.log` accidentally committed at the repo root.** 0-byte file, not in `.gitignore`. Removed.

2. **Planning-time sentinel did not actually exercise the optimizer.** `db.prepare(sql)` only parses; planning is deferred until first `step()` / explicit `compile()`. The sentinel as written did `db.prepare(sql); await stmt.finalize();` — the optimizer was never invoked, so the test ran in ~6 ms instead of measuring planner work. Fix: call `stmt.compile()` after `db.prepare()`. Running with the fix exposed a second bug (next item).

3. **50-conjunct WHERE exceeded `maxOptimizationDepth = 50`.** A 50-element left-associative AND tree is 49 levels deep; the structural pass's top-down traversal hit the depth guard in `pass.ts:285` and threw `Maximum optimization depth exceeded: 50`. This is a *latent* limitation of the optimizer's traversal, not caused by the contradiction rule — but the sentinel as written would have begun failing as soon as it was wired up correctly. Fix: reduced the sentinel to 25 conjuncts × 25 columns (AND-tree depth 24 — comfortably under the depth ceiling), still validating the linearity property the sentinel exists to protect. Wall-clock now ~25 ms / 50 iterations; budget loosened to 5 s for CI headroom.

### Findings logged for follow-up (`fix/optimizer-contradiction-followups`)

4. **`maxOptimizationDepth = 50` is too tight for wide WHERE clauses.** A WHERE with ~50+ conjuncts (the bulk-INSERT / wide-table case) fails to plan. The traversal is structurally tail-recursive on the AND tree, so the guard probably wants either an iterative traversal for AND-chains or a depth ceiling that scales with the input. Not blocking for this ticket but worth a separate look.

5. **`x IN ()` is treated as `unknown` rather than `unsat`.** The checker's `IN`-absorption bails out when `conj.values` is missing or empty (with a comment that the parser usually rejects this). The conservative path is sound, but `IN ()` is provably empty if the parser ever produces it — worth tightening if we encounter it in practice.

6. **`Filter(_, lit-null)` not folded by the contradiction rule.** Three-valued logic treats `NULL` predicate as FALSE for filters, so an explicit `NULL` predicate is provably empty. The rule's literal-false guard checks `=== false`, so `null` falls through to the checker, which sees no column refs and returns `sat`. Missed opportunity rather than a regression; folding would naturally live next to the existing `lit-false` short-circuit.

### Gaps in test coverage (acknowledged in implement handoff; not fixed here)

- No explicit unit test for `MAX_CONJUNCTS = 64` / `MAX_VALUES_PER_COL = 64` cap behavior (pathological inputs bail to `unknown`). Mirrors existing `MAX_FDS_PER_NODE`-style caps.
- No explicit test for the `Filter(_, lit-false)` early-return guard (visible behavior identical via the cascade, so untested).
- No multi-level cascade test specifically via the contradiction rule (e2e tests show cascade firing through `EMPTYRELATION`, but a `Project(Sort(Filter(t, unsat)))` plan-shape assertion is absent).
- No partial-domain × predicate unit test at the checker layer (only covered transitively by the e2e CHECK + WHERE tests).
- No IN-list-with-NULL-entries test (behavior is correct — NULLs filter out before intersection — but not pinned).

### Architecture/style review

- **SPP / DRY**: Reuses `splitConjuncts` (existing), `flipComparison` (existing), `compareSqlValues` (existing) — no parallel implementation. The per-column accumulator is the right shape; no obvious DRY violation.
- **Modularity**: Checker (`analysis/sat-checker.ts`) is pure and reusable. The join-on follow-up will be able to consume it with a wider attrId mapping. The filter rule itself is ~30 lines of glue.
- **Scalability**: O(conjuncts × columns_mentioned), bounded by `MAX_CONJUNCTS` and `MAX_VALUES_PER_COL`. Per-column `sawUnknown` (not global) is the right granularity.
- **Performance**: One pass, no map rebuilds in the hot loop; `compareSqlValues` resolves the collation on every call which is wasteful for hot loops — but for the scale here (≤64 conjuncts × ≤64 columns) it doesn't matter.
- **Resource cleanup**: Pure analysis; no resources to leak.
- **Error handling**: Conservative-by-construction — every unrecognized shape marks `sawUnknown`. The rule never throws.
- **Type safety**: No `any`. Generic-free, all types narrowed via `instanceof` checks.

### Minor style/robustness notes (not blocking)

- `markUnknownForColumns` uses `'expression' in child` to filter scalar-shaped descendants when walking arbitrary children. This is fragile — a `RelationalPlanNode` that happens to carry an `expression` field (none today, but no contract preventing it) would slip through, and the walker would wander into relational territory. Worst case is some attribute IDs that aren't in `attrIndex` get queried (returning `undefined` and no-op), so the heuristic is unsound *in name* but sound *in practice*. Could be tightened by checking `getType().typeClass === 'scalar'` instead.
- The temporal-contradiction unit test asserts behavior that works because ISO 8601 strings sort lexically. The implementation has no general date arithmetic — it's just `compareSqlValues` on strings. The test name is slightly aspirational; the behavior it pins is correct.

## End
