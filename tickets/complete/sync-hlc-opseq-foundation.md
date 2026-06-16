description: HLC `opSeq` foundation — a 4th comparison component `(wallTime, counter, siteId, opSeq)` threaded through compareHLC, all serializers (storage 26→30 bytes, JSON, change-log key), the change-log key encoding/scan-bound math, and 5 downstream metadata serializers. Greenfield key-format change, no migration. `opSeq` is always 0 until the producer ticket lands — a no-behavior-change foundation that preserves total order and key monotonicity.
files:
  - packages/quereus-sync/src/clock/hlc.ts
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/src/metadata/peer-state.ts
  - packages/quereus-sync/src/metadata/schema-migration.ts
  - packages/quereus-sync/src/metadata/schema-version.ts
  - packages/quereus-sync/src/sync/snapshot-stream.ts
  - packages/quereus-sync/test/clock/hlc.spec.ts
  - packages/quereus-sync/test/metadata/keys.spec.ts
  - packages/quereus-sync/test/metadata/change-log.spec.ts
  - packages/quereus-sync-client/test/serialization.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - docs/sync.md
----

# Complete: HLC + opSeq foundation (total-order comparison key)

`compareHLC` is now a 4-tuple `(wallTime, counter, siteId, opSeq)`, with `opSeq` a
per-transaction, 0-based **uint32** that is the *last* tiebreak (compared after
siteId, so it only ever discriminates facts of the *same* transaction). Storage
and key serializers grew 26→30 bytes (4 BE bytes appended after siteId); JSON,
change-log key offsets/scan bounds, `pruneEntriesBefore`, the 5 metadata
serializers, and the snapshot checkpoint all carry it. Nothing assigns a non-zero
opSeq yet (the producer ticket does), so at opSeq 0 the order reduces to the old
3-component order → no behavioral change. Landed independently.

## Review findings

Adversarial pass over the implement-stage diff (`56f73fdb`), read before the
handoff. Scrutinized for key monotonicity, offset consistency across all encoders,
DRY/SPP, type safety, error handling, and doc accuracy. The implementation was
solid; two minor issues found and fixed inline, no major findings.

### Checked — key monotonicity (the load-bearing invariant) ✓
Re-derived the change-log key layout: `cl:`(3) + HLC(30) + type(1) + suffix → type
at byte 33, suffix at 34; gte buffer `3+30`. The opSeq 4 bytes are the *last* of
the 30-byte HLC (offset 26, after siteId at 10..25), so lexicographic key order ==
`compareHLC`. `keys.spec.ts` proves this with a double-loop over a component-spanning
set for both `serializeHLCForKey` and full `buildChangeLogKey`, plus
counter-rollover-beats-opSeq. Confirmed counter is uint16 @ offset 8 and opSeq is
uint32 @ offset 26 in *both* `serializeHLC` and `serializeHLCForKey` (they agree).

### Checked — the 5 shifted metadata serializers ✓
column-version (`slice(0,30)`/`slice(30)`), tombstones & peer-state (buffer 34→38,
field @ 30), schema-migration (`offset += 30`), schema-version (typeByte @ 30, data
@ 31) — every post-HLC read/write moved 26→30 consistently on both encode and decode
sides. Verified via `serializeHLC(` reference sweep that these are the *only* five
fixed-offset HLC embedders — no sixth was missed.

### Checked — hand-rolled HLC comparisons ✓
`pruneEntriesBefore` was the only ad-hoc wallTime/counter compare; it now uses
`compareHLC(...) >= 0` so opSeq participates. A `.wallTime`/`.counter` comparison
sweep confirms the only remaining hand comparisons live inside `compareHLC` itself
and the `HLCManager` clock-merge (which legitimately ignores opSeq — `receive`
ignores `remote.opSeq`, tested).

### Checked — `hc:` clock state stayed 10 bytes ✓
`persistHLCState` / `persistHLCStateBatch` still write `{wallTime(8), counter(2)}` =
10 bytes; `getState()` returns only those two. opSeq is transaction-local and
correctly never persisted there.

### Checked — transport & checkpoint carry opSeq ✓
Client `serializeHLCForTransport`/change-set serialization delegate to the binary
`serializeHLC`, so opSeq rides through transport. Snapshot checkpoint JSON carries
`opSeq` with a `?? 0` decode fallback.

### Fixed inline (minor)
- **Missing carry test (handoff item 2).** The `incrementHLCBytes` carry across the
  opSeq→siteId boundary at `opSeq = 0xFFFFFFFF` was unverified. Analyzed the generic
  last-byte-carry: at max opSeq it rolls all four opSeq bytes to 0 and increments the
  low siteId byte — correct, since the next possible key is `(wallTime, counter,
  siteId+1, opSeq 0)`. Added a test in `keys.spec.ts` asserting the decoded gte HLC
  carried exactly that way and that the boundary fact is excluded. (sync 215→216
  passing.)
- **Stale doc comment.** `schema-version.ts` file header still read "HLC (26 bytes)";
  corrected to 30.

### Noted — not actioned (acceptable for a foundation)
- **No opSeq range validation.** `createHLC` / serializers accept any `number`;
  `setUint32` silently wraps values outside `[0, 2^32)`. This matches the existing
  `counter` pattern (createHLC doesn't enforce `MAX_COUNTER` either — only the
  manager does) and the handoff explicitly defers opSeq exhaustion / a hard-error on
  overflow to the producer ticket (`sync-per-transaction-hlc-tick`), where a non-zero
  opSeq is first produced. No new ticket: it is already captured as the producer's
  responsibility.
- **Test literal style.** The ~60 HLC literals were updated via a scoped regex,
  leaving `siteId, opSeq: 0` on one line in the client specs. Valid and harmless;
  not churned.

### Greenfield disposition ✓
On-disk change-log/metadata key shapes changed; any pre-existing LevelDB sync store
is now unreadable — intended (AGENTS.md: no back-compat yet), no migration by design.

## Validation
- `yarn workspace @quereus/sync build` — clean (tsc).
- `yarn workspace @quereus/sync test` — **216 passing** (215 + the added carry test).
- `yarn workspace @quereus/sync-client test` — **45 passing**.
- `yarn workspace @quereus/sync-coordinator test` — **121 passing** (consumes
  `createHLC`, unaffected).
- No lint run: per AGENTS.md only `packages/quereus` has a lint script (untouched by
  this change); the tsc build is the type-check gate for the sync packages and passed.
- The `[Sync] Error handling …` console lines during the sync run are intentional
  fault-injection tests (sync-manager.spec.ts:1211/1243), not failures.

## Future work (already ticketed elsewhere)
- `sync-per-transaction-hlc-tick` / plan `sync-hlc-transaction-grouping` — the
  producer that assigns non-zero opSeq per transaction and adds the uint32-overflow
  hard error.
