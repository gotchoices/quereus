# SQLite Test Cross-Check — Process

This document defines **how** the SQLite test cross-check work is executed. The shared **state** lives in [`sqlite-test-crosscheck.md`](sqlite-test-crosscheck.md) (the index of SQLite test files mapped to existing Quereus coverage, plus the out-of-scope block). Tickets in `tickets/implement/5-sqlite-xref-*.md` carry out the work, one category section per ticket.

## Goal

Use SQLite's test suite as a starting point to expand `packages/quereus/test/logic/` coverage. Where SQLite covers a feature scenario we don't, write a Quereus test that does. The new test files in `test/logic/` are the deliverable; making them pass is a separate, downstream pass.

## Critical constraints (these override default tess behavior)

1. **Do not run tests, build, or debug.** No `yarn test`, no `yarn build`, no diagnostics. This ticket only creates tests; making them pass is a separate downstream pass. The default tess instruction "ensure build and tests pass" does **not** apply to these tickets — don't try to satisfy it.
2. **Do not modify engine code.** Only `docs/sqlite-test-crosscheck.md`, new `.sqllogic` files under `packages/quereus/test/logic/`, and (rarely) `packages/quereus/test/property.spec.ts` or a `test/*.spec.ts` are touched.
3. **Do not mirror SQLite tests in bulk.** Distill scenarios; don't transliterate the TCL.
4. **`n/a` rows produce no test files.** Mark the row `n/a` with a one-line reason in Notes and move on.
5. **Stay within the assigned section.** Don't drift into adjacent categories.
6. **Don't track gaps separately.** The new test files **are** the record. There's no gaps log to maintain.

## Sources

- **Primary**: SQLite TCL test suite. GitHub mirror: <https://github.com/sqlite/sqlite>, `test/` directory.
  - Raw fetch URL pattern: `https://raw.githubusercontent.com/sqlite/sqlite/master/test/<file>.test`
  - If a file isn't present at that path, search the `sqlite/sqlite` repo or report back unmapped — don't fabricate.
- **Secondary**: SQLite sqllogictest corpus, <https://www.sqlite.org/sqllogictest/>. Format-aligned but auto-generated; useful for bulk regression patterns when TCL coverage is thin.

## Per-ticket workflow

Each ticket targets exactly one section of `docs/sqlite-test-crosscheck.md`.

1. Read this process doc and the assigned section of the index doc.
2. Dispatch one Explore subagent per SQLite source file (multi-file rows fan out into multiple subagents), in parallel batches of 4–8. Use the [subagent prompt template](#subagent-prompt-template).
3. As subagent reports return, collate them:
   - For rows where existing Quereus fixtures already cover everything: write nothing new.
   - For rows where the SQLite file exercises scenarios Quereus doesn't: write the proposed fixture(s) following the [test output guidance](#test-output-guidance).
   - For `n/a` rows: write nothing; just record the reason.
4. Update each row in the index doc to its final Status:
   - `reviewed (<handle>, YYYY-MM-DD)` — cross-check done; any new fixtures live in `test/logic/`. Optionally update the Coverage column to add new fixture filenames the reviewer wrote, so the index stays current.
   - `n/a (<short reason>)` — design-excluded.
5. When the section is done, move the ticket to `tickets/review/` per `tess/agent-rules/tickets.md`. The review summary lists how many rows were reviewed, how many were `n/a`, and the new fixture filenames written.

Do not run any test, build, or lint command at any point. The review summary states explicitly that no tests were run.

## Status calibration

The index doc has only three status values: `unreviewed`, `reviewed`, `n/a`. The reviewer's job per row is one decision tree:

1. Does the SQLite scenario apply to Quereus by design?
   - **No** → `n/a (<reason>)`. Don't write tests.
2. Do existing Quereus fixtures (in the row's Coverage column, plus any others uncovered by greppe) already exercise the meaningful scenarios?
   - **Yes** → `reviewed`. Don't write tests.
   - **Partly or no** → `reviewed`. Write tests for the uncovered scenarios.
3. Genuinely uncertain — can't tell whether Quereus's behavior should match the SQLite test, or whether existing fixtures count?
   - Leave Status as `unreviewed` with a one-line Notes entry explaining what would resolve it. **Do not hedge — uncertainty is honest output.**

A scenario that depends on SQLite-specific behavior (implicit type-affinity coercion, rowid arithmetic, autoincrement) is `n/a` *for that scenario* — don't write a test that asserts SQLite's behavior. If the whole row is `n/a` for that reason, mark the row.

## Test output guidance

### Preference order

1. **`.sqllogic` (logic test)** — strongly preferred. Black-box SQL + expected results. Goes in `packages/quereus/test/logic/`.
2. **Property test** — only when the feature has an invariant naturally expressed over many inputs (idempotence, roundtrip, ordering, antisymmetry). Add to `packages/quereus/test/property.spec.ts`.
3. **Unit test** — only when SQL-level testing can't reach the surface (parser-internal behavior, planner state, vtab interface details). Add to the existing `test/<area>/*.spec.ts` for that subsystem.

Do not invent a new test harness. Do not add a new top-level test directory.

### Naming and placement

- New `.sqllogic` files go directly in `packages/quereus/test/logic/` and follow existing convention — feature- or scenario-named (`between-with-nulls.sqllogic`, `orderby-collate-nocase.sqllogic`, `compound-select-order-by.sqllogic`). No "from this exercise" prefix — they're regular tests once written.

- **The numeric prefix determines run order, and run order matters.** Tests run lowest-number-first; we want mundane scenarios to fail before exotic ones so the first failure exhibits in its most general form. Every new file MUST get a numeric prefix that places it correctly in the existing sequence.

  How to pick the prefix:
  1. Find the existing test whose topic is closest to the new file's. Skim adjacent numbers (`ls test/logic/`) so you understand the local ordering.
  2. Place the new file **after** the basic-coverage test for that topic and **before** any edge-case test for that topic. Existing convention puts edge cases in the 20s (`21-null-edge-cases`, `25-aggregate-edge-cases`, `26-join-edge-cases`) and 90s+ (`91-merge-join-edge-cases`, `96-subquery-edge-cases`, `99-conversion-edge-cases`); new edge-case files belong there too.
  3. Use a decimal sub-number to slot between adjacent files when needed (e.g., between `06.2-math-functions` and `06.3-schema` use `06.2.1-…`). Don't renumber existing files.
  4. Mundane → exotic guideline by major number group — use these as anchors, not rigid rules:
     - `01–17` — feature basics: parser/expressions, transactions, vtab, builtins, aggregates, joins, set ops, CTEs, temporal.
     - `20–29` — feature edge cases (NULL, boundaries, self-join duplicates, etc.).
     - `40–50` — semantics-heavy features (constraints, FKs, generated cols, RETURNING, declarative schema, assertions).
     - `80–86` — optimizer / plan-shape concerns.
     - `90–99`, `100+` — error paths, edge cases, mutation kills.
  5. If genuinely uncertain, prefer placement nearer to its topic's basic-coverage anchor (lower number) over piling more files into the 90s+ block.

- **Internal ordering inside a file: mundane → exotic.** Start with the simplest scenario that exercises the feature; build up to NULL, type mixes, boundaries, error cases. The same reasoning applies — you want the most general failure to surface first when reading test output.

- One file per index row when feasible. Combine only when scenarios share a fixture schema and would otherwise duplicate setup verbatim.

- An optional one-line comment at the top of the file citing the SQLite source is fine for provenance (`-- adapted from SQLite test/where5.test`), but treat it as a regular comment, not a magic marker. Don't depend on it for tooling.

- Property tests: add scenarios into existing `describe(...)` blocks in `property.spec.ts` where they fit thematically; create a new `describe(...)` only if a new theme is warranted.

- Unit tests: add to the existing `test/<area>/*.spec.ts` files in conventional style.

### Style

- Match existing fixtures: lowercase SQL keywords, expected results on the next line marked `→ <json>`, errors marked `-- error: <substring>`.
- Use the simplest table schema that exercises the scenario. Don't drag in unrelated features.
- Distill — don't translate SQLite tests literally. SQLite TCL tests have a lot of plumbing (procs, loops, eval); the SQL you keep should be the minimum that demonstrates the scenario.
- Quereus differs from SQLite (NOT NULL by default, no rowids, explicit type conversions, etc.). Adapt expected results to Quereus semantics — don't paste SQLite's expected values when they would conflict.
- If Quereus deliberately rejects the SQLite input (e.g., implicit coercion the engine doesn't allow), the test should use `-- error: <substring>` so it passes by failing in the documented way.

### Write tests faithfully — don't pre-soften

You won't run the tests, so there's no failure to react to. Write each test asserting what the SQLite scenario demonstrates *should* work, then stop. Do not:

- Add `-- skip` markers.
- Weaken assertions or remove expected results because you suspect Quereus might not produce them.
- Comment out scenarios you think will fail.
- Rewrite the SQL into a form you guess Quereus will accept, when the original form is what the scenario actually demonstrates.

The next pass will run the tests, see what fails, and decide what to do about it (fix the engine, fix the test, or reclassify). That's not your concern here — your concern is documenting the scenario faithfully.

The only legitimate reason to assert failure (`-- error: <substring>`) is when Quereus's design *documented* in `docs/architecture.md`, `docs/types.md`, etc. — explicitly rejects the input (e.g., implicit affinity coercion). That's a "passes by failing in the documented way" test, not a hedge.

If a scenario doesn't apply to Quereus *at all* (rowids, triggers, etc.), the whole row is `n/a` and you write nothing for it. If you find yourself wanting to skip-mark a test, the row is `n/a`.

## Subagent prompt template

Dispatch Explore subagents (read-only) — one per SQLite source file. Suggested prompt body, with `<FILE>` and `<ROW-COVERAGE>` filled in by the orchestrator:

```
You are cross-checking SQLite test/<FILE>.test against Quereus's test/logic/
fixtures. Read docs/sqlite-test-crosscheck-process.md first; it defines the
status calibration, output preferences, and constraints.

DO NOT run tests, build, or modify any files. You are reading and reporting
only.

Steps:

1. WebFetch
   https://raw.githubusercontent.com/sqlite/sqlite/master/test/<FILE>.test
   Read it end-to-end. Build a checklist (5-25 bullets) of distinct
   feature scenarios it exercises. Ignore TCL plumbing (proc, do_test
   wrappers, db close/open, file deletion).
   If the URL 404s, search the sqlite/sqlite repo for the correct path and
   report back unmapped instead of guessing.

2. For each Quereus file listed in <ROW-COVERAGE>, read it and mark which
   bullets it covers.

3. Grep packages/quereus/test/logic/ and packages/quereus/test/*.spec.ts for
   keywords from your checklist in case the survey missed coverage.

4. For each bullet, decide:
   - APPLIES + COVERED  — Quereus already exercises this. No new test.
   - APPLIES + UNCOVERED — Propose a new fixture (see step 5).
   - N/A                — Doesn't apply to Quereus by design; one-line
                          reason.

5. For each UNCOVERED bullet, propose a fixture:
   - kind: sqllogic | property | unit
   - filename: feature- or scenario-named .sqllogic in
     packages/quereus/test/logic/, with a numeric prefix that places it
     correctly in run order (mundane → exotic). Suggest a number by
     looking at adjacent existing files for the same topic — basics go
     in the low ranges (01–17), feature edge cases in the 20s, error
     paths and exotic edge cases in the 90s+. The orchestrator may
     adjust if your suggestion conflicts with another scenario in the
     same batch. Inside the file, also order scenarios mundane → exotic.
     For property/unit, give the existing target file or describe-block
     name.
   - sql: paste the minimal SQL ready to drop in (schema setup +
     statement(s) + expected results in `→ <json>` form, or `-- error:
     <substring>` if failure is expected by design). Order statements
     simplest first.
   - rationale: one line — what the SQLite test was demonstrating.

6. Calibrate confidence honestly. If you can't tell whether the row's whole
   feature applies, return status `unreviewed` and say what would resolve it.

Return under 600 words, in this shape:

  row-status: reviewed | n/a | unreviewed
  n/a-reason (n/a only): <one sentence>
  unreviewed-reason (unreviewed only): <what additional input would resolve>
  bullets-uncovered (reviewed only):
    - description: <short>
      kind: sqllogic | property | unit
      filename: <suggested>
      sql: |
        <minimal SQL, ready to paste>
      rationale: <one line>
  bullets-covered: <count or short list>
  bullets-na: <count or short list, if any>
  confidence: high | medium | low
  notes: <one short paragraph or omit>
```

## Stopping rules and recovery

- **One ticket = one section.** Do not drift into other sections.
- **Don't reshape the index schema.** Splitting a row inline is allowed; renaming columns is not.
- **Budget**: if a section is too large to finish in one ticket context, spawn a sibling implement ticket (`5-sqlite-xref-<category>-part2.md`) for the remaining rows and stop cleanly. Mention in the review summary that part 2 was created.
- **No tests run.** Successful exit requires only: index row Status updates, new fixture files. No `yarn` invocations.

## Definition of done (for the ticket)

- Every row in the assigned section has a final Status: `reviewed` or `n/a` (or, in rare cases, `unreviewed` with a clear note explaining what's needed).
- New fixture files exist under `packages/quereus/test/logic/` with reasonable feature-named filenames and correct numeric prefixes (or appropriate `*.spec.ts`). Failing tests are expected.
- No engine code modified.
- No test, build, or lint commands were executed.
- The review-stage summary lists row counts (reviewed/n/a/unreviewed) and the new fixture filenames written.
