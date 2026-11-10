---
description: Adding a text-comparison rule to a sort that refers to a column by its number — like "sort by column 2, ignoring letter case" — used to silently stop sorting. It now sorts that column with the requested rule applied, the way SQLite does; review the fix.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts   # all code changes
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # new `nc` table block after the `nk` alias-shadow cases
repro: verified
---

# Review: `order by 2 collate nocase` now sorts by column 2

## What changed

All code is in `select-ordinal.ts`; no caller changed.

- `parseOrdinalTerm` peels any number of `collate` wrappers off an ORDER BY / GROUP BY term, then asks `extractOrdinalValue` whether the inner expression is an integer literal (optionally signed). It returns the position plus the **outermost** wrapper (the one that takes effect, as with nested `CollateNode`s and SQLite's `sqlite3ExprCollSeq`).
- `resolveOrdinalReference` keeps its old signature (it is used by `orderByNeedsPostAggregateSort`) and delegates to a new private `resolveOrdinalTerm`, which also returns the wrapper. `buildOrdinalAwareExpression` uses `resolveOrdinalTerm` and wraps whatever it resolved to (source-attribute reference or re-planned entry expression).
- `resolveOrdinalOutputColumn` now returns `ScalarPlanNode | null` (was `ColumnReferenceNode | null`) and wraps its column reference. Both callers (`applyOrderBy`, `applyOuterOrderBy`) only use it as a sort-key expression; type-check passed with no edits there.
- The two copies of the out-of-range error became `assertOrdinalInRange`. Out-of-range positions under a wrapper now raise it (`order by 5 collate nocase` → `ORDER BY position 5 is not in the SELECT list (1..1)`), matching SQLite.
- `applyOrdinalCollate` does the wrapping. JSDoc on the three affected functions now mentions the collate suffix.

### Where this departs from the fix ticket

The fix ticket suggested building the `CollateNode` from the user's own AST wrapper so plan output shows what the user wrote. I did **not** do that. `applyOrdinalCollate` builds a new AST, `<resolved column's expression> collate <name>`, instead. The reason: grouped-query coverage (`findUngroupedColumnRef` / `buildGroupByCoverage`) and post-aggregate redirection (`redirectToGroupKeys` rule 1) match expressions by AST fingerprint (`expressionToIdentityString`). The user's wrapper fingerprints as `1 collate nocase`, which is the constant 1, not column 1. With the new AST, the grouping key from `group by 1 collate nocase` has the same fingerprint as the one from `group by a collate nocase`. Side effect: plan output shows `a collate nocase` rather than `1 collate nocase`. The existing ordinal `ColumnReferenceNode` already shows the column name rather than the number, so this is consistent.

### The double-wrapper case (checked, not assumed)

`select a collate nocase k, count(*) c from t group by 1 collate nocase` would build the key `CollateNode(nocase, CollateNode(nocase, a))`, whose fingerprint `a collate nocase collate nocase` does not cover the SELECT-list column `a collate nocase`. I confirmed this: with the skip disabled, the query fails with `Column 'a' must appear in the GROUP BY clause…`. `applyOrdinalCollate` therefore returns the operand unchanged when its type already has `collationSource === 'explicit'` and the same collation name (compared case-insensitively). With the skip, the ordinal and named forms give the same result (`A`/2, `B`/1, `c`/1).

## Behaviour checked by hand (ad-hoc probe, not committed)

Data `('a','1'), ('B','9'), ('c','5'), ('A','3')`:

- `select a, count(*) from t group by 1 collate nocase` raises the same coverage error as `group by a collate nocase`, which is the expected behaviour (the ticket's GROUP BY note explains why).
- `order by (1 collate binary) collate nocase` sorts nocase; `order by (1 collate nocase) collate binary` sorts binary, so the outermost wrapper wins. (A bare `1 collate binary collate nocase` doesn't parse in Quereus, so the nesting can only be written with parentheses.)
- `select a, count(*) from t group by a order by 1 collate nocase desc`: the grouped path with an aligned output sorts correctly.
- `select count(*) c, max(a) m from t order by 2 collate nocase`: the aggregate path where the ordinal targets an aggregate is fine.
- `select * from t order by 1 collate nocase, 2`: a star-expanded column works.
- `… group by 1 collate nocase having k = 'a'` works.

## Tests added (`28.2-orderby-expression-extras.sqllogic`, `nc` block)

Data is `'a','B','c','D'`. Binary order is `B D a c` and nocase order is `a B c D`, so the orders differ and no two values tie under nocase.

- `select a from nc order by 1 collate nocase`: the basic single-SELECT case (`resolveOrdinalOutputColumn`, aligned output).
- `select b as a, a as z from nc order by 2 collate nocase`: alias shadowing combined with collate. It sorts by `z`. Sorting by the alias `a` (= `b`) or by binary `z` would each give a different order.
- `select a from nc union select 'e' order by 1 collate nocase`: the compound path (`applyOuterOrderBy`).
- `select a from nc order by 5 collate nocase`: the prepare-time out-of-range error.
- After inserting `'A'`: `select c, lo from (select a collate nocase k, count(*) c, min(a) lo from nc group by 1 collate nocase) order by lo`. This is the GROUP BY path and the double-wrapper skip: `a`/`A` must be one group of 2. The outer query hides `k`, because which of `a`/`A` represents the group is not pinned.

The ORDER BY cases returned unsorted rows before the fix, as verified in the fix ticket. Before the fix the GROUP BY case grouped by the constant 1, giving one group of 5.

## Validation

- `yarn workspace @quereus/quereus test`: 11135 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` (eslint + test-file type check): clean.
- Store mode (`yarn test:store`) was not run. The change is build-time planning only, with nothing specific to storage.

## Known gaps / things for the reviewer to poke at

- The skip test is type-based: any operand whose type already has the same *explicit* collation is left unwrapped, not just a literal `CollateNode`. That includes, say, a function whose result type propagates an explicit collation. Leaving such an operand unwrapped shouldn't change any comparison, since the collation and its strength are the same, but it is wider than "the operand is a CollateNode".
- A same-named collation that is only *declared* on the column (non-explicit source) still gets wrapped, which upgrades it to explicit. That matches the named form `a collate nocase`.
- No test pins the outermost-wins rule for nested wrappers. It was checked by hand above, and it needs parentheses to write.
