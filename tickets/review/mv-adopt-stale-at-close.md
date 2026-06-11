description: Review the stale-at-close MV exclusion — the clean-shutdown marker now carries a JSON stale-set payload that withholds the adopt fast path per-entry, so a stale-at-close MV refills instead of adopting a behind backing.
files:
  - packages/quereus-store/src/common/key-builder.ts          # parseMaterializedViewCatalogKey + marker docstring
  - packages/quereus-store/src/common/index.ts                # export the new parse helper
  - packages/quereus-store/src/common/store-module.ts         # closeAll capture+write; consumeCleanShutdownMarker parse; rehydrateCatalog per-entry trust
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts    # 6 new stale-at-close cases + 1 adapted existing test
  - docs/materialized-views.md                                # § Cross-module atomicity: gate-5 payload wording, caveat bullet removed
difficulty: medium
----

# Review: carry the stale set in the clean-shutdown marker; exclude stale MVs from adopt

## What the bug was

`stale` is in-memory-only runtime state on `MaterializedViewSchema`. An MV that
went stale mid-session — any `table_modified` on a source (an ALTER, even a
`create index`) detaches its row-time maintenance, so subsequent source writes
never reach the backing — and was then **cleanly closed** without a `refresh`
passed every DDL-level adopt gate at reopen. Adopt registered the *behind*
backing as fresh, serving stale content silently. (Fix-stage confirmed repro:
`create index` then a post-stale `insert`, then `closeAll`; reopen served the
pre-stale rows where a refill yields the current ones.)

## What changed (store-only; no engine change)

The clean-shutdown marker's **value** was a bare `'1'`. It is now
`JSON.stringify(staleAtClose)` — the array of qualified lowercased `schema.mv`
names that were stale at close. The store is the attesting party and has the
stale flags at close, so the exclusion is entirely store-side; `ImportCatalogOptions`
(`trustBackings` / `adoptedBackings`) is unchanged.

- **`closeAll`** captures the stale set *before* the unsubscribe block clears
  `subscribedDb` (nothing between capture and the marker write can change the
  flags — closeAll only drains the queue and disconnects tables), then writes
  `JSON.stringify(set)`. No subscribed db ⇒ empty set (see soundness note below).
- **`consumeCleanShutdownMarker`** now returns `{ trusted, staleAtClose }`. It
  still reads + immediately deletes (single-use, regardless of parse outcome).
  **Conservative parse:** any unparseable / wrong-shape payload (including a
  legacy bare `'1'`, which parses to a *number*, not an array) ⇒
  `{ trusted: false, ∅ }` — refill everything (degrade to safe, never
  trust-everything). Logs a `console.warn` when it discards a present-but-bad
  payload (satisfies the "don't eat exceptions silently" rule).
- **`rehydrateCatalog` phase 3** retains each MV entry's catalog key, derives its
  qualified name via the new `parseMaterializedViewCatalogKey` (strips the
  `\x00mview\x00` prefix), and passes per-entry
  `trustBackings: trusted && !staleAtClose.has(name)`. A stale-at-close MV thus
  refills (recomputing content and clearing `stale` with live maintenance) while
  every live-at-close MV keeps the fast path.
- **MV-over-MV falls out for free:** a refilled (stale) upstream is never added
  to `adoptedBackings`, so the existing ledger gate forces its dependents to
  refill. The intra-session cascade also already marks a stale upstream's
  dependents stale (backing invalidation fires `table_modified` on the backing),
  so they are independently in the stale set — belt and braces.

## How to validate

`yarn workspace @quereus/store test` — **519 passing** (includes the 6 new cases
below). `yarn workspace @quereus/quereus test` — **5853 passing** (engine
untouched; cheap sanity check). `yarn workspace @quereus/store typecheck` — clean.

The oracle throughout is **sentinel divergence** (a row planted directly in the
backing's physical store that the body would never produce): sentinel survives ⇒
adopted; absent ⇒ refilled. New cases in `mv-rehydrate-adopt.spec.ts` →
`describe('stale-at-close exclusion')`:

1. **stale-at-close refills** — `create index` marks mv stale + a post-stale
   `insert`; reopen refills (post-stale row present, sentinel scrubbed, `stale`
   cleared). Marker asserted `["main.mv"]`.
2. **stale-then-refreshed adopts** — `refresh` before close clears the flag;
   marker `[]`, reopen adopts (sentinel survives).
3. **fine-grained** — two MVs over two sources, only one source ALTERed; the
   stale one refills, the live one adopts (marker `["main.amv"]`).
4. **MV-over-MV stale upstream** — index on the upstream's source cascades to
   both; marker has both names; reopen refills both, content correct end-to-end.
5. **no-subscribed-db close** — a session that never rehydrates / never touches a
   store table writes marker `[]` (asserted) and the next session adopts.
6. **garbage marker** — hand-written legacy `'1'` ⇒ refill (sentinel scrubbed).

## Honest gaps / points needing reviewer judgment

- **Adapted an existing test (please scrutinize).** `a declared-column arity
  mismatch under trust errors per-entry without dropping the backing` widens the
  source via `alter table src add column w` across sessions — which now *also*
  marks the MV stale, so it would take the **refill** path (which drops the
  backing *before* `materializeView` reaches the arity check) rather than the
  **adopt** path (whose `tryAdoptPreExistingBacking` arity check fires *before*
  any drop, preserving the rows). To keep covering the adopt-path
  preserve-on-unmaterializable branch — still valid defensive behavior, reachable
  via `importCatalog({trustBackings:true})` — I overwrite the marker to `[]`
  right before the final reopen, with a comment. **Verify this isn't papering
  over a regression.**
- **Real behavior change in a pathological corner.** For a *stale-at-close* MV
  whose body can no longer materialize (arity mismatch from a `select *` widened
  under an explicit `mv(a,b)` list), the new refill path drops the durable
  backing *before* discovering it can't rebuild → those rows are lost (the entry
  errors per-entry, no MV registered). Pre-fix this scenario silently *adopted*
  the stale rows (the bug). The rows were already stale and the body is broken
  either way, so I judged this acceptable, but a reviewer may want the refill path
  to assert arity *before* dropping (out of scope here; would also help the
  non-stale refill case). Flagging for a verdict.
- **No-subscribed-db empty-set soundness** rests on the invariant that every path
  that can mark an MV stale requires a session in which this module observed the
  db (store source create/connect both call `ensureSchemaSubscription`;
  `rehydrateCatalog` subscribes up front). Pinned by case 5, but it is an
  argument, not a mechanical guarantee — worth a second read.
- **Provider coverage.** Like all existing adopt tests, these use the in-memory
  persistent provider; no LevelDB/IndexedDB durability is exercised. The
  pre-existing marker-durability-under-power-loss caveat
  (`mv-adopt-marker-sync-durability`) is unchanged and still the one remaining
  documented trust caveat.
- **Name matching is opaque string equality** (both sides lowercase `schema.mv`;
  the key is lowercased at build time, the close-side via `.toLowerCase()`). No
  `.`-splitting anywhere. A schema or MV name containing a `.` would not round
  through differently than the catalog key already does — but worth confirming no
  quoting/escaping edge exists for exotic identifiers.
