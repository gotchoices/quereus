description: Alias-shadow-aware consumer-rewrite descent in the multi-level CTE-body flattener — a nested subquery that re-binds the inner CTE's source name as a LOCAL FROM alias is no longer wrongly rewritten to the outer inner-CTE's defining expression (silent-wrong fix). Reviewed and completed.
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts          # composeBody descend + makeSubstitutions (the fix)
  - packages/quereus/src/planner/mutation/scope-transform.ts      # transformAliasScopedQuery exported, default aliasShadow param
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # 5 regressions at ~L3279 (4 from implement + 1 compound-leg added in review)
  - docs/view-updateability.md                                    # multi-level CTE body section — alias-shadow note
---

# Multi-level CTE flatten — nested-subquery alias shadowing of the inner source name

## Summary

`composeBody` (`cte-flatten.ts`) collapses a single-source projection-and-filter
consumer by substituting each reference to the inner sibling-CTE source with the
inner's defining expression. The descent into the consumer's subquery operands was
not scope-aware (`mapQueryExprUniform` applies the substitution at every nesting
depth), so a `sourceName.`-qualified column inside a nested subquery that re-bound
that same name as a *local* FROM alias was silently rewritten to the inner CTE's
defining term — wrong by innermost-scope SQL rules, no error.

The fix swaps the descent to scope-transform's shared `transformAliasScopedQuery`
(now `export`ed, `aliasShadow` defaulting to `NO_ALIAS_SHADOW`) and gates
`nestedSubst` with `&& !aliasShadow.has(lcSource)`, so substitution stops once a
nested FROM alias shadows the source name. The top consumer scope is deliberately
NOT routed through the alias descent — its own single FROM source *is* `sourceName`
(the thing being substituted away), so the alias set begins empty and only a nested
re-bind shadows.

## Review findings

### Checked

- **Fresh read of the implement diff** (`8917494`) — `cte-flatten.ts`,
  `scope-transform.ts`, docs, and tests, before consulting the handoff.
- **Alias-shadow threading correctness** — traced all four implement cases plus my
  added compound-leg case against the scope rules in `transformAliasScopedQuery`:
  a select's own FROM aliases join the set for its clauses (`sub`) and nested
  subqueries (`onNested`); a compound/union leg keeps the *incoming* set (`onLeg`,
  not the leg's siblings' FROM); VALUES threads the set unchanged; a DML…RETURNING
  operand clones through. All consistent with SQL innermost-scope binding.
- **Top-scope routing** — confirmed the consumer body's own FROM source (`sourceName`)
  correctly never counts as a shadow (top scope goes through
  `transformExpr(e, topSubst, descend)` with `descend` starting at empty alias set).
- **Guard is load-bearing** — temporarily dropped `&& !aliasShadow.has(lcSource)`;
  the primary repro (`nbase`/`nother`) failed with the exact pre-fix wrong answer
  (`{"id":1,"color":"red"}`). Restored and re-ran green.
- **No missed sibling sites** — audited the other `mapQueryExprUniform` substitution
  callers: `forEachColumnRefDeep` (pure observer, always returns `undefined`) and
  `substituteNewRefs` (`new.`-qualified, a reserved qualifier no FROM source shadows)
  are correctly scope-insensitive; neither needed the fix. `cloneQueryExpr` is a no-op.
- **Type safety / DRY** — `nestedSubst` widened to the two-arg `(col, aliasShadow)`
  shape; `topSubst` correctly kept single-arg to match `transformExpr`'s one-arg
  `substitute(col)` call. The strip path (`innerColumns === null`) split into
  `stripTop`/`stripNested` mirrors the map path cleanly. Reuse of the shared
  `transformAliasScopedQuery` (same descent the cross-source SET strip and self-read
  capture use) is good DRY; the `NO_ALIAS_SHADOW` default preserves the existing
  `transformAliasScopedExpr` caller with no behavior change.
- **Docs** — the `docs/view-updateability.md` multi-level CTE paragraph was updated
  to describe the alias-shadow-aware descent and reflects the new reality.
- **Lint + full suite** — `yarn workspace @quereus/quereus lint` clean;
  `yarn workspace @quereus/quereus test` 6231 passing / 9 pending.

### Found & done (minor — fixed inline)

- **Added a compound/union-leg regression** (`lbase`/`lother2`, ~L3339 of
  `93.4-view-mutation.sqllogic`) — the handoff flagged the leg path (`onLeg`) as
  asserted-by-reading-only. The new case re-binds the inner source name inside a
  UNION leg of a nested EXISTS (`… union select 1 from lother2 x where x.note='red'`)
  so the leg's `x.note` must stay local; it exercises that a leg's own FROM aliases
  shadow *within* that leg. Passes; routes through the identical `nestedSubst` guard.

### Considered & dismissed (not regressions of this fix)

- **Bare correlated reference to a renamed column inside a nested subquery** — e.g.
  a substituted bare inner term (`x.note`→`color`) that an inner FROM re-captures
  (case 2's `cbase`/`cother`). This is pre-existing behavior: `nestedSubst` is
  qualified-only and predates this fix (the prior `mapQueryExprUniform` path was
  identically qualified-only). Out of scope per the ticket; not introduced here.
- **`in (values …)` / DML…RETURNING operands inside the consumer** — structurally
  handled by `transformAliasScopedQuery`'s `values`/DML branches, which are already
  exercised by the cross-source SET-strip suite that shares the descent. Judged a
  separate test low-value; not added.

### No new tickets

No major findings. The fix is a narrowly-scoped, correct AST-composition change with
no plan-shape or diagnostic changes; `analyzeView` and everything downstream run
unchanged on the flattened body. No `test/plan` golden updates needed or made.

### Pre-existing failures

None. Suite was green before and after; the only intentional red was the temporary
guard-removal probe (reverted).
