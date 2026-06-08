---
description: IND-aware existence-folding rewrites — anti-join-to-empty, semi-join trivial, and FK-covered aggregate-over-join elimination — exploiting `child.fk ⊆ parent.pk` to drop parent-side access for EXISTS / NOT EXISTS / count(*) shapes.
files:
  - packages/quereus/src/planner/util/ind-utils.ts (new)
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts (new)
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts (new)
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts (refactored — extracted `lookupCoveringFK`/`isRowPreservingPathToTable` to ind-utils; added `ruleJoinEliminationUnderAggregate`; `isAndOfColumnEqualities` exported for reuse)
  - packages/quereus/src/planner/optimizer.ts (three new Structural-pass rule handles at priority 26)
  - packages/quereus/test/optimizer/ind-existence.spec.ts (new — 10 tests)
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts (one test relaxed for FK-fold interaction)
  - docs/optimizer.md (new "Inclusion-dependency reasoning" subsection)
---

## What landed

Three new Structural-pass rules at priority 26 (after `subquery-decorrelation`
at 25). All three share the new `planner/util/ind-utils.ts`:

- `lookupCoveringFK(child, parent, childEquiCols, parentEquiCols)` — returns
  the matched FK plus a nullability bit (mirrors `checkFkPkAlignment` in
  `key-utils.ts` but surfaces the FK declaration so callers can branch on FK
  child-column nullability).
- `isRowPreservingPathToTable(node)` — true when the relational subtree is a
  chain of row-count-preserving wrappers (`TableReference`, bare-source
  `Retrieve`, `Alias`, `Sort`) ending at a base-table reference. `Project` is
  intentionally excluded.
- `tableSchemaOf(node)` — thin wrapper over `extractTableSchema`.

`isAndOfColumnEqualities` was promoted to an `export` from
`rule-join-elimination.ts` and reused by the two new subquery rules.

Rules:

1. **`rule-anti-join-fk-empty`** — `AntiJoin(L, R, p)` with `p` an
   AND-of-column-equalities, FK coverage on L→R, every FK col `notNull`, R
   row-preserving → `Filter(L, LiteralNode(false))`. Anti-join is empty under
   the IND.
2. **`rule-semi-join-fk-trivial`** — same preconditions, FK may be nullable.
   Non-null FK → returns `node.left`. Nullable FK → `Filter(L, fk_col IS NOT NULL AND …)`.
3. **`ruleJoinEliminationUnderAggregate`** — Aggregate counterpart of
   `ruleJoinElimination`'s ProjectNode entrypoint. Collects attribute IDs from
   group-by and aggregate expressions, walks the wrapper chain to find the
   join, reuses `tryEliminate` (inner-join + FK + row-preserving). Includes
   `count(*) from child join parent` because `count(*)` references no source
   attrs.

## Review findings

### What was checked

- Implement commit `c5bc2684` diff read end-to-end (10 files, +796/-246).
- `ind-utils.ts` helpers — `lookupCoveringFK` permutation match logic, the
  composite-FK length check, nullability detection across FK columns,
  `isRowPreservingPathToTable` whitelist, and the `Retrieve` bare-source
  short-circuit.
- `rule-anti-join-fk-empty.ts` — join-type guard, condition guard, AND-of-
  column-equalities normalization, FK lookup, NOT-NULL precondition, row-
  preserving precondition, `Filter(L, false)` rewrite.
- `rule-semi-join-fk-trivial.ts` — same checks plus the nullable-FK
  `IS NOT NULL` predicate construction in `buildIsNotNullPredicate`:
  `ColumnReferenceNode`'s `columnIndex` is the position into `leftAttrs`,
  which under the row-preserving precondition equals the row position L
  produces. Verified UnaryOpNode for `IS NOT NULL` and BinaryOpNode for `AND`
  construction match the codebase pattern.
- `rule-join-elimination.ts` refactor — the new `ruleJoinEliminationUnderAggregate`
  entrypoint reuses `walkChain` / `tryEliminate` / `rebuildChain` correctly;
  the new `AggregateNode` is constructed with `preserveAttributeIds = node.getAttributes()`
  so callers above keep finding the same output attribute IDs. The `walkChain`
  whitelist (Filter/Sort/LimitOffset/Distinct/Alias) intentionally excludes
  `Project`, which would block alignment — verified that `Aggregate(Project(Join(...)))`
  simply abstains (graceful degradation, no soundness risk).
- `optimizer.ts` registration — three rules registered at Structural priority
  26, correctly after `subquery-decorrelation` (25). `nodeType` targets are
  correct (`PlanNodeType.Join` × 2, `PlanNodeType.Aggregate` × 1).
- Structural-pass fixed-point convergence — all three rules return a node
  that no longer matches the trigger nodeType (semi/anti drop the join,
  aggregate elim removes the join from the chain). One pass converges.
- `LiteralNode` constructor signature and boolean-typed literal handling —
  verified path returns a non-nullable BOOLEAN ScalarType.
- `FilterNode.getAttributes` — passes source attributes through, so
  `Filter(L, false)` exposes L's attribute IDs unchanged for downstream
  consumers.
- Semi/anti `JoinNode.buildAttributes` — returns L's attributes only, so
  replacing the join with L or `Filter(L, …)` preserves attribute IDs.
- Decorrelation produces `'semi'` / `'anti'` JoinNodes (verified via
  `rule-subquery-decorrelation.ts`).
- The 2 existing `checkFkPkAlignment` consumers outside the IND rules:
  `ruleJoinKeyInference` (diagnostic logging only — no soundness coupling)
  and `ruleJoinElimination` inner branch (uses both `checkFkPkAlignment` and
  `lookupCoveringFK`, sharing the same alignment logic).
- `docs/optimizer.md` § "Inclusion-dependency reasoning" — added at the end
  of the FK→PK inference block. Documents the three rules, the row-preserving
  guard, the federated-vtab payoff, and the `Filter(L, false)` placeholder.
- Lint + full quereus test sweep: **0 lint errors after the inline fix
  below**, **2974 passing / 2 pending** — identical to implement-stage report.

### What was found and disposition

#### Inline (fixed in this review)

1. **Lint error in `ind-existence.spec.ts:172`** — `const plan = await planRows(db, q)`
   was assigned but never read in the "does NOT fold EXISTS when the FK is
   undeclared" test, which lint correctly rejects. Worse, the original
   comment ("must survive — assert result correctness, not strictly plan
   shape") weakens the test: with the value unused, the test relied on
   incidental data correctness to "verify the rule abstained" — which would
   silently pass even if the rule erroneously folded a result-correct query.
   Fixed by asserting `joinCount(plan) > 0` (the rule *must* abstain → an
   anti-join must survive in the plan) and keeping the result-correctness
   assertion as a backstop.

#### New tickets filed

2. **Soundness bug — composite-FK permutation alignment is too permissive**
   → `fix/optimizer-fk-alignment-composite-permutation.md`. Both the new
   `lookupCoveringFK` and the pre-existing `checkFkPkAlignment` only verify
   that the equi-partner of each FK column is *some* PK column, not the
   specific `fk.referencedColumns[i]` the FK declaration says it should map
   to. For composite FKs expressed with a non-canonical equi-pair permutation
   (e.g. `p.a = c.fb AND p.b = c.fa` against FK `(fa, fb) → (a, b)`), all
   four rules (anti-join-fk-empty, semi-join-fk-trivial, inner-join elim, the
   new aggregate-over-join elim) will unsoundly fold a query the FK does NOT
   actually guarantee. The bug is pre-existing — both helpers and the
   existing `ruleJoinElimination` inner branch carry it — but the new IND
   ticket propagates it to three more callsites, so it warrants a fix-stage
   ticket rather than silent inheritance. The existing
   "composite-FK both equi-pair declaration orders" test exercises operand-
   side swaps (which don't change child→parent column mapping), not the
   misaligned permutation case, so the bug is uncovered by tests today.

3. **`EmptyRelationNode` + const-fold for `Filter(x, lit-false)`** →
   `backlog/optimizer-empty-relation-node.md`. The implementer flagged this
   gap in the implement-stage notes: `rule-anti-join-fk-empty` emits
   `Filter(L, LiteralNode(false))` (which still iterates L per row, evaluating
   constant false) rather than a generic empty relation. The federated win
   (parent table never accessed) is preserved, but local L iteration is
   wasted. Filed as backlog because it's a missed optimization, not a
   correctness bug, and depends on a new node primitive plus a small const-
   fold pass.

#### Minor — noted, not fixed

4. **Misleading test name in `ind-existence.spec.ts`: "chained NOT EXISTS
   folds at every level when each FK covers"**. The test sets up a 3-table
   schema (grandparent → parent2 → child2) suggesting nested NOT EXISTS
   coverage, but the actual query has only a single NOT EXISTS clause
   between `child2` and `parent2`. The body asserts the outer NOT EXISTS
   folds, which it does — but no chaining is exercised. The test still passes
   for what it asserts; tightening it to actually chain `NOT EXISTS (… NOT
   EXISTS (…))` would strengthen coverage but risks misjudging the
   intermediate plan shape during decorrelation. Left as-is; flagged for a
   future test-quality follow-up if more IND chaining work lands.

5. **Test assertion granularity in `ind-existence.spec.ts`**: most tests
   assert `joinCount(plan) === 0`, which is correct for the rule's contract.
   None of them inspect the resulting node tree to confirm the *expected*
   shape (e.g. `Filter(LiteralNode(false), …)` vs just `child` for the anti-
   join case). If the rule ever silently regressed to a different folding
   (e.g. `Project(true, child)` instead of `Filter(L, false)`), the result-
   correctness assertion would still pass and the join-count assertion would
   too. Strengthening these tests to assert plan-shape specifics is a
   judgement call; the current coverage matches the level used elsewhere
   in `optimizer/*.spec.ts`.

### Empty categories (explicit)

- **Performance regressions**: none. Three additional rules per Structural
  pass; each early-exits on `joinType` / `nodeType` mismatch in O(1). The
  shared helpers (`lookupCoveringFK`, `isRowPreservingPathToTable`) are
  cheap: linear in FK columns and chain depth respectively.
- **Resource cleanup**: nothing to clean up — pure node-tree rewrites,
  immutable plan nodes. No file handles, no timers, no event listeners.
- **Type safety**: confirmed via lint + tsc; no `any` introduced.
  `CoveringFKMatch` is a new public interface with `fk` and `nullable`
  fields; no nullable returns left untyped.
- **API surface**: three new module exports (`lookupCoveringFK`,
  `isRowPreservingPathToTable`, `tableSchemaOf`) in `ind-utils.ts`;
  `isAndOfColumnEqualities` promoted to export from
  `rule-join-elimination.ts`; one new entrypoint `ruleJoinEliminationUnderAggregate`
  alongside the existing `ruleJoinElimination`. No breaking changes.
- **Cross-platform**: pure data-structure transformations; no platform-
  specific APIs.
- **Security**: none — read-only over already-validated schema; no untrusted
  input crosses a new boundary.
- **Backwards compatibility**: not a concern per project policy. The three
  new rules are additive; the refactor of `rule-join-elimination.ts` is
  internal (the test that previously asserted "SEMI/ANTI never eliminated"
  was correctly updated by the implementer to use a non-FK schema, since
  the new rules legitimately fold the FK case).

## End
