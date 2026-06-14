description: Add structural plan-rigor tests for the CTE-name / inline-subquery DML write targets — (1) a new test/plan/ spec asserting the ephemeral single-source target lowers to an attribute-id-canonical-identical base-op mutation subtree to the equivalent named view, and (2) plan-cache-dependency cases pinning that an ephemeral DML records NO `view` dependency (so a later `create view`/`alter view` of the same name does not invalidate it) but DOES depend on the real base table.
prereq:
files:
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts            # NEW — case 1 + 3 (plan-shape parity)
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # case 2 (ephemeral no-view-dep + base-table dep)
  - packages/quereus/test/plan/_helpers.ts                           # serializePlanForGolden / withDeterministicPlanIds (reuse)
  - packages/quereus/test/plan/golden-plans.spec.ts                  # snapshot-pattern reference
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # the !view.ephemeral recordDependency skip (line ~58) under test
  - packages/quereus/src/planner/nodes/view-mutation-node.ts         # ViewMutationNode — extraction anchor
  - packages/quereus/src/planner/nodes/reference.ts                  # ColumnReferenceNode.getLogicalAttributes() emits attributeId (line ~399) — the id leak
  - packages/quereus/src/core/statement.ts                           # schema-change invalidation listener (lines ~157-198)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic          # existing STATE-only parity (CTE block ~3060, inline block ~3556)
  - docs/view-updateability.md                                       # § Common Table Expressions, § Round-Trip Laws
difficulty: medium
----

# CTE-name / inline-subquery DML write target: structural plan rigor

## Background

The shipped acceptance bar for the CTE-name and inline-subquery DML write targets is that a
single-source projection-and-filter body lowers to a **base-op plan tree identical to the
equivalent `create view t as (…)` + same DML** (modulo synthesized attribute ids). The
implement + review passes verified this only as observable **base-table STATE parity**
(`test/logic/93.4-view-mutation.sqllogic` — the *CTE Round-Trip Law* block ~L3060 and the
*Inline-subquery* block ~L3556). No structural plan-tree assertion was added, and the
"ephemeral target records no `view` schema dependency" property was reasoned from the code
path (the `!view.ephemeral` guard) but not pinned by a test.

This ticket closes both gaps with test-only additions. **No production code changes** — the
behavior under test already ships.

### How the substrate works (the two facts the tests rest on)

- **All three forms funnel through `buildViewMutation`** (`view-mutation-builder.ts`):
  a named view enters with `view.ephemeral === false`; a CTE-name target and an inline-subquery
  target enter with `view.ephemeral === true`. From there all three share `propagate` → the
  per-base-op re-plan through the ordinary base-table builder → a wrapping `ViewMutationNode`.
  For the single-source projection-and-filter case the wrapped base-op subtree is intended to be
  byte-identical across the three forms apart from the freshly-minted attribute ids.

- **The `!view.ephemeral` guard** (`view-mutation-builder.ts` ~L58) skips
  `ctx.schemaDependencies.recordDependency({ type: 'view', … })` for an ephemeral target. So a
  CTE/inline DML records **no `view` dep** on `<schema>.<cteName>` (there is nothing to depend
  *on* — the body is part of the statement), while still recording the ordinary **`table` dep**
  on the real base table its lowered op writes.

### Why the attribute-id offset is the whole problem for case 1

`serializePlanForGolden` (`_helpers.ts`) already strips node ids (the ` [n]` / `#n` tokens in
`detail`) and drops any logical key literally named `id`. But `ColumnReferenceNode.getLogicalAttributes()`
(`reference.ts` ~L399) emits `attributeId: <bare number>` — *not* under an `id` key — so it
survives `normalizeSnapshot`. That is exactly why `golden-plans.spec.ts` resets the global
counters with `withDeterministicPlanIds` before each snapshot.

Counter-reset alone does **not** equalize the two forms here: each form allocates a *different
number* of attribute ids before reaching the base-op subtree (CTE/inline body planning vs view
resolution), so the subtree's `attributeId` values sit at different offsets. The fix is a
**canonical attribute-id renumbering** (remap each distinct id to its first-appearance index)
applied to the extracted subtree snapshot — which preserves the relative wiring while erasing the
offset. `SELF_ALIAS` (`'__vm_self'`, `single-source.ts` ~L130) is a module constant and is
therefore already identical across forms — it needs no normalization; do **not** rewrite it.

## Design

### Case 1 + 3 — plan-shape parity (new spec `test/plan/cte-dml-plan-shape.spec.ts`)

Compare the **`ViewMutationNode` subtree** of three forms over the same base table
`b (id integer primary key, color text)` and the same DML
`set color = 'x' where id = 1` (and the DELETE analog `where id = 1`):

| form        | how to plan                                                                                  |
|-------------|----------------------------------------------------------------------------------------------|
| named view  | `db.exec('create view t as select id, color from b')` then `db.getPlan('update t set color=\'x\' where id=1')` |
| CTE name    | `db.getPlan("with t as (select id, color from b) update t set color='x' where id=1")`         |
| inline sub  | `db.getPlan("update (select id, color from b) as v set color='x' where id=1")`                |

Procedure per form:
1. `db.getPlan(sql)` returns the optimized `BlockNode`. DFS for the first node with
   `nodeType === 'ViewMutationNode'` (the mutation substrate; see `view-mutation-node.ts`). If
   the optimizer ever folds/renames it, anchor on the equivalent post-optimization node and note
   it — but it should survive (emit mirrors planner nodes 1:1).
2. `serializePlanForGolden(viewMutationNode)` → snapshot string.
3. **Canonicalize**: replace every `"attributeId": <n>` occurrence (the targeted, reliable JSON
   key) with its first-appearance ordinal (0,1,2,…) consistently within that one snapshot.

Then assert the canonicalized snapshots are **string-equal** across named-view ≡ CTE ≡ inline,
for both UPDATE and DELETE. (Inline-subquery INSERT is deliberately rejected — do not add an
INSERT arm for the inline form.)

**Self-validating completeness guard (load-bearing — write this first).** The targeted
`attributeId` regex is only *known* to be complete if a missed id leak is caught
deterministically. Add a guard test that plans the **named-view form twice at two different
counter offsets** (e.g. plan it once, then plan an unrelated throwaway statement to advance the
global counters, then plan it again — do *not* wrap these in `withDeterministicPlanIds`), extracts
+ canonicalizes both, and asserts they are string-equal. If the canonicalizer missed any
id-bearing logical key (e.g. a descriptor array, a RowDescriptor, an `attributeIds` list), this
guard fails — extend the canonicalizer (broaden the renumber to cover the additional key by name)
until it passes. Because the canonicalizer makes counter offset irrelevant, the comparison tests
do **not** need `withDeterministicPlanIds`; the guard is what proves that.

Anti-vacuity controls:
- Assert the canonicalized named-view snapshot is **non-empty** and contains the base table `b`
  and a `VIEW MUTATION` op (so an empty/short-circuited extraction cannot pass silently).
- Assert that a **deliberately divergent** plan does NOT compare equal — e.g. the same UPDATE
  against a *different* predicate (`where id = 2` vs a different base column, or an extra
  assignment) canonicalizes to a *different* string. This proves the canonicalizer is not
  collapsing everything to a constant.

### Case 2 — plan-cache dependency (`view-dependency-invalidation.spec.ts`)

Schema for these cases: `create table cte_base (id integer primary key, color text)`.

**Recording half** (add to the existing `dependency recording (buildViewMutation funnel)`
describe). Reuse the file's `viewDeps(sql)` / `planDeps(sql)` helpers:
- A CTE-target UPDATE records **no** `view` dep:
  `viewDeps("with t as (select id, color from cte_base) update t set color='x' where id=1")`
  `.to.deep.equal([])`.
- …but **does** record a `table` dep on the real base: assert
  `planDeps(...).some(d => d.type === 'table' && d.objectName === 'cte_base')` is `true`.
  (Mirror the existing read-only-SELECT test's table-dep assertion.)
- Same two assertions for the inline-subquery form
  `update (select id, color from cte_base) as v set color='x' where id=1`.
- Contrast control: the equivalent **named view** form DOES record exactly one `view` dep — so
  the empty result above is meaningful, not an artifact of the helper. (The existing
  single-source view INSERT test already establishes view-dep recording; add a parallel
  UPDATE control here if it reads cleanly, otherwise rely on the existing tests.)

**Invalidation half** (add to the existing `plan invalidation (prepared-statement compile
identity)` describe). Use the established `prepare → compile (p1) → control re-compile === p1 →
mutate schema → assert` shape, every `!==` preceded by a `===` control:
- **`view_modified` of the same name must NOT invalidate a CTE-target plan.** Prepare
  `with t as (select id, color from cte_base) update t set color='x' where id=1`; compile `p1`;
  control `=== p1`. Then `create view t as select id, color from cte_base` followed by
  `alter view t set tags (display_name = 'x')` (the latter fires the *watched* `view_modified`
  event for `t`). Assert `compile() === p1` — the CTE-target recorded no `view` dep on `t`, so the
  event does not match. (The existing tests already prove `view_modified` *does* invalidate a real
  view-dep plan, so this `===` is non-vacuous.) Optionally also run the statement afterward and
  assert `cte_base` was updated and the new view `t` is untouched (the CTE shadows the view as the
  write target — re-planning still routes to the base table).
- **`table_modified` of the base table MUST invalidate the CTE-target plan.** From the same
  prepared statement, apply an additive `alter table cte_base add column extra text` (fires the
  watched `table_*` event for `cte_base`; additive so the recompiled statement still runs). Assert
  `compile() !== p1`. This pins that the ephemeral target depends on the real base table — the
  partner property of the `view`-dep skip.
- Inline-subquery form: it has no name to collide with, so it gets only the base-table
  invalidation assertion (prepare the inline DML, `alter table cte_base add column …`, assert
  `!== p1`, with the preceding `=== p1` control).

## Edge cases & interactions

- **Optimizer survival of `ViewMutationNode`.** `getPlan` returns the *optimized* tree. Confirm
  the anchor node still exists post-optimization; if a rule rewrites it, re-anchor and document.
  Comparing the optimized subtree is intended (stronger) — both forms optimize identically.
- **Canonicalizer completeness.** The only *known* id leak in the relevant subtree is
  `attributeId` on `ColumnReferenceNode`. The self-stability guard is the backstop for any other
  id-bearing logical key (descriptor arrays / RowDescriptor sparse arrays whose indices are
  attribute ids). Do not hand-enumerate leaks — let the guard drive coverage. A RowDescriptor (if
  one surfaces) renders as a sparse array with id-valued *indices*, not as an `attributeId` value;
  if the guard trips on one, normalize it explicitly.
- **Single-source only.** Restrict case 1 to the single-source projection-and-filter body. A
  join-bodied (multi-source) CTE/inline target lowers through a different substrate (identity
  capture, `__vmupd_keys`) and is out of scope — do not assert plan-shape parity there.
- **DELETE vs UPDATE.** Cover both. INSERT: the named-view and CTE forms admit it, but the inline
  form rejects INSERT (`93.4` ~L3704) — only compare the named-view↔CTE pair for INSERT if you add
  an INSERT arm; keep the inline arm to UPDATE/DELETE.
- **SELF_ALIAS must not be rewritten.** It is a constant (`'__vm_self'`) identical across forms;
  touching it would mask a real divergence. Only `attributeId` integers are remapped.
- **Shadowing semantics.** In the invalidation half, `create view t` while the CTE-target stmt is
  prepared: the CTE shadows the view, so re-execution still targets the base table. The behavioral
  follow-up assertion (base updated, view untouched) guards against accidental re-routing.
- **`alter table` choice.** Use an *additive* alter (`add column`) so the recompiled statement
  still plans and runs; avoid `rename`/`drop` of the base, which would break re-execution and
  muddy the assertion.
- **Cache-control discipline.** Every `!==` (invalidation) assertion must be preceded by a `===`
  (cache hit) control, and the `===` (no-invalidation) assertions rely on the existing positive
  controls proving the event type *can* invalidate — otherwise a never-caching compile passes
  vacuously. This is the file's established convention; follow it.
- **Isolation.** Fresh `Database` per `it` (the file already does `beforeEach`/`afterEach`). For
  case 1, one db can host all three forms (names don't collide problematically — the CTE/inline
  forms don't depend on the view), but a fresh db per form is also fine; prefer whichever reads
  cleaner.

## Validation

- `yarn workspace @quereus/quereus test` (or the repo-root `yarn test`) — the new
  `cte-dml-plan-shape.spec.ts` and the extended `view-dependency-invalidation.spec.ts` pass.
- `yarn lint` in `packages/quereus` (eslint + `tsc -p tsconfig.test.json --noEmit`) — the new
  spec call sites type-check.
- Stream long runs: `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.

## TODO

### Phase 1 — plan-shape spec (case 1 + 3)
- Create `test/plan/cte-dml-plan-shape.spec.ts`. Add a `viewMutationSubtree(plan)` DFS helper
  (anchor `nodeType === 'ViewMutationNode'`) and a `canonicalizeAttrIds(snapshot)` helper
  (first-appearance remap of `"attributeId": <n>`).
- Write the **self-stability guard** first: named-view form planned at two counter offsets →
  canonicalized snapshots string-equal. Iterate `canonicalizeAttrIds` until it passes.
- Add the parity assertions: named-view ≡ CTE ≡ inline for UPDATE and for DELETE.
- Add anti-vacuity controls: non-empty / contains `b` + `VIEW MUTATION`; a divergent predicate
  canonicalizes differently.

### Phase 2 — dependency + invalidation (case 2)
- Extend `dependency recording (buildViewMutation funnel)`: CTE-target and inline-target UPDATE
  each record no `view` dep but a `table` dep on `cte_base`; named-view control records one view
  dep.
- Extend `plan invalidation (prepared-statement compile identity)`: `alter view t set tags` does
  NOT invalidate the CTE-target plan (`=== p1`); additive `alter table cte_base` DOES invalidate
  it (`!== p1`); inline-target base-table invalidation case.

### Phase 3 — validate
- Run the two specs, then `yarn test` + `yarn lint`. Fix any drift. If a failure is plainly
  pre-existing / outside this diff, follow the `.pre-existing-error.md` flag protocol rather than
  chasing it here.
