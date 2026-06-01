description: column_info() over-reported is_updatable='YES' for cross / `> 2`-table / self-join view bodies that propagate() rejects wholesale. Fixed by gating deriveColumnInfo on a shared, non-throwing AST shape predicate (isDecomposableJoinBody) — the boolean shadow of collectInnerJoinSources. Reviewed and completed.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

# column_info() non-inner-join over-report — complete

## What the bug was

`deriveColumnInfo` (`func/builtins/schema.ts`) resolved each output attribute's
backward `updateLineage` `base` site to a producing `TableReferenceNode` and
reported `is_updatable = 'YES'` — even for **cross joins** and **`> 2`-table
joins** (and self-joins), which `propagate()` rejects wholesale. Only
LEFT/RIGHT/FULL joins null-extend, so the pre-existing `outerJoin` lineage gate
did **not** catch these strict-`base` bodies; they slipped straight through and
over-reported a YES-when-NO.

## What shipped

- **`isDecomposableJoinBody(selectAst)`** — new non-throwing AST shape check in
  `planner/mutation/multi-source.ts` (exported), the boolean shadow of the
  throwing `collectInnerJoinSources`. Returns `true` iff the body is a single
  explicit two-table INNER join with an ON predicate over two distinct plain
  base tables. Cross / outer / `> 2`-table / subquery-source / self-join → `false`.
- **Gate wired into `deriveColumnInfo`**: `unsupportedJoinShape =
  isJoinBody(selectAst) && !isDecomposableJoinBody(selectAst)`, OR-combined with
  the pre-existing `outerJoin` gate at the per-attribute site read. Defense in
  depth: one gate reads lineage, one reads the AST.
- **Same helper reused by `deriveViewInfo`** (landed via prereq
  `view-info-non-inner-join-overreport`), so the two surfaces stay parallel.
- **Docs**: `view-updateability.md` § `column_info` Divergence 3 paragraph.
- **Tests**: `06.3.5-column-info.sqllogic` — `cross_v`, `three_v`, and (added in
  review) `self_v`, each all-`NO`/`null` and each cross-checked against a
  rejected mutation.

## Review findings

**Process note:** the implement-stage handoff was written *before* the prereq
landed and flagged that as gap #1. By review time the prereq
(`view-info-non-inner-join-overreport`) had landed (implement + review). Several
of the handoff's other "honest gaps" turned out to be speculative — I verified
each empirically against the live engine rather than trusting the prose.

### Checked — correctness / shape predicate
- **`isDecomposableJoinBody` exactly mirrors `collectInnerJoinSources`'s AST
  acceptance** — `from.length !== 1` / non-join → reject; per-node `joinType !==
  'inner' || !condition` → reject; subquery/function source → reject; `!= 2`
  tables → reject; same-name (self-join) → reject. Verified node-by-node against
  the throwing original. No divergence in shape acceptance.
- **Type safety / SPP**: clean, no `any`; cheap once-per-call AST walk (not
  per-row); pure function, no resource concerns.

### Found & fixed inline (minor)
- **Self-join was gated but untested (handoff gap #2).** Confirmed empirically
  that `self_v` reports all-`NO`/`null` and its mutation errors `cannot write
  through view … a self-join is not yet decomposable`. **Added a paired
  `self_v` test case** (column_info + rejected update) to 06.3.5. Raises the floor.
- **Stale comma-join attribution in the 06.3.5 comment.** The comment claimed "a
  multi-source comma FROM is rejected at view-creation time (the builder rejects
  multiple FROM sources)". Empirically: `from a x, b y` (aliased) is a **parse**
  error; `from a, b` (unaliased) is rejected by the **SELECT builder** globally
  ("SELECT with multiple FROM sources (joins) not supported") — neither is
  view-creation-specific. **Corrected the test comment.** (The docs paragraph was
  already corrected with accurate, nuanced wording by the prereq's review — no
  doc change needed here.)

### Verified — handoff gaps that did NOT reproduce
- **Gap #3 (DISTINCT / LIMIT / OFFSET join bodies "would still over-report") is a
  false alarm.** Empirically `select distinct … from a join b on …` and
  `select … from a limit 5` both report **all-`NO`** via the lineage path —
  DISTINCT/LIMIT plan nodes don't propagate base sites, so `baseSiteOf` returns
  undefined and the column reads `NO` without any shape gate. No over-report, no
  follow-up ticket warranted.
- **UNION-of-joins** (`… from a join b on … union select …`): also all-`NO` via
  the lineage path; the shape gate operates on the first leg's valid two-table
  join but the union node breaks 1:1 base lineage, so no misfire.

### Verified — consistent-by-design (no action)
- **Gap #4 (equi-join condition not validated):** `isDecomposableJoinBody`
  requires an ON condition to be *present*, not specifically `a.col = b.col` —
  identical to `collectInnerJoinSources`. A non-equi two-table inner join passes
  both, so the surfaces stay consistent with what `propagate()` accepts.
  Intentional and consistent.
- **`USING (col)` join bodies** are gated (no `condition`), matching
  `collectInnerJoinSources` — both surfaces agree (a pre-existing limitation, not
  introduced here).
- **Gap #1 (prereq):** resolved — `view_info('cross_v')` / `view_info('three_v')`
  now both report all-`NO`, agreeing with `column_info`; `deriveViewInfo` reuses
  the same `isDecomposableJoinBody` helper (no second predicate).

### DRY note (not actioned — out of scope, documented risk)
- `isDecomposableJoinBody` duplicates the *shape* logic of the throwing
  `collectInnerJoinSources`. Documented as an intentional "boolean shadow"; both
  live in `multi-source.ts` adjacent to each other, limiting drift risk.
  Refactoring the throwing variant to delegate to the boolean one would touch the
  mutation substrate — deliberately out of this ticket's scope.

### Major findings
- **None.** No new fix/plan/backlog tickets filed.

## Validation run

- `node test-runner.mjs --grep "06.3.5"` — 1 passing (incl. new `self_v` case).
- `node test-runner.mjs --grep "SQL Logic Tests"` — 216 files passing.
- `node test-runner.mjs` (full quereus suite) — 4260 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus run typecheck` — exit 0.
- `yarn run lint 'src/**/*.ts'` (in `packages/quereus`) — exit 0.
