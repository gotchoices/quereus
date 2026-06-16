description: Review the HLC `opSeq` foundation — a 4th comparison component `(wallTime, counter, siteId, opSeq)` threaded through compareHLC, all serializers (storage 26→30 bytes, JSON, change-log key), the change-log key encoding/scan-bound math, and 5 downstream metadata serializers that hard-coded the 26-byte offset. Greenfield key-format change, no migration. `opSeq` is always 0 until the producer ticket lands — so this is a no-behavior-change foundation that must preserve total order and key monotonicity.
prereq:
files:
  - packages/quereus-sync/src/clock/hlc.ts                     # HLC interface (+opSeq), compareHLC tiebreak, createHLC default, serialize/deserialize 30B, SerializedHLC + JSON
  - packages/quereus-sync/src/metadata/keys.ts                 # serializeHLCForKey/deserializeHLCFromKey 30B, buildChangeLogKey offsets, scan bounds, parseChangeLogKey
  - packages/quereus-sync/src/metadata/change-log.ts           # pruneEntriesBefore now compareHLC-based
  - packages/quereus-sync/src/metadata/column-version.ts       # 26→30 slice offsets
  - packages/quereus-sync/src/metadata/tombstones.ts           # buffer 34→38, offset 26→30
  - packages/quereus-sync/src/metadata/peer-state.ts           # buffer 34→38, offset 26→30
  - packages/quereus-sync/src/metadata/schema-migration.ts     # buffer +4, offset 26→30
  - packages/quereus-sync/src/metadata/schema-version.ts       # buffer +4, typeByte 26→30, data slice 27→31
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # checkpoint JSON carries opSeq
  - packages/quereus-sync/test/clock/hlc.spec.ts               # extended: opSeq order, 30B round-trip, JSON, receive-ignores-opSeq
  - packages/quereus-sync/test/metadata/keys.spec.ts           # NEW: key round-trip, byte-order==compareHLC, scan-bound exclusivity
  - packages/quereus-sync/test/metadata/change-log.spec.ts     # NEW pruneEntriesBefore + scan exclusivity tests
  - packages/quereus-sync-client/test/                         # serialization.spec / sync-client.spec HLC literals carry opSeq
  - docs/sync.md                                               # § Hybrid Logical Clock documents opSeq
difficulty: medium
----

# Review: HLC + opSeq foundation (total-order comparison key)

## What landed

The HLC comparison key is now the 4-tuple `(wallTime, counter, siteId, opSeq)`.
`opSeq` is a per-transaction, 0-based **uint32** sub-order. It is the **last**
tiebreak — compared *after* siteId — so it only ever discriminates facts from the
*same* site at the same `(wallTime, counter)` (i.e. the same transaction). This is
purely the data-model layer; **nothing assigns a non-zero opSeq yet** (the producer
ticket `sync-per-transaction-hlc-tick` / plan `sync-hlc-transaction-grouping` will).
Until then every fact is opSeq 0 and `compareHLC` reduces to the old 3-component
order → **no behavioral change**, independently landable.

Concrete changes:
- `HLC` gains required `readonly opSeq: number`. `createHLC(..., opSeq = 0)` defaults it
  so existing call sites stay terse; `tick()/receive()/now()` produce opSeq 0 (via the
  default). `receive(remote)` **ignores** `remote.opSeq` for the clock merge.
- **Storage** `serializeHLC` 26→**30 bytes** (4 BE bytes appended after siteId);
  `deserializeHLC` length guard 26→30.
- **JSON** `SerializedHLC` gains `opSeq`; `hlcToJson`/`hlcFromJson` carry it
  (`hlcFromJson` tolerates a missing field via `?? 0`).
- **Change-log key** `serializeHLCForKey` 26→30; `buildChangeLogKey` offsets
  (type byte `key[29]→key[33]`, suffix `30→34`, length `3+30+1`);
  `buildChangeLogScanBoundsAfter` gte buffer `3+30`; `parseChangeLogKey` slices
  (`3..33`, type `33`, suffix `34`) + min-length `31→35`. opSeq bytes sit *after*
  siteId so **lexicographic key order == compareHLC**.
- **`pruneEntriesBefore`** now uses `compareHLC(parsed.hlc, beforeHLC) >= 0` (was an
  ad-hoc wallTime/counter compare) so opSeq participates; still relies on ascending
  key-order iteration to break early.
- **5 metadata serializers hard-coded the 26-byte offset** and were shifted to 30:
  column-version (`slice(0,30)` / `slice(30)`), tombstones & peer-state
  (buffer 34→38, createdAt/lastSyncTime at offset 30), schema-migration (buffer +4,
  `offset += 30`), schema-version (typeByte at 30, data at 31).
- **`hc:` clock state is deliberately unchanged** (10 bytes, `{wallTime, counter}`).
  opSeq is transaction-local and must NOT be persisted there — verify this stayed 10B
  (`sync-context.ts` persistHLCState / `sync-manager-impl.ts` load).
- snapshot checkpoint JSON (`snapshot-stream.ts`) round-trips opSeq.

## Validation performed (the floor, not the ceiling)

- `yarn workspace @quereus/sync build` — clean (tsc).
- `yarn workspace @quereus/sync test` — **215 passing**. (The `[Sync] Error handling
  …`/`iterate failed` console lines are intentional fault-injection tests at
  sync-manager.spec.ts:1211/1243, not failures.)
- `yarn workspace @quereus/sync-client test` — **45 passing** (its HLC literals were
  updated for the required field).
- `yarn workspace @quereus/sync-coordinator test` — **121 passing** (uses `createHLC`,
  unaffected).
- ts-node runs full type-checking (no transpileOnly), so green tests also prove the
  ~60 updated HLC literals type-check.

New/extended tests worth re-reading:
- `keys.spec.ts` (NEW): the load-bearing one. Asserts byte-order == compareHLC across
  all four components (double loop), counter-rollover-beats-opSeq, change-log key
  round-trip at new offsets (column + delete), and scan-bound exclusivity with a
  **non-zero-opSeq** boundary (excludes `<= since`, includes `since+1`).
- `hlc.spec.ts`: opSeq tiebreak, siteId-beats-opSeq, 30-byte round-trip incl. opSeq,
  rejects legacy 26-byte buffer, JSON opSeq round-trip, **receive ignores remote
  opSeq** (advances identically for opSeq 0 vs 4e9), tick/now produce opSeq 0.
- `change-log.spec.ts`: pruneEntriesBefore prunes strictly-before a non-zero-opSeq
  boundary; getChangesSince excludes the boundary opSeq and includes the next.

## Use cases to probe (reviewer focus)

1. **Key monotonicity is the whole game.** If lexicographic key order ever diverges
   from `compareHLC`, range scans silently skip/duplicate. Re-derive the offsets:
   `cl:`(3) + HLC(30) + type(1) + suffix; type at byte 33, suffix at 34. Confirm the
   opSeq 4 bytes are the *last* of the 30-byte HLC component (after siteId).
2. **`incrementHLCBytes` carry across the opSeq→siteId boundary is NOT directly
   tested.** The scan-bound tests use small opSeq (5, 10) with no carry. Consider a
   case where `opSeq = 0xFFFFFFFF`: `buildChangeLogScanBoundsAfter` must carry into the
   siteId bytes correctly (the increment is generic last-byte-carry, so it *should*
   work, but it's unverified). **Known gap — candidate for an added test.**
3. **uint16 counter vs uint32 opSeq widths.** Confirm counter is still 2 BE bytes at
   offset 8 and opSeq is 4 BE bytes at offset 26 in *both* `serializeHLC` and
   `serializeHLCForKey` (they must agree). A width mismatch between the two encoders
   would not be caught by either's own round-trip test.
4. **The 5 shifted metadata serializers** each interleave the HLC with other fields at
   a fixed offset. Spot-check that every post-HLC read moved 26→30 (e.g. schema-version
   writes typeByte at `buffer[30]` and reads it at `buffer[30]`; data at 31/31). A
   stale 26 on one side only would corrupt silently within a single process run.
5. **Greenfield disposition:** on-disk change-log/metadata keys changed shape. Any
   pre-existing LevelDB sync store is now unreadable — intended (AGENTS.md: no backcompat
   yet), documented in the ticket's RESOLVED section. No migration code exists by design.

## Known gaps / honesty

- **No non-zero opSeq is produced anywhere** — grouping behavior is future work; this
  ticket only guarantees the field round-trips and preserves order at opSeq 0 (and at
  arbitrary opSeq in the unit tests).
- **opSeq exhaustion (uint32 overflow → hard error)** is deferred to the producer
  ticket; nothing here can exhaust it.
- **incrementHLCBytes carry at opSeq max** — unverified (item 2 above).
- Did **not** run the full monorepo `yarn test` or `yarn test:store`. Validation was
  scoped to the build + the three packages whose source/tests changed; the main quereus
  engine does not reference HLC. `test:store` exercises the engine logic path, not the
  sync package (sync tests are InMemoryKVStore-backed), so it would not cover this change.
- HLC literal updates in tests were applied via a scoped regex (`counter: …, siteId… }`
  → `…, opSeq: 0 }`); each match was verified to contain `wallTime` before applying, and
  no malformed double-insertions remain — but a reviewer eyeballing the test diffs is the
  backstop.

## Disposition

Minor findings (spacing, a missing carry test, doc nits) → fix inline. If the
incrementHLCBytes-at-opSeq-max behavior turns out wrong, that's a real bug → spawn a
fix/ ticket rather than papering over it. Otherwise → complete/ with a `## Review
findings` section.
