description: MATCH SIMPLE NULL guards for child-side FK constraint checks — NULL FK columns satisfy the constraint without evaluating the EXISTS subquery.
prereq: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
  docs/sql.md
----

## Summary

`synthesizeExistsCheck()` in `foreign-key-builder.ts` wraps the generated EXISTS expression with OR-chained `IS NULL` guards — one per FK column. This implements SQL:2016 §4.17.2 MATCH SIMPLE: the FK is satisfied immediately when any referencing column is NULL, without evaluating the EXISTS subquery.

Generated AST: `(NEW.col1 IS NULL) OR (NEW.col2 IS NULL) OR ... OR EXISTS(SELECT 1 FROM parent WHERE ...)`

No changes to parent-side checks — parent PK columns are non-NULL by definition.

## Review notes

- Code is clean, well-structured, and correctly implements the SQL standard semantics.
- `reduceRight` builds the OR chain with NULL guards short-circuiting before the expensive EXISTS subquery.
- No lint issues in changed files.
- Docs updated: `docs/sql.md` §7.6 now documents MATCH SIMPLE NULL semantics.
- Added UPDATE-to-NULL test case to cover both INSERT and UPDATE paths.

## Test coverage

- Empty parent + NULL child INSERT (RESTRICT) — succeeds
- UPDATE FK column to NULL — succeeds
- Self-referential FK, first row NULL — succeeds
- Multi-column FK, one NULL column — succeeds
- Multi-column FK, all NULLs — succeeds
- Multi-column FK, no NULLs, no match — fails (regression guard)
- All existing FK tests pass (full suite green)
