description: Review the cross-check of SQLite expression/type/conversion/collation tests against Quereus
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/03.2-bitwise-operators.sqllogic, packages/quereus/test/logic/03.3-is-truthy-falsy.sqllogic, packages/quereus/test/logic/99.1-cast-syntax-extras.sqllogic, packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
----

## Summary

Cross-checked the **"Expressions, types, conversion"** section of `docs/sqlite-test-crosscheck.md` against Quereus's `test/logic/` fixtures. All 9 rows updated:

- **8 reviewed** (`expr.test/expr2.test`, `e_expr.test`, `cast.test`, `types.test`, `types2.test/types3.test`, `numcast.test/tostr.test`, `boundary*.test`, `collate1.test–collate9.test`)
- **1 n/a** (`bigint.test` — file does not exist in upstream sqlite/sqlite; meaningful surface already covered by `03.7-bigint-mixed-arithmetic`)

No tests were run, no engine code was modified, no build/lint commands were executed. As called out in the ticket, this category produces a long n/a list because SQLite's affinity model and implicit-coercion rules don't apply to Quereus's strict logical/physical type system.

## New fixture files

- `packages/quereus/test/logic/03.2-bitwise-operators.sqllogic` — `&` / `|` / `<<` / `>>` binary, with negative operands, NULL propagation, precedence, column-driven values. (Closes the `expr.test` / `e_expr.test` bitwise gap; existing 03-expressions only covers unary `~`.)
- `packages/quereus/test/logic/03.3-is-truthy-falsy.sqllogic` — `IS TRUE` / `IS FALSE` / `IS NOT TRUE` / `IS NOT FALSE` on boolean columns and predicate expressions, with NULL semantics. (Closes the `expr2.test` truth-value-test gap.)
- `packages/quereus/test/logic/99.1-cast-syntax-extras.sqllogic` — BLOB roundtrips via `cast`, scientific notation in `cast`/`real()`/`integer()`, leading/trailing whitespace handling, NUMERIC affinity (`cast('3.0' as numeric)` → INTEGER 3 vs `'3.5'` → REAL 3.5), IEEE 754 INF/NaN handling, IN with mixed-type literal lists, real-to-text formatting, BOOLEAN ↔ numeric edges. (Closes `cast.test`, `types2.test/types3.test`, `numcast.test`, `boundary*.test` value-domain gaps.)
- `packages/quereus/test/logic/06.4.2-collation-extras.sqllogic` — ORDER BY with column-level NOCASE plus explicit `COLLATE BINARY` override, RTRIM equality / ordering / DISTINCT, JOIN ON with `COLLATE BINARY` override, DISTINCT under NOCASE deduplication, UNION/UNION ALL/INTERSECT/EXCEPT under NOCASE, MIN/MAX over a NOCASE column, INDEX `COLLATE NOCASE` for case-insensitive equality search, COLLATE inside CASE WHEN. (Closes `collate1–9.test` propagation gaps.)

## Validation / usage notes

- All four files follow existing fixture conventions: lowercase keywords, `→ <json>` expected results, `-- error: <substring>` for documented-failure paths. None used.
- Filenames slot into the existing prefix scheme: `03.2`/`03.3` between `03.1-quoted-identifiers` and `03.4-defaults` (basic expression coverage); `99.1` next to `99-conversion-edge-cases` (conversion edge cases); `06.4.2` next to `06.4.1-schema-case-insensitive` (schema/collation cluster).
- Internal ordering inside each file is mundane → exotic per the process doc.
- No tests run. Failing tests are expected and downstream-handled.

## Tests / scenarios worth pinning when running

- **Bitwise**: `5 & 3 = 1`, `5 | 3 = 7`, `1 << 4 = 16`, `8 >> 1 = 4`, `-8 >> 2 = -2`, NULL propagation through bitwise ops.
- **IS TRUE/FALSE**: Truth-value tests must treat NULL as neither TRUE nor FALSE (`null IS TRUE` → false, `null IS NOT TRUE` → true). The parser may not currently accept these — if not, that's the next pass's call.
- **CAST extras**: `cast('3.0' as numeric)` → INTEGER 3 (NUMERIC affinity); `cast(1e400 as real)` → null per Quereus's IEEE 754 INF handling; `cast(x'68656c6c6f' as text)` → `'hello'`; whitespace trim works around the value.
- **Collation propagation**: NOCASE column drives ORDER BY, DISTINCT, UNION dedup, MIN/MAX, and equality search under indexed expressions; `COLLATE BINARY` override in ORDER BY / JOIN ON works as expected.

## n/a categorization (this category produces the longest list)

Per ticket request, here is the explicit n/a reason rollup:

- **Implicit column-type affinity / coercion** (largest bucket): `types.test`, `types2.test`, `types3.test` core surface; CREATE TABLE column-type affinity-driven coercion of inserts; NUMERIC/INTEGER/TEXT/BLOB affinity rules — Quereus uses strict logical types with planner-inserted explicit casts, no per-column-affinity insert coercion.
- **Rowid arithmetic / autoincrement**: rowid as an addressable column, rowid range arithmetic — Quereus has no rowids.
- **Triggers**: `RAISE(...)` expressions in `e_expr.test` — no triggers in Quereus.
- **FTS / regex matchers**: `MATCH` operator (FTS-only), `REGEXP` operator (no built-in regex matcher in Quereus core).
- **SQLite-internal counters / introspection**: `sqlite3_search_count`, `sqlite3_compileoption_used`, `sqlite_offset()`, etc. — implementation detail of SQLite's bytecode VM.
- **Storage encoding boundaries**: SQLite varint encoding tests, page-format byte boundaries, record-size tests, 1/2/4/8-byte integer encoding selection — Quereus delegates storage to VTab modules.
- **Custom collation registration via C API**: `sqlite3_create_collation`, `sqlite3_create_collation_v2`, collation factory callbacks — Quereus exposes custom collations through the plugin path on logical types, not a C-API runtime registration.
- **`REINDEX` command**: not a Quereus surface.
- **`ATTACH`**: cross-database collation precedence and ATTACH-driven scenarios — Quereus schema is in-memory.
- **UTF-16 encoding paths**: SQLite stores text as UTF-8 or UTF-16 depending on encoding pragma; Quereus is UTF-8 only.
- **`bigint.test` upstream missing**: SQLite repo has no `test/bigint.test`; existing `03.7-bigint-mixed-arithmetic` covers the mixed-type bigint/number arithmetic surface that tests would have hit.
- **`tostr.test` upstream missing**: file does not exist; numeric → text covered via `text()` / `cast(... as text)` in existing fixtures.
- **Manifest typing via Tcl variables / custom-function affinity tagging** (`types3.test`): Tcl-binding-specific; Quereus uses explicit return-type declarations on functions.
