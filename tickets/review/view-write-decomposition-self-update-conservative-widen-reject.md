description: Review the recovered null-propagating partial self-update on an optional decomposition member. The matched-update-only self path was regressed into a plan-time reject by two unconditional materialize soundness gates; this change folds the materialize's null-substituted non-empty filter at plan time and, when it folds constant-false (no absent row can ever materialize), skips the materialize INSERT and both gates with it — degrading the group to present-rows-only. A genuinely-materializing self-update still emits the INSERT and runs the gates.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate `hasSelf` branch ~L1077-1100, buildSelfMaterializeInsertSelect ~L1234-1289 + its now-shared filter, new helpers selfMaterializeNonEmptyFilter + foldsConstantFalse ~L1291-1330, imports L11-14), packages/quereus/src/planner/analysis/const-evaluator.ts (createRuntimeExpressionEvaluator — reused, unchanged), packages/quereus/src/planner/building/expression.ts (buildExpression — reused, unchanged), packages/quereus/test/lens-put-fanout.spec.ts (~L335 comment refresh; ~L639-695 three self-update arms), docs/lens.md (§ The Default Mapper put fan-out UPDATE ~L154), docs/view-updateability.md (~L194)
----

## What changed

`emitOptionalMemberUpdate`'s `hasSelf` branch previously emitted, unconditionally, a matched
UPDATE **plus** `buildSelfMaterializeInsertSelect` (the absent-row materialize INSERT). That INSERT
runs two data-independent plan-time soundness gates — `assertNoUnassignedValueColumnWiden`
(unassigned non-null/defaulted value column would widen the absent row) and `assertNoMissingNotNull`
(NOT-NULL-no-default base column nothing covers). Because both fired before the runtime non-empty
filter was consulted, a **null-propagating** partial self-update (`set e1 = e1 + 1` on a member whose
sibling `e2` carries `default 7`) was **rejected at plan time** — even though its materialize filter
`((null + 1) is not null)` is constant-false and guarantees no absent row ever materializes. That was
a regression vs. the pre-materialize self path, which called neither gate and accepted the write
(present rows only).

The fix decides statically whether the materialize is **dead**:

- Extracted `selfMaterializeNonEmptyFilter(cells, member)` — the null-substituted `is not null`
  OR-chain — now shared by `buildSelfMaterializeInsertSelect` (where it is conjoined with the user
  predicate as the emitted INSERT's WHERE) and the new dead-check, so the two cannot drift.
- Added `foldsConstantFalse(ctx, expr)`: builds the filter to a scalar plan node via the engine's own
  `buildExpression`, evaluates it through `createRuntimeExpressionEvaluator(ctx.db)`, and returns
  `true` only when the fold is boolean `false` (defensively `0`/`0n`). A non-null fold, a Promise, or
  a throw (volatile / unbound parameter) ⇒ `false` (stay conservative). **No hand-rolled evaluator**
  — reuses the existing const-folding substrate per the ticket's resolved mechanism.
- The `hasSelf` branch now emits the matched UPDATE unconditionally, and emits
  `buildSelfMaterializeInsertSelect` (and therefore both gates) **only when** the filter does not
  fold constant-false. Skipping the dead materialize takes both gates with it — sound, because a gate
  is only a plan-time proxy for "a materialized row would violate", and no row materializes.

The gate functions and the materialize builder's internals are unchanged; guarding the **call** is
what skips the gates. The `hasSelf` branch doc, `buildSelfMaterializeInsertSelect` doc, lens.md, and
view-updateability.md were updated to state the gates run only on a statically-live materialize.

## Use cases / validation (all green)

`yarn build` (no import cycle from the new const-evaluator import), `eslint` on the two touched
files, the full `yarn workspace @quereus/quereus test` suite (**5269 passing, 9 pending**), and the
targeted `lens-put-fanout.spec.ts` (93 passing). Key behavioral arms (in `lens-put-fanout.spec.ts`,
fixture `setupMulti`: `M_opt(c1,c2)` both nullable, `M_def(e1, e2 default 7)`, id=1 present / id=2
absent):

- **Flipped to accept** — `update x.M set e1 = e1 + 1 where id = 2` on `M_def`: filter
  `((null+1) is not null)` → false → skip materialize + both gates → present-rows-only. Present row
  (id=1) updates e1, keeps e2; absent row (id=2) materializes nothing; e2 never widened. (Was a
  reject.)
- **Still rejects** — `update x.M set e1 = coalesce(e1, 0) + 1 where id = 2`: filter
  `((coalesce(null,0)+1) is not null)` → true → emit + gate → widen gate rejects (e2 has default).
- **Conservative emit (new arm)** — `update x.M set c1 = coalesce(c1, :x) where id = 2` with `x=5`:
  the parameter is unbound during plan-time folding (the const-evaluator uses an empty param map), so
  the fold **throws** → `foldsConstantFalse` returns false → materialize emitted (widen gate passes,
  c2 nullable-no-default). At runtime `coalesce(null,5)=5` materializes (id=2 → c1=5, c2=null),
  proving the non-foldable path is not silently skipped.
- **Unchanged (live) cases stay green** — `set c1 = c1+1, c2 = 5` (self + non-null constant) and
  `set c1 = c1+1, c2 = coalesce(c2,0)+1` (two self, mixed null-prop) both fold the OR-chain to true →
  emit + materialize. The single-column `T_c` null-prop self (`set c = c + 1`, spec ~L335) now folds
  to false → skip; observably identical (no row materializes either way) — comment refreshed.

## Honest gaps / reviewer attention

- **`random()` is NOT a conservative case (deviates from the ticket's edge-case note).** The ticket
  lists `set c = c + random()` as a non-foldable emit case. In fact `null + random()` = null (null
  propagates regardless of `random()`'s value), so `((null + random()) is not null)` folds to false →
  the materialize is **skipped**. This is **sound** (an absent row's `c` is null, so `c + random()`
  is null — nothing would materialize anyway), and observably accept either way, so no test
  contradicts it. I therefore used a **bound parameter** (`coalesce(c1, :x)`) for the conservative-arm
  test, which genuinely throws at fold time and reliably exercises the emit path. A pure volatile with
  no column ref (`set c = random()`) folds to a non-null value → emit (correct). Worth the reviewer
  confirming they're comfortable with volatile/null-propagating self-values skipping rather than
  emitting — it is sound but is a (benign) behavior shift from the always-emit code.
- **Plan-time evaluation side effects.** `foldsConstantFalse` runs the engine over the
  column-ref-free filter once at plan-build. For a `random()`-bearing self it consumes randomness at
  plan time (harmless; the decision is baked into the plan). Self cells cannot embed subqueries (the
  classifier rejects them before a cell forms) and the filter has no column refs, so no table scans
  occur during folding.
- **Plan caching + parameters.** The dead-check runs once at build; for a parameterized self value
  the materialize is always emitted (conservative) regardless of the bound value, and the runtime
  non-empty filter handles per-row liveness. Confirm this matches expectations for prepared-statement
  reuse.
- **NOT-NULL-no-default sibling arm is covered transitively, not directly.** No `M_def`-style fixture
  has a NOT-NULL-no-default *value* sibling, so the "missing-not-null gate also skipped in the dead
  case" claim is exercised only via the shared guard (both gates live behind the same
  `buildSelfMaterializeInsertSelect` call). The null→non-null variant still rejects via
  `assertNoMissingNotNull` on the live path. A reviewer wanting belt-and-suspenders could add a
  fixture with a NOT-NULL-no-default value sibling.
- **`foldsConstantFalse` Promise handling.** A Promise return is treated as not-provably-dead
  (`=== false` is false → emit). For the `is not null` OR-chain over constants the fold is always
  synchronous, so this is defensive only; an async/non-constant fold would not be awaited (no floating
  rejection in practice because the filter is constant).

## Suggested review focus

1. Soundness of skipping `assertNoMissingNotNull` alongside the widen gate in the dead case (the
   ticket argues both are proxies for a materialized-row violation; confirm there is no plan-time
   obligation that must fire even when nothing materializes).
2. The `foldsConstantFalse` truthiness check (`false`/`0`/`0n`) vs. what the runtime actually returns
   for the `is not null` OR-chain (verified: boolean `false`; `OR` of two `false` → boolean `false`).
3. Whether the volatile/`random()` skip behavior (sound but a shift from always-emit) is acceptable,
   and whether the conservative-arm should also assert a `random()` case (currently parameter-only).
