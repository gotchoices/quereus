description: Review of cross-check for SQLite scalar/string/math/printf/random/like function tests against Quereus
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/06.1.1-string-functions-extended.sqllogic, packages/quereus/test/logic/06.1.2-printf.sqllogic, packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic, packages/quereus/test/logic/06.2.1-math-extended.sqllogic, packages/quereus/test/logic/24.1-substr-extras.sqllogic, packages/quereus/test/logic/24.2-random-extras.sqllogic
----

## Summary

Cross-checked the scalar-function rows of the "Functions" section in `docs/sqlite-test-crosscheck.md` (date/JSON owned by sibling ticket `5-sqlite-xref-functions-temporal-json`). 11 rows touched.

Per the process doc constraints: no tests run, no engine code modified, no follow-up tickets. New `.sqllogic` fixtures *are* the record.

## Row outcomes

- `func.test` — **reviewed**. Wrote 06.1.1-string-functions-extended.sqllogic for hex/char/unicode/octet_length. Quote/zeroblob/last_insert_rowid/changes/total_changes/sqlite_version n/a (storage/persistence concepts).
- `func2.test` — **reviewed**. Wrote 24.1-substr-extras.sqllogic for NULL propagation, substring() alias, Y > strlen, 2-arg negative Y, Y=0 + length, negative-Z (chars preceding Y per SQLite docs), multi-byte indexing.
- `func3.test` — **n/a**. likelihood/likely/unlikely + C-API destructor mechanics; no SQL-observable surface.
- `func4.test` — **n/a**. totype.c extension (tointeger/toreal) — not part of Quereus's logical type system.
- `func5.test` — **reviewed**. Deterministic factoring already covered in 44-determinism-validation / 45-udf-determinism; remainder is C-API flag mechanics (n/a).
- `func6.test` — **n/a**. `sqlite_offset()` — b-tree byte-offset introspection; storage delegated to VTab modules.
- `func7.test` — **reviewed**. Wrote 06.2.1-math-extended.sqllogic for SQLite 3.35+ math (ln/log/log10/log2/exp, trig, hyperbolic, pi/degrees/radians, trunc/mod/sign) — none of which Quereus currently exposes.
- `substr.test` — **reviewed**. Folded into 24.1-substr-extras.sqllogic.
- `printf.test`, `printf2.test` — **reviewed**. printf()/format() not currently registered in Quereus. Wrote 06.1.2-printf.sqllogic faithfully documenting the SQLite surface (integer/float/string specifiers, width/precision, asterisk-width, alternate-form/sign flags, %q/%Q/%w SQLite extensions, %% literal, %c, %,d thousands, NULL handling, format() alias) per process-doc rule "if absent, write a fixture using it — next pass decides".
- `random.test` — **n/a (upstream)**. File doesn't exist in upstream sqlite/sqlite (raw URL 404). Wrote 24.2-random-extras.sqllogic to pin randomblob() type/length contract and arity validation as a forward-looking regression guard. Determinism rejection already covered in 44/45.
- `like.test`, `like2.test`, `like3.test` — **reviewed**. Wrote 06.1.3-like-glob-edges.sqllogic for case-sensitivity invariant, multi-byte `_` matching, LIKE on numeric/BLOB column, ESCAPE clause (parser may reject — written faithfully per process-doc), GLOB char classes (`[abc]`, `[a-c]`, `[^abc]`). like3.test plan-shape / REINDEX / UTF-16 n/a.

## Counts

- Reviewed: 8 rows (func, func2, func5, func7, substr, printf+printf2 (joined), like+like2+like3 (joined))
- n/a: 4 rows (func3, func4, func6, random)
- New fixtures: 6
  - `packages/quereus/test/logic/06.1.1-string-functions-extended.sqllogic`
  - `packages/quereus/test/logic/06.1.2-printf.sqllogic`
  - `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic`
  - `packages/quereus/test/logic/06.2.1-math-extended.sqllogic`
  - `packages/quereus/test/logic/24.1-substr-extras.sqllogic`
  - `packages/quereus/test/logic/24.2-random-extras.sqllogic`

## Use cases / validation

The fixtures double as a forward-looking spec. Many will fail on first run because Quereus does not currently register the SQL surface they exercise (printf/format, hex, char, unicode, octet_length, ln/log/exp/trig/hyperbolic/pi/degrees/radians/trunc/mod/sign, GLOB character classes, LIKE … ESCAPE). The next pass should:

- Decide per group: implement the missing function/syntax, or reclassify the row to `n/a` and remove the fixture.
- Reconcile the substr negative-Z behavior — `06.2.1` and `24.1-substr-extras` assert SQLite's documented "chars preceding Y" semantics, while the existing assertion in `24-builtin-branches.sqllogic:274` (`substr('hello', 2, -1) → ''`) reflects Quereus's current implementation. One of them needs to change; the fixture deliberately documents SQLite's documented behavior so the engine fix surfaces vs. a deliberate divergence (which would warrant a comment in `string.ts`).
- Verify multi-byte indexing in `like('a_b', 'aäb')` and `substr('a😀b', 2, 1)` — these depend on character-vs-byte semantics in the implementation.

## Tests run / build

None — explicit ticket constraint. The next stage runs them.

## TODO

- [ ] Code-review pass
- [ ] No engine code touched (per ticket constraints)
