description: Shape-aware `refresh materialized view` — refresh re-derives the backing table's shape and rebuilds the backing table (drop+recreate+fill) when a source `alter` shifts the re-planned body's output shape, instead of swapping new rows into the stale create-time schema. Repairs the direct-read corruption for schema-shifting (`select *`) bodies, restores positional backing↔body alignment, and re-enables the join read-rewrite after such a refresh.
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/materialized-view-refresh-reshape.spec.ts, packages/quereus/test/query-rewrite-join.spec.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md, docs/optimizer.md
----

## What shipped

`refresh materialized view` is now **shape-aware**:

- `emitRefreshMaterializedView` re-derives `shape = deriveBackingShape(db, bodySql, mv.columns)`
  from the re-planned body, then branches:
  - **Explicit-column count-shift → error**: an `mv(a,b,c)` whose body output count
    shifted under a source change errors ("declared with N … now produces M — drop and
    recreate"); the MV stays stale.
  - **`backingShapeMatches` → fast path** (`rebuildBacking`, data-only swap, backing
    `TableSchema` identity + warm caches preserved).
  - **else → rebuild** (`rebuildBackingTable`: drop+recreate the backing at the new shape
    via the create path `buildBackingTableSchema → createBackingTable → replaceBaseLayer`),
    then update `mv.primaryKey`/`ordering`/`sourceTables`.
  - Order preserved: (re)build → `registerMaterializedView` (binds maintenance to the new
    backing) → clear `stale` → notify.
- Helpers added: `backingShapeMatches`, `rebuildBackingTable`; `computeBackingPrimaryKey`
  exported so the fast-path PK compare matches the rebuild's installed PK.
- Docs: `materialized-views.md` § REFRESH (fast-path-vs-rebuild + count-shift error);
  `optimizer.md` join arm (rewrite **re-enables** after a schema-shifting refresh;
  `backingAlignsWithBody` retained as defense-in-depth).

## Review findings

**Verdict: accept.** Implementation is correct for the autocommit path (the only way
refresh/alter are issued in every existing test and the normal usage), well-decomposed,
type-safe, and documented. Lint + typecheck clean; full suite `yarn test` green
(**4894 passing**, 9 pending — +1 from the cascade regression test added below).

### Checked & clean

- **Diff read first, fresh eyes** (`materialized-view.ts`, `materialized-view-helpers.ts`)
  before the handoff. Branch logic, error path, and field updates are coherent.
- **Fast-path correctness**: `backingShapeMatches` compares count, per-column
  name(ci)/logicalType/notNull/collation, and the physical PK (index/desc/collation) — the
  same dimensions `buildBackingTableSchema` installs. No false-positive match path found
  (it ignores only `defaultValue`/`generated`, which are constant for derived backings).
  Order of operations is safe: the match check runs *before* `buildBackingTableSchema`
  mutates `shape.columns` PK flags.
- **Re-binding**: `registerMaterializedView` runs after the (re)build and reads the new
  backing's `primaryKeyDefinition` — maintenance binds to the reshaped backing. Verified
  by the existing row-time-after-reshape test.
- **Type safety / DRY / cleanup**: no `any`; rebuild reuses the create path; half-built
  backing dropped on fill failure. Resource cleanup on the error path is present.
- **Docs**: `materialized-views.md` and `optimizer.md` updates are accurate. `sql.md`
  (grammar/examples) and `usage.md` ("not required for currency", "transactional") remain
  true and need no change.

### Found & fixed inline (minor)

- **Gap #3 (MV-over-MV cascade on a producer reshape) was relied-on but untested.** I
  verified via throwaway probe that the rebuild's `table_removed` on `_mv_<producer>`
  cascades staleness to a consumer MV (whose `sourceTables` include the producer backing)
  and that a consumer refresh then realigns to the reshaped producer and picks up the new
  column. **Added a regression test** for exactly this (`a producer reshape cascades
  staleness to a consumer MV, which a refresh then realigns`) in
  `materialized-view-refresh-reshape.spec.ts`.

### Confirmed pre-existing / out-of-scope (no new ticket — already filed)

- **Gap #1 — in-transaction `alter`+`refresh` of a `select *` MV fills stale data.**
  Reproduced (`begin; alter; refresh; commit` then `select * from v` yields `extra:1`
  instead of `'x'` — a misaligned `c.id` leak). Confirmed it is **upstream of refresh**:
  the body re-execution via `collectBodyRows` (unchanged by this ticket, shared with the
  old fast path) reads the MV *source* at its pre-alter row shape mid-transaction when an
  MV over that source exists; the same read with no MV present is correct. The autocommit
  path is fully correct. This is a **pre-existing source-read data-visibility bug**, not a
  regression here. Already filed as `tickets/fix/mv-refresh-intxn-altered-source-stale-read.md`
  with a thorough root-cause write-up. **I agree with the pre-existing/out-of-scope
  disposition** — it is silent data corruption and should be prioritized, but it predates
  this change and has its own ticket. (Not routed to `.pre-existing-error.md` — that channel
  is for *failing tests*; no test exercises in-txn alter+refresh, so nothing is masked.)

### Found, accepted without action (minor, non-blocking)

- **Gap #2 — duplicate-producing / PK-shifting reshape failure path is untested.** A
  realistic column *add* preserves the PK and the set property, so the failure case is not
  constructible without an artificial reshape. The handling is defensive (drop half-built
  backing → MV stays stale → next read errors; I probed a missing-backing read and it errors
  rather than serving empty). Left untested by design — noted, no ticket.
- **Double planning per refresh.** Every refresh now also calls `deriveBackingShape` (a full
  plan), in addition to `collectBodyRows`' prepare (and `revalidateBody` when stale). This
  mirrors the create path's two-plan pattern (`deriveBackingShape` + `collectBodyRows`) and
  is correctness-neutral; not worth a refactor in review. Noted for the perf-minded follow-up.

## Validation

- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` (memory vtab) — **4894 passing, 9 pending**.
- Targeted: `materialized-view-refresh-reshape.spec.ts` (6 passing, incl. new cascade test),
  `query-rewrite-join.spec.ts` (rewrite re-enables after rebuild).
