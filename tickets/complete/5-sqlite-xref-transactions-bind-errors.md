description: Review of SQLite transactions / savepoints / bind / identifier / errors cross-check
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/02.1-bind-parameters.sqllogic, packages/quereus/test/logic/90.1-parse-errors.sqllogic
----

## Summary

Cross-checked SQLite test files in the **Transactions, savepoints**, **Bound parameters, identifiers**, and **Error paths** sections of `docs/sqlite-test-crosscheck.md`.

Counts:
- Rows reviewed: 4 (`trans*.test` group, `savepoint*.test` group, `transaction.test`, `bind.test`)
- Rows marked `n/a`: 2 (`identifier.test`, `errors.test` — both confirmed not present upstream via raw URL 404)
- Rows marked `unreviewed`: 0

`descidx*.test` was previously reviewed under ticket `5-sqlite-xref-indexes` and was out of scope here.

## New fixtures

- **`packages/quereus/test/logic/02.1-bind-parameters.sqllogic`** — comprehensive bind-parameter coverage adapted from SQLite `bind.test`. Exercises positional `?`, named `:name` / `$name`, numeric named `:N` / `$N`, parameter type variation (integer / real / text / NULL), bind across INSERT / UPDATE / DELETE, parameter in arithmetic / function call / CASE / IN list / LIMIT / OFFSET, repeated parameter references, and repeated execution with different bind values to verify parameters are not constant-folded.

## Edits to existing fixtures

- **`packages/quereus/test/logic/90.1-parse-errors.sqllogic`** — appended three parser-rejection cases:
  - `@name` parameter form → lexer "Unexpected character".
  - `?1` (SQLite `?N` form) → stray digit after positional placeholder.
  - Bare `:` prefix without identifier or number → "Expected identifier or number after parameter prefix".

## Rationale for n/a calls within reviewed rows

- **DDL inside transactions / savepoints**: Quereus DDL is non-transactional (per `10.1-ddl-lifecycle` lines 103–106). SQLite's `trans.test` / `savepoint*.test` scenarios that assert CREATE/DROP TABLE rollback don't apply.
- **BEGIN DEFERRED / IMMEDIATE / EXCLUSIVE**: Locking modes have no observable surface in Quereus.
- **Multi-connection isolation, journal mode, freelist, auto-vacuum**: storage delegated to VTab modules.
- **C-API `sqlite3_txn_state`, `sqlite3_bind_parameter_index/_name`, Tcl `$varname` integration**: not applicable to Quereus's binding model.
- **Cursor-during-COMMIT**: the sqllogic harness drains iterators before each next statement, so this scenario isn't observable at the SQL surface.
- **`savepoint3.test`**: does not exist upstream (raw URL 404).
- **`identifier.test`, `errors.test`**: do not exist upstream (raw URL 404 confirmed). SQLite distributes these scenarios across `e_select.test`, `e_expr.test`, etc.; Quereus already covers identifier surface in `03.1-quoted-identifiers` + `06.4.1-schema-case-insensitive`, and error surface across `90-error_paths` / `90.1` / `90.2` / `90.3` / `90.4` / `90.5` / `90.6`.

## Validation notes

- **No tests were run.** No `yarn test`, `yarn build`, or lint command was executed.
- No engine code modified.
- Failing tests are expected; the next pass runs them and decides per-fixture remediation (engine fix vs. test adjustment).

## Review focus

The new fixture in `02.1-bind-parameters.sqllogic` makes assumptions about Quereus parameter-binding behavior:
- That `:N` / `$N` numeric named parameters can be bound via JSON object key `"1"`, `"2"`.
- That `IS ?` with a NULL parameter behaves as null-safe equality (matches NULL-valued rows).
- That `LIKE ? || '%'` works with a parameter operand.
- That repeated execution of a prepared statement with different bind values produces the expected per-call result (i.e., parameters aren't const-folded into the plan).

If any of these assumptions don't match Quereus's intended semantics, the next pass should adjust the fixture rather than the engine.

The `?1` rejection in `90.1-parse-errors.sqllogic` uses a bare `-- error:` substring (matches any error) because the precise error message wasn't determined — the parser's behavior with `?` followed immediately by a digit is implementation-dependent at the expression boundary.
