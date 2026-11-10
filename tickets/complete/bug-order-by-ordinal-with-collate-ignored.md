---
description: Adding a text-comparison rule to a sort that refers to a column by its number — like "sort by column 2, ignoring letter case" — used to silently stop sorting. It now sorts that column with the requested rule applied, the way SQLite does.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  - docs/sql-select.md
repro: verified
---

# Complete: `order by 2 collate nocase` sorts by column 2

## What landed

All code is in `select-ordinal.ts` (commit `ticket(implement): bug-order-by-ordinal-with-collate-ignored`). `parseOrdinalTerm` strips any number of `collate` wrappers before testing whether an ORDER BY / GROUP BY term is an integer position, keeping the outermost wrapper. The resolved target (output-column reference, source-attribute reference, or re-planned select-list expression) is then wrapped by `applyOrdinalCollate`, which builds a new `CollateNode` whose AST is `<resolved expression> collate <name>`. Building a new AST, rather than reusing the user's `1 collate nocase`, keeps grouping-key fingerprints identical to the named form `group by a collate nocase`. An operand that already has the same explicit collation is left unwrapped, so `select a collate nocase k … group by 1 collate nocase` still recognises its own select-list column as the key. The two copies of the out-of-range error became `assertOrdinalInRange`, and a wrapped out-of-range position (`order by 5 collate nocase`) now raises it, as in SQLite.

## Review findings

**Read the diff first, then probed behaviour** with an ad-hoc spec (deleted afterwards) on data `a, B, c, A`:

- Correctness, all callers: every caller of `resolveOrdinalReference` / `buildOrdinalAwareExpression` / `resolveOrdinalOutputColumn` (select.ts window pre-sort, select-modifiers aligned and non-aligned paths, select-aggregates pre-aggregate sort, GROUP BY keys, `orderByNeedsPostAggregateSort`, select-compound) was read. All of them now see the collate suffix. Probed: grouped non-aligned output (`group by a, b order by 1 collate nocase`), DISTINCT, a window-function query, a multi-key sort with `desc` and a tiebreak, an ordinal on an aggregate output, `select upper(a) u, a … order by 2 collate nocase`, explicit-collation override (`select a collate nocase k … order by 1 collate binary` sorts binary), a compound whose column already has explicit nocase, and an unknown collation (`no such collation sequence: NOSUCH`). All gave correct results.
- Interaction with post-aggregate redirection: `redirectPostAggregate` only walks expressions that reference pre-grouping attributes. The CollateNode over an output-column reference from the aligned path does not, so the AST-text match in `redirectToGroupKeys` cannot rebind it to a different column. No hazard found.
- Consistency with the named form: `group by 1 collate nocase` / `group by 1 collate binary` / `group by lower(a)`-by-ordinal reject or accept exactly where the named spellings do (checked side by side). The rejection of `select a, count(*) … group by a collate nocase` is Quereus's existing coverage rule, not something this change introduced.
- Edge: `order by -1 collate nocase` is treated as a constant sort key, not a position. The parser binds `collate` tighter than unary minus, so the term is `-(1 collate nocase)`. SQLite parses and classifies it the same way (`sqlite3ExprIsInteger` does not see through the collate under the minus), so this matches. No change.
- Type safety / error handling: `resolveOrdinalOutputColumn` widening to `ScalarPlanNode` is fine for both callers, which only use it as a sort key. The range error keeps the source location. No `any`. Nothing found.
- Hygiene / size: the file is 274 lines. The helpers are small, single-purpose, and their comments explain why (fingerprint matching, the double-wrapper skip) rather than narrating statements. Nothing to fix.
- Performance / resource cleanup: this is build-time planning only, adding one extra loop over the wrappers and at most one node per term. Nothing to address.
- Tests: cut the `select b as a, a as z … order by 2 collate nocase` case. It goes through the same path (`resolveOrdinalOutputColumn` → `applyOrdinalCollate`) as the basic single-SELECT case, and alias shadowing is already pinned without collate earlier in the same file. Kept the single-SELECT, compound, out-of-range and GROUP BY (double-wrapper skip) cases, since each covers a distinct path. The outermost-wins rule for nested wrappers is not pinned by a test. It can only be written with parentheses and was verified by hand during implement, so it was left untested on purpose.
- Docs: `docs/sql-select.md` had no mention of a collate suffix on a positional reference. Added one bullet to GROUP BY (same semantics and coverage rule as the named spelling) and one to ORDER BY (overrides the column's collation, outermost wins, still range-checked).
- Implementer's open points: the type-based skip (any operand with the same explicit collation, not only a literal `CollateNode`) does not change comparisons and is accepted as is. Wrapping a column whose same collation is only declared on the column matches the named form. Neither needs action.
- Tripwires / tickets filed: none. No conditional concern came up that needed a `NOTE:`.

## Validation

- `yarn workspace @quereus/quereus test`: 11135 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean (exit 0).
- Store mode was not run. The change is planner-only and has nothing specific to storage.
