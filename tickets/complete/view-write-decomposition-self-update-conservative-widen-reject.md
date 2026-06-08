description: Recover the null-propagating partial self-update on an optional decomposition member. Two unconditional materialize soundness gates had regressed the matched-update-only self path into a plan-time reject; the implementation folds the materialize's null-substituted non-empty filter at plan time and, when it folds constant-false (no absent row can ever materialize), skips the materialize INSERT and both gates with it — degrading to present-rows-only. A genuinely-materializing self-update still emits and runs the gates. Review hardened `foldsConstantFalse` with a determinism gate so a volatile/non-deterministic self value can no longer be unsoundly proven dead.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate hasSelf branch, buildSelfMaterializeInsertSelect, selfMaterializeNonEmptyFilter, foldsConstantFalse + new determinism gate, imports), packages/quereus/test/lens-put-fanout.spec.ts (self-update arms + new non-deterministic-UDF arm), docs/lens.md (§ UPDATE), docs/view-updateability.md (§ Still deferred (LEFT))
----

## What shipped (implement stage)

`emitOptionalMemberUpdate`'s `hasSelf` branch previously emitted, unconditionally, a matched UPDATE
**plus** `buildSelfMaterializeInsertSelect` (the absent-row materialize INSERT), whose two
data-independent plan-time soundness gates (`assertNoUnassignedValueColumnWiden`,
`assertNoMissingNotNull`) fired before the runtime non-empty filter was consulted. A null-propagating
partial self-update (`set e1 = e1 + 1` on a member whose sibling `e2 default 7`) was therefore
**rejected at plan time** even though its materialize filter `((null + 1) is not null)` is
constant-false and guarantees no absent row materializes — a regression vs. the pre-materialize self
path (which accepted, present-rows-only).

The fix decides statically whether the materialize is **dead**:

- `selfMaterializeNonEmptyFilter(cells, member)` extracted as the shared null-substituted
  `is not null` OR-chain (used both as the emitted INSERT's WHERE — conjoined with the user predicate
  — and as the dead-check input, so the two can't drift).
- `foldsConstantFalse(ctx, expr)` builds the filter via the engine's own `buildExpression` and folds
  it through `createRuntimeExpressionEvaluator(ctx.db)`, returning `true` only on a boolean `false`
  (defensively `0`/`0n`). A non-null fold, a Promise, or a throw ⇒ `false` (conservative).
- The `hasSelf` branch emits the matched UPDATE unconditionally and emits the materialize INSERT
  (and therefore both gates) **only when** the filter does not fold constant-false. Skipping a dead
  materialize takes both gates with it — sound, since a gate is only a plan-time proxy for "a
  materialized row would violate" and no row materializes.

## Review findings

Reviewed the implement diff (7ca7fb7a) with fresh eyes, then the surrounding decomposition substrate
(value classification, the two gates, `substituteOwnerColumnsWithNull`, the const-evaluator, and the
parameter-reference emitter), the docs the change touched, and ran build + lint + the full suite.

### Major — one fixed inline (was latent silent-data-loss), none filed

- **`foldsConstantFalse` could unsoundly prove a *volatile* materialize dead → silent dropped row
  (FIXED inline).** The `hasSelf` branch's own comment already claimed "a non-foldable / volatile /
  parameterized value cannot be proven dead, so it stays live (emit + gate)", but the code did not
  enforce it for volatiles. The value classifier admits any non-column-ref (including function calls)
  into a `self` cell, so `set c = coalesce(c, vfn())` with `vfn` a non-deterministic UDF classifies
  as `self`. After null-substitution the dead-check folds `coalesce(null, vfn())` by evaluating
  `vfn()` **once** at plan time; a nullable volatile reading null at plan time but non-null per row at
  runtime would fold constant-false → skip the materialize → drop an absent row the always-emit path
  would have created. A single plan-time fold is an unsound proxy for the per-row runtime filter.
  This also contradicted the ticket's edge-case note, which lists `set c = c + random()` as an
  **emit** case, not a skip. **Fix:** `foldsConstantFalse` now short-circuits to `false` (stay live)
  when `containsNonDeterministicCall(expr, isDeterministic)` is true, sourcing determinism from the
  function registry (`ctx.schemaManager.findFunction` + `FunctionFlags.DETERMINISTIC`, unknown ⇒
  deterministic — matching the engine's other determinism gates in `check-extraction.ts` /
  `rule-materialized-view-rewrite.ts`). Reuses existing infrastructure; no hand-rolled volatility
  walk. Closes the unsound-skip class by construction and realigns the `random()` edge-case onto the
  emit path. The two markdown docs were updated to state non-deterministic values stay live.

  *Why inline (not a filed ticket):* a two-line guard over an existing helper, no API/behavior change
  to any case the suite already covered (the dead-skip cases are function-free; coalesce/deterministic
  cases already emit), build + lint + full suite green after.

### Soundness checks that held (no change needed)

- **Skipping `assertNoMissingNotNull` alongside the widen gate (review focus #1).** Both gates are
  plan-time proxies for a materialized-row violation; with no INSERT emitted, no row materializes, so
  neither obligation can be tripped. The matched UPDATE inserts nothing. The null→non-null live path
  still runs both gates. Sound.
- **Dead-check omits the user predicate.** `pred AND false = false`, so folding the non-empty filter
  alone is sound — the predicate only narrows liveness further.
- **`foldsConstantFalse` truthiness (review focus #2).** Verified the `is not null` OR-chain returns
  boolean `false` for a dead materialize (`OR` of `false`/`false` → `false`); the `0`/`0n` arms are
  defensive only.
- **Unbound-parameter linchpin.** `emitParameterReference` throws (`StatusCode.NOTFOUND`/`RANGE`) when
  a key is absent, and `createRuntimeExpressionEvaluator` evaluates with `params: {}`, so a
  parameterized self value reliably throws at fold time ⇒ conservative emit. Confirmed by the existing
  `coalesce(c1, :x)` arm (the parameter is not a function, so the new determinism gate does not catch
  it — the throw path still carries it).
- **`reduce` without seed in `selfMaterializeNonEmptyFilter`.** Safe — `hasSelf` implies ≥1 cell; same
  pattern as the pre-refactor code.
- **EAV path unaffected.** `foldsConstantFalse` is only reached from the optional `hasSelf` branch; an
  EAV self lowers to a subquery and lands `arbitrary` (rejected) before a cell forms.

### Tests

- Existing arms reviewed and re-run: the flipped-to-accept null-prop arm (`e1 + 1`), the
  still-rejects live arm (`coalesce(e1,0)+1`), the parameterized conservative arm (`coalesce(c1,:x)`),
  and the single-column `T_c` `set c = c + 1` skip. All green.
- **Added** `lens-put-fanout.spec.ts` arm: a registry-non-deterministic UDF self value
  (`set c1 = coalesce(c1, vol9())`) materializes the absent row via the emit path — a volatile-in-a-
  self-cell case the deterministic and parameterized arms didn't cover.
- **Honest test gap (not filed):** the determinism guard's *distinguishing* behavioral change is the
  null-at-plan / non-null-at-runtime volatile, which is inherently stateful and not robustly
  unit-testable without coupling to evaluation order / `coalesce` short-circuit internals (the new
  `vol9` arm returns non-null and so folds the same way with or without the guard — it locks the
  emit-path contract, not the fold decision). The guard eliminates the unsound class by construction;
  a robust isolating test would require a stateful UDF whose call count across the matched-UPDATE and
  materialize ops is engine-defined. Left uncovered deliberately rather than ship a brittle test.
- **NOT-NULL-no-default *value* sibling** is still covered only transitively (both gates share the one
  `buildSelfMaterializeInsertSelect` call; no `M_def`-style fixture has a NOT-NULL-no-default value
  sibling). Belt-and-suspenders, not required for soundness — the null→non-null path still rejects via
  `assertNoMissingNotNull`. Not filed.

### Minor noted, not actioned

- **Plan-time evaluation side effects.** `foldsConstantFalse` runs `buildExpression` +
  the runtime over the column-ref-free filter once at plan-build. With the determinism gate in place,
  a `random()`/volatile self no longer reaches the evaluator at all (short-circuited), so the only
  plan-time evaluation is over deterministic constants — no randomness consumed, no scans (self cells
  cannot embed subqueries). The earlier concern about plan-time randomness consumption is moot.

### Validation

`yarn build` (full monorepo) ✓ · `eslint src/planner/mutation/decomposition.ts` ✓ ·
`yarn workspace @quereus/quereus test` → **5270 passing, 9 pending, 0 failing** (was 5269; +1 from the
new non-deterministic arm).
