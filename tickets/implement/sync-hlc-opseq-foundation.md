description: Add a per-transaction `opSeq` sub-order to the HLC tuple so the comparison key is a single total order. Extend the HLC type, compareHLC, all three serializers (storage / JSON / change-log key), and the change-log key encoding + scan-bound math. Greenfield key-format change (no migration). Foundation for per-transaction HLC grouping; no behavioral grouping change yet (every fact still gets opSeq 0 until the producer ticket sets it).
prereq:
files:
  - packages/quereus-sync/src/clock/hlc.ts                  # HLC type, compareHLC, createHLC, serialize/deserialize, hlcToJson/FromJson, HLCManager.tick/receive/now
  - packages/quereus-sync/src/metadata/keys.ts              # serializeHLCForKey/deserializeHLCFromKey, buildChangeLogKey, buildChangeLogScanBoundsAfter, parseChangeLogKey
  - packages/quereus-sync/src/metadata/change-log.ts        # pruneEntriesBefore HLC comparison (must respect opSeq via compareHLC)
  - packages/quereus-sync/test/                             # hlc + keys unit tests (round-trip, ordering)
  - docs/sync.md                                            # § Hybrid Logical Clock (HLC) — document the opSeq dimension
difficulty: hard
----

# HLC + opSeq: make the comparison key a total order

## Goal

Extend the Hybrid Logical Clock so the canonical comparison key is the 4-tuple
`(wallTime, counter, siteId, opSeq)`. `opSeq` is a **per-transaction**,
contiguous sub-order (0 for the first fact of a transaction). This is the data-model
layer for "HLC = transaction" (Lamina §4). This ticket adds the field and threads
it through every place an HLC is compared, serialized, deserialized, or encoded into
a key — but does **not** yet change *when* the clock ticks (still per row-event).
Until the producer ticket (`sync-per-transaction-hlc-tick`) lands, every fact is
produced with `opSeq = 0`, which makes `compareHLC` reduce to the current
3-component order — so this ticket is independently landable with no behavior change.

## Type & comparison

```ts
// hlc.ts
interface HLC {
  readonly wallTime: bigint;
  readonly counter: number;       // 0–65535 (uint16)
  readonly siteId: SiteId;        // 16 bytes
  readonly opSeq: number;         // NEW: per-transaction sub-order, 0-based (uint32)
}

// compareHLC: existing wallTime, counter, siteId comparisons …then:
//   if (a.opSeq < b.opSeq) return -1;
//   if (a.opSeq > b.opSeq) return 1;
//   return 0;
```

- `createHLC(wallTime, counter, siteId, opSeq = 0)` — default `0` to keep the many
  existing call sites (tick/receive/now, deserializers, applicator) terse while the
  field stays **required** on the interface (AGENTS.md: not type-lazy).
- `HLCManager.tick()` / `receive()` / `now()` produce `opSeq: 0`. `opSeq` is **not**
  a clock-monotonicity component: it is transaction-local. `receive(remote)` merges
  `wallTime`/`counter` exactly as today and **ignores** `remote.opSeq` for the merge
  (inbound facts retain their own `opSeq` through deserialization, not through the
  receive return value).

## Width & encoding decision (RESOLVED)

- **`opSeq` is `uint32` (4 bytes).** A transaction's fact count = (changed columns ×
  rows) + deletions + schema migrations; `batchSize` defaults to 1000 and bulk loads
  can far exceed 65535, so uint16 is too small. uint32 (4.29e9) cannot be reached by
  a single in-memory transaction. Exhaustion is a hard error, not a silent wrap —
  see the producer ticket.
- **Storage `serializeHLC`** (`hlc.ts`, currently 26 bytes): append 4 BE bytes →
  **30 bytes**. Update `deserializeHLC` length check (26→30) and the offset reads.
- **JSON `SerializedHLC`** (`hlcToJson`/`hlcFromJson`): add `opSeq: number`.
- **Change-log key `serializeHLCForKey`** (`keys.ts`, currently 26 bytes): append 4
  BE bytes → **30 bytes**, so lexicographic key order matches `compareHLC` (the
  opSeq bytes sit *after* siteId, the last tiebreak — correct). Update
  `deserializeHLCFromKey`.
- **`buildChangeLogKey`** offsets: HLC component 26→30 ⇒ type byte moves `key[29]`→
  `key[33]`, suffix start `30`→`34`, total length `3+26+1`→`3+30+1`. Update
  `parseChangeLogKey` slice offsets (hlc `3..29`→`3..33`, type `29`→`33`, suffix
  `30`→`34`) and its minimum-length guard (`31`→`35`).
- **`buildChangeLogScanBoundsAfter`** and the private `incrementHLCBytes`: operate on
  the now-30-byte HLC prefix; the byte-increment "smallest key greater than sinceHLC"
  logic is unchanged in spirit but must increment the full 30-byte component. The
  `gte` buffer is `3 + 30`.
- **`change-log.ts` `pruneEntriesBefore`** currently hand-compares `wallTime`/
  `counter` only. Leave it correct under opSeq: it prunes entries strictly before a
  boundary HLC; compare via `compareHLC(parsed.hlc, beforeHLC) < 0` rather than the
  ad-hoc field comparison, so opSeq participates consistently. (Pruning is by
  transaction boundary in the watermark world — keep it monotone.)

## Key-format change disposition (RESOLVED)

**Greenfield, no migration.** AGENTS.md: backwards-compat is not yet a goal. The
on-disk change-log key layout changes (26→30-byte HLC component). Existing dev/test
stores are discarded. The only hard requirement: the new key order stays **monotone**
and matches `compareHLC` (verified by the round-trip + ordering tests below).

## HLC_STATE persistence is unaffected

`hc:` (HLC clock state) persists only `{wallTime, counter}` (see
`sync-manager-impl.ts` create + `persistHLCState`). `opSeq` is transaction-local and
resets every transaction — it is **not** clock state and must **not** be persisted
there. Leave the `hc:` read/write at 10 bytes.

## Edge cases & interactions

- **Mixed-origin facts at equal `(wallTime, counter)`** — `siteId` is compared
  *before* `opSeq`, so two different sites never reach the `opSeq` tiebreak; `opSeq`
  only ever discriminates facts from the **same** site at the same `(wallTime,
  counter)` — i.e. the same transaction. `siteId + opSeq` is therefore sufficient;
  no `prior_hlc` disambiguation is needed. Add a unit test asserting two distinct
  sites at equal `(wallTime, counter)` order by siteId regardless of opSeq.
- **Key monotonicity** — round-trip test: for a sorted set of HLCs differing only in
  `opSeq`, `buildChangeLogKey` byte order must equal `compareHLC` order. Also test
  ordering across a `counter` rollover vs an `opSeq` increment.
- **Scan bound exclusivity** — `buildChangeLogScanBoundsAfter(h)` must EXCLUDE every
  entry `<= h` and INCLUDE the next. Test with `h` carrying a non-zero `opSeq`
  (e.g. the last fact of a transaction): the next scan starts strictly after it.
- **deserialize length guards** — `deserializeHLC` (30) and `parseChangeLogKey`
  (min 35) reject short buffers; add negative tests.
- **`receive` ignores opSeq** — test that `receive(remote)` advances the clock from
  `remote.wallTime/counter` identically whether `remote.opSeq` is 0 or large.

## Key tests (TDD)

- `compareHLC`: total order across all four components; opSeq is the last tiebreak;
  siteId beats opSeq.
- `serializeHLC`/`deserializeHLC`: 30-byte round-trip incl. opSeq; rejects 26-byte.
- `hlcToJson`/`hlcFromJson`: opSeq survives JSON round-trip.
- `serializeHLCForKey`/`deserializeHLCFromKey` + `buildChangeLogKey`/
  `parseChangeLogKey`: 30-byte HLC component round-trip; type byte + suffix parse at
  new offsets; lexicographic order == `compareHLC`.
- `buildChangeLogScanBoundsAfter`: excludes `<= sinceHLC` including a non-zero-opSeq
  boundary.

## TODO

- Add `opSeq` to the `HLC` interface; update `createHLC` (default 0), `compareHLC`,
  `hlcEquals` (unchanged — delegates to compareHLC), `tick`/`receive`/`now`.
- Update `serializeHLC`/`deserializeHLC` (26→30) and `SerializedHLC` +
  `hlcToJson`/`hlcFromJson`.
- Update `serializeHLCForKey`/`deserializeHLCFromKey`, `buildChangeLogKey`,
  `parseChangeLogKey` (offsets + min-length), `buildChangeLogScanBoundsAfter`,
  `incrementHLCBytes` for the 30-byte HLC component.
- Switch `change-log.ts` `pruneEntriesBefore` to `compareHLC`-based boundary check.
- Audit every other `createHLC(...)` / HLC-literal construction in
  `packages/quereus-sync/src` (column-version, tombstones, schema-migration
  deserializers; snapshot (de)serialization) and ensure opSeq is carried (default 0
  is fine for existing literals; deserializers that read persisted HLCs must read the
  new opSeq byte). Grep `createHLC|wallTime:` under `packages/quereus-sync/src`.
- Add/extend unit tests above.
- Update `docs/sync.md` § Hybrid Logical Clock to document the `opSeq` dimension and
  that the comparison key is `(wallTime, counter, siteId, opSeq)`.
- `yarn workspace @quereus/sync build` + the sync package tests must pass; run
  `yarn lint` in `packages/quereus` only if engine files were touched (they are not
  here).
