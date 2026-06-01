description: view_info() over-reported updateability for non-inner / multi-table join bodies (cross / comma / `> 2`-table / self-join). Fixed by reusing the shared `isDecomposableJoinBody` AST shape predicate to short-circuit `deriveViewInfo` to the conservative all-`NO`/`[]` row for any join body `propagate()` does not accept, while the two-table inner equi-join (`ms_jv`) and outer-join cases are unchanged. Reviewed and completed.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
----

# view_info() over-reports non-inner-join multi-table bodies — DONE

## What the bug was

`deriveViewInfo` (`func/builtins/schema.ts`) walked the planned body's root
`updateLineage`, resolved each `base` site to a producing `TableReferenceNode`,
and reported `is_updatable = 'YES'` with both tables in `effective_targets` — even
for **cross joins** and **`> 2`-table inner joins**, which `propagate()`
(`propagateMultiSource` / `collectInnerJoinSources`) rejects wholesale. The
pre-existing `null-extended` (outer-join, Divergence 2) gate did not catch these:
only LEFT/RIGHT/FULL joins null-extend, so cross / `> 2`-table bodies carry
strict-`base` lineage and slipped through, reporting a dangerous `YES`-when-`NO`.

## What changed (implement stage)

- **`deriveViewInfo` gate (`schema.ts`):** right after the Divergence-2 outer-join
  gate, an early return `if (isJoinBody(view.selectAst) &&
  !isDecomposableJoinBody(view.selectAst)) return CONSERVATIVE_VIEW_INFO;`.
- **No new parser — DRY.** Reuses `isDecomposableJoinBody`, the non-throwing boolean
  shadow of the throwing `collectInnerJoinSources`, already created/exported by the
  `column-info-non-inner-join-overreport` ticket and already wired into
  `deriveColumnInfo`. Both static surfaces now call the one predicate, agreeing with
  what a real mutation through the view accepts.
- **Tests (`06.3.4-view-info.sqllogic`):** new "Divergence 3" section — `xj_cross`
  (2-table cross join) and `xj_three` (3-table inner join), each asserting the
  conservative all-`NO`/`[]` row and each cross-checked against a rejected mutation;
  plus a positive control in the `ms_jv` section (a clean no-op update) proving the
  two-table inner equi-join stays writable.

## Review findings

**Disposition: 2 minor fixes applied inline; 0 major (no new tickets). All gaps the
implementer flagged were investigated; one speculative gap was empirically disproved.**

### Aspect review (SPP / DRY / correctness / type safety / tests / docs)

- **DRY / no second parser — confirmed.** `deriveViewInfo` imports and calls
  `isDecomposableJoinBody` from `planner/mutation/multi-source.ts` (the same helper
  `deriveColumnInfo` uses). No duplicated join-shape parsing. The two surfaces are
  structurally parallel (`schema.ts:762` vs `schema.ts:1054`).
- **Correctness — confirmed.** The shape predicate exactly mirrors
  `collectInnerJoinSources`'s acceptance (single explicit two-table INNER join, ON
  present, two distinct plain base tables). Outer joins are caught by *both* the
  lineage gate and the shape gate (parallel defense-in-depth, as documented).
- **Type safety / error handling — clean.** Pure read path; per-view try/catch
  preserves the never-throw posture of the introspection surface. No `any`.
- **Tests — extended.** Implementer covered cross + 3-table + ms_jv positive
  control. I added a **self-join** case (see below).
- **Docs — corrected** (see Gap 1). `docs/view-updateability.md` § Divergence 3 now
  accurately describes both surfaces and the comma-FROM rejection path.

### Findings & disposition

1. **[minor — FIXED] Comma-FROM rejection wording was imprecise.** The
   implementer's own honest-gap note (and the column-info-authored doc) said a
   multi-source comma FROM is "rejected by the view builder at create-view time".
   Verified empirically: with aliases (`from a x, b y`) it is a **parse error**
   (`Expected statement type … got 'a'`); only the no-alias form is a select-builder
   reject. Either way the load-bearing claim ("such a view never reaches these
   surfaces") holds, but the mechanism was misstated. Corrected the sentence in
   `docs/view-updateability.md` § Divergence 3 and the matching in-file note in
   `06.3.4-view-info.sqllogic` to name both paths.

2. **[minor — FIXED] Self-join gated but untested.** A self-join
   (`from t a join t b on …`) is the *only* buildable shape that exercises
   `isDecomposableJoinBody`'s distinct-table-name branch (cross / `> 2`-table fail
   earlier checks). It is genuinely buildable (unlike comma joins), so the gate is
   load-bearing for it. Added `xj_self` to `06.3.4-view-info.sqllogic`: asserts the
   conservative all-`NO`/`[]` row and cross-checks against a rejected
   self-join mutation. Passes.

3. **[not a bug — INVESTIGATED, no action] DISTINCT / LIMIT / OFFSET join bodies.**
   The implementer flagged these as a possible un-gated over-report (gap #3).
   Empirically **disproved** for `view_info`: a `select distinct … from a join b
   on …` view, a `… join … limit 5` view, and even a single-source `… limit 5` view
   all report `is_updatable='NO', effective_targets='[]'`. The Distinct/Limit node
   at the body root carries no `base` root lineage, so the existing
   `targetIds.size === 0` short-circuit catches them before the shape gate matters.
   No divergence, no follow-up ticket.

4. **[intentional — CONFIRMED] Equi-join condition not validated.** Like
   `collectInnerJoinSources`, `isDecomposableJoinBody` only requires an ON condition
   to be *present*, not specifically `a.col = b.col`. This keeps the static surface
   consistent with what `propagate()`'s shape gate accepts (the surfaces must agree
   with the substrate, not be stricter than it). Confirmed as the desired contract.

5. **[confirmed adequate] insertable/deletable latency.** The conservative
   short-circuit zeroes all four flags; the tests assert all four are `NO`, so a
   cross/`>2`-table shape that exposed PKs + nullable columns (which would otherwise
   over-report insertable/deletable too) is also covered.

### Validation (review stage)

- `node test-runner.mjs --grep "06.3.4-view-info|06.3.5-column-info"` — 2 passing
  (view_info with the new self-join case; column_info unchanged).
- `node test-runner.mjs` (full quereus suite) — **4243 passing, 9 pending, 0
  failing**.
- `yarn workspace @quereus/quereus run typecheck` — exit 0.
- `yarn lint` (in `packages/quereus`) — exit 0.
- Cross-surface consistency spot-checked: `view_info` and `column_info` agree
  (both conservative) for cross / `> 2`-table / self-join; both report writable for
  `ms_jv`.

## Follow-ups spun out (pre-existing, unrelated to this fix)

None required by this review. (The orthogonal `view-mutation-top-level-colref-view-scope`
implement ticket was spun out during the implement stage and is unrelated to the
join-shape gate.)
