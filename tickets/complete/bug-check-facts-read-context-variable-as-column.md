description: When a table has a column and a per-statement context value with the same name, a CHECK on that name governs the context value, but the query optimizer treated it as a fact about the column and queries silently missed stored rows. The optimizer no longer draws column facts from CHECKs that read context values, and the review also fixed a tree walk that hid anything inside a CASE from these checks.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts  # getCheckExtraction, extractCheckConstraints, walkConjunction, containsContextVariableRef, readsContextVariable, isRowInvariantCheck doc
  - packages/quereus/src/planner/analysis/predicate-shape.ts  # walkAstNodes (review fix), columnIndexFromExpr doc
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 27
  - packages/quereus/test/logic/40.2-check-extras.sqllogic  # CASE arm dependency
  - docs/optimizer-fd.md  # "Check-derived contributions", row-invariant gate
repro: verified
----

## What was built

`walkConjunction` skips any AND-conjunct that reads a declared context variable, next to the `old.` screen and for the same reason. Sibling conjuncts with no variable still extract. `getCheckExtraction` supplies the lower-cased names from `tableSchema.mutationContext`, so `getTrustedCheckExtraction` consumers (`TableReferenceNode`, `lens-prover`) are covered. `assertion-hoist-cache.ts` passes nothing, because a hoisted assertion has no context.

The screen covers every spelling of a declared name except `new.<name>` with no schema qualifier. That includes the self-qualified `t.who`, because enforcement strips it to the bare form, which the variable captures. A `context.<name>` whose name is not declared still extracts, so a table literally named `context` keeps those facts.

## Review findings

Read the diff of `ticket(implement): bug-check-facts-read-context-variable-as-column` first, then measured against `dist` on the memory module.

**Fixed in this pass**

- **Real defect, the screen could not see inside a CASE.** `walkAstNodes` only descended into children carrying a `type`, and a CASE's when/then pairs have none. So `check (a = case when who > 0 then b else b + 1 end)` still produced `b → a`, and `group by b, a` merged two distinct rows into one group. The same gap gave the same wrong result with `who` in a THEN arm, with `old.c` in a WHEN arm, and with no context at all: `check (a = case when c > 0 then b else b + 1 end)` over a plain column. All four were measured wrong before the fix and correct after. The cause was the one site, so I fixed the walker rather than the screen: it now passes through untyped containers, skips `loc`, and ignores non-plain objects such as a blob's `Uint8Array`. This also makes the walker's other consumers see those positions: the collation gate, the non-determinism screen, `captureBodyFunctions` and `mentionsSelectListAlias`. Each only becomes more conservative or more accurate. `OrderByClause` is untyped too, so `captureBodyFunctions`'s doc comment claiming ORDER BY coverage was false until now.
- **Tests.** Added `FactCase` to Test 27 and `case_fd` to `40.2-check-extras.sqllogic`, one for this ticket's screen and one for the plain-column false dependency. Cut `FactSupplied`: the screen never looks at nullability or a supplied value, so it ran the same path as `FactBare`.
- **Docs.** Added "a CASE arm" to the list of positions in `docs/optimizer-fd.md`, and rewrote the `walkAstNodes` doc comment.

**Major, recorded on an existing ticket**

- **A column rename brings back this ticket's wrong result.** After `alter table t rename column who to w`, the stored CHECK becomes `w > 0`, the fact lifts again, and `select * from t where w <= 0` misses a stored row with `w = -1`. The cause is in the column-rename walker, not in this screen. `bug-column-rename-rewrites-check-read-of-context-variable` already owns that site, so I appended the measurement there, along with the DEFAULT case (`Column not found: w` on the next insert) and the opposite direction (renaming `x` to `who` makes the CHECK stop constraining the column). That ticket sits in `backlog/` and a maintainer may want to promote it, because this is a wrong result reachable through ordinary DDL.

**Known gaps, confirmed and left where they are parked**

- **Table literally named `new`.** Measured still wrong: `select * from "new" where who <= 0` returns `[]`. Parked by a `NOTE:` in `readsContextVariable` and described in `bug-self-qualified-check-reads-context-variable` (`blocked/`).
- **False refusal of `drop column who`** when only a bare variable read mentions it. Measured; a safe refusal, already an arm of the rename ticket.
- **ALTER's existing-row scan reads a shadowed name as the column.** Owned by `bug-alter-check-validation-cannot-reference-mutation-context`, which is in `implement/`. Direction is safe: the scan can validate more than is lifted, never less.

**Checked, nothing found**

- Spellings: inline column CHECK, mixed case and quoted names, `between`, `in`, `or`, `main.context.who`. All return the stored row or reject the write correctly.
- `add column who` on a table whose CHECK already reads the variable `who`: no fact, and the row is returned.
- Sibling and `new.` facts still fold, including a variable-free CHECK added by ALTER on a context table.
- Other consumers of CHECK expressions: `buildLogicalConstraints` and `write-site-analysis` draw no facts. `buildLogicalTableSchema` carries no context, so a logical table's bare names are columns. `mutationContext` is set in only one schema builder and carried by spreads.
- A hoisted assertion on a same-named column correctly still folds, since it has no context.
- A subquery conjunct already contributes no facts, because `containsNonDeterministicCall` rejects it.

**Considered and declined**

- The `new Set(mutationContext.map(…))` line now appears at three sites, here, in `insert.ts` and in `mutation-context.ts`. It is one line, and sharing it would make `planner/analysis` import from `planner/building`, so I left it.
- The `identifier` arm of `readsContextVariable` is reached in parsed SQL only by a table name inside a subquery. I kept it because `columnIndexFromExpr` resolves the same node shape, so the two stay symmetric.

**Categories with nothing to report**

- Resource cleanup: the change allocates only a cached per-schema set.
- Performance: extraction is cached per schema, and the walker now also visits small untyped containers. Not measured beyond the suite's wall-clock.
- Tripwires: no new `NOTE:` was added. The conditional concerns above already have a home.

## Validation

- `yarn workspace @quereus/quereus run lint`: passes.
- `yarn workspace @quereus/quereus run test`: 11047 passing, 26 pending.
- `yarn test:store --grep "46-mutation-context|40.2-check-extras"`: passes. The rest of the store leg was not run.
- `@quereus/store` tests: 1986 passing. `@quereus/isolation` tests: 451 passing.
- **Not run to completion:** the remaining workspace packages (sync and the others). A sweep across them hit the 10-minute tool limit and I stopped it, with no result either way.
