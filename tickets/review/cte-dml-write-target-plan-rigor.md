description: Review test-only plan-rigor additions for the CTE-name / inline-subquery DML write targets — (1) a new structural plan-shape parity spec (named view ≡ CTE ≡ inline ViewMutationNode subtree, offset-canonicalized) with a self-stability completeness guard, and (2) extended dependency/invalidation pins that an ephemeral DML records NO `view` dep (so `alter view <name>` does not invalidate it) but DOES depend on the real base table (so `alter table <base>` does).
prereq:
files:
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts            # NEW — case 1 + 3 (plan-shape parity + self-stability guard)
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # EXTENDED — case 2 (ephemeral no-view-dep + base-table dep + invalidation)
  - packages/quereus/test/plan/_helpers.ts                           # serializePlanForGolden (reused; unchanged)
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # the !view.ephemeral recordDependency skip (~L58) under test (unchanged)
  - packages/quereus/src/planner/nodes/plan-node.ts                  # UpdateSite.base.table = producing node id (~L283); the leak the canonicalizer erases
  - packages/quereus/src/core/statement.ts                           # schema-change invalidation listener (~L157-198) under test (unchanged)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic          # pre-existing STATE-only parity (CTE ~L3060, inline ~L3552)
difficulty: medium
----

# CTE-name / inline-subquery DML write target: structural plan rigor — review handoff

## What shipped

**Test-only. No production code changed.** The behavior under test already ships; this
ticket closed two test-coverage gaps left by the original implement+review passes (which
verified only observable base-table STATE parity in `93.4-view-mutation.sqllogic`).

### Phase 1 — plan-shape parity (`test/plan/cte-dml-plan-shape.spec.ts`, NEW, 6 tests)

Pins that all three single-source DML write-target forms — named view, CTE name, inline
subquery — lower to a **structurally identical `ViewMutationNode` subtree** over the same
base table `b (id integer primary key, color text)`, modulo per-plan id offsets.

- `viewMutationSubtree(plan)` — DFS for the first `PlanNodeType.ViewMutation` in the
  optimized `getPlan` tree (it survives optimization — emit mirrors planner nodes 1:1).
- `canonicalizePlanIds(snapshot)` — remaps per-plan ids to first-appearance ordinals.
- Tests: self-stability guard (write-first), UPDATE parity (named≡cte≡inline), DELETE parity
  (named≡cte≡inline), INSERT parity (named≡cte only), non-empty/contains-`b`+`VIEW MUTATION`
  anti-vacuity, and divergent-predicate non-equality.

### Phase 2 — dependency + invalidation (`view-dependency-invalidation.spec.ts`, EXTENDED, +6 tests)

- **Recording** (in `dependency recording (buildViewMutation funnel)`): CTE-target UPDATE and
  inline-target UPDATE each record `[]` `view` deps but a `table` dep on `cte_base`; the
  equivalent **named-view** UPDATE records exactly one `view` dep (contrast control, makes the
  empty results meaningful).
- **Invalidation** (in `plan invalidation (prepared-statement compile identity)`, the
  established `prepare → compile p1 → === control → mutate schema → assert` shape):
  - `alter view t set tags` does **NOT** invalidate a CTE-target plan (`=== p1`) — plus a
    behavioral follow-up that re-running still writes the real `cte_base` (the CTE shadows the
    view as the write target).
  - additive `alter table cte_base add column extra text` **DOES** invalidate the CTE-target
    plan (`!== p1`).
  - same base-table invalidation for the inline-subquery form (it has no name to collide with,
    so only this half applies).

## ⚠️ Material deviation from the original ticket's premise — review this first

The original ticket asserted the only id leak to canonicalize is a surviving
`ColumnReferenceNode` `"attributeId": <n>` value, and that `serializePlanForGolden` otherwise
neutralizes everything. **That premise does not hold for the optimized single-source plan.**
Empirically (verified by dumping all three subtrees):

- The `id = 1` predicate **folds into the `IndexSeek` seek key** and the `set color = 'x'`
  assignment is a **literal**, so **no `ColumnReferenceNode.attributeId` value survives** in the
  compared subtree at all. The ticket's targeted regex would have been a pure no-op.
- The actual offset-bearing tokens both live inside `physical.updateLineage` (rendered by
  `safeJsonStringify` as a bounded `$map`): (1) the `$map` **keys** are output attribute ids,
  and (2) each base site's `"table"` field is the **producing `TableReferenceNode`'s plan-node
  id** (`UpdateSite` kind `'base'`, plan-node.ts ~L283). These differ across forms purely
  because each form allocates a different number of ids before reaching the shared subtree.

The canonicalizer therefore renumbers **two independent id namespaces** (kept separate so an
attribute id and a node id sharing a value are never conflated):
- attribute ids — the `$map` keys (`["<id>", { "kind": …`) + a defensive `"attributeId": <n>`;
- plan-node ids — `"table": <n>` (numeric `"table"` is always a node id; the logical table
  *name* renders as a quoted string).

This is faithful to the ticket's deeper intent ("let the guard drive coverage"): the
**self-stability guard** is the completeness authority. It plans the named-view form at two
different counter offsets WITHOUT `withDeterministicPlanIds`, asserts the **raw** snapshots
differ (offset really moved — non-vacuous) and the **canonicalized** snapshots match. Any
missed id-bearing token fails it. I confirmed both renumberings are load-bearing: dropping
either makes the guard fail.

## Use cases / what to scrutinize (your tests are a floor)

- **Canonicalizer robustness.** The two regexes are tuned to the *actual* single-source `base`
  lineage shape. They are validated by the guard **only for the `base` UpdateSite kind**.
  Out-of-scope lineage shapes (`null-extended`, `computed`, `authored`, multi-source
  `__vmupd_keys`) are NOT exercised — case 1 is deliberately single-source-only (a join-bodied
  CTE/inline target lowers through a different substrate). If a reviewer broadens coverage, the
  `$map`-key / `"table"` regexes may need extending and the guard would catch a residual leak.
- **`"table": (\d+)` assumption.** Relies on a numeric `"table":` always being a node id. True
  today (logical name is quoted). Worth a sanity confirm if the serializer surface changes.
- **Divergence control strength.** Uses `where id = 2` (a surviving seek-key literal `"1"`→`"2"`).
  Real but small; a reviewer wanting more could add an extra-assignment or different-column arm.
- **No `withDeterministicPlanIds` anywhere in Phase 1** — by design; the canonicalizer makes the
  counter offset irrelevant and the guard proves it. Do not "fix" this by resetting counters.
- **Invalidation event wiring is exercised live**, not reasoned: `alter view … set tags` fires
  `view_modified` (no-match for the depless CTE plan) and `alter table … add column` fires
  `table_*` (matches the base dep). Both pass.
- **Shadowing** (`create view t` while a `with t as (…)` statement is prepared): the CTE shadows
  the view, so re-execution still routes to the base — pinned behaviorally.

## Validation performed

- `node … mocha cte-dml-plan-shape.spec.ts` → 6 passing.
- `node … mocha view-dependency-invalidation.spec.ts` → 19 passing (13 pre-existing + 6 new).
- `yarn workspace @quereus/quereus lint` → exit 0 (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn workspace @quereus/quereus test` → **6231 passing, 9 pending, exit 0**. No new or
  pre-existing failures; no `.pre-existing-error.md` filed.

## Out of scope (correctly deferred, not gaps to fix here)

- Multi-source (join-bodied) CTE/inline plan-shape parity — different substrate.
- Inline-subquery INSERT — rejected at parse ("Expected table name"), confirmed; no INSERT arm
  added for the inline form (only named↔CTE).
