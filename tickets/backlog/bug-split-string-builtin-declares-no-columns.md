description: The built-in `split_string` table function has no column names, so the query the documentation shows for it (`select value from split_string('a,b,c', ',')`) fails with "Column not found: value".
architecture: docs/functions.md#string-table-valued-function
files: packages/quereus/src/func/builtins/string.ts, docs/functions.md, packages/quereus/src/runtime/emit/table-valued-function.ts
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: Declaring the columns renames `select *` output from `col_0`/`col_1` to `value`/`ordinal`, so any caller relying on the positional names breaks; the fix is otherwise one declaration.
----
`docs/functions.md` § String Table-Valued Function documents two columns for `split_string(str, delimiter)`: `value` (TEXT, the segment) and `ordinal` (INTEGER, 0-based index), and shows `select value from split_string('a,b,c', ',')`.

The built-in registration in `packages/quereus/src/func/builtins/string.ts` (`splitStringFunc`) passes no `returnType`, so the function declares no columns. Verified on 2026-11-17:

- `select value, ordinal from split_string('a,b', ',')` → error `Column not found: value`
- `select * from split_string('a,b', ',')` → rows `{"col_0":"a","col_1":0}`, `{"col_0":"b","col_1":1}`

`packages/quereus/src/runtime/emit/table-valued-function.ts` names `split_string` as the example of a function with no declared columns, which skips row-width normalization and the per-cell representation check for it.

The plugin example in `docs/plugins.md` (and its mirror in `test/documentation.spec.ts`) registers its own `split_string` *with* declared `ordinal`/`value` columns, which is why the documentation test does not catch this.

Expected: the built-in declares the documented columns (in the order it yields them: value, then ordinal) with their types, so the documented query works and the representation check covers its cells. `test/logic/03.6.2-value-to-text.sqllogic` currently pins `col_0`/`col_1` in one row and would need its expected output updated.
