description: Harden test coverage for row-time (write-through) materialized-view maintenance. The shipped `53-materialized-views-rowtime.sqllogic` covers 3 of the 6 DML maintenance hook sites and several behaviors only weakly. The underlying code was reviewed and found correct; this ticket is about closing coverage gaps so future regressions are caught, not about fixing a known defect.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/parser/parser.ts
----

> **Scope note (post row-time-only consolidation).** `materialized-view-rowtime-only-consolidation`
> makes row-time the *sole* MV model and **removes the `with refresh = '...'`
> clause** — the DDL becomes a bare `create materialized view v as select …`. Every
> example below that writes `with refresh = 'row-time'` is now just
> `create materialized view`. The "round-trip the `row-time` policy" and
> "parse-error for an unknown refresh literal" spec ideas at the bottom are
> superseded: instead assert the bare DDL round-trips and that **any** `with
> refresh` clause is now a parse error. Maintenance also batches per-statement
> (not strictly per-row) after the consolidation — the six hook sites still fire,
> but a multi-row statement flushes once; keep that in mind when asserting backing
> contents mid- vs post-statement.

## Why

The row-time write-through maintenance hook (`maintainRowTimeStructures` in
`dml-executor.ts`, lines ~80-87) is invoked at **six** DML sites:

1. UPSERT do-update (`insert ... on conflict do update`)
2. INSERT-OR-REPLACE eviction (at the insert site)
3. normal INSERT
4. UPDATE-causes-REPLACE eviction (evicted row → `delete` change)
5. normal UPDATE
6. normal DELETE

The committed test file (`53-materialized-views-rowtime.sqllogic`) exercises only
**sites 3, 5, 6** (plain insert/update/delete). Sites 1, 2, 4 — the UPSERT and the
two REPLACE-eviction paths — have **zero** SQL-level coverage. These are precisely
the paths most likely to harbor an old/new-row or op-ordering bug (each REPLACE
eviction emits *two* changes — a delete for the evicted row plus an insert/update
for the survivor).

A focused adversarial review confirmed the code at all six sites is currently
correct (old/new row images match what `_recordX` recorded; the eviction
delete + update net to the correct backing state). So this is coverage debt, not a
live bug — but the untested sites are a regression hazard, especially ahead of the
downstream `covering-structure-mv-rowtime-enforcement` work which builds on the same
backing table.

## Important constraint discovered during review

`UPDATE OR REPLACE t SET ...` **does not parse** in Quereus today — the parser
errors with `near "or": syntax error`. So site 4 (UPDATE-causes-REPLACE eviction)
appears to be **unreachable from SQL** via the `UPDATE OR REPLACE` form. Before
writing a test for it, confirm whether the `onConflict === 'replace'` UPDATE path
(`_applyUpdateWithReplace` / the executor's replace-on-update branch) is reachable
at all — e.g. via a table/column-level `on conflict replace` declaration, or only
internally. If it is genuinely unreachable, document that (and consider whether the
dead branch should be removed or a parser feature filed) rather than forcing a test.

NOTE on sqllogic DDL syntax: the `with refresh = '...'` clause must come **after**
the view body, e.g. `create materialized view v as select ... with refresh =
'row-time';` — not before `as`.

## Coverage to add

Each item below is a missing or weak assertion; cite the scenario it strengthens.

- **UPSERT do-update write-through (site 1).** `insert into rt values (<existing pk>,
  …) on conflict do update set x = …;` then read the MV and assert the backing row
  reflects the *updated* image (`updatedRow` is existing-cloned-then-assignments).
- **INSERT-OR-REPLACE eviction (site 2).** `insert or replace into rt values
  (<existing pk>, <new x>);` — assert the MV reflects the replacement, including the
  key-moving case where the projected backing key changes.
- **UPDATE-causes-REPLACE eviction (site 4).** Only if reachable (see constraint
  above): an update that collides on a secondary unique index, evicting a row with a
  *different* PK; assert the evicted row's backing image is gone and the moved row's
  is present.
- **Savepoint interaction.** `begin; insert A; savepoint sp; insert B; insert C;
  rollback to sp;` then read the MV → must show A, not B/C; then `release`/`commit`
  and confirm A persists. This stresses the lazily-registered backing connection's
  savepoint-depth replay (`getBackingConnection` → `registerConnection`), the same
  lazy-attach hazard `04a-savepoint-lazy-attach.sqllogic` guards for user tables but
  which is untested for the backing connection.
- **NULL / 3-valued predicate (partial MV).** `applyRowTimeChange.inScope` uses
  `predicate.evaluate(row) === true`, so a predicate evaluating to NULL is
  out-of-scope. For a partial MV `where x > 0`: insert with `x = NULL` → no backing
  row; update in-scope→NULL → row leaves; NULL→positive → row enters. Also a
  nullable *projected payload* column carrying NULL through to the backing row.
- **Key-changing update colliding with an existing backing row.** Construct a
  covering MV where an in-scope key-changing update's new backing key equals another
  live row's key; assert both rows end correct (guards the delete-old/upsert-new
  ordering in `applyRowTimeChange`).
- **ALTER / DROP of the source + re-registration.** ALTER the source of a row-time
  MV (add/rename a non-projected column), then write the source — assert correct
  continued maintenance or a clean `stale` diagnostic, not a crash. DROP the source
  → MV reads stale. Recreate a row-time MV after DROP → assert the new plan is
  maintained (proves `releaseRowTime`/`rowTimeBySource` clean re-registration).
- **Compound-PK beyond §6.** Add to the compound-PK scenario: a `delete` (compound
  delete-key) and a key-changing update of one PK column (compound key move).
- **Boundary cases.** No-op update (`set x = x`), delete of a non-existent row, and
  delete of an out-of-scope row from a partial MV (backing unchanged, no error).

## Strengthen weak assertions already present

- **§8 eligibility rejections** currently all assert only `-- error: row-time`.
  Because every `buildRowTimePlan` reject emits that same phrase, the 9 cases prove
  "errors mentioning row-time", not "errors for the claimed reason". Assert the
  distinctive tail of each diagnostic (e.g. `does not support aggregate`, `join`,
  `DISTINCT`, `every projected column`, `every source primary-key column`).
- **§9 DROP** asserts `count(*)` on the *source* table `dr` (always 2 regardless of
  maintenance). Replace with an assertion that proves the backing plan was detached
  — e.g. re-create a different row-time MV on `dr` and confirm it is maintained
  while a stale read of the dropped name errors.

## Also worth a small spec-level test (optional, separate from sqllogic)

- Round-trip `create materialized view ... with refresh = 'row-time'` through
  `ast-stringify` (no existing test asserts the `row-time` policy round-trips).
- A parse-error test for an unknown refresh literal (`with refresh = 'bogus'`).
- A `row-time` case in `change-scope.spec.ts` (only the incremental projection is
  covered today).
