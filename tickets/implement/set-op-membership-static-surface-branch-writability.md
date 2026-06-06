description: Gate the set-op membership static surfaces (`column_info` / `view_info`) on a lightweight AST-only branch-writability probe, so the catalog reports a non-writable shape (`is_updatable='NO'` / view all-`NO`) for a set-op membership body whose branch is non-writable (computed leg, `select *` leg, non-SELECT operand, column-count mismatch) — matching what the dynamic write (`analyzeSetOpView`) actually does, instead of over-claiming writable from the membership-flag presence alone.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/docs/view-updateability.md
----

## Problem

`deriveViewInfo` (schema.ts:728) and `deriveColumnInfo` (schema.ts:1040) short-circuit on
`isSetOpMembershipBody(view.selectAst)` — a pure AST peek that only checks the compound
carries ≥1 `exists … as <flag>` clause — and report the view/columns fully writable
(`is_insertable_into='YES'` / `is_updatable='YES'` / `is_deletable='YES'`; every column
`is_updatable='YES'`). They never verify the two operands are themselves writable.

The **dynamic** write path (`buildSetOpWrite` → `analyzeSetOpView`, set-op.ts:148) *does*
enforce branch writability and rejects (`unsupported-set-op`):
- a right operand that is not a `SELECT` (`rightBranchSelect`, set-op.ts:237),
- a `select *` leg (`branchColumnNames`, set-op.ts:282),
- a computed (non-plain-`column`) leg projection (`branchColumnNames`),
- a branch whose projected column count disagrees with the data-column count
  (`buildBranch`, set-op.ts:258).

So a view such as

```sql
create view Uc as
  select id, x from A
  union exists left as inA, exists right as inB
  select id, x + 1 from B          -- computed right leg
```

reports every column `is_updatable='YES'` from `column_info('Uc')` and view all-`YES` from
`view_info('Uc')`, yet `update Uc set x = 5 where id = 1` rejects. This is a
static-vs-dynamic over-claim (catalog honesty gap) — **not** a correctness bug: the write
itself rejects cleanly. The **join** body static surface, by contrast, already gates this
class of over-claim via its "non-decomposable join shape gate"
(`isJoinBody && !isDecomposableJoinBody` → `CONSERVATIVE_VIEW_INFO`, schema.ts:744 / 1062);
the set-op surface was modelled on the join surface but skipped the analogous gate.

## Desired behavior

A new **non-throwing, AST-only** probe exported from `planner/mutation/set-op.ts`:

```ts
/**
 * True iff both operands of a set-op membership body are recursively writable *at the
 * branch-shape level* — the static (no-plan) shadow of the four branch rejections in
 * {@link analyzeSetOpView}: a non-SELECT right operand, a `select *` leg, a computed
 * (non-plain-column) leg, or legs whose plain-column counts disagree. Lets the
 * `column_info` / `view_info` static surfaces gate the membership-writable claim on the
 * SAME shape the dynamic write enforces, instead of reporting writable from the membership
 * flag's presence alone. Non-recursive (one level): a nested-compound operand whose first
 * leg is plain still passes here, matching that `analyzeSetOpView` also defers the nested
 * reject to write-time `propagate` (`set-op-membership-nested`).
 */
export function isSetOpBranchWritable(selectAst: AST.QueryExpr): boolean
```

It must:
- return `false` if `selectAst` is not a `select`-with-`compound` (defensive; callers
  already gate on `isSetOpMembershipBody`),
- reuse `leftBranchSelect(sel)` for the left operand and `compound.select` for the right,
- reject (return `false`) when the right operand is not `type === 'select'`,
- probe each leg's projection with a **non-throwing** column-name helper
  (`tryBranchColumnNames(branchSelect): string[] | null`) that returns `null` on a
  `select *` (`rc.type === 'all'`) or a computed projection (`rc.expr.type !== 'column'`),
  else the positional name list (`rc.alias ?? rc.expr.name`),
- return `false` when either leg probes `null`, or when the two legs' name-list lengths
  disagree (the AST-only equivalent of `dataColNames.length !== dataColCount`).

Keep the existing throwing `branchColumnNames` for the dynamic path's specific per-side
diagnostics; have it call `tryBranchColumnNames` and, on `null`, re-derive the specific
reason (`select *` vs computed) for its message — so the two paths share the single
predicate (DRY) and cannot drift. (Alternatively leave `branchColumnNames` untouched and
accept the two-line duplication of the `all`/`column` checks; prefer the shared-predicate
refactor unless it muddies the per-side error messages — both are acceptable, pick the
cleaner diff.)

Wire it into **both** static surfaces, immediately inside the existing
`isSetOpMembershipBody(...)` block, before the writable row is returned:

- `deriveViewInfo` (schema.ts:728): if `!isSetOpBranchWritable(view.selectAst)` →
  `return CONSERVATIVE_VIEW_INFO` (the same conservative all-`NO` row the join shape gate
  returns).
- `deriveColumnInfo` (schema.ts:1040): if `!isSetOpBranchWritable(view.selectAst)`, fall
  through to the normal per-column lineage walk rather than the all-`YES` short-circuit.
  **Decision:** a non-writable set-op body has no per-column base lineage at the root (a
  `SetOperationNode` root exposes no `base` `updateLineage` site for its data columns), so
  the per-column walk naturally reports every column `is_updatable='NO'` with null base —
  the conservative row the ticket asks for. Verify this in the test (below); if the walk
  ever resolved a base site for a set-op leg, prefer an explicit early `return` of
  all-`NO` rows over relying on the fall-through. Confirm against the planned tree before
  choosing — do not leave it implicit if unverified.

Dependency direction stays one-way: `schema.ts` already imports `isSetOpMembershipBody`
from `set-op.ts` (schema.ts:23); add `isSetOpBranchWritable` to that same import. No new
edge into `set-op.ts`.

## Edge cases & interactions

- **Computed right leg** (`select id, x+1 from B`) — non-writable → `view_info` all-`NO`,
  every `column_info` row `is_updatable='NO'`, null base. Cross-check: the dynamic
  `update … set x = …` still rejects.
- **Computed left leg** (`select id, x+1 from A union exists … select id, x from B`) —
  symmetric; non-writable. (Probe must check BOTH legs, not only the right.)
- **`select *` leg** (either side) — non-writable. Note the engine's compound grammar does
  not accept a parenthesized left leg at the outer level (see the existing test's comment,
  property.spec.ts:2201), so author the `*`-leg fixture in the supported
  non-parenthesized form.
- **Non-SELECT right operand** — `… union exists left as inA, exists right as inB values
  (1, 2)`: right `type !== 'select'` → non-writable. (Confirm this parses as a membership
  body with a VALUES right operand; if the parser rejects it outright, drop this fixture
  and note it — the dynamic `rightBranchSelect` reject then can't be reached either.)
- **Column-count mismatch between legs** — defensive; a valid set op has equal leg counts,
  but a `*` leg already returns `null` before the length compare, so this branch mainly
  guards a genuine arity disagreement. Keep the length check.
- **All-plain-column fixture (regression)** — the shipped `U`
  (`select id, x from A union exists left as inA, exists right as inB select id, x from B`)
  must STILL report writable (`view_info` all-`YES`, every column `is_updatable='YES'`).
  The existing `static surface agrees with the dynamic write` test (property.spec.ts:2569)
  and the `column_info` / `view_info` tests (property.spec.ts:2376 / 2388) only exercise
  writable fixtures — they are the regression guard; ensure they stay green.
- **Renamed plain columns** (`select id as k, x from A …`) — still writable (the probe
  keys off `rc.alias ?? rc.expr.name`, the alias path). Worth one assertion so a future
  tightening of "plain column" doesn't silently drop renamed legs.
- **Nested-compound operand (known non-goal)** — a right operand that is itself a compound
  (`… union exists … (select … union select …)`) whose first leg is plain still passes the
  probe; the dynamic path also defers its reject to write-time `propagate`
  (`set-op-membership-nested`). This residual one-level-deep over-claim is explicitly OUT
  of scope here (the probe is non-recursive); call it out in a comment so the reviewer does
  not file it as a regression.
- **Plain (flag-less) set-op body** — unchanged: `isSetOpMembershipBody` is already
  `false`, so the new probe is never consulted; the flag-less body keeps falling through to
  the conservative row via the `targetIds.size === 0` path (schema.ts:775).
- **Re-plan-on-read posture** — both surfaces re-plan the body per call; the probe is pure
  AST and adds no plan build, so no perf interaction. It runs BEFORE the existing plan
  build in `deriveViewInfo`/`deriveColumnInfo` only logically — place the guard where shown
  (inside the `isSetOpMembershipBody` block) so the early conservative return still happens
  after the membership-body shape is confirmed.

## Tests (property.spec.ts, `Set-operation membership writes` or `…membership columns` describe)

Add alongside the existing static-surface tests:

- **`column_info`: a computed-leg set-op view reports the non-writable shape** — create
  `Uc` with a computed right leg; assert every `column_info('Uc')` row
  `is_updatable='NO'`, `base_table`/`base_column` null. Then assert the dynamic write still
  rejects (`update Uc set x = 5 where id = …` throws) — static now agrees with dynamic.
- **`view_info`: a computed-leg set-op view reports all-`NO`** — `is_insertable_into`,
  `is_updatable`, `is_deletable` all `'NO'` for `Uc`.
- **`column_info` / `view_info`: a `select *`-leg set-op view reports the non-writable
  shape** — same assertions over a `*`-leg fixture (non-parenthesized form).
- **regression: the all-plain `U` view still reports writable** — keep/extend the existing
  `static surface agrees with the dynamic write`, `column_info`, and `view_info` tests
  green; optionally add a renamed-plain-column fixture asserting it stays writable.

Expected outputs: computed/`*`-leg → `is_updatable='NO'` everywhere, view triple `'NO'`;
all-plain → `is_updatable='YES'` everywhere, view triple `'YES'`.

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/setop-static.log; tail -n 80 /tmp/setop-static.log`
  (stream — do not silent-redirect). Focus the `Set-operation membership` describes.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).

Update `packages/quereus/docs/view-updateability.md` § Set Operations to note the static
surfaces now gate on branch writability (mirroring the join shape gate) — a one-paragraph
addition next to the existing set-op writability prose; do not author a new doc.

## Notes

- Surfaced during review of `set-op-membership-write` (see that complete ticket's Review
  findings). Deferred as backlog (minor honesty gap, no correctness impact); the inline
  review fix in that pass addressed a separate, higher-impact bug (bound parameters in the
  WHERE of a membership write).
- Conservative-direction-*wrong* today (claims writable when not), so the fix only ever
  tightens a `YES` to `NO` for genuinely non-writable shapes — it cannot regress a write
  that currently succeeds (those are all all-plain-column bodies the probe passes).

## TODO

- Add `tryBranchColumnNames(branchSelect): string[] | null` and
  `isSetOpBranchWritable(selectAst): boolean` to `planner/mutation/set-op.ts`; export the
  latter. Refactor `branchColumnNames` to share the predicate (or accept the minor
  duplication — see Desired behavior).
- Import `isSetOpBranchWritable` into `schema.ts` (extend the existing `set-op.js` import).
- Gate `deriveViewInfo`'s `isSetOpMembershipBody` block on the probe → `CONSERVATIVE_VIEW_INFO`.
- Gate `deriveColumnInfo`'s `isSetOpMembershipBody` block on the probe (fall through to the
  per-column walk, or explicit all-`NO` rows — verify which against the planned tree).
- Add the `column_info` / `view_info` computed-leg and `*`-leg non-writable tests; confirm
  the all-plain regression tests stay green; optional renamed-plain-column writable test.
- Update `docs/view-updateability.md` § Set Operations.
- Build, test (streamed), lint.
