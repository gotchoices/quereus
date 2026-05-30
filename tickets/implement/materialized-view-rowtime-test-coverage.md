description: Close the row-time (write-through) materialized-view maintenance test-coverage gaps. The shipped `53-materialized-views-rowtime.sqllogic` exercises only 3 of the 6 DML maintenance hook sites (plain insert/update/delete) and asserts several behaviors weakly. The underlying code was reviewed and found correct — this is coverage debt, not a live bug. Add SQL-level coverage for the UPSERT and the two REPLACE-eviction hook sites, strengthen the eligibility/DROP assertions, and add focused spec-level tests for the gate diagnostics + the now-removed `with refresh` clause.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic, packages/quereus/test/logic/04a-savepoint-lazy-attach.sqllogic
----

## Context (research already done — design against these facts)

The consolidation prereq has effectively **landed in the code**: the committed
`53-materialized-views-rowtime.sqllogic` is already in the post-consolidation
shape — bare `create materialized view v as select …` DDL (no `with refresh`),
and the create-time gate diagnostic is `cannot be materialized` (§7), not the old
`row-time` phrasing. Design against the current file, not the original fix-ticket's
section numbers.

### The six row-time maintenance hook sites (verified)

`maintainRowTimeStructures` (`dml-executor.ts` lines ~80-87) → `applyRowTimeChange`
(`database-materialized-views.ts` lines ~216-252). Each source row-write applies
a pure-projection backing delta to the backing table's *pending* transaction layer
synchronously (reads-own-writes mid-statement; committed/rolled-back in lockstep).
Maintenance is **per source row** (not per-statement-batched) — each call applies
its ops to the pending layer immediately, which is exactly why mid-statement and
multi-row reads-own-writes hold. The six call sites:

| # | Site | `dml-executor.ts` | op emitted | Covered today? |
|---|------|-------------------|------------|----------------|
| 1 | UPSERT do-update | ~485-486 (`processInsertRow`) | `update` (old=existingRow, new=updatedRow) | **No** |
| 2 | INSERT-OR-REPLACE eviction | ~521 (`processInsertRow`, `replacedRow`) | `update` (old=replacedRow, new) | **No** |
| 3 | normal INSERT | ~536 | `insert` | Yes (§1,§4) |
| 4 | UPDATE-causes-REPLACE eviction | ~640-641 (`processUpdateRow`, `result.replacedRow`) | `delete` (old=evicted) | **No** |
| 5 | normal UPDATE | ~656-657 | `update` | Yes (§1,§3) |
| 6 | normal DELETE | ~755-756 | `delete` | Yes (§1,§3) |

### Site-4 reachability — RESOLVED: it IS reachable from SQL

The original fix ticket flagged uncertainty here. Resolution: `update or replace`
does **not** parse, but site 4 does not need it. `processUpdateRow`'s
`result.replacedRow` branch is fed by the memory manager's
`performUpdateWithPrimaryKeyChange` (`vtab/memory/layer/manager.ts` ~801-846),
which returns `replacedRow` when **a key-changing UPDATE moves a row onto an
occupied PK and the effective PK conflict action is REPLACE**. That action is
reachable from plain SQL via a `primary key on conflict replace` default
(column- or table-level) — no statement-level `OR REPLACE` needed. See the
existing template at `29.1-column-level-conflict-clause.sqllogic:96-108`
("UPDATE path honors PRIMARY KEY ON CONFLICT REPLACE"):

```sql
create table pk_upd_replace (id integer primary key on conflict replace, v text);
insert into pk_upd_replace values (1, 'a'), (2, 'b');
update pk_upd_replace set id = 2 where id = 1;   -- evicts (2,'b'), moves (1,'a')→(2,'a')
select id, v from pk_upd_replace order by id;
→ [{"id":2,"v":"a"}]
```

Note the **eviction is a PK-change collision**, not a secondary-unique collision —
the original ticket's "collides on a secondary unique index" framing is wrong for
this hook. A secondary-UC REPLACE returns a constraint result, not `replacedRow`,
so it does not drive site 4. Build the site-4 test on a `primary key on conflict
replace` source.

### Create-time gate diagnostics — actual distinctive tails

Every reject in `buildRowTimePlan` (`database-materialized-views.ts` ~287-395) is
wrapped as: `materialized view '<name>' cannot be materialized: <detail>. A
materialized view must be row-time maintainable …`. The `<detail>` tails are the
real distinctive strings — **but check-ordering matters and some differ from the
naive expectation**:

- aggregate → `its body uses an aggregate`
- **join → trips `its body reads more than one source table (joins are not supported)` FIRST** (the `tableRefs.length > 1` check precedes `containsAnyJoin`), not "its body contains a join". A single-source self-join also surfaces ≥2 table refs.
- DISTINCT → `its body uses DISTINCT`
- set op → `its body uses a set operation (union/intersect/except)`
- recursive CTE → `its body uses a recursive CTE`
- TVF → `its body calls a table-valued function`
- LIMIT/OFFSET → `its body uses LIMIT/OFFSET`
- no source PK → `its source '<base>' has no primary key`
- computed/expression column → `it projects a computed/expression column`
- dropped PK column → `it does not project source primary-key column '<name>'`
- WHERE not single-row → `its WHERE is not evaluable on a single source row`
- MV-over-MV → `materialized views over materialized views are not yet supported`

**The implementer MUST run each §7 case and capture the literal tail it actually
produces** before asserting it — do not transcribe this table blind; the join /
multi-source ordering is the trap this whole strengthening exists to catch. The
sqllogic `-- error: <substring>` directive matches a substring of the message
(confirmed by the existing `-- error: cannot be materialized`), so assert the
shortest unambiguous tail per case.

### `with refresh` is now a parse error

`createMaterializedView` (`parser.ts` ~2592-2601) consumes only a trailing
`with tags (...)`; any other `WITH` clause is backed up (`this.current--; break`)
and left unconsumed, so `… as select … with refresh = 'row-time'` fails at the
statement boundary. Assert that **any** `with refresh` clause is a parse error
(supersedes the original "round-trip the row-time policy" idea). Confirm the exact
message by running it; assert a stable substring.

## TODO

### A. New sqllogic sections in `53-materialized-views-rowtime.sqllogic`

Append new numbered sections (continue the existing numbering, currently ending at
§9). Use the covering shape `select <payload>, <pk> from <src> [where …] [order by …]`
so the backing key carries the source PK. Read the MV back to observe maintenance.

- **Site 1 — UPSERT do-update write-through.** `create table u (id integer primary
  key, x integer); insert into u values (1,10);` then
  `insert into u values (1, 999) on conflict do update set x = excluded.x;`
  (verify the engine's UPSERT `excluded`/assignment surface first — see
  `parseUpsertClause`; if `excluded` isn't supported use a literal/`x = x + …`
  form). Assert the MV reflects the **updated** image (`updatedRow` = existing
  cloned then assignments applied), not the proposed insert row. Add a
  `do update … where`-skips case (WHERE false ⇒ DO NOTHING ⇒ backing unchanged).

- **Site 2 — INSERT-OR-REPLACE eviction.** `insert or replace into u values (1, 7);`
  on an existing PK. The source PK is fixed by the collision, so the backing key
  (= source PK) does **not** move — assert the backing **payload** updates for that
  key (drop the original ticket's "key-moving" qualifier; it cannot occur here).

- **Site 4 — UPDATE-causes-REPLACE eviction.** Build on a `primary key on conflict
  replace` source (template above). Covering MV over it; two live rows; a
  key-changing UPDATE that moves one row's PK onto the other's. Assert: the evicted
  row's backing image is **gone** and the moved row's backing image is present
  under the new key. This exercises the op-`delete` for the evicted row (site 4)
  *plus* the op-`update` for the survivor (site 5) — both must net correctly.

- **Savepoint interaction (lazy backing-connection registration).**
  `begin; insert A; savepoint sp; insert B; insert C; rollback to sp;` then read the
  MV → must show A only; then `release`/`commit` → A persists. Stresses
  `getBackingConnection` → `registerConnection` savepoint-depth replay for the
  lazily-attached backing connection (the same lazy-attach hazard
  `04a-savepoint-lazy-attach.sqllogic` guards for user tables, untested for the
  backing connection). Mirror that file's structure.

- **NULL / 3-valued predicate (partial MV).** `applyRowTimeChange.inScope` uses
  `predicate.evaluate(row) === true`, so a NULL predicate is out-of-scope. For a
  partial MV `where x > 0`: insert `x = NULL` → no backing row; update in-scope→NULL
  → row leaves; NULL→positive → row enters. Plus a nullable projected *payload*
  column carrying NULL through to the backing row (payload NULL ≠ predicate NULL).

- **Key-changing update colliding with an existing backing row.** Covering MV where
  an in-scope key-changing UPDATE's new backing key equals another live row's key;
  assert both rows end correct (guards the delete-old/upsert-new ordering in
  `applyRowTimeChange`'s UPDATE branch).

- **ALTER / DROP of the source + re-registration.** ALTER the source of a row-time
  MV (add a non-projected column), then write the source → assert continued correct
  maintenance OR a clean `stale` diagnostic (whichever the schema-change listener
  produces — a source `table_modified` event calls `releaseRowTime` + marks stale;
  determine and assert the real behavior, not a crash). DROP the source → MV reads
  stale/errors cleanly. Recreate a row-time MV after DROP → assert the new plan is
  maintained (proves `releaseRowTime`/`rowTimeBySource` clean re-registration).

- **Compound-PK beyond the existing §5.** Add to the compound-PK scenario: a
  compound `delete` and a key-changing update of one PK column (compound key move).

- **Boundary cases.** No-op update (`set x = x` — old/new both in-scope, same key:
  delete-key then upsert at same key, net unchanged), delete of a non-existent row
  (no `result.row` ⇒ maintenance never fires ⇒ backing unchanged, no error), delete
  of an out-of-scope row from a partial MV (`inScope(oldRow)` false ⇒ no op).

### B. Strengthen existing sqllogic assertions

- **§7 eligibility rejections** — currently 8 cases all asserting only
  `-- error: cannot be materialized`, which proves "errors mentioning the gate",
  not "errors for the claimed reason". Strengthen each to assert its distinctive
  tail (table above) **after running to capture the literal string** — especially
  the join case (expect the multi-source tail, not "contains a join").

- **§9 DROP** — currently asserts `count(*)` on the *source* `dr` (always 2,
  regardless of maintenance — proves nothing). Replace with: after `drop
  materialized view dr_ix`, a read of the dropped name errors (no such view), and a
  newly-created different row-time MV on `dr` is maintained on the next source write
  — proving the old plan detached and re-registration is clean.

### C. Spec-level tests (`materialized-view-diagnostics.spec.ts`)

This spec already locks the generic gate wording. Extend it:

- Add per-reason cases asserting the distinctive tail of each `buildRowTimePlan`
  reject (the strings the sqllogic §7 cannot ergonomically pin all at once),
  including the join→multi-source ordering case.
- Add a **parse-error test for `with refresh`**: `create materialized view v as
  select id, x from t with refresh = 'row-time'` must throw a parse error
  (`captureError` helper already present). Also assert an unknown literal
  (`with refresh = 'bogus'`) is the same parse error (the clause is gone entirely —
  the literal is never inspected).

### D. Optional (do if cheap, else note as deferred)

- A `row-time` MV case in `test/logic/change-scope.spec.ts` (a `select` from a
  row-time MV must project its change-scope to the *source* via `mv.sourceScope`,
  per `registerMaterializedView` — only the incremental projection is covered today).
- An `ast-stringify` round-trip of the bare `create materialized view … as select …`
  DDL (no `with refresh`) — likely in `emit-roundtrip.spec.ts`; confirm it isn't
  already covered before adding.

### E. Validate

- Run the focused sqllogic + specs first, then the package suite:
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mvrt.log; tail -n 80 /tmp/mvrt.log`
  (stream — never silent-redirect). Lint touched TS: `yarn workspace
  @quereus/quereus lint` (single-quote globs on Windows).
- If a failure surfaces that is plainly pre-existing / outside this diff, follow the
  `.pre-existing-error.md` flagging protocol rather than chasing it here.
- This is coverage-only: **no source changes** under `src/` are expected. If a new
  test exposes a real maintenance defect, do not paper over it — file a fix ticket
  and reference it from the failing assertion.
