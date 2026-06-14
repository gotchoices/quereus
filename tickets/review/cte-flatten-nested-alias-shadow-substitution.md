description: Review the alias-shadow-aware consumer-rewrite descent in the multi-level CTE-body flattener — a nested subquery that re-binds the inner CTE's source name as a LOCAL FROM alias must no longer be wrongly rewritten to the outer inner-CTE's defining expression (silent-wrong fix).
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts          # composeBody descend + makeSubstitutions (the fix)
  - packages/quereus/src/planner/mutation/scope-transform.ts      # transformAliasScopedQuery now exported, default aliasShadow param
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # 4 new regressions at ~L3279
  - docs/view-updateability.md                                    # multi-level CTE body section — alias-shadow note
---

# Review: multi-level CTE flatten — nested-subquery alias shadowing of the inner source name

## What was wrong (and is now fixed)

`composeBody` (`cte-flatten.ts`) collapses a single-source projection-and-filter
consumer by substituting each reference to the inner sibling-CTE source with the
inner's defining expression. The descent into the consumer's subquery operands
was **not scope-aware** — it used `mapQueryExprUniform`, which applies the
`nestedSubst` substitution at *every* nesting depth. So a column qualified by the
inner source's name was rewritten to the inner CTE's defining expression **even
when a nested subquery had re-bound that same name as a local FROM alias**. By
innermost-scope SQL rules the qualified column is local to that subquery, so the
rewrite was silently wrong — no error, wrong result.

### The fix (3 edits + tests + docs)

1. **`scope-transform.ts`** — `transformAliasScopedQuery` (the FROM-alias-shadow
   descent that already backs the cross-source SET-value strip and mirrors the
   self-read capture's alias threading) is now `export`ed and its `aliasShadow`
   param defaults to `NO_ALIAS_SHADOW`. No behavior change to existing callers
   (`transformAliasScopedExpr` already passed the arg explicitly).

2. **`cte-flatten.ts` / `composeBody`** — the descent swapped from
   `mapQueryExprUniform(q, nestedSubst)` to `transformAliasScopedQuery(q, nestedSubst)`.
   The top consumer scope is deliberately **not** routed through the alias descent
   (it goes through `transformExpr(e, topSubst, descend)`), so the consumer body's
   OWN single FROM source — which *is* `sourceName`, the thing being substituted
   away — never counts as a shadow. Alias accumulation begins empty and only a
   *nested* FROM alias ever shadows `sourceName`.

3. **`cte-flatten.ts` / `makeSubstitutions`** — `nestedSubst` now takes the
   alias-shadow set and stops firing once `lcSource` is shadowed
   (`&& !aliasShadow.has(lcSource)`). The strip path (identity `select *` inner,
   `innerColumns === null`) was split: `topSubst` stays a single-arg qualified-only
   strip; `nestedSubst` is a two-arg shadow-aware strip. `topSubst` keeps its
   single-arg signature because `transformExpr` calls `substitute(col)` with one arg.

## How to validate

Primary gate is the logic suite. The 4 new regressions sit in
`test/logic/93.4-view-mutation.sqllogic` right after the `base2` self-name shadow
case (~L3279):

- Run just this file: `yarn workspace @quereus/quereus test --grep "93.4-view-mutation"`
- Full suite: `yarn workspace @quereus/quereus test` (6231 passing, 9 pending at handoff)
- Lint + test typecheck: `yarn workspace @quereus/quereus lint` (clean at handoff)

### The four new cases (what each one guards)

1. **The bug repro (`nbase`/`nother`)** — `from nother x` re-binds the inner
   source `x`; `x.note` there must stay local → EXISTS sees `nother.note='red'`
   (true) → write fires → `[{"id":1,"color":"z"}]`. **Verified to be a true
   regression**: I temporarily removed the `&& !aliasShadow.has(lcSource)` guard
   and this case failed with the exact pre-fix wrong answer
   (`{"id":1,"color":"red"}`), then restored the guard and re-ran green.

2. **Over-suppression guard (`cbase`/`cother`)** — a *genuine* correlation: the
   nested subquery does NOT re-bind `x`, so `x.note` must STILL substitute to the
   inner base term. This catches the symmetric over-suppression failure mode (if
   `nestedSubst` wrongly suppressed whenever *any* alias was present, `x.note`
   would become an unresolvable reference after the FROM re-point and error).

3. **Identity-strip benign pin (`idbase`/`idother`)** — `select *` inner, no
   rename (`innerColumns === null`). A nested re-bind resolves to the same local
   column either way; pins the "no behavior change" claim for the strip path.

4. **Deeper nesting (`nd_base`/`nd_mid`/`nd_inner`)** — the re-bind is TWO
   subquery levels down; exercises downward alias-set accumulation *through
   `composeBody`'s descend specifically* (the existing self-read suite exercises
   the parallel `transformScopedQuery` path, not `transformAliasScopedQuery`).

## Known gaps / where to push as a reviewer

- **Edge cases asserted by reading, not by test.** The ticket called out a few
  cases that "fall out" of reusing the shared `transformAliasScopedQuery` descent
  but were left as optional tests — I did NOT add explicit coverage for them:
  - a **compound / union leg inside a nested subquery** (a leg keeps the *incoming*
    alias set via `onLeg`, not the select's own FROM aliases — so a re-bind in an
    enclosing FROM shadows, a sibling leg's FROM does not);
  - a **`in (values …)` / embedded DML … RETURNING operand** inside the consumer
    (VALUES threads the alias set; DML clones through structurally — byte-identical
    to the old `mapQueryExprUniform` path). A reviewer wanting belt-and-suspenders
    could add one of each near the new block.

- **Case 2 (`cbase`) caveat.** Its final result is the same before and after the
  fix (it's an over-suppression guard, not a primary regression). The bare-`color`
  inner term it substitutes binds innermost (to `cother.color`) by pre-existing
  bare-name-correlation behavior — *out of scope for this fix* per the ticket
  ("nestedSubst is qualified-only; a bare correlated reference to the consumer
  source inside a nested subquery is pre-existing behavior"). If a reviewer wants
  case 2 to also pin a value that *differs* pre/post-fix, it would need a redesign;
  as written it guards the unresolvable-reference regression, which is real.

- **Case 3 (`idbase`) is a weak pin.** Both old and new strip paths yield `z`, so
  it mainly guards against the strip-path closure split regressing structurally,
  not a value divergence. Documented as benign-by-design.

- **No new diagnostics / no plan-shape changes.** This is a pure AST-composition
  correctness fix; `analyzeView` and everything downstream run unchanged on the
  flattened body. No `test/plan` golden updates were needed and none were made.

## Pre-existing failures

None observed. Full suite was green before and after; the only intentional red
was my temporary guard-removal probe (reverted).
