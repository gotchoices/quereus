description: Check that a peer which no longer has a table can be configured to durably keep a straggler's edits for it AND mark them ready to pass along — the "keep and mark" half of store-and-forward (the passing-along itself is the sibling ticket).
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts              # UnknownTableDisposition + 'store-and-forward' + doc
  - packages/quereus-sync/src/metadata/quarantine.ts        # forwardable flag, put() param, listForwardable
  - packages/quereus-sync/src/sync/change-applicator.ts     # hold under quarantine OR store-and-forward
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # unknownTableForwarded counter + stats
  - packages/quereus-sync/src/sync/manager.ts               # getUnknownTableStats shape (+forwarded)
  - packages/quereus-sync/test/metadata/quarantine.spec.ts            # forwardable serialization round-trips
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts # store-and-forward describe block
  - docs/sync.md                                            # disposition table + stats + SyncConfig type literal
  - docs/migration.md                                       # § 4 Contract store-and-forward bullet (implemented)
----

# Review: store-and-forward, part 1 — the durable forwardable hold

## What landed

The `store-and-forward` disposition's **in-engine substrate** (the "keep and mark"
half). A diverted out-of-basis straggler change is held **identically to
`quarantine`** but additionally marked **forwardable**, so the sibling relay ticket
can re-offer it to peers that still have the table. This ticket adds **no transport,
client, or coordinator surface** — only the flag, the disposition that sets it, the
read path the relay consumes, and telemetry parity.

### Core changes
- **`protocol.ts`** — `UnknownTableDisposition` widened to
  `'ignore' | 'quarantine' | 'store-and-forward'`; doc comment describes the new
  value (durable hold + forwardable mark; original-`hlc`+`siteId` is the relay
  loop-breaker). `DEFAULT_SYNC_CONFIG.unknownTableDisposition` stays `'quarantine'`
  (opt-in, no default change). `ApplyResult.unknownTable` doc enumerates the third
  value. `UnknownTableEvent.disposition` widens automatically (no shape change).
- **`quarantine.ts`** —
  - `QuarantineEntry.forwardable: boolean` (required).
  - Serialized as a compact optional `f?: 1` — **emitted only when `true`**, so a
    plain-quarantine entry stays byte-identical to the pre-store-and-forward encoding
    and decodes to `forwardable: false`. Deserialize: `obj.f === 1`.
  - `put(batch, change, receivedAt, forwardable)` — new param threaded into the
    serialized value. **HLC key is unchanged** (the flag lives in the value), so a
    re-delivery under a different disposition overwrites its own entry — last-writer-
    wins on the flag (latest config governs).
  - `listForwardable()` — full `qt:` scan filtered to `entry.forwardable`; horizon-
    bounded like `list()`, zero-cost with no stragglers. Deliberately dumb (no
    HLC/origin filter — that is the relay ticket's concern), so it is testable here.
- **`change-applicator.ts`** — the hold block triggers for **both** `quarantine`
  and `store-and-forward`, passing `forwardable = disposition === 'store-and-forward'`
  to `quarantine.put`. Still inside the same `commitMetadata` admission unit
  (durable-before-watermark crash-safety preserved). `ignore` still writes nothing.
- **`sync-manager-impl.ts` / `manager.ts`** — `unknownTableForwarded` counter; a
  `store-and-forward` branch in `recordUnknownTable` (the `byTable` accumulation
  stays unconditional — the union the per-disposition counters partition).
  `getUnknownTableStats()` gains `forwarded`. *(The sibling relay ticket, already in
  `review/`, further extended this shape with `relayed` — see the ordering note.)*
- **Docs** — `docs/migration.md` § 4 bullet now reads **implemented** across both
  parts; `docs/sync.md` disposition table has the `store-and-forward` row, the stats
  line lists `forwarded`, and the `SyncConfig.unknownTableDisposition` type literal
  was corrected to include the third value (the one doc line neither the prior hold
  run nor the relay ticket had updated — fixed this run).

## How to validate

```
yarn workspace @quereus/sync run typecheck          # exit 0
yarn workspace @quereus/sync run test               # 371 passing
```

Both confirmed green this run (typecheck exit 0; 371 passing — the noisy `[Sync]
Error handling transaction commit: …` / `batch write failed` / `iterate failed`
lines are deliberate fault-injection in unrelated error-path specs, not failures).

### Test coverage (a floor, not a ceiling)
- **`quarantine.spec.ts` § forwardable flag** — defaults to `false` and is **omitted
  from the encoding** when not forwardable (byte-level absence check); round-trips
  `forwardable: true` on a column change (with and without before-image) and on a
  delete (with and without `priorRow`), so the flag composes with the existing
  before-image fields.
- **`unknown-table-disposition.spec.ts` § store-and-forward** — durable hold +
  forwardable mark + telemetry (`forwarded` counter, `byTable` union, event
  `disposition`); no CRDT metadata written (same diversion as quarantine);
  idempotent re-apply keeps one forwardable entry; **disposition flip is LWW in both
  orders** (`quarantine → store-and-forward` and back); `listForwardable` filters out
  plain-quarantine entries; **GC reclaims forwardable entries** past the horizon like
  quarantined ones; **self-origin echo skipped first** (never held forwardable,
  `forwarded` stays 0). The existing quarantine/ignore tests gained `forwarded === 0`
  assertions.

## Honest gaps / where to push

1. **`forwarded` double-counts on idempotent re-apply — by design, but verify it's
   acceptable.** `recordUnknownTable` bumps the counter once per diverted
   `(schema,table)` group on **every** apply, so a re-delivered batch (crash before
   watermark) bumps `forwarded` again even though `listForwardable` still shows one
   entry. This is **pre-existing telemetry semantics** — `quarantined`/`ignored`
   already behave identically; the counters measure "changes diverted this apply,"
   not "distinct entries held." Not a regression, but worth a conscious sign-off, and
   no test pins the post-re-apply counter value.
2. **No real-engine end-to-end test of the hold.** Coverage asserts at the
   SyncManager/CRDT-metadata + serializer layers (mirroring the existing disposition
   spec), not through a real `Database` + `StoreModule`. The relay ticket carries the
   same gap as its highest-value item; a shared real-engine straggler→hold→relay test
   would harden both. Out of scope here.
3. **`listForwardable` is an unbounded full scan.** It scans every `qt:` entry and
   filters in memory. Horizon-bounded (same as `list()`), zero-cost with no
   stragglers, fine for the transitional window the feature targets — but if a
   deployment accumulates many forwardable holds, the relay calling this per
   `getChangesSince` is O(all-quarantine) each round. The relay ticket's review
   should weigh whether an HLC/origin-indexed read path is warranted; deliberately
   left dumb here per the ticket.

## Ordering note (unusual — read before reviewing)

This ticket's prior implement run **errored after the code + tests landed but before
the doc edits and the file transition** (see the `<!-- resume-note -->` that was on
the source ticket). The runner committed that partial work in `a0410716`
("agent error on sync-store-and-forward-hold — added resume note") — so **all the
source and test changes above are already committed**, not staged in the working
tree. The downstream **relay ticket** (`sync-store-and-forward-relay`, prereq: this
one) then ran on top of that committed substrate, finished the docs to the
both-parts-implemented state, extended the stats shape with `relayed`, and is **now
already in `review/`** (`tickets/review/6.5-sync-store-and-forward-relay.md`).

Consequences for the reviewer:
- The working tree / diff for this ticket and the relay ticket **overlap** in
  `sync-manager-impl.ts`, `manager.ts`, `sync-client.spec.ts`, `docs/sync.md`, and
  `docs/migration.md`. When reviewing this hold ticket, scope to the substrate
  (forwardable flag, `listForwardable`, hold-under-both-dispositions, `forwarded`
  telemetry); the `relayed` counter, `collectForwardableChanges`, the `getChangesSince`
  merge, and the relay prose belong to the relay ticket's review.
- This resumed run's **only** working-tree change is the one-line `SyncConfig` type-
  literal fix in `docs/sync.md`; everything else is verification + this transition.
