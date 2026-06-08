description: Review SQLite-index cross-check fixtures and cross-check doc updates
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic, packages/quereus/test/logic/10.5.2-expression-indexes.sqllogic, packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic, packages/quereus/test/optimizer/desc-index-ordering.spec.ts
----

## What was done

Cross-checked the index-related rows of `docs/sqlite-test-crosscheck.md` "WHERE, JOIN, indexing" section (plus `descidx*.test` from the "Bound parameters, identifiers" section, since the ticket scoped both):

- `index.test`, `index1-7.test` — collapsed into one row in the doc; reviewed.
- `indexedby.test` — n/a.
- `descidx*.test` — reviewed.

No tests were run, no engine code was modified, no build/lint executed (per ticket constraints).

### Row counts

- 3 rows reviewed (1 was a multi-file row covering `index.test` and `index1.test`–`index7.test`)
- 1 row n/a (`indexedby.test`: INDEXED BY / NOT INDEXED grammar absent in Quereus)
- 0 rows unreviewed

### New fixtures written

| File | Topic | Notes |
| --- | --- | --- |
| `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic` | Partial indexes (CREATE INDEX … WHERE …) | Basic partial index, partial UNIQUE within scope (incl. cross-scope dup allowed and scope-transition on UPDATE), IS NULL predicate, compound WHERE (AND + comparison), update propagation when row enters/leaves scope. |
| `packages/quereus/test/logic/10.5.2-expression-indexes.sqllogic` | Expression indexes (CREATE INDEX … ON tab(expr)) | `UPPER(name)` equality + ORDER BY, arithmetic `a+b`, concatenation, UNIQUE on `lower(name)` collision, expression-index combined with partial WHERE. |
| `packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic` | DESC indexes — output correctness | Single-column DESC traversal (asc + desc), composite (ASC, DESC), NULLs ordering under DESC (default, NULLS FIRST/LAST), range scan, DESC TEXT lexicographic. |
| `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` | DESC indexes — plan-shape | ORDER BY DESC consumes DESC index without an explicit SORT; range + ORDER BY DESC uses index access; composite (ASC, DESC) eliminates SORT for equality-leading + DESC-trailing. |

### What was left covered by existing fixtures

- Basic CREATE INDEX / IF NOT EXISTS / DROP INDEX / DESC PK / multi-column / NULL handling — `10.5-indexes.sqllogic`, `40.1-pk-desc-direction.sqllogic`.
- COLLATE in indexed columns — `06.4.2-collation-extras.sqllogic` (`create index idx_name_nc on coll_idx (name collate nocase)`).
- UNIQUE: post-hoc CREATE UNIQUE INDEX rejecting duplicates, UNIQUE+COLLATE NOCASE — `102.1-unique-edge-cases.sqllogic`.
- Index introspection in `schema()` / sqlite_master — `06.3-schema.sqllogic`.
- ALTER propagation across partial-index WHERE clauses and `(v + 1)` expression indexes — `41.3-alter-rename-propagation.sqllogic`.
- Plan-shape for equality / range / composite-prefix on secondary indexes — `test/optimizer/secondary-index-access.spec.ts`, `test/optimizer/composite-prefix-range.spec.ts`, `test/plan/index-selection.spec.ts`.

### Scenarios marked n/a (not represented as tests)

- Implicit rowid auto-index, INTEGER PRIMARY KEY rowid alias, autoincrement-rowid linking — Quereus has no rowids (per `architecture.md` § Design Differences).
- REINDEX, VACUUM, ATTACH, PRAGMA case_sensitive_like — not in Quereus.
- Disk I/O / page-format / write-pattern probes (the focus of `index5.test`) — storage delegated to VTab.
- 1k-column / 65k-row stress probes (focus of `index2.test`, `index4.test`) — performance regression suite, not feature coverage.
- INDEXED BY / NOT INDEXED hint syntax (entire `indexedby.test`) — parser does not accept; planner uses BestAccessPlan.
- Reserved `sqlite_` prefix index-name policy — SQLite-specific naming policy, not a Quereus invariant.
- SQLite file-format compatibility (descidx1–3 SQLite format-version 4 paths) — Quereus is in-memory; no on-disk format constraints.

## Test plan for review

Reviewer should:

1. **Read each new fixture for faithfulness:** are the assertions documenting what SQLite demonstrates *should* work, without pre-softening to Quereus's guessed behavior? (Per `docs/sqlite-test-crosscheck-process.md` § "Write tests faithfully".)
2. **Run the new tests** (`yarn test` and the one new optimizer spec) and triage failures:
   - If the engine produces correct results but plan-shape assertions fail, the optimizer spec is the right place to encode the gap.
   - If a partial-index or expression-index scenario fails, that is a real engine bug to file.
   - If the parser rejects the syntax outright (e.g. expression in `CREATE INDEX`), confirm against `parser.ts:3098` (`indexedColumn()` accepts `expression()` as the first form) — the path exists; failures should be in planner/runtime, not parser.
3. **Re-confirm `n/a` calls** by reading the relevant SQLite source paragraphs cited in the cross-check Notes column.
4. **Check the cross-check doc** still parses cleanly (table format, no broken row layout).

## Use cases pinned by the new fixtures

- "I want to mark some rows soft-deleted by setting `deleted_at` and have a partial index over only live rows" — `10.5.1` § 3.
- "I want a UNIQUE constraint that only applies while a row is active" — `10.5.1` § 2.
- "I want to look up users case-insensitively without storing a denormalized `lower(name)` column" — `10.5.2` § 1, § 4.
- "I want my time-series queries `ORDER BY ts DESC` to consume a DESC index without sorting" — `10.5.3` § 1, § 4 + `desc-index-ordering.spec.ts`.
- "I want a `(category, score DESC)` leaderboard-style index" — `10.5.3` § 2 + `desc-index-ordering.spec.ts` § 3.

No tests were run; expect failures to land on the next downstream pass.
