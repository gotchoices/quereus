description: A `maintained as …` clause written after `with tags (…)` on a table used to be silently discarded in a schema declaration (leaving the table permanently empty) and rejected with a confusing error in `create table`; the parser now accepts the clauses in either order.
files: packages/quereus/src/parser/parser.ts (`parseTableTrailingClauses`, `TableTrailingClauses`; called from `createTableStatement` and `declareTableItem`), packages/quereus/test/declare-schema-item-boundary.spec.ts (describe "`maintained as` after `with tags`"), packages/quereus/src/emit/ast-stringify.ts (comment on `maintainedClauseToString`), docs/materialized-views.md, docs/sql.md (`create_table_stmt` grammar)
repro: verified
----

# Table trailing clauses accepted in any order

## What was wrong

Both table parsers (`create table` and the `declare schema { table … }` item) parsed `maintained as …` once, before the loop that reads `with context` / `with tags` in any order. With `with tags (…) maintained as …`, a declared table lost its derivation: the leftover `maintained as select …` became an unrecognized block item and was kept as opaque text, with no error. `create table` failed with `Expected statement type (…), got 'maintained'`.

## The fix

One shared helper, `Parser.parseTableTrailingClauses()`, replaces the two duplicated blocks. It loops over `maintained [(cols)] as <body>`, `with context (…)` and `with tags (…)` in any order, each at most once. A second `maintained` raises `Duplicate MAINTAINED clause`. A `with` followed by anything else is handed back to the caller. No AST change; the SQL writer still emits `maintained` before the `with` clauses, so round trips are unchanged. `docs/materialized-views.md` now states the any-order rule instead of "Clause order is fixed".

Tests (in `test/declare-schema-item-boundary.spec.ts`): the declared-table reproduction, the same order on `create table`, and the duplicate-`maintained` rejection.

## Review findings

Read the diff of `ticket(implement): maintained-clause-dropped-when-written-after-table-tags` before the handoff.

- **Correctness, checked by running probes (temporary spec, since deleted):** `with tags … maintained as … with context …`, `with context … maintained as … with tags …`, tags first with a `maintained (a) as … with defaults (a = 1)` body, and a `with` CTE body followed by tags all parse and re-emit in canonical order. A tag clause repeated around the body gives `Duplicate WITH TAGS clause`. A bare trailing `maintained` gives `Expected 'AS' after MAINTAINED.`. The helper cannot loop forever: `parseMaintainedClause` always consumes once `peekKeyword('MAINTAINED')` holds. End to end, `declare schema` with a tags-first maintained table followed by `apply schema` fills the table from its source (2 rows). No defect found.
- **Sharp edge (tripwire):** a second `maintained` written directly after a body, with no `with` clause between, is read as the body's bare table alias and fails on `as` with a generic message. Confirmed for `create table` as well as the declaration block the implementer named. It is still an error, and only for a doubled clause. Parked as a `NOTE:` in `parseTableTrailingClauses`.
- **Docs:** `docs/sql.md`'s `create_table_stmt` grammar left out the `maintained` clause entirely. Added `maintained_clause` to the any-order trailing-clause repetition and defined it. `docs/schema.md` line 346 and `docs/sql-views.md` line 81 describe the emitted (canonical) order and are still accurate. The comment change in `ast-stringify.ts` is accurate.
- **Design (accept both orders vs. reject the reversed one):** agree with accepting both. It matches how the `with` clauses already behaved, and in a declaration block a strict order can only fail silently, because unrecognized items are kept as opaque text (an accepted-tradeoff `NOTE:` on `declareIgnoredItem` already covers that wider class, so nothing is filed for it).
- **Tests:** all three pay for themselves. Two reproduce the two reported failures, one at each call site, and one covers the single new branch. Nothing cut, nothing added.
- **DRY / modularity / types:** the change removes about 40 duplicated lines, and the returned `TableTrailingClauses` interface is typed with no `any`. No resource or error-handling concerns, because the parser does not catch errors on this path.
- **Validation:** `yarn workspace @quereus/quereus run lint` is clean. `yarn workspace @quereus/quereus test` gives 11126 passing, 26 pending, 0 failing. Other workspaces were not run because only the quereus parser and docs changed.
