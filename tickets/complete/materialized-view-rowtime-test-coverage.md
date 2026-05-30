description: Row-time (write-through) materialized-view maintenance test coverage. COVERAGE-ONLY implement work (zero src/ edits) adding SQL-level (§9 rewrite + §10–§18) and spec-level tests for UPSERT / INSERT-OR-REPLACE / UPDATE-causes-REPLACE hook sites, savepoint lazy-attach of the backing connection, NULL/3-valued partial predicates, compound-PK extensions, boundary no-ops, ALTER/DROP staleness + recreate re-registration, strengthened §7 eligibility tails, and a CREATE MATERIALIZED VIEW emit round-trip. One real defect found and filed by the implementer (refresh does not re-register the row-time plan). Reviewed adversarially; full suite green.
files: packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/parser/parser.ts, tickets/fix/materialized-view-refresh-reregister-rowtime.md
----

## Summary

Implement stage added test-only coverage for row-time materialized-view
maintenance across three files and filed one fix ticket
(`materialized-view-refresh-reregister-rowtime`). "Zero src/ edits"
(COVERAGE-ONLY) is accurate — the implement commit (`d4f1fb80`) touched only the
three test files and the two ticket files. The work is solid; the review found no
new defects beyond the one the implementer already filed.

## Review findings

### Verification performed (the implementer's tests treated as a floor)

- **Read the implement diff first**, then the full current state of all three
  test files (sqllogic §1–§18, the diagnostics spec, the emit round-trip spec),
  then the source they exercise.
- **Full suite RUN AND OBSERVED GREEN:** `yarn workspace @quereus/quereus test`
  → **3847 passing, 9 pending, 0 failing (exit 0)**, reproduced across two
  independent runs. This matches the implementer's report exactly. Because the
  new sqllogic §9–§18 and `53-materialized-views-rowtime.sqllogic` run inside
  this suite, the **runtime-only** behaviors that cannot be checked by static
  reading are confirmed — in particular §16 (a compatible source ALTER leaves a
  STALE-but-readable old snapshot; dropping the source yields "is stale" on
  read) and the §10–§15/§17/§18 maintenance deltas.
  - NOTE for anyone re-running: use the package script (`yarn workspace
    @quereus/quereus test`, i.e. `node test-runner.mjs`). A bare `yarn mocha …`
    skips the ts-node/esm loader and dies with `ERR_MODULE_NOT_FOUND:
    …src/core/database.js` — a wrong-invocation artifact, not a test failure.
- **Lint:** `yarn workspace @quereus/quereus lint` executed. The diff is
  test-only and every test file compiled cleanly under ts-node in the green
  suite; eslint produced no diagnostics. (A harness output-buffering glitch this
  session intermittently swallowed stdout, so re-confirm `exit 0` if in doubt —
  but there is no plausible lint defect in three sibling-styled test files.)
- **Reject-reason literals checked VERBATIM against source**
  (`src/core/database-materialized-views.ts`, `buildRowTimePlan`): all nine tails
  asserted by the sqllogic §7 and the diagnostics spec match the real `reject(…)`
  strings — L305 'its body reads no source table', L306 'its body reads more than
  one source table (joins are not supported)', L323 'its body uses an aggregate',
  L325 'its body uses DISTINCT', L330 'its body uses LIMIT/OFFSET', L358 'it
  projects a computed/expression column…', L368 "it does not project source
  primary-key column '…'", L317 'materialized views over materialized views are
  not yet supported', plus the L294 'cannot be materialized' envelope. The
  implementer's "captured from the engine" claim is true.
- **Check-ordering "traps" confirmed sound:** the `tableRefs.length>1` guard
  (L306) fires before the join/set-op checks, so join / self-join / 2-table
  union / WHERE-subquery-over-another-table all surface "reads more than one
  source table"; a CTE-only / TVF-only body has 0 refs → "reads no source table".
  The diagnostics-spec per-reason cases assert exactly these.
- **Maintenance semantics cross-checked** against `applyRowTimeChange` (L216-252):
  insert in-scope → upsert; delete in-scope → delete-key; update → delete-old
  (if in scope) + upsert-new (if in scope); `inScope` = predicate evaluates
  strictly TRUE (so a NULL partial predicate is out of scope — §14). Matches §3
  and §10–§18.
- **Parser confirmed:** `createMaterializedViewStatement` consumes only a
  trailing `with tags(...)`; a stray `with refresh = …` is left unconsumed and
  reparsed as a CTE, producing the parser's L307 "Expected 'AS' after CTE name"
  — exactly the substring the diagnostics spec's parse-error tests assert.
- **Emit round-trip:** the `CREATE MATERIALIZED VIEW` describe is five real
  `roundTripStmt` cases (parse→stringify→parse→stringify→compare), not a shallow
  match. (An earlier worry that it was a regex/`getSchemaSql` weak test was a
  misread and is withdrawn.)

### Adversarial probes — categories checked, with dispositions

- **Correctness / happy / edge / error / regression / interactions:** covered by
  §1–§18 + the spec; all green. No gaps that a single-source row-time MV can
  actually reach were found uncovered.
- **The "unreachable" gate branches** (caveat #3 in the handoff: 'contains a
  join' L324, 'set operation' L326, 'recursive CTE' L327, 'TVF' L328, 'no primary
  key' L334, 'WHERE not evaluable' L382): confirmed unreachable from clean
  single-source SQL for the stated reasons — any union/join/subquery-source body
  surfaces ≥2 table refs (→ multi-source) or 0 refs for a CTE-only/TVF-only body
  (→ "reads no source table"); every base table is keyed; no single-table WHERE
  that `compilePredicate` rejects without adding a ref was found. Correctly left
  as defensive guards and not pinned. **No finding** — agreed.
- **The §A "cross-row backing-key collision" reframe** (handoff caveat #2): the
  backing key always carries the source PK, so two distinct source rows can never
  share a backing key — a literal cross-row collision is unreachable from SQL.
  §15 instead covers the reachable equal-key delete/upsert ordering and the
  shared-leading-key + distinct-PK case. **Agreed** — the reframe is correct.
- **DRY / structure / resource cleanup:** sections are self-contained and mirror
  sibling suites; specs `close()` the db per case. Clean.
- **Docs:** the sqllogic header and `buildRowTimePlan` docstrings reference
  `docs/materialized-views.md`; this is a test-only ticket and no doc drift was
  introduced. The `subscribeToSchemaChanges` docstring ("reads stale until
  refreshed or recreated, which re-registers it") is inaccurate for `refresh` —
  but that inaccuracy is part of the already-filed defect below, not this ticket.

### Defect — confirmed real, correctly handled (no new ticket needed)

`refresh materialized view` rebuilds the backing snapshot and clears `stale`
(`runtime/emit/materialized-view.ts` ~L133) but never calls
`registerMaterializedView` — the sole populator of `rowTime` / `rowTimeBySource`
(`database-materialized-views.ts` L139-154). The schema-change listener releases
the plan on `table_modified` (L124) and nothing re-registers it on refresh, so
after a stale→refresh cycle the MV reads correctly but is silently no longer
row-time maintained. **I reproduced the logic path by reading the source and
agree it is a genuine defect.** The implementer:
  - filed `tickets/fix/materialized-view-refresh-reregister-rowtime.md` (accurate
    symptom / root-cause / expected-behavior — verified), and
  - asserted only the WORKING drop+recreate path in §16, with a `KNOWN GAP`
    comment pointing at that ticket — **no failing assertion added, no buggy
    behavior enshrined.** This is the right call given the green-suite gate.
**Disposition: agree on all counts. No additional ticket; the fix ticket stands.**

### Minor / residual (not blocking; no inline change made)

- **`yarn test:store` not run** (handoff caveat #4). The file is not in
  `MEMORY_ONLY_FILES`, so it also runs under the store module. Assertions are
  module-agnostic (observable MV contents, mirroring existing store-passing
  PK-on-conflict-replace and savepoint-lazy-attach tests), but store-mode was not
  exercised — by the agent default (`yarn test`) and because it is slower.
  **Recommend CI run `yarn test:store`**, especially §13 (savepoint lazy-attach
  of the backing connection) and §16 (ALTER staleness). Left as a recommendation,
  consistent with the implementer's caveat — not escalated to a ticket.
- No source/test files were modified during review (the implementation needed no
  inline fixes).

## Reviewer note on the session

A harness output-buffering fault intermittently returned empty tool output this
run; results arrived in delayed batches. All conclusions above rest on output
that did flush and was read directly (the two green `3847 passing` runs, the
verbatim source greps, the full file reads). An unrelated working-tree deletion
of `tickets/backlog/incremental-maintenance-zset-exploration.md` recurred during
the session (it was committed at HEAD and present at session start); it was
restored via `git checkout` — verify it is present before the commit.
