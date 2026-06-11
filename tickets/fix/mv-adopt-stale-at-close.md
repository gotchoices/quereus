description: Adopt fast path trusts a backing whose MV was stale at clean close — the marker attests "no crash", not "maintenance was live", so adopt can serve a behind backing as fresh.
difficulty: hard
files:
  - packages/quereus/src/core/database-materialized-views.ts   # schema-change listener: table_modified on a source marks dependents stale + detaches row-time maintenance
  - packages/quereus-store/src/common/store-module.ts          # closeAll marker write; rehydrateCatalog marker consume + phase-3 trust threading
  - packages/quereus/src/schema/manager.ts                     # tryAdoptPreExistingBacking gates (all DDL-level today)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts     # reopen matrix to extend with a stale-at-close case
  - docs/materialized-views.md                                 # § Cross-module atomicity: caveat documented, to be removed when fixed
----

# Adopt gate hole: staleness at close is not attested

## Problem

The clean-shutdown marker attests *no crash since the last close*. It does not
attest *every store-backed MV's row-time maintenance was live through the
session*. Those are different claims, and the adopt gates only cover the first.

`MaterializedViewManager`'s schema-change listener marks **every** MV whose
`sourceTables` includes a `table_modified` table stale and detaches its
row-time maintenance plan. `table_modified` fires for any source ALTER — and
also for a plain `create index` / `drop index` on a source. From that point
until a `refresh`, source DML no longer propagates to the backing: the
persisted backing content is legitimately *behind* the persisted source
content. `stale` is runtime state and is not persisted.

Reproduction shape (all inside one session, no crash):

1. `create table src (...) using store; create materialized view mv using store as select id, v from src`
2. `create index i on src(v)` — fires `table_modified` ⇒ `mv` stale, maintenance detached
3. `insert into src ...` — NOT propagated to `_mv_mv`
4. `closeAll()` — clean-shutdown marker written
5. Reopen ⇒ every adopt gate passes (shape unchanged — the body never selected
   anything the index touched), so `mv` is **adopted**: the behind backing is
   registered `stale: false` with live maintenance, and reads serve it silently.
   A refill would have recomputed the correct content.

Within the session this was safe (stale MVs re-validate on read and never serve
the backing via the rewrite); the adopt converts that known-stale state into
trusted-fresh state across the reopen.

## Expected behavior

An MV that was stale at clean shutdown must NOT adopt at the next open — it
refills (which also clears the staleness correctly), while MVs that were live
at close keep the fast path. No change to crash semantics (no marker ⇒ refill
everything, as today).

## Specification sketch

The store module is the attesting party and has everything it needs at
`closeAll` time: it can read `getAllMaterializedViews()` off the subscribed
db's schema manager and record which are `stale` at the moment the marker is
written. Two candidate vehicles:

- **Marker payload**: write the stale set (lowercased `schema.name` list) as
  the marker's value instead of `'1'`. `rehydrateCatalog` consumes it and
  either (a) threads a per-entry exclusion into phase 3 (the catalog key of
  each MV entry names the MV, so the store can pass `trustBackings: false` for
  just those entries), or (b) passes an exclusion set through
  `ImportCatalogOptions` so the engine arm can also honor it.
- **Coarse gate**: write no marker at all when any store-backed MV is stale at
  close. Simpler, but punishes unrelated MVs with refills.

Edge cases to pin down in tests:

- stale at close via `create index` on a source (no shape change) + post-stale
  DML ⇒ refill at reopen, content correct
- stale then `refresh`ed before close ⇒ adopts
- MV-over-MV: a stale upstream must also force the dependent to refill (the
  existing adopt-ledger gate gives this for free once the upstream refills)
- `closeAll` with no subscribed db (never rehydrated/used) — stale set unknowable;
  decide and document (likely: empty set, since no MV could have gone stale
  through this module's session)

Remove the corresponding caveat bullet from `docs/materialized-views.md`
§ Cross-module atomicity when this lands.
