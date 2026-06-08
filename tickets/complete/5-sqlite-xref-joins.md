description: Review SQLite JOIN cross-check fixtures (5-sqlite-xref-joins)
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/11.1-join-using.sqllogic, packages/quereus/test/logic/11.2-comma-join.sqllogic, packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic, packages/quereus/test/logic/26.3-join-on-constants.sqllogic, packages/quereus/test/logic/26.4-join-on-is-null-nullable.sqllogic, packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic
----

## Summary

Cross-checked SQLite's JOIN test suite (`join.test`, `join1-7.test`, `joinB-H.test`) against Quereus's existing JOIN coverage (`11-joins`, `12-join_padding_order`, `23-self-joins-duplicates`, `26-join-edge-cases`, `26.1-left-join-isnull-on-notnull`).

Row counts:
- **reviewed**: 13 SQLite test files (`join`, `join2`–`join7`, `joinB`–`joinF`, `joinH`)
- **n/a**: 2 files (`join1.test`, `joinG.test` — confirmed 404 in upstream sqlite/sqlite repo)
- **unreviewed**: 0

## New fixtures (no tests run; failing-on-write expected)

- `packages/quereus/test/logic/11.1-join-using.sqllogic` — USING clause: single column, multi-column, column merging in projection, default-binary collation, COLLATE NOCASE column-level. Inner and LEFT JOIN forms.
- `packages/quereus/test/logic/11.2-comma-join.sqllogic` — Comma syntax in FROM: 2-table, 3-table, with WHERE join condition, partial WHERE (one-table filter), and comma-mixed-with-explicit JOIN.
- `packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic` — ON-clause vs WHERE-clause filtering distinction on LEFT JOIN: ON-equality, ON-inequality, IS NULL anti-join idiom, IS NOT NULL inner-join equivalence, mixed left-side WHERE, HAVING with COUNT.
- `packages/quereus/test/logic/26.3-join-on-constants.sqllogic` — Constant predicates in ON clause: `1`, `0`, `null`, `true`, `false` on INNER and LEFT joins. Includes a three-way LEFT JOIN with constant ON in the middle.
- `packages/quereus/test/logic/26.4-join-on-is-null-nullable.sqllogic` — `ON IS NULL` / `IS NOT NULL` on nullable columns, complementing 26.1 (which targets NOT NULL columns). Covers null-key cross-joining, both-sides null, equality with explicit IS NULL fallback.
- `packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic` — Pins current unsupported-state: `RIGHT [OUTER] JOIN`, `FULL [OUTER] JOIN`, `NATURAL JOIN`, `NATURAL LEFT JOIN`. Uses `-- error:` to document the runtime / parse-error response.

## Test plan

- [ ] Run `yarn test` in `packages/quereus/`; new fixtures will likely fail until engine work catches up — that is expected (per process doc).
- [ ] Triage failures per scenario and decide: fix engine, refine fixture (e.g., adjust expected error substrings), or reclassify.
- [ ] Verify the unsupported-join error substrings remain accurate (search `runtime/emit/join.ts` for `RIGHT JOIN is not supported yet` / `FULL JOIN is not supported yet`).
- [ ] Confirm the `NATURAL JOIN` parse-error substring once the parser's actual error message is known (90.5 uses `NATURAL` as a generic substring; tighten if a more specific token-level error appears).
- [ ] Read 11.1 to ensure column-disambiguation expectations match Quereus's `col`, `col:1` serialization (USING merges should produce a single `col` key, distinct from non-USING joins).

## Notes for reviewer

- No engine code was modified.
- No tests, build, or lint were run (per ticket constraints).
- `IS NOT DISTINCT FROM` (proposed by one subagent for joinD) was dropped: the operator is not in Quereus's parser, so any such test would fail in the parser before exercising the join semantics.
- `joinC`'s 256-row USING-permutation suite was treated as plan-shape rather than semantic and not mirrored; the USING semantics are exercised in 11.1.
- Column-level COLLATE NOCASE in USING (added in 11.1) is the realistic path Quereus exposes; SQLite-style implicit affinity isn't applicable.
