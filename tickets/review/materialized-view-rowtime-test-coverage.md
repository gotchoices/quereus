description: Review the added test coverage for row-time (write-through) materialized-view maintenance. This was COVERAGE-ONLY work — no `src/` changes. New SQL-level + spec-level tests close the gaps the original fix flagged (UPSERT / INSERT-OR-REPLACE / UPDATE-causes-REPLACE hook sites, savepoint lazy-attach of the backing connection, NULL/3-valued partial predicates, compound-PK extensions, boundary no-ops, ALTER/DROP staleness + recreate re-registration), and strengthen the previously-weak §7 eligibility and §9 DROP assertions. One real defect was discovered and filed (refresh does not re-register the row-time plan); several gate reject branches were found to be unreachable from clean SQL and documented.
files: packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/parser/parser.ts
----

## What changed (all under `test/` — zero `src/` edits)

### `test/logic/53-materialized-views-rowtime.sqllogic`
- **§7 (eligibility gate) strengthened** — each of the 8 cases now asserts its
  *distinctive* reason tail instead of the generic `cannot be materialized`. The
  literal tails were captured by running each body through the engine, not
  transcribed. Two are the deliberate "traps":
  - 2-table UNION → `its body reads more than one source table` (NOT "set
    operation" — the `tableRefs.length > 1` check fires first).
  - recursive-CTE-only body → `its body reads no source table` (NOT "recursive
    CTE" — a CTE-only body has 0 base-table refs).
- **§9 (DROP) rewritten** — the old assertion was `count(*)` on the *source*
  (always 2, proved nothing). Now: read of the dropped name errors (`not
  found`), and a freshly-created MV on the same source is maintained on the next
  write (proves detach + clean re-registration).
- **New §10–§18** (continue the file's numbering):
  - §10 UPSERT do-update (hook site 1): asserts the MV reflects the UPDATED image
    (existing cloned + assignments), `excluded.*` works, and `do update … where
    false` is DO NOTHING.
  - §11 INSERT OR REPLACE (site 2): backing key fixed (carries source PK), so the
    PAYLOAD updates in place.
  - §12 UPDATE-causes-REPLACE eviction (site 4) via `primary key on conflict
    replace`: evicted image gone, moved image present (site 4 `delete` + site 5
    `update` net correctly).
  - §13 savepoint lazy backing-connection registration (mirrors
    `04a-savepoint-lazy-attach.sqllogic`): mid-txn visibility, `rollback to`
    discards post-savepoint deltas, commit persists.
  - §14 NULL / 3-valued partial predicate: NULL predicate ⇒ out of scope;
    scope-enter / scope-leave on NULL transitions; a nullable PAYLOAD carries NULL
    through (payload NULL ≠ predicate NULL).
  - §15 same-key & shared-leading-key updates: delete-then-upsert-at-same-key
    ordering (payload-only + `set x = x` no-ops), and shared leading key with
    distinct PK (both rows survive via the PK tiebreak).
  - §16 source ALTER/DROP staleness + recreate re-registration (see DEFECT + the
    reframe note below).
  - §17 compound-PK: compound delete + compound key-change (move one PK column).
  - §18 boundary: delete of a non-existent row (maintenance never fires), delete
    of an out-of-scope row from a partial MV (`inScope(oldRow)` false ⇒ no op).

### `test/materialized-view-diagnostics.spec.ts`
- New `per-reason tails` describe: 11 data-driven cases + the MV-over-MV case,
  each asserting the literal `buildRowTimePlan` reject tail (locks reasons the
  sqllogic §7 can't all pin ergonomically, incl. the join→multi-source ordering).
- New `with refresh is a parse error` describe: `with refresh = 'row-time'` and
  `with refresh = 'bogus'` both throw the same parse error (`after CTE name`) and
  register no MV (the clause is gone; the literal is never inspected).

### `test/emit-roundtrip.spec.ts`
- New `CREATE MATERIALIZED VIEW` round-trip describe (optional item D2): bare DDL
  with NO `with refresh` policy round-trips through parse→stringify→parse.

## Validation performed
- `node … mocha "test/logic.spec.ts" --grep 53-materialized` → 1 passing.
- `node … mocha "test/materialized-view-diagnostics.spec.ts"` → 17 passing.
- `node … mocha "test/emit-roundtrip.spec.ts" --grep "MATERIALIZED VIEW"` → 5 passing.
- **Full package suite `yarn workspace @quereus/quereus test` → 3847 passing, 9
  pending, 0 failing.** No `.pre-existing-error.md` was needed.
- `yarn workspace @quereus/quereus lint` → clean.

## Reviewer: treat these tests as a FLOOR. Known gaps / honest caveats

1. **DEFECT FOUND & FILED — `refresh` does not re-register the row-time plan.**
   After a source schema change marks an MV stale (detaching its plan), `refresh
   materialized view` rebuilds the snapshot + clears `stale` but does NOT
   re-register row-time maintenance — subsequent source writes are silently
   unmaintained. Only drop+recreate fully restores it. Filed as
   `tickets/fix/materialized-view-refresh-reregister-rowtime.md`. §16 of the
   sqllogic asserts only the WORKING drop+recreate path and carries a `KNOWN GAP`
   comment pointing at that ticket — no failing assertion was added and no buggy
   behavior was enshrined. **Reviewer: confirm you agree this is a real defect and
   that not adding a (failing) regression assertion now is the right call given
   the implement stage requires a green suite.**

2. **"Key-changing update colliding with an existing backing row" was reframed
   (deviation from the ticket's §A bullet).** The backing PK is the ORDER BY
   column(s) seeded with the source PK appended (`computeBackingPrimaryKey`), so
   the source PK is ALWAYS part of the backing key → two distinct source rows can
   never share a backing key, and a cross-row backing-key collision is unreachable
   from SQL. §15 instead covers the actually-reachable cases the ticket was
   gesturing at: the delete-old/upsert-new ordering at an equal key, and a shared
   leading-key with distinct PK. If the reviewer wants a literal cross-row backing
   collision it would require a backing-PK shape that omits the source PK — not
   possible today.

3. **Several gate reject branches are UNREACHABLE from clean single-source SQL
   and were intentionally NOT pinned** (documented in the spec's NOTE): "set
   operation (union/intersect/except)", "recursive CTE", "calls a table-valued
   function", "source has no primary key", and "WHERE not evaluable on a single
   source row". Reasons: any union/join/subquery-source body surfaces ≥2 table
   refs (→ multi-source) or 0 refs for a CTE-only/TVF-only body (→ "reads no
   source table"); every base table is keyed (no PK-less table); and a
   single-table WHERE that `compilePredicate` rejects without adding a 2nd table
   ref was not found. These remain as defensive guards. If the reviewer believes
   one of these is reachable, that's a good adversarial target.

4. **`yarn test:store` was NOT run.** This sqllogic file is NOT in
   `MEMORY_ONLY_FILES`, so it also executes under the LevelDB/isolation store
   path. Assertions were kept module-agnostic (observable MV contents, patterns
   mirroring existing store-passing tests for PK-on-conflict-replace and savepoint
   lazy-attach), but store-mode was not exercised here (slower; the ticket scoped
   validation to `yarn test`). **Reviewer or CI should run `yarn test:store`** to
   confirm §10–§18 pass under the store module, especially §13 (savepoint
   lazy-attach of the backing connection) and §16 (ALTER staleness).

5. **Ground-truth facts worth re-checking** (captured via throwaway probes, since
   deleted): columns default to NOT NULL (Third Manifesto) — nullable columns in
   §14 use explicit `null`; the `with refresh` parse error message is
   incidental (`Expected 'AS' after CTE name`) because the parser reparses the
   stray clause as a CTE — a stable but indirect substring; if the parser's
   WITH-clause handling changes, this assertion may need a refresh.

## Suggested adversarial checks for the reviewer
- Re-run each §7 body and confirm the asserted tail is still the literal one
  produced (the whole point of the strengthening is to catch reason drift).
- Verify §12 (site 4) and §11 (site 2) actually drive the intended hook sites in
  `dml-executor.ts` (lines ~485, ~521, ~640) rather than an adjacent path.
- Probe whether any of the "unreachable" branches in caveat #3 can in fact be hit.
- Confirm the `refresh` defect (caveat #1) reproduces and that the filed fix
  ticket's expected-behavior section is correct.
