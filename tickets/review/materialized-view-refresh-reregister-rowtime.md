description: `refresh materialized view` now re-registers the MV's row-time (write-through) maintenance plan after rebuilding the snapshot. Previously refresh cleared `stale` and rebuilt the backing, but left the plan detached (a prior compatible source-schema change had released it), so post-refresh source writes were silently not propagated. One-line fix + §16 test coverage. Review the fix correctness, the error-path ordering, and whether the new test branches are an adequate floor.
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/materialized-views.md, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts
----

## What changed

### Fix — `emitRefreshMaterializedView` (`src/runtime/emit/materialized-view.ts:115`)

Added a single call, `db.registerMaterializedView(mv);`, immediately after `mv.stale = false;`
and before the `materialized_view_refreshed` notification, with an explanatory comment.

Root cause: when a *compatible* source schema change (e.g. `alter table … add column`) marks an
MV stale, `MaterializedViewManager.subscribeToSchemaChanges` (`database-materialized-views.ts:245`)
also calls `releaseRowTime`, **detaching** the compiled row-time plan. `refresh` rebuilt the backing
snapshot and cleared `stale`, but never re-attached the plan — so reads after refresh returned the
correct rebuilt set while subsequent source writes were silently dropped. Only `drop + recreate`
re-registered.

`registerMaterializedView` (`database-materialized-views.ts:260`) is idempotent: it calls
`releaseRowTime(key)` first, then rebuilds the plan via `buildMaintenancePlan` and indexes it under
`rowTimeBySource`. So re-registering a never-stale MV is a harmless no-op re-attach with no duplicate
index entry. `db.registerMaterializedView` is the existing public passthrough (`database.ts:1729`).

### Tests — `test/logic/53-materialized-views-rowtime.sqllogic` §16

§16 previously documented this as a KNOWN GAP and only asserted the `drop + recreate` path. Rewritten:
- Removed the `KNOWN GAP (...)` note; updated the header to state both `refresh` and drop+recreate
  restore the MV (rebuild snapshot **and** re-register the plan).
- **16a** — the core regression: alter (compatible) → stale, post-alter write unmaintained, then
  `refresh materialized view al_ix` must (a) rebuild the snapshot to include the missed row and
  (b) resume maintenance so a *subsequent* insert appears.
- **16b** — drop+recreate kept as a separate sub-case (`al2`), also ending fully maintained.
- **16c** — idempotent-registration guard: refresh of a NOT-stale MV, then a write that must still
  be maintained (no duplicate `rowTimeBySource` entry breaking maintenance).
- **16d** — compound-PK MV: stale via compatible alter, refresh, subsequent compound-PK write maintained.
- **16e** — partial (`where x > 0`) MV: stale via alter, refresh applies the predicate on rebuild
  (in-scope missed row appears, out-of-scope excluded), and a subsequent in/out-of-scope write pair
  confirms the predicate is honored after re-registration.
- Kept the existing drop-source → clean stale-error case unchanged.

### Docs — `docs/materialized-views.md` § Schema-change staleness

Made the staleness section state that marking an MV stale **detaches** its row-time plan, and that
the next successful refresh (or drop+recreate) clears `stale`, rebuilds the snapshot, **and**
re-registers the detached plan (idempotent for a never-stale MV).

## Validation performed

- `yarn build` (quereus) — green.
- Full quereus **memory** suite (`node test-runner.mjs`) — **3959 passing, 9 pending, 0 failing**.
- 53 file in **store** mode (`node test-runner.mjs --store --grep 53-materialized-views-rowtime`) —
  passing. §16 exercises `ALTER` on the source, so the store path was confirmed (it differs from
  memory for ALTER), per the ticket's request to confirm both paths.
- `eslint` on the changed source file — clean.

Not run: the cross-workspace `yarn test` over the *other* packages, and `yarn test:store` for the full
logic suite. The change is confined to MV registration in `packages/quereus`; no other workspace
references the touched code. The targeted store run above covers the relevant store-path concern.

## Review focus — honest notes / known gaps

- **Error-path ordering (the one subtle point).** The fix follows the ticket's prescribed order:
  `mv.stale = false;` then `db.registerMaterializedView(mv);`. If `registerMaterializedView` were to
  throw (it re-runs the eligibility gate and throws `UNSUPPORTED` on an ineligible body), the MV is
  left non-stale + snapshot-rebuilt + plan-detached, since `mv.stale` is a plain (non-transactional)
  field mutation. In practice this throw is **unreachable**: `revalidateBody` runs first and a
  *compatible* alter that keeps the body planning also keeps it row-time eligible (the create-time
  gate already passed and a compatible alter doesn't change projection/PK eligibility). I followed the
  ticket exactly rather than reorder; a reviewer may want to weigh whether registering *before*
  clearing `stale` is the safer failure posture (it would leave the MV stale → reads re-validate/error
  instead of serving an unmaintained snapshot). No behavioral difference on the success path. The
  ticket explicitly says do **not** swallow the exception — I did not.
- **Test floor, not ceiling.** §16 covers single-PK / compound-PK / partial-WHERE MVs resuming after
  refresh. Not covered: an MV with an **expression-projection** column (§19-style) resuming after a
  refresh; refresh-resume **inside an explicit transaction** with mid-statement reads-own-writes;
  refresh-resume of an **MV-over-MV cascade** (does re-registering the inner producer's plan keep the
  outer consumer's cascade edge intact?). These are plausible extra branches a reviewer might add as a
  fix/backlog follow-up rather than block on.
- **Idempotency proof depth.** 16c asserts maintenance still fires after a redundant re-register, which
  indirectly proves no duplicate `rowTimeBySource` entry corrupts maintenance — but it does not
  white-box assert the set size. A reviewer wanting a stronger guard could add a unit test against
  `MaterializedViewManager` directly.
