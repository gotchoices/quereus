description: When a table has a column and a per-statement context value with the same name, a CHECK on that name governs the context value, but the query optimizer treated it as a fact about the column and queries silently missed stored rows. The optimizer no longer draws column facts from CHECKs that read context values; this needs a review pass.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts  # getCheckExtraction, extractCheckConstraints, walkConjunction, containsContextVariableRef, readsContextVariable, isRowInvariantCheck doc
  - packages/quereus/src/planner/analysis/predicate-shape.ts  # columnIndexFromExpr doc only
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 27
  - docs/optimizer-fd.md  # "Check-derived contributions", row-invariant gate
repro: verified
----

## What changed

`walkConjunction` now skips any AND-conjunct that reads a declared context variable, next to the `old.` screen and for the same reason. Sibling conjuncts with no variable still extract. `getCheckExtraction` supplies the lower-cased names from `tableSchema.mutationContext`, so `getTrustedCheckExtraction` consumers (`TableReferenceNode`, `lens-prover`) are covered. `assertion-hoist-cache.ts` passes nothing, because a hoisted assertion has no context.

## Deviation from the implement ticket

The ticket said `<table>.<name>` stays extractable because it always reaches the column. Measurement showed it does not: enforcement strips `t.who` to the bare form, which the variable captures. With `check (t.who > 0)`, `with context who = 5 values (1, -1)` is accepted and `with context who = -5 values (2, 5)` is rejected. Exempting that spelling would have left the reported wrong result in place for it.

So the screen covers every spelling of a declared name except `new.<name>` with no schema qualifier. A `context.<name>` whose name is not declared still extracts, so a table literally named `context` keeps those facts (measured: `context.v > 0` still folds).

## Use cases to check

Each measured before and after on `dist`, memory module, with column and variable both named `who` unless noted:

| CHECK | Row or query | Before | After |
|---|---|---|---|
| `who > 0` | row `who = -1`, `where who <= 0` | `[]` | row returned |
| `context.who > 0` | same | `[]` | row returned |
| `t.who > 0`, `main.t.who > 0` | same | `[]` | row returned |
| `who > 0`, variable NOT NULL, `with context who = 5` | same | `[]` | row returned |
| `a = b + who`, no column named `who` | `group by b, a` over rows `(a=2,b=1)`, `(a=3,b=1)` | one group, `c = 2` | two groups |
| same | `order by b, a desc` | ascending `a` | descending `a` |
| `new.who > 0` | plan of `where who <= 0` | EmptyRelation | EmptyRelation |
| `who > 0 and b > 0` | plan of `where b <= 0` | EmptyRelation | EmptyRelation |

The `a = b + who` rows are a case the ticket did not list: a variable sharing no column's name still produced a false dependency, and that gave wrong results.

## Tests

Added to `46-mutation-context.sqllogic` as Test 27. No spec was added.

- `FactBare`: the ticket's reproduction, a bare name.
- `FactQual`: the `context.` spelling.
- `FactSelf`: the self-qualified spelling, which pins the deviation above.
- `FactSupplied`: a NOT NULL variable with a supplied value.
- `FactFree`: a variable with no same-named column does not yield a false dependency.
- `FactKept`: `new.who` and a sibling conjunct still fold, so the screen does not simply disable extraction on these tables.

`FactBare` failed before the fix. Because the logic runner stops at a file's first failure, the other cases' before-state comes from the measurement script behind the table above.

`declarative-equivalence.spec.ts` ("table-level named CHECK with subquery") caught a crash in my first version: the walk also visits result columns of `in (select …)`, which share `type: 'column'` but have no `name`. That is the reason for the `typeof ref.name` guard.

## Validation

- `yarn workspace @quereus/quereus run lint`: passes.
- `yarn workspace @quereus/quereus run test`: 11047 passing, 26 pending. That run came before a final comment-only edit; lint and the focused specs were rerun after it (141 passing).
- `yarn test:store --grep "46-mutation-context"`: passes. The rest of the store leg was not run.

## Known gaps

- **A table literally named `new` still gives the wrong result.** `check (new.who > 0)` there reads the variable, because the strip treats `new` as the table's own name, yet the fact is still lifted. It is parked with a `NOTE:` in `readsContextVariable` and described in `bug-self-qualified-check-reads-context-variable`. Handling it here would mean passing the table name into the screen for a contrived case whose cause is in the strip.
- **What `t.who` should mean is undecided.** Today it reads the variable, and the documentation is silent. Proposed text is in `tickets/blocked/bug-self-qualified-check-reads-context-variable.md`.
- **Doc claims left for the next ticket.** `storedRowPredicate` and `validateRowInvariantChecksOverExistingRows` still say validated equals lifted; `bug-alter-check-validation-cannot-reference-mutation-context` owns those. The direction is safe: after this change, the scan can validate more than is lifted, never less.
- **ALTER reads a shadowed name differently from writes until that ticket lands.** The existing-row scan still reads a bare `who` as the column. This no longer risks a wrong result, because nothing is lifted from such a conjunct.

## Other tickets touched

- `debt-ast-result-column-shares-column-tag`: added confirmed evidence. A CHECK with `in (select …)` nested under a comparison makes every statement on the table fail with a `TypeError`. This predates this ticket and was not fixed here.
- `bug-alter-check-validation-cannot-reference-mutation-context`: added a note on the `t.who` measurement, the test number, and which doc claims are already corrected.
- `bug-self-qualified-check-reads-context-variable`: new, in `blocked/`.
