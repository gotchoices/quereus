description: Carry the stale-at-close MV set in the clean-shutdown marker payload so adopt excludes (refills) MVs whose row-time maintenance was detached at clean close.
files:
  - packages/quereus-store/src/common/store-module.ts          # closeAll capture + marker write; consumeCleanShutdownMarker parse; rehydrateCatalog phase-3 per-entry trust
  - packages/quereus-store/src/common/key-builder.ts           # marker docstring; add MV-catalog-key → qualified-name parse helper
  - packages/quereus-store/src/common/index.ts                 # export the new parse helper if tests need it
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts     # reopen-matrix extension (stale-at-close cases)
  - docs/materialized-views.md                                 # § Cross-module atomicity: remove caveat bullet, update gate-5 marker description
difficulty: medium
----

# Carry the stale set in the clean-shutdown marker; exclude stale MVs from adopt

## Confirmed reproduction (fix-stage)

The hole is real and reproduces exactly as specified. One session, no crash:

```ts
db.exec('create table src (id integer primary key, v integer) using store');
db.exec('insert into src values (1, 10), (2, 20)');
db.exec('create materialized view mv using store as select id, v from src');
db.exec('create index i on src(v)');   // table_modified ⇒ mv.stale = true, row-time plan detached
db.exec('insert into src values (3, 30)');  // NOT propagated to _mv_mv
await mod.closeAll();                  // marker written unconditionally
```

At reopen, `rehydrateCatalog` adopts `mv` (every gate passes — the shape never
changed) and `select id, v from mv` serves `[1, 2]` where a refill yields
`[1, 2, 3]`. Verified with a scratch spec against the persistent in-memory
provider from `mv-rehydrate-adopt.spec.ts` (mocha, `yarn workspace
@quereus/store test`); the scratch spec was deleted — re-land this scenario as
a regression test (TODO below).

Root cause confirmed in code:

- `MaterializedViewManager.subscribeToSchemaChanges`
  (`database-materialized-views.ts` ~line 432) marks every MV whose
  `sourceTables` includes a `table_modified` table stale and calls
  `releaseRowTime` — from then to a `refresh`, source DML does not reach the
  backing. `stale` lives only on the in-memory `MaterializedViewSchema`
  (`schema/view.ts` line 151); it is never persisted.
- `StoreModule.closeAll` (`store-module.ts` ~line 2271) writes the marker value
  `'1'` unconditionally after the persist-queue drain; it never consults
  `subscribedDb.schemaManager`.
- `rehydrateCatalog` (~line 1924) consumes the marker into a single boolean
  `trustBackings` threaded uniformly into every phase-3
  `importCatalog([ddl], { trustBackings, adoptedBackings })` call.
- All five adopt gates (`SchemaManager.tryAdoptPreExistingBacking`,
  `manager.ts` ~line 2753) are DDL/shape-level; none can see staleness.

## Chosen design: marker payload, store-only change

The store module is the attesting party and has everything it needs at close.
**No engine change** (`ImportCatalogOptions` keeps its current two fields): the
catalog key of each MV entry names the MV, so the store can withhold
`trustBackings` per entry. The coarse alternative (write no marker when any MV
is stale) was rejected — it punishes unrelated MVs with refills; per-entry
exclusion is barely more code.

### Close side (`closeAll`)

Capture the stale set **before** the unsubscribe block clears `subscribedDb`
(top of `closeAll`); nothing between capture and the marker write can change
the flags (closeAll only drains the queue and disconnects tables):

```ts
const staleAtClose = this.subscribedDb
	? this.subscribedDb.schemaManager.getAllMaterializedViews()
		.filter(mv => mv.stale)
		.map(mv => `${mv.schemaName}.${mv.name}`.toLowerCase())
	: [];
```

Write `JSON.stringify(staleAtClose)` as the marker value (replaces `'1'` — no
back-compat shim per project rules; an old-format `'1'` payload parses as
invalid and degrades to refill-everything, which is the safe posture).

Name format: lowercased `${schemaName}.${name}` — `MaterializedViewSchema`
stores the canonical schema name, which is exactly what
`buildMaterializedViewCatalogKey` lowercases into the catalog key, so close-side
names and consume-side key-derived names match without re-canonicalization.
The set is treated as opaque strings everywhere (no `.`-splitting).

**No subscribed db at close** (module opened, never rehydrated, no store table
created/connected): record the **empty set**. Sound because every path that can
mark an MV stale requires a session in which the store module observed the db —
a store source table must have been created or connected through this module
(both hooks call `ensureSchemaSubscription`), and `rehydrateCatalog` subscribes
up front. A session in which `subscribedDb` is undefined therefore never
detached any persisted MV's maintenance. Document this in the `closeAll`
docstring.

Memory-backed MVs of the subscribed db may appear in the set — harmless: their
catalog entries always refill anyway (no phase-1 pre-existing backing), and
withholding trust from a refilling entry is a no-op.

### Consume side (`consumeCleanShutdownMarker` + phase 3)

`consumeCleanShutdownMarker` returns `{ trusted: boolean; staleAtClose: ReadonlySet<string> }`
(still read + immediate delete, single-use). Parse: decode the value, `JSON.parse`,
require an array of strings. **Any unparseable / wrong-shape payload ⇒
`trusted: false`, empty set** — degrade to refill-everything rather than
trust-everything.

Phase-3 threading: the classification loop in `rehydrateCatalog` currently
collects `mvDDLs: string[]` (keys discarded). Retain the key for MV entries and
derive each entry's qualified name from it — add a small exported helper in
`key-builder.ts` (the prefix byte constants are module-private):

```ts
/** Qualified lowercased `schema.mv` from a `\x00mview\x00…` catalog key. */
export function parseMaterializedViewCatalogKey(key: Uint8Array): string
```

Then the fixpoint loop carries `{ name, ddl }` pairs and passes per-entry
options:

```ts
await db.schemaManager.importCatalog([ddl], {
	trustBackings: trusted && !staleAtClose.has(name),
	adoptedBackings,
});
```

A stale-at-close MV thus refills — which also clears its staleness correctly
(refill registers `stale: false` with live maintenance, recomputed content) —
while every live-at-close MV keeps the fast path. Crash semantics unchanged
(no marker ⇒ `trusted: false` ⇒ refill everything).

**MV-over-MV comes free**: a refilled (stale) upstream is never added to
`adoptedBackings`, so the existing `_mv_`-source ledger gate in
`tryAdoptPreExistingBacking` forces its dependents to refill. The inverse
(stale dependent over a live upstream) is also correct: the upstream adopts,
the dependent refills its body over the adopted backing.

Also note: within the session the staleness cascade already propagates down
MV-over-MV chains (`emitBackingInvalidation` fires `table_modified` on the
backing, whose name is in the dependent's `sourceTables`), so a stale upstream's
dependents are themselves in the stale set — belt and braces with the ledger.

## Tests — extend `packages/quereus-store/test/mv-rehydrate-adopt.spec.ts`

Reuse the existing provider/`open`/`reopen`/`plantSentinel`/`markerPresent`
helpers and the sentinel-divergence oracle (sentinel survives ⇒ adopted;
absent ⇒ refilled). Cases:

- **Stale at close via `create index` + post-stale DML** (the confirmed repro):
  reopen refills — sentinel absent AND content includes the post-stale row
  (`[1,2,3]`), `result.errors` empty. Assert `mv.stale === true` before close
  to pin the trigger.
- **Stale then `refresh`ed before close**: `refresh materialized view mv`
  clears the flag (`runtime/emit/materialized-view.ts` line 138) and
  re-registers maintenance; post-refresh DML propagates; reopen **adopts**
  (sentinel survives).
- **Fine-grained exclusion**: two MVs over two sources in one session; only one
  goes stale. Reopen: the stale one refills, the other adopts (plant a sentinel
  in each backing; one survives, one doesn't).
- **MV-over-MV, stale upstream**: `mv2 as select … from mv1`; index-create on
  `mv1`'s source marks both stale (cascade); reopen refills both and content is
  correct end-to-end.
- **No-subscribed-db close**: seed + clean close (session 1); session 2 opens a
  module over the same provider, never rehydrates, calls `closeAll` (re-writes
  the marker with an empty stale set); session 3 adopts. Pins the empty-set
  decision.
- **Garbage marker payload**: hand-write a non-JSON marker value (e.g. `'1'`),
  reopen ⇒ refill (sentinel absent) — the conservative-parse posture.

Run `yarn workspace @quereus/store test` (whole package) plus
`yarn workspace @quereus/quereus test` for the engine side (untouched, but
cheap). The existing adopt-matrix tests must stay green — in particular the
clean-session adopt cases, which now ride a `'[]'` payload.

## Docs

- `docs/materialized-views.md` § Cross-module atomicity: **remove** the
  "Staleness at close is not attested" caveat bullet (line ~121; keep the
  marker-durability bullet and renarrow "Two known trust caveats" to one), and
  update the gate-5 paragraph (~line 115) to say the marker's payload is the
  stale-at-close MV set consumed into per-entry trust.
- `key-builder.ts` `CLEAN_SHUTDOWN_META_NAME` docstring and the
  `rehydrateCatalog` / `closeAll` docstrings in `store-module.ts`: marker value
  is now the stale-set JSON payload, not a bare flag.

## TODO

- Add `parseMaterializedViewCatalogKey` to `key-builder.ts` (export via `common/index.ts`)
- `closeAll`: capture stale set before unsubscribe; write `JSON.stringify(set)` as the marker value; document the empty-set/no-subscribed-db decision
- `consumeCleanShutdownMarker`: return `{ trusted, staleAtClose }` with conservative parse (bad payload ⇒ untrusted)
- `rehydrateCatalog`: retain MV catalog keys in classification; per-entry `trustBackings: trusted && !staleAtClose.has(name)` through the fixpoint loop
- Extend `mv-rehydrate-adopt.spec.ts` with the six cases above
- Update `docs/materialized-views.md` (remove caveat bullet, gate-5 payload wording) and the marker docstrings
- `yarn workspace @quereus/store test` + `yarn workspace @quereus/quereus test` green; lint the touched quereus files if any engine file changes (none expected)
