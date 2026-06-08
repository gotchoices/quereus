description: JSON path operators -> and ->> as syntactic sugar over json_extract
files:
  - packages/quereus/src/parser/lexer.ts (DARROW token, ARROW token, - handler branching)
  - packages/quereus/src/parser/parser.ts (jsonPath(), jsonPathRhs() methods in expression precedence chain)
  - packages/quereus/test/logic/json-path-operators.sqllogic (comprehensive test coverage)
  - docs/sql.md (JSON Path Operators section, grammar update)
  - docs/functions.md (cross-reference with json_extract)
----

## Summary

Added `->` and `->>` binary operators for JSON path access, following SQLite 3.38+ conventions. These are pure syntactic sugar — the parser desugars them into `json_extract()` calls at parse time.

### Implementation
- **Lexer**: `ARROW` (`->`) and `DARROW` (`->>`) tokens, lexed in the `-` handler with proper 3-way branching (`--` comment / `->` or `->>` / plain `-`)
- **Parser**: `jsonPath()` inserted between `collateExpression()` and `primary()` in the expression precedence chain. Left-associative loop handles chaining. `jsonPathRhs()` normalizes shorthand paths (`'name'` → `'$.name'`, `0` → `'$[0]'`).
- `->` desugars to `json_extract(expr, path)` (returns native JSON)
- `->>` desugars to `cast(json_extract(expr, path) as text)` (returns TEXT)

### Test Coverage
- Basic `->` with full JSON path, nested path, string/integer shorthand
- `->` extracting nested objects as native JSON
- `->>` TEXT coercion for strings, numbers, arrays, nested objects
- `->>` with string and integer shorthand
- Chained `->`, mixed `->` / `->>` chaining
- NULL propagation (SQL NULL input)
- Non-existent path returns NULL
- Boolean and JSON null values
- Table data with `->` / `->>` in projection and WHERE
- `->>` in WHERE clause (no explicit cast needed since it returns TEXT)
- Aliased results

### Notes
- Full JSON type distinction between `->` and `->>` depends on ticket json-native-object-storage
- `->>` with arrays serializes as `"1,2"` not `"[1,2]"` due to current cast behavior
