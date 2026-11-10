---
description: Adding a text-comparison rule to a sort that refers to a column by its number — like "sort by column 2, ignoring letter case" — silently stops sorting altogether instead of sorting that column. Make the column number keep working, with the requested comparison rule applied, the way SQLite does.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts   # extractOrdinalValue, resolveOrdinalReference, resolveOrdinalOutputColumn, buildOrdinalAwareExpression
  - packages/quereus/src/planner/building/select-modifiers.ts # applyOrderBy (calls both resolvers)
  - packages/quereus/src/planner/building/select-compound.ts  # applyOuterOrderBy (union/intersect/except)
  - packages/quereus/src/planner/building/select-aggregates.ts # GROUP BY build (line ~135), pre-aggregate sort (~250), orderByNeedsPostAggregateSort (~1446)
  - packages/quereus/src/planner/building/select.ts           # window-path ORDER BY (~277)
  - packages/quereus/src/planner/nodes/scalar.ts              # CollateNode (takes the AST.CollateExpr + operand)
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # existing positional-reference coverage
repro: verified
---

# `order by 2 collate nocase` does not sort

## Behaviour today (verified against `Database.eval`, dist build of current planner source)

Setup: `create table t (a text primary key, b text); insert into t values ('a','1'), ('B','9'), ('c','5'), ('A','3');`

| query | Quereus | SQLite 3 (node:sqlite) |
|---|---|---|
| `select a from t order by 1 collate nocase` | `A B a c` (just the source order — no sort) | `A a B c` |
| `select b as a, a as z from t order by 2 collate nocase` | source order | sorted by `z` nocase: `a A B c` |
| `select a from t union select 'b' order by 1 collate nocase` | `A B a c b` (unsorted) | `A a B b c` |
| `select a from t order by 5 collate nocase` | no error, unsorted | error: `1st ORDER BY term out of range - should be between 1 and 1` |
| `select count(*) c from t group by 1 collate nocase` | one group of 4 (grouped by the constant 1) | groups by column 1 nocase |
| `select a from t order by (1) collate nocase` | — | sorts by column 1 (parentheses don't create an AST node in Quereus either) |

SQLite settles the open question from the fix ticket: its resolver strips `COLLATE` wrappers before testing whether a term is a column number (`sqlite3ExprSkipCollate`), so out-of-range positions error, and the requested collation applies to the resolved column. That is the spec to implement.

## Cause

`extractOrdinalValue` (`select-ordinal.ts`, bottom of file) recognises only `literal` and `unary +/-` over a literal. A `collate` AST node (`{type:'collate', expr, collation}`) around the literal returns null, so every caller falls through to `buildExpression`, which plans `CollateNode(LiteralNode(2))` — a constant sort/group key.

Both resolvers sit on that one function:

- `resolveOrdinalReference` → returns the `SelectListEntry`; consumed by `buildOrdinalAwareExpression` (GROUP BY, pre-aggregate ORDER BY, window-path ORDER BY, the non-aligned fallback in `applyOrderBy`) and by `orderByNeedsPostAggregateSort` (which only inspects `entry.expr`).
- `resolveOrdinalOutputColumn` → returns a `ColumnReferenceNode` over the Nth output attribute; consumed by `applyOrderBy` (aligned output) and `applyOuterOrderBy` (compounds).

## Fix

All in `select-ordinal.ts`; callers should not need changes.

- Add a small helper that peels `collate` wrappers off a term: returns the innermost non-collate expression plus the **outermost** `AST.CollateExpr` (outermost wins, matching how `CollateNode` nesting resolves — the top wrapper's collation is the effective one; SQLite's `sqlite3ExprCollSeq` likewise takes the first COLLATE walking down from the top).
- `extractOrdinalValue` (or its callers) tests the peeled inner expression. Out-of-range positions under a collate wrapper must then raise the existing `... position N is not in the SELECT list` error (SQLite errors here too).
- `resolveOrdinalOutputColumn`: after building the `ColumnReferenceNode`, if a collate wrapper was peeled, return `new CollateNode(scope, outerCollateExpr, columnRef)`. Its return type widens from `ColumnReferenceNode` to `ScalarPlanNode`; check the two callers still type-check (they only use it as a sort-key expression).
- `buildOrdinalAwareExpression`: same — wrap the source-attribute reference / re-planned `entry.expr` in a `CollateNode` built from the peeled wrapper. Building `CollateNode` directly from the AST wrapper (rather than synthesising a new AST) keeps `expressionToString` / plan output showing what the user wrote.
- `resolveOrdinalReference` keeps returning the entry (so `orderByNeedsPostAggregateSort` keeps working unchanged); it just needs to see through the wrapper. Simplest shape: have it return `{ entry, collate? }` or expose the peel helper so `buildOrdinalAwareExpression` can get the wrapper — pick whichever keeps the functions small.
- Update the JSDoc on `resolveOrdinalReference` / `resolveOrdinalOutputColumn` / `extractOrdinalValue` that currently says "bare integer literal (or unary +/-)" to mention the collate wrapper.

### GROUP BY note

With the fix, `group by 1 collate nocase` builds the grouping key `CollateNode(nocase, <column 1>)` — the same key the named form `group by a collate nocase` builds. Quereus already rejects `select a, count(*) from t group by a collate nocase` with `Column 'a' must appear in the GROUP BY clause…` (a bare `a` is not determined by a case-insensitive group: `'a'` and `'A'` share a group). The ordinal form will raise the same error for the same query, which is correct and consistent with the named form — not a regression to chase here. The shape that works today with the named form, `select a collate nocase k, count(*) from t group by a collate nocase`, should work identically with `group by 1 collate nocase`. If the double wrapper `CollateNode(nocase, CollateNode(nocase, a))` produced by `select a collate nocase k … group by 1 collate nocase` trips the coverage check (`validateAggregateProjections`) while the named form passes, handle it (e.g. skip rewrapping when the entry expression's resolved collation already equals the requested one) — check it, don't assume.

## Tests

Add to `test/logic/28.2-orderby-expression-extras.sqllogic` next to the existing `order by 2` alias-shadow cases (~line 98), using data where binary and nocase orders differ (e.g. `'a','B','c','A'`):

- `order by 1 collate nocase` on a single SELECT sorts case-insensitively.
- `select b as a, a as z … order by 2 collate nocase` sorts by `z` (alias-shadow + collate together).
- compound: `select a from t union select 'b' order by 1 collate nocase`.
- `order by 5 collate nocase` → prepare-time out-of-range error.
- `select a collate nocase k, count(*) c from t group by 1 collate nocase order by 1` → groups `A`/`a` together.

One case per behaviour; don't duplicate across every call site.

## TODO

- Add the collate-peeling helper and route `extractOrdinalValue`'s callers through it in `select-ordinal.ts`.
- Rewrap the resolved positional reference in `CollateNode` in `resolveOrdinalOutputColumn` and `buildOrdinalAwareExpression`; fix any type fallout at callers.
- Update the affected JSDoc comments.
- Verify the GROUP BY double-wrapper case against the coverage check (see GROUP BY note).
- Add the sqllogic cases above; run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
- If `docs/sql.md` gains/has a note on ORDER BY / GROUP BY positional references, mention that a `collate` suffix is allowed (it currently has none — don't add a section just for this).
