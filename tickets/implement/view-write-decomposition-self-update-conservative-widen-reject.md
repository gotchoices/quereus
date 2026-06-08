description: Recover the previously-working null-propagating partial self-update on an optional decomposition member. A self-reference UPDATE (`set e1 = e1 + 1`) that leaves a NOT-NULL / non-null-defaulted sibling value column unassigned currently **rejects** at plan time via the materialize's two unconditional soundness gates — even though, being null-propagating, it materializes no absent row and therefore can never widen anything. Fold the materialize's null-substituted non-empty filter at plan time: when it folds **constant-false** (no absent row can materialize), skip the materialize INSERT and its two gates entirely, degrading the group to matched-update-only (present-rows-only), matching the pre-materialize behavior. A genuinely-materializing self-update (`set e1 = coalesce(e1, 0) + 1`) still emits the INSERT and runs the gates.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate `hasSelf` branch ~L1077-1090, buildSelfMaterializeInsertSelect ~L1221-1276, substituteOwnerColumnsWithNull ~L1500, the non-empty OR-chain filter ~L1254-1257), packages/quereus/src/planner/building/expression.ts (buildExpression — already imported by sibling mutation modules), packages/quereus/src/planner/analysis/const-evaluator.ts (createRuntimeExpressionEvaluator), packages/quereus/test/lens-put-fanout.spec.ts (`rejects a partial self-update that leaves a non-null-defaulted sibling value column unassigned` ~L639-655 — flip the null-propagating arm to an accept; add a null→non-null reject arm), docs/lens.md (§ The Default Mapper, the `put` fan-out UPDATE paragraph, L154), docs/view-updateability.md (decomposition self-materialize gate text, ~L145-194)
----

## Background

`emitOptionalMemberUpdate`'s `hasSelf` branch (decomposition.ts ~L1077) emits, for a member
self-reference UPDATE on an **optional columnar** member, a matched UPDATE for present rows
**plus** a materialize INSERT (`buildSelfMaterializeInsertSelect`) for absent rows. That INSERT
runs two data-independent, plan-time soundness gates (shared with the constant/anchor materialize
builders):

- **`assertNoUnassignedValueColumnWiden`** — an unassigned member value column that would not land
  null (it is NOT NULL, or declares a default) cannot materialize without widening the absent row's
  logical image.
- **`assertNoMissingNotNull`** — a NOT NULL base column with no default that no value covers cannot
  be created.

Both fire **unconditionally**, before the runtime non-empty filter is consulted. So a
null-propagating self-update — `set e1 = e1 + 1` on `M_def` whose sibling `e2` carries `default 7` —
is rejected at plan time, even though its materialize filter `((null + 1) is not null)` is
constant-false and **guarantees no absent row ever materializes** (hence nothing is ever widened).

### Why this is a regression to fix

The pre-materialize `hasSelf` branch called **neither** gate (it never materialized) and correctly
accepted `set e1 = e1 + 1`, updating only present rows. The current path rejects it — sound (never
wrong data) but strictly less permissive than what shipped, and the reject message ("materializing
an absent row … would leave value column 'e2' to a base default") is misleading for a case that
never materializes.

### Why the planner can now decide this statically

A `self` cell's value, after `substituteOwnerColumnsWithNull` (decomposition.ts ~L1500), has **no
column refs** — the classifier (`lowerMaterializedValue`, ~L922) proved every leaf is the owner's
own column, and a constant sibling carries none. So each null-substituted cell value is a
**constant expression**, and the materialize's non-empty filter
`(<v1> is not null or <v2> is not null or …)` is a **plan-time constant** once each `<vi>` folds.
The engine already constant-folds deterministic operators/functions (`null + 1` → null;
`coalesce(null, 0) + 1` → 1; `case`/`iif` fold once their args are literals).

## Desired behavior

In `emitOptionalMemberUpdate`'s `hasSelf` branch, decide statically whether the materialize is dead:

- **filter folds constant-false** (every self cell null-propagates **and** no non-null constant
  sibling) → **no absent row can materialize** → emit **only** the matched UPDATE; **skip** the
  materialize INSERT and — because the gates live inside `buildSelfMaterializeInsertSelect` — both
  soundness gates with it. Recovers the present-rows-only behavior.
- **otherwise** (some cell folds non-null, or the value is non-foldable / volatile / parameterized) →
  emit the matched UPDATE + `buildSelfMaterializeInsertSelect` and run the gates, **exactly as
  today**. Non-foldable stays conservative — we cannot prove it dead, so we keep the gate.

Skipping `assertNoMissingNotNull` together with the widen gate in the dead case is sound: both are
plan-time proxies for "a materialized row would violate"; if no row materializes, no violation is
possible.

### Mechanism (resolved)

Reuse the engine's constant folding — do **not** hand-roll an AST evaluator (AGENTS.md: no janky
parsers). Build the null-substituted non-empty filter expression to a scalar `PlanNode` via
`buildExpression(ctx, expr)` (already imported and used across `multi-source.ts` / `set-op.ts`), then
evaluate it via `createRuntimeExpressionEvaluator(ctx.db)` from
`planner/analysis/const-evaluator.ts`. The filter is an OR-chain of `<nulledValue> is not null`;
`is not null` is total (never NULL), so a dead materialize folds to boolean `false` (defensively also
treat `0` / `0n`):

```ts
/** True when the self-materialize non-empty filter provably folds constant-false at plan time. */
function foldsConstantFalse(ctx: PlanningContext, expr: AST.Expression): boolean {
  try {
    const node = buildExpression(ctx, expr);
    const value = createRuntimeExpressionEvaluator(ctx.db)(node);   // MaybePromise<OutputValue>
    return value === false || value === 0 || value === 0n;          // Promise / non-null / truthy → not provably dead
  } catch {
    return false;   // non-foldable / volatile / parameterized → stay conservative (emit + gate)
  }
}
```

Keep the OR-chain construction DRY: extract the null-substituted non-empty filter into a shared
helper (e.g. `selfMaterializeNonEmptyFilter(cells, member): AST.Expression`) used by **both** the
dead-check (folded directly, **without** the user predicate — liveness is about the value, not which
rows match) and `buildSelfMaterializeInsertSelect` (where it is conjoined with `pred` as today, see
`combineAnd(pred, nonEmpty)` ~L1257). `buildSelfMaterializeInsertSelect` still computes the per-cell
`nulled` projections (it needs `basisColumn` pairing); the filter helper just rebuilds the OR-chain
from `cells` + `member`.

Wire the branch:

```ts
if (hasSelf) {
  ops.push(memberUpdateOp(ctx, view, shape, member,
    cells.map(c => ({ column: c.basisColumn, value: stripMemberQualifier(c.value, member) })), pred, stmt));
  // Skip the materialize INSERT (and its two gates) when no absent row can ever materialize.
  if (!foldsConstantFalse(ctx, selfMaterializeNonEmptyFilter(cells, member))) {
    ops.push(buildSelfMaterializeInsertSelect(ctx, view, shape, member, cells, pred, stmt));
  }
  return;
}
```

Leave the gate functions and `buildSelfMaterializeInsertSelect`'s internals unchanged — guarding the
**call** is what skips the gates. Update the branch's leading doc comment and the
`buildSelfMaterializeInsertSelect` doc to note the gates run only when the materialize is statically
live.

## Edge cases & interactions

- **`set e1 = e1 + 1` on `M_def` (e2 `default 7`)** — single null-propagating self cell. Filter
  `((null + 1) is not null)` → `false` → skip materialize + gates → matched UPDATE only. Absent row
  (id=2) stays absent; present rows update e1, keep e2. **Accept** (was reject). Acceptance bullet 1.
- **`set e1 = coalesce(e1, 0) + 1` on `M_def`** — filter `((coalesce(null,0)+1) is not null)` →
  `true` → emit + gate → widen gate rejects (e2 unassigned, has default). **Still rejects.**
  Acceptance bullet 2. Add this as a new arm.
- **NOT-NULL-no-default sibling analogue** — a null-propagating partial self-update leaving a
  NOT-NULL-no-default sibling uncovered now **succeeds** (present rows only — both gates skipped
  together); the null→non-null variant still **rejects** via `assertNoMissingNotNull`. Acceptance
  bullet 3. (No `M_def`-style fixture has a NOT-NULL-no-default value sibling today; either reuse an
  existing optional member or note it covered transitively by the shared skip — the widen and
  missing-not-null gates are skipped by the same guard, so one arm exercising the skip suffices.)
- **`set c1 = c1 + 1, c2 = 5`** (self + non-null constant, existing test ~L578) — filter
  `((null+1) is not null or (5) is not null)` → `false or true` → `true` → emit + materialize, image
  `(c1=null, c2=5)`. **Unchanged** — the constant keeps it live; the existing materialize test stays
  green.
- **`set c1 = c1 + 1, c2 = coalesce(c2, 0) + 1`** (two self, mixed null-prop, existing test ~L599) —
  `false or true` → `true` → emit. **Unchanged.**
- **`set c1 = c1 + 1, c2 = null`** (self + explicit null sibling) — both fold null → filter `false` →
  skip materialize. Present rows: c1 transformed, c2 set null. Correct (absent rows would land all
  null — nothing to create). Now recovered (was gated).
- **Identity self `set c1 = c1`** — nulled → `null` → filter `false` → skip. No-op on present, absent
  stays absent. Correct.
- **`case`/`iif` self (`set c1 = case when c1 is null then 9 else c1 + 1 end`)** — nulled →
  `case when null is null then 9 else null+1 end` → 9 (non-null) → live → emit + gate. Correct (maps
  null→9, materializes).
- **Parameter / volatile in a self value (`set c1 = c1 + :x`, `set c1 = c1 + random()`)** — after
  null-substitution `null + :x` / `null + random()` does not fold to a plan-time constant: the
  evaluator throws (param unbound) or yields a Promise/non-constant → `foldsConstantFalse` returns
  `false` → emit + gate. Conservative, matches today. (Add at least one volatile/param arm to pin the
  conservative path; a `random()`-bearing self over a fully-nullable optional member should still
  **accept** via emit since the widen gate passes when every value column is assigned.)
- **`hasAnchor && hasSelf`** and **`hasAnchor`** branches — untouched (the mix still rejects; the
  anchor-only branch still upserts). Only the `hasSelf`-only branch changes.
- **EAV members** — an EAV self lowers to a correlated subquery and is rejected in
  `lowerMaterializedValue` before reaching a cell; `emitEavMemberUpdate` has no self path. No change.
- **Atomicity** — the matched UPDATE alone (no INSERT) is a single base op; nothing partial.
- **Import-cycle check** — `createRuntimeExpressionEvaluator` lives in the optimizer analysis layer
  (pulls in `runtime/emitters`, `runtime/scheduler`). `buildExpression` is already imported here's
  siblings, but confirm adding the const-evaluator import to `decomposition.ts` does not introduce a
  cycle that breaks `yarn build` (runtime depends on planner nodes, not on `planner/mutation`, so it
  should be clean — verify).

## Key tests (lens-put-fanout.spec.ts)

- **Flip** `rejects a partial self-update that leaves a non-null-defaulted sibling value column
  unassigned` (~L639): rename/repurpose so the **null-propagating** arm `update x.M set e1 = e1 + 1
  where id = 2` now **succeeds** — present row updates, absent row (id=2) materializes nothing
  (`select count(*) from main.M_def where id = 2` → `0`), and the present row's e2 is untouched.
- **Add** a reject arm on the same fixture: `update x.M set e1 = coalesce(e1, 0) + 1 where id = 2`
  still throws `/silently widening|base default/i` (genuinely materializes, widens e2).
- **Add** a conservative-path arm: a non-foldable self value (`random()` / a bound parameter) over a
  member where every value column is assigned still emits the materialize (accepts when no widen) —
  proving non-foldable stays on the emit path, not silently skipped.
- Keep the existing `'a self cell with a non-null-constant sibling materializes …'` and
  `'two self cells with mixed null-propagation …'` tests green (they assert materialization, which
  the live path preserves).
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens.log; tail -n 60 /tmp/lens.log`
  (stream it) plus lint on the touched file.

## Docs

- **docs/lens.md** § The Default Mapper, the `put` fan-out **UPDATE** paragraph (L154): after the
  self-reference sentence (the runtime non-empty filter), note that the two materialize soundness
  gates (unassigned-value-column widen, missing-not-null) fire **only when the materialize is
  statically live** — when the null-substituted non-empty filter folds constant-false at plan time
  the materialize INSERT and its gates are skipped, so a null-propagating partial self-update
  (`set c = c + 1`) updates present rows only and never trips the widen gate.
- **docs/view-updateability.md** (decomposition self-materialize gate text, ~L145-194): mirror the
  same clarification — the plan-time gates are conditioned on a statically-live materialize.

## TODO

- Extract `selfMaterializeNonEmptyFilter(cells, member): AST.Expression` (the null-substituted
  `is not null` OR-chain) and reuse it in `buildSelfMaterializeInsertSelect` (replacing the inline
  `nonEmpty` construction) so the dead-check and the emitted filter cannot drift.
- Add `foldsConstantFalse(ctx, expr)` using `buildExpression` + `createRuntimeExpressionEvaluator`;
  add the const-evaluator import.
- Guard the `buildSelfMaterializeInsertSelect` call in the `hasSelf` branch behind
  `!foldsConstantFalse(...)`; keep the matched UPDATE unconditional.
- Update the `hasSelf` branch comment and `buildSelfMaterializeInsertSelect` doc to state the gates
  run only on a statically-live materialize.
- Flip the null-propagating test arm to an accept; add the `coalesce` reject arm and a non-foldable
  conservative arm.
- Update docs/lens.md (L154) and docs/view-updateability.md.
- `yarn build`, run the lens put-fanout suite (streamed) and `yarn test`, lint the touched file.
