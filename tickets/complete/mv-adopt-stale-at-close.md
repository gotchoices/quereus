description: Carry the stale-at-close MV set in the clean-shutdown marker; exclude stale-at-close MVs from the adopt fast path so a behind backing refills instead of silently adopting. Store-only change.
files:
  - packages/quereus-store/src/common/key-builder.ts          # parseMaterializedViewCatalogKey + marker docstring
  - packages/quereus-store/src/common/index.ts                # export the new parse helper
  - packages/quereus-store/src/common/store-module.ts         # closeAll capture+write; consumeCleanShutdownMarker parse; rehydrateCatalog per-entry trust
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts    # stale-at-close cases + 1 adapted existing test
  - docs/materialized-views.md                                # § Cross-module atomicity: gate-5 payload wording, caveat bullet removed
  - docs/schema.md                                            # § Rehydrate phasing: per-entry trust + marker-value wording (review fix)
----

# Carry the stale set in the clean-shutdown marker; exclude stale MVs from adopt

## What the bug was

`stale` is in-memory-only runtime state on `MaterializedViewSchema`. An MV that
went stale mid-session — any `table_modified` on a source (an ALTER, even a
`create index`) detaches its row-time maintenance, so subsequent source writes
never reach the backing — and was then **cleanly closed** without a `refresh`
passed every DDL-level adopt gate at reopen, registering the *behind* backing as
fresh and serving stale content silently.

## What changed (store-only; no engine change)

The clean-shutdown marker's **value** went from a bare `'1'` to
`JSON.stringify(staleAtClose)` — the array of qualified lowercased `schema.mv`
names that were stale at close. The store is the attesting party and holds the
stale flags at close, so the exclusion is entirely store-side;
`ImportCatalogOptions` (`trustBackings` / `adoptedBackings`) is unchanged.

- **`closeAll`** captures the stale set before the unsubscribe block clears
  `subscribedDb`, then writes `JSON.stringify(set)`. No subscribed db ⇒ empty set.
- **`consumeCleanShutdownMarker`** returns `{ trusted, staleAtClose }`; reads +
  deletes single-use. Conservative parse: any unparseable / wrong-shape payload
  (including a legacy bare `'1'`) ⇒ `{ trusted: false, ∅ }` and a `console.warn`.
- **`rehydrateCatalog` phase 3** derives each MV's qualified name via the new
  `parseMaterializedViewCatalogKey` and passes per-entry
  `trustBackings: trusted && !staleAtClose.has(name)`. Stale-at-close ⇒ refill
  (recompute + re-arm maintenance, clear `stale`); live-at-close ⇒ keep the fast
  path. A refilled MV is never added to `adoptedBackings`, so MV-over-MV
  dependents refill too (and are independently in the stale set via the cascade).

## Validation

`yarn workspace @quereus/store test` — **519 passing**.
`yarn workspace @quereus/store typecheck` — clean. (Store has no lint script;
only `packages/quereus` does.) Engine untouched, so the engine suite was not
re-run in review — no engine source changed.

The oracle is **sentinel divergence**: a row planted directly in the backing's
physical store that the body would never produce. Sentinel survives ⇒ adopted;
absent ⇒ refilled.

## Review findings

**Scope of review.** Read the full implement diff (commit `2daf46ad`) first, then
the source it touches (`key-builder.ts`, `store-module.ts` `closeAll` /
`consumeCleanShutdownMarker` / `rehydrateCatalog`, `index.ts`) and the sibling
engine surfaces it relies on (`getAllMaterializedViews`, the schema-change
listener's stale/detach path, the persist-side MV catalog key). Verified name
round-tripping, the no-subscribed-db soundness argument, parse conservatism, and
docs against the new reality. Ran store tests (twice) + typecheck.

**Checked — correctness.**
- Name symmetry is sound: the persist key (`buildMaterializedViewCatalogKey`,
  `mv.schemaName`/`mv.name` lowercased), the close-side stale set
  (`${mv.schemaName}.${mv.name}`.toLowerCase()), and the rehydrate-side
  `parseMaterializedViewCatalogKey` (strips the `\x00mview\x00` prefix, decodes
  the rest) all key on the same lowercased `schema.mv` string. No `.`-splitting
  anywhere, so exotic identifiers round-trip through the same encoder/decoder.
- Conservative parse is correct: legacy `'1'` parses to a *number*, fails the
  `string[]` shape check ⇒ `trusted:false` ⇒ refill-everything, with a warn (no
  silently-eaten exception). Verified by the garbage-marker test.
- `getAllMaterializedViews` spans all schemas; per-entry trust is keyed correctly
  for multi-schema and MV-over-MV cascades.
- Empty-set on no-`subscribedDb` rests on the invariant that every stale-marking
  path requires a session that subscribed the db; argued in the closeAll comment,
  pinned by the no-subscribed-db test. Accepted as sound.

**Found — minor, fixed in this pass.**
- *Doc staleness.* `docs/schema.md` § Rehydrate phasing still described phase-3
  trust as a single global `trustBackings: <marker consumed>` flag and the marker
  as a bare presence token. The implement diff updated `materialized-views.md` but
  missed this sibling doc. Fixed inline: the marker value is now documented as the
  JSON stale-at-close set, and trust is documented as decided **per entry**
  (`<marker present> && not stale-at-close`).
- *Test strengthening.* The headline test (case 1) asserted refill + `stale`
  cleared but never confirmed maintenance was genuinely **re-armed** (only the
  flag cleared). Added a post-reopen `insert into src` that must reach the
  refilled MV — closing the "recompute *and* re-arm" claim. 519 still passing.

**Found — major, filed as a new ticket.**
- *Refill drops a durable backing before confirming the body can rebuild.* A
  stale-at-close MV whose body can no longer materialize (a `select *` widened
  under an explicit `mv(a,b)` list) now takes the refill path, which drops the
  durable backing *before* the arity check fails → durable rows lost. The adopt
  path already checks arity *before* any drop; the refill path should mirror it.
  Pre-existing refill behavior (not staleness-specific) that this fix makes newly
  reachable; the rows were already stale and the body broken, so accepted here.
  Filed `tickets/backlog/mv-refill-shape-check-before-drop`.

**Scrutinized — the adapted existing test (no regression).** The
`declared-column arity mismatch under trust errors per-entry without dropping the
backing` test widens the source across sessions, which now also marks the MV
stale (⇒ refill path). To keep exercising the **adopt-path** preserve-on-
unmaterializable branch — still valid, reachable via
`importCatalog({trustBackings:true})` and via any clean close where the MV did
*not* go stale — the test overwrites the marker to `[]` right before the final
reopen, with a comment. This isolates the adopt path rather than papering over a
regression; the new refill-path behavior is the major finding above, separately
tracked. Confirmed legitimate.

**Empty categories.**
- *Provider coverage:* unchanged — like all existing adopt tests, these use the
  in-memory persistent provider; no LevelDB/IndexedDB durability is exercised.
  The `mv-adopt-marker-sync-durability` caveat is unchanged and remains the one
  documented marker-durability trust caveat. Out of scope here.
- *Lint:* none run — the store package has no lint script (AGENTS.md: only
  `packages/quereus` does). Not an omission.
