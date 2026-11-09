description: A `maintained as …` clause written after `with tags (…)` on a table used to be silently discarded in a schema declaration (leaving the table permanently empty) and rejected with a confusing error in `create table`; the parser now accepts the clauses in either order.
files: packages/quereus/src/parser/parser.ts (`parseTableTrailingClauses`, `TableTrailingClauses`; called from `createTableStatement` and `declareTableItem`), packages/quereus/test/declare-schema-item-boundary.spec.ts (describe "`maintained as` after `with tags`"), packages/quereus/src/emit/ast-stringify.ts (comment on `maintainedClauseToString`), docs/materialized-views.md (clause-order sentence under the `create table … maintained as` grammar)
repro: verified
----

# Table trailing clauses accepted in any order

## What was wrong

Both table parsers (`create table` and the `declare schema { table … }` item) called `parseMaintainedClause()` once, before the loop that reads `with context` / `with tags` in any order. With `with tags (…) maintained as …`:

- **Declared table:** the item ended after the tags; the leftover `maintained as select …` became the next block item, matched no item keyword, and fell to `declareIgnoredItem`, which keeps unrecognized items as opaque text. No error; the table was declared without a derivation. Verified: the item list was `['declaredTable', 'declareIgnored', 'declaredTable']`.
- **`create table`:** the statement ended after the tags, and the top-level parser raised `Expected statement type (…), got 'maintained'`. Verified.

## The fix

One shared helper, `Parser.parseTableTrailingClauses()`, replaces the two duplicated blocks. It loops over `maintained [(cols)] as <body>`, `with context (…)`, `with tags (…)` in any order, each at most once. A second `maintained` raises `Duplicate MAINTAINED clause`, matching the existing `Duplicate WITH TAGS/CONTEXT clause` errors. A `with` followed by anything else is handed back to the caller, as before.

No AST change. The SQL writer still emits the canonical order (`maintained` before `with tags`), so round trips are unchanged. `docs/materialized-views.md` previously said "Clause order is fixed"; it now states the any-order rule.

## Tests added

All in `test/declare-schema-item-boundary.spec.ts`, describe "`maintained as` after `with tags`":

- `keeps the derivation on a declared table`: the reproduction. Tags-first declared table followed by another table parses to two `declaredTable` items, with both `tags` and `maintained` set and no stolen alias on the body's source.
- `keeps the derivation on create table`: the same order on `create table` (the second site the ticket asked to confirm).
- `rejects a second maintained clause`: pins the new duplicate check, which is the one new branch.

Validation: `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus test`: 11126 passing, 26 pending, 0 failing. Other workspaces were not run; only the quereus parser changed.

## For the reviewer

- **The decision to accept both orders rather than reject the reversed one.** The ticket recommended accepting both. The docs said the order was fixed, and I changed them to match the parser. If the reviewer prefers the strict order, the floor is to throw on `MAINTAINED` after the `with` loop instead of parsing it.
- **Remaining sharp edge, not addressed:** in a declaration block, `maintained` is not in `DECLARE_ITEM_KEYWORDS` (the alias barrier). So a body ending in a bare-alias slot followed directly by a second `maintained` (`… maintained as select id from t1 maintained as …`, with no `with` clause between) reads the second `maintained` as a table alias and then fails on `as`. It is still a parse error, just a less precise one, and only for a contrived doubled clause. I left it alone.
- **Not end-to-end tested.** The test is at the parser layer, the lowest layer that reproduces the bug. I did not add an `apply schema` test, because once the AST carries `maintained`, the rest of the path is the same one the canonical order already exercises.
- The ticket's example uses a leading `using memory { … }` with braces. That goes through the same `declareTableItem` path, so the parenthesized test form covers it.
