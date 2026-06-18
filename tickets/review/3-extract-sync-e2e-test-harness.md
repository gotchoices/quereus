description: Review the extraction of duplicated sync-test boilerplate into a shared helper module.
prereq:
files:
  - packages/quereus-sync/test/sync/_peer-harness.ts   (new)
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts
----

## What was done

Created `packages/quereus-sync/test/sync/_peer-harness.ts` exporting:

- `COLUMNS_PER_FRESH_INSERT = 2`
- `DEFAULT_ORDERS_DDL`
- `createInMemoryProvider()` — returns `{ provider, stores }`
- `collect(db, sql)` — async row collector
- `settle` — 25ms timeout promise
- `Peer` interface
- `makePeer(name, opts?)` — full-wired real-engine peer; supports `createOrders`, `disposition`, `ordersDdl`
- `closePeer(peer)`
- `localWrite(peer, sql)`
- `relay(from, to)` — returns `ApplyResult` (satisfies all callers that access `.applied`)
- `changesFor(peer, excludeSiteId: Uint8Array)` — returns `Change[]`
- `flattenSets`, `hasOrders`
- `reviveOrders(peer, ddl?)`

## Per-file changes

| File | Removed | Added |
|---|---|---|
| `store-and-forward-relay-e2e.spec.ts` | All local boilerplate + COLUMNS_PER_FRESH_INSERT | Import from harness |
| `sync-drain-e2e.spec.ts` | All local boilerplate + constants | Import from harness |
| `echo-loop-quiescence.spec.ts` | `createInMemoryProvider`, `collect`, `settle`, `Peer`, `closePeer`, `localWrite`, `relay`, `changesFor`, two local `COLUMNS_PER_FRESH_INSERT` | Import from harness; **kept** echo-loop-specific `makeBarePeer`, `makePeer`, `makeFilledPeer`, `makeFilteredFilledPeer`, `makeFilteredEmptyPeer` |
| `snapshot-bootstrap.spec.ts` | Local `createInMemoryProvider` + `collect` | Import from harness |
| `store-adapter-seam.spec.ts` | Local `createInMemoryProvider` + `collect` | Import from harness |
| `store-adapter-pk-collation.spec.ts` | Local `createInMemoryProvider` (KVStoreProvider-only variant) + `collect` | Import from harness; `beforeEach` uses `provider = createInMemoryProvider().provider` |

## Validation

- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` exits 0 (no errors)
- Mocha suite: **425 passing**, 0 failing (ticket expected ≥ 412)

## Known gaps / reviewer notes

- `store-adapter-pk-collation.spec.ts` used a narrower `createInMemoryProvider` (returned `KVStoreProvider` only, not `{ provider, stores }`). Changed to `.provider` property access — functionally equivalent.
- Echo-loop's `relay` was typed `Promise<ApplyResult>` while drain/relay-e2e typed theirs `Promise<{ applied: number }>`. Harness uses `ApplyResult` which satisfies both (all callers only access `.applied`).
- Echo-loop's `changesFor` was `Promise<readonly unknown[]>` while harness uses `Promise<Change[]>`. The test code casts elements with `as { table: string }` which still compiles since `Change` has `table: string`.
- The 425 test count (up from expected 412) reflects tests added since the ticket was written.
