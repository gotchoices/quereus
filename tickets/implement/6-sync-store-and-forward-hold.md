<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-17T20:38:55.008Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\6-sync-store-and-forward-hold.implement.2026-06-17T20-38-55-008Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: When a peer no longer has a table, let an operator configure it to durably keep an incoming straggler's edits for that table AND mark them as ready to be passed along to other peers — this ticket builds the "keep and mark" half (the actual passing-along is a follow-up).
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts              # UnknownTableDisposition enum + DEFAULT_SYNC_CONFIG + doc
  - packages/quereus-sync/src/metadata/quarantine.ts        # forwardable flag on entry + put() param + listForwardable scan
  - packages/quereus-sync/src/sync/change-applicator.ts     # hold under 'store-and-forward' (forwardable=true)
  - packages/quereus-sync/src/sync/sync-context.ts          # recordUnknownTable already takes disposition (no sig change)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # unknownTableForwarded counter + stats field
  - packages/quereus-sync/src/sync/manager.ts               # getUnknownTableStats() return shape (+ forwarded)
  - packages/quereus-sync/src/sync/events.ts                # UnknownTableEvent.disposition (type already widens)
  - docs/migration.md                                       # § 4 Contract — disposition list
  - docs/sync.md                                            # § Unknown-Table Disposition table + stats
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts  # extend
difficulty: medium
----

# Store-and-forward, part 1: the durable hold + forwardable mark

This is the **first** of two prereq-chained tickets that together deliver the
`store-and-forward` (relay) unknown-table disposition deferred from the completed
`sync-unknown-table-disposition` work (see `tickets/complete/2-sync-unknown-table-disposition.md`
and `docs/migration.md` § 4 Contract). This ticket builds the in-engine substrate
**within `@quereus/sync` only** — no transport/client/coordinator changes. The
outbound relay wiring is the sibling ticket `sync-store-and-forward-relay`
(prereq: this one).

## Background (what already exists)

`applyChanges` (`change-applicator.ts`) detects out-of-basis straggler changes
**structurally** at Phase 1 — a change whose table is neither in the local basis
nor created by the batch (and not dropped by it) is **diverted** out of the
resolve/apply/CRDT-metadata path and either dropped (`ignore`) or durably held
(`quarantine`, the default), always telemetered. The hold substrate is
`QuarantineStore` (`metadata/quarantine.ts`): HLC-keyed (`qt:` prefix) so re-apply
is idempotent, staged into the admission `commitMetadata` callback so it lands
**before** the clock watermark advances, GC-bounded by `pruneOlderThan` at the
retention horizon.

`store-and-forward` reuses **exactly** this hold substrate, adding one bit per
entry: **forwardable**. A forwardable entry is held identically to a quarantined
one but is additionally eligible to be re-offered to peers that still hold the
table (the sibling relay ticket consumes the flag). The convergence/loop-freedom
argument (handled in the relay ticket) rests on each forwarded change keeping its
**original `hlc` + `siteId`**, which the verbatim-`Change` storage already
preserves — this ticket changes nothing about how the `Change` is stored, only
adds the flag and the disposition that sets it.

## What this ticket does

### 1. Extend the disposition type
`protocol.ts`:
```ts
export type UnknownTableDisposition = 'ignore' | 'quarantine' | 'store-and-forward';
```
Update the doc comment to describe `store-and-forward` (durably hold **and** mark
forwardable so peers that still have the table receive it; relay wiring is the
relay ticket). `DEFAULT_SYNC_CONFIG.unknownTableDisposition` stays `'quarantine'`
(no default change — opt-in). `events.ts` `UnknownTableEvent.disposition` is typed
as `UnknownTableDisposition`, so it widens automatically; verify it compiles and
the event still fires with the new value.

### 2. Forwardable flag on the hold substrate
`quarantine.ts`:
- Add `readonly forwardable: boolean` to `QuarantineEntry`.
- Serialize as a compact optional field `f?: 1` in `SerializedQuarantineEntry`
  (emit only when `true`, so plain-quarantine entries stay byte-identical to
  today and deserialize to `forwardable: false`). Deserialize: `forwardable: obj.f === 1`.
- `put(batch, change, receivedAt, forwardable: boolean)` — add the param and
  thread it into the serialized entry. HLC-keyed key is **unchanged** (the flag
  lives in the value, not the key), so a change re-delivered under a different
  disposition overwrites its own entry with the new flag — idempotent and
  last-writer-wins on the flag, which is correct (the latest disposition governs).
- Add a read path for forwardable entries the relay ticket will call:
  ```ts
  // Yields held entries marked forwardable. Bounded by the retention horizon
  // (same as list()). The relay ticket filters these by HLC/origin; this method
  // just surfaces the forwardable subset.
  async listForwardable(): Promise<QuarantineEntry[]>
  ```
  Implement as the full `buildQuarantineScanBounds()` scan filtered to
  `entry.forwardable`. (HLC/origin filtering is the relay ticket's concern — keep
  this method dumb so it is independently testable here.)

### 3. Hold under `store-and-forward` in the applicator
`change-applicator.ts`, the disposition block currently guarded by
`disposition === 'quarantine'`:
- Trigger the hold for **both** `quarantine` and `store-and-forward`.
- Pass `forwardable: disposition === 'store-and-forward'` to `quarantine.put`.
- `ignore` still writes nothing.

Keep the hold inside the same `commitMetadata` callback (durable-before-watermark
ordering is the load-bearing crash-safety property — do not move it).

### 4. Telemetry parity
- `sync-manager-impl.ts`: add `private unknownTableForwarded = 0;`. In
  `recordUnknownTable`, add a `store-and-forward` branch that bumps it (the
  `byTable` accumulation stays unconditional, as today).
- `getUnknownTableStats()` (impl + `manager.ts` interface) gains
  `forwarded: number`. Returned shape: `{ ignored, quarantined, forwarded, byTable }`.
- The `onUnknownTable` event already carries `disposition` — it now reports
  `store-and-forward`; no shape change.
- Note in the stats doc-comment that `forwarded` counts changes **held as
  forwardable at apply time**, distinct from the per-relay "relayed" volume the
  relay ticket may add (held once, relayed possibly many times until GC).

### 5. Docs
- `docs/migration.md` § 4 Contract (the `store-and-forward` bullet currently says
  "deferred"): change to describe it as implemented in two parts — this ticket
  (durable forwardable hold + telemetry) and the relay ticket (outbound
  `getChangesSince` integration). Keep the original-HLC loop-breaker sentence.
- `docs/sync.md` § Unknown-Table Disposition: add the `store-and-forward` row to
  the disposition table; update `getUnknownTableStats()` to include `forwarded`.
  Defer the relay/convergence prose to the relay ticket (cross-reference it).

## Edge cases & interactions

- **Idempotent re-apply preserves the flag.** Re-delivering a `store-and-forward`
  batch overwrites each entry's own HLC-key with `f:1` again — exactly one entry,
  still forwardable. Test: apply twice, assert one entry, `forwardable === true`.
- **Disposition flip on re-delivery is last-writer-wins.** Same change arrives
  first as `quarantine` then `store-and-forward` (config changed between applies):
  the second `put` overwrites with `f:1`. Acceptable and correct (latest config
  governs). Test both orders; assert final flag matches the last disposition.
- **`ignore` unaffected.** No hold, no forwardable entry, telemetry still fires
  (`onUnknownTable` + `byTable` + nothing in `forwarded`). Existing tests cover
  ignore; assert `forwarded` stays 0.
- **Self-origin echo still skipped first.** A self-change to a retired table is
  skipped before disposition (existing behavior) — never held as forwardable.
- **GC reclaims forwardable entries too.** `pruneOlderThan` scans all `qt:`
  entries regardless of flag, so a forwardable entry past the horizon is reclaimed
  like a quarantined one (the relay ticket documents the in-flight-relay
  tradeoff). Test: a forwardable entry older than the cutoff is pruned.
- **Serialization round-trip of the flag** with both change kinds (column +
  delete), and with/without before-images, so the flag composes with the existing
  before-image fields. Test `serialize → deserialize` preserves `forwardable`.
- **`byTable` counts store-and-forward changes** under the same `schema.table`
  key as the other dispositions (no double counting against `forwarded`; `byTable`
  is the union, the per-disposition counters partition it).

## Validation
- `yarn workspace @quereus/sync run typecheck` → exit 0.
- `yarn workspace @quereus/sync run test 2>&1 | tee /tmp/sf-hold.log; tail -n 40 /tmp/sf-hold.log`
  — all green; the new disposition's hold/flag/telemetry tests pass; existing
  ignore/quarantine tests unchanged.
- Type-check the touched spec file explicitly (the package `typecheck` excludes
  `test/`): `yarn workspace @quereus/sync exec tsc -p tsconfig.json --noEmit`
  won't cover it — run the test (mocha type-strips) and eyeball for `any`.

## TODO

- [ ] Extend `UnknownTableDisposition` to include `'store-and-forward'`; update its
      doc comment; confirm `events.ts`/`DEFAULT_SYNC_CONFIG` compile unchanged.
- [ ] Add `forwardable` to `QuarantineEntry`; serialize as optional `f?: 1`;
      deserialize to a boolean; round-trip both change kinds.
- [ ] Add the `forwardable` param to `QuarantineStore.put`; key unchanged.
- [ ] Add `QuarantineStore.listForwardable()` (full scan filtered to forwardable).
- [ ] Applicator: hold under both `quarantine` and `store-and-forward`; pass
      `forwardable` accordingly; `ignore` unchanged.
- [ ] Add `unknownTableForwarded` counter + `store-and-forward` branch in
      `recordUnknownTable`; add `forwarded` to `getUnknownTableStats()` (impl +
      `manager.ts`).
- [ ] Update `docs/migration.md` § 4 and `docs/sync.md` disposition table + stats.
- [ ] Tests: hold+flag, idempotent re-apply, disposition-flip LWW, ignore stays
      0, GC prunes forwardable, serialization round-trip, telemetry counts.
- [ ] Run typecheck + package tests; confirm green.
