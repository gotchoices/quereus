# Quereus Tests

Tests for the Quereus engine. Most behavior is exercised through SQL logic tests; lower-level unit tests live alongside in subdirectories.

## Layout

| Path | What lives there |
|---|---|
| `logic/*.sqllogic` | Primary regression suite — black-box SQL with expected results. Runner is `logic.spec.ts`. |
| `plan/` | Optimizer plan-shape and golden-plan tests. See `plan/README.md`. |
| `optimizer/` | Per-rule optimizer unit tests (pushdown, joins, aggregate strategy, statistics, etc.). |
| `planner/` | Planner framework, cost model, predicate normalization, validation, stats. |
| `runtime/` | Runtime emitter and execution unit tests (caches, scan emitter, temporal arithmetic, shadow DDL). |
| `schema/` | Catalog and schema-differ tests. |
| `vtab/` | Virtual-table contract tests (best-access plan, events, scan bounds, remote disconnect). |
| `core/` | Core database/options API tests. |
| `cross-platform/` | Browser and environment-compatibility checks. |
| `util/` | Pure utility tests (hash, hrtime, plugin helpers, mutation-statement). |
| `*.spec.ts` (top level) | Cross-cutting suites: parser, type system, fuzz, property, lifecycle, multi-statement, exports, capabilities, performance sentinels, etc. |

## Running tests

```bash
yarn test            # default — memory vtab; this is what agents should run
yarn test:store      # re-run logic suite against the LevelDB store module
yarn test:full       # both (only for store-specific diagnosis or release prep)
```

Diagnostics for logic-test failures (flags are picked up by `logic.spec.ts`):

```bash
yarn test --show-plan                                  # concise query plan
yarn test --plan-summary                               # one-line execution path
yarn test --plan-full-detail                           # full plan as JSON
yarn test --show-plan --expand-nodes "node1,node2"     # expand specific nodes
yarn test --show-plan --max-plan-depth 3               # cap plan depth
yarn test --show-program                               # instruction program
yarn test --show-trace                                 # execution trace
yarn test --trace-plan-stack                           # plan stack tracing in runtime
yarn test --show-stack                                 # full stack traces
yarn test --verbose                                    # verbose progress
```

`DEBUG=quereus:...` enables namespaced log output. To run a single ad-hoc spec without the workspace harness:

```bash
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js 'packages/quereus/test/**/*.spec.ts' --colors --bail
```

## Logic-test conventions

- `→ [expected_json_results]` marks expected rows.
- `-- error: <substring>` marks expected errors.
- Lowercase SQL keywords. Match the existing fixtures' style.
- Inside a file, order scenarios **mundane → exotic** so the most general failure surfaces first.
- File names carry a numeric prefix that places them in run order. The same mundane → exotic principle applies across files. Anchors:
  - `01–17` — feature basics (parser, expressions, transactions, vtab, builtins, aggregates, joins, set ops, CTEs, temporal).
  - `20–29` — feature edge cases (NULL, boundaries, self-join duplicates).
  - `40–50` — semantics-heavy features (constraints, FKs, generated cols, RETURNING, declarative schema, assertions).
  - `80–86` — optimizer / plan-shape concerns.
  - `90–99`, `100+` — error paths, exotic edge cases, mutation kills.
- Use a decimal sub-number to slot between adjacent files (`06.2.1-…` between `06.2-…` and `06.3-…`); don't renumber existing files.
- Tests represent expected behavior when features are fully implemented. A failing test is a roadmap item, not a regression to silence.

## Test philosophy

Tests are the contract. When a feature is incomplete, write the test the way the feature *should* behave and let it fail — that documents the gap. Don't add `-- skip` markers, don't relax expected results to match observed output, don't comment out assertions.

## Historical: SQLite test cross-check

Between 2026-04 and 2026-05, the suite was systematically expanded by cross-checking SQLite's own test corpus (the TCL `test/*.test` files in the upstream `sqlite/sqlite` repo, with the sqllogictest corpus as a secondary reference) against `test/logic/`. The shared workspace doc was `docs/sqlite-test-crosscheck.md`; the workflow was `docs/sqlite-test-crosscheck-process.md`. Twelve `5-sqlite-xref-*` implement tickets carried out the work, one per category (SELECT/output, WHERE/BETWEEN, joins, indexes, subqueries/CTE, aggregates/windows, expressions/types, scalar functions, temporal/JSON functions, DML, DDL/constraints, transactions/bind/errors).

Key rules that shaped the resulting fixtures:

- **Applicability filter.** SQLite tests covering rowids, btree/pager/wal internals, vacuum/backup/attach, triggers, type-affinity coercion, fault injection, and file-page pragmas are `n/a` to Quereus by design — see the out-of-scope block in the cross-check doc and `docs/architecture.md` § Design Differences from SQLite. They were dead-marked, not translated.
- **Distill, don't transliterate.** SQLite TCL tests carry a lot of plumbing (procs, do_test wrappers, db open/close, file deletion). The SQL kept in our fixtures is the minimum that exercises the scenario.
- **Adapt to Quereus semantics.** NOT NULL by default, no rowids, explicit type conversions, key-based addressing — expected results were rewritten where SQLite's defaults differ. Where Quereus deliberately rejects an SQLite input, the fixture asserts the rejection via `-- error: <substring>`.
- **Failing tests were the deliverable.** The cross-check passes wrote fixtures that document gaps; making them pass is a separate downstream pass. Look for fixtures whose internal scenarios fail to find the still-open work.
- **Status calibration.** Each row in the index landed at `covered`, `partial`, `gap`, or `n/a`. `partial` and `gap` rows produced new fixtures, logged in the doc's Gaps Log with their final filenames.

The full state, status legend, per-category index, and per-fixture Gaps Log live in `docs/sqlite-test-crosscheck.md` — consult it when adding more SQLite-derived coverage so existing classifications aren't redone, and when triaging which failing fixture covers which SQLite scenario.

## Adding new tests

1. Pick the right kind: `.sqllogic` first; property test (`property.spec.ts`) only when an invariant naturally generalizes; unit test only when SQL-level coverage can't reach the surface.
2. For `.sqllogic`, name the file by feature/scenario (`between-with-nulls.sqllogic`), prefix it numerically per the run-order anchors above, and order scenarios inside the file mundane → exotic.
3. Run `yarn test` to confirm the test exercises what you expect. If it's documenting a gap, leave it failing — don't paper over it.
4. Update the relevant docs (this README, the cross-check doc, or the topic doc in `docs/`) when adding a whole new category.
