description: Extract duplicated sync-test boilerplate into a shared helper so future test files don't need to copy it.
prereq:
files:
  - packages/quereus-sync/test/sync/_peer-harness.ts   (new)
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts
difficulty: easy
----

# Extract the shared real-engine sync test harness

Six spec files duplicate ~150 lines of identical wiring.  Pull it into
`packages/quereus-sync/test/sync/_peer-harness.ts` and update every spec to
import from it.

## Shared module API

Create `packages/quereus-sync/test/sync/_peer-harness.ts` exporting:

```typescript
// ── constants ─────────────────────────────────────────────────────────────
export const COLUMNS_PER_FRESH_INSERT = 2;   // id + v/note — PK included for fresh insert
export const DEFAULT_ORDERS_DDL = 'create table orders (id integer primary key, note text) using store';

// ── provider ──────────────────────────────────────────────────────────────
export function createInMemoryProvider(): {
    provider: KVStoreProvider;
    stores: Map<string, InMemoryKVStore>;
}

// ── query helper ──────────────────────────────────────────────────────────
export async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]>

// ── timing ────────────────────────────────────────────────────────────────
export const settle: () => Promise<void>   // setTimeout(resolve, 25)

// ── peer type ─────────────────────────────────────────────────────────────
export interface Peer {
    readonly name: string;
    readonly db: Database;
    readonly provider: KVStoreProvider;
    readonly events: StoreEventEmitter;
    readonly storeModule: StoreModule;
    readonly manager: SyncManagerImpl;
}

// ── peer lifecycle ────────────────────────────────────────────────────────
/**
 * Build a real-engine peer.  `createOrders` creates the `orders` base table
 * with `ordersDdl` (defaults to DEFAULT_ORDERS_DDL).  `disposition` overrides
 * `unknownTableDisposition` in the SyncConfig.
 */
export async function makePeer(
    name: string,
    opts?: { createOrders?: boolean; disposition?: UnknownTableDisposition; ordersDdl?: string }
): Promise<Peer>

export async function closePeer(peer: Peer): Promise<void>

// ── write / relay helpers ─────────────────────────────────────────────────
export async function localWrite(peer: Peer, sql: string): Promise<void>

/**
 * One-directional full DATA relay (from-zero, schema migrations stripped).
 * Returns the full ApplyResult so callers can inspect `.applied` or other fields.
 */
export async function relay(from: Peer, to: Peer): Promise<ApplyResult>

/** Flatten a peer's relayable log, excluding the given siteId. Settles before reading. */
export async function changesFor(peer: Peer, excludeSiteId: Uint8Array): Promise<Change[]>

// ── convenience ───────────────────────────────────────────────────────────
export const flattenSets: (sets: ChangeSet[]) => Change[]
export const hasOrders: (changes: Change[]) => boolean

/**
 * Re-create the `orders` base table on a peer that had it retired.
 * Companion to makePeer — drain-specific but a natural lifecycle helper.
 */
export async function reviveOrders(peer: Peer, ddl?: string): Promise<void>
```

### Imports the shared module needs

```typescript
import { Database, type SqlValue } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, InMemoryKVStore, type KVStoreProvider } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
    DEFAULT_SYNC_CONFIG,
    type ApplyResult, type Change, type ChangeSet, type SyncConfig, type UnknownTableDisposition,
} from '../../src/sync/protocol.js';
```

`SiteId` is `Uint8Array`, so `excludeSiteId: Uint8Array` avoids an extra import in the module itself; callers that need `SiteId` by name can import it from `../../src/clock/site.js` directly.

## Per-file changes

### `store-and-forward-relay-e2e.spec.ts`
Remove local: `createInMemoryProvider`, `collect`, `settle`, `Peer`, `makePeer`, `closePeer`, `localWrite`, `relay`, `changesFor`, `flattenSets`, `hasOrders`, `COLUMNS_PER_FRESH_INSERT`.
Import all from `'./_peer-harness.js'`.
Keep test-specific imports: `ChangeSet`, `Change`, `ColumnChange`, `SyncConfig`, `UnknownTableDisposition`, `siteIdEquals`, `compareHLC`, `createHLC`, `generateSiteId`.

### `sync-drain-e2e.spec.ts`
Remove local: same list plus `DEFAULT_ORDERS_DDL`, `reviveOrders`.
Import all from `'./_peer-harness.js'`.
Keep test-specific imports: `ChangeSet`, `Change`, `UnknownTableDisposition`, `HeldChangesDrainedEvent`, `siteIdEquals`, `compareHLC`, `generateSiteId`.

### `echo-loop-quiescence.spec.ts`
Remove local: `createInMemoryProvider`, `collect`, `settle`, `Peer` interface, `closePeer`, `localWrite`, `changesFor`, `relay`.
Import those from `'./_peer-harness.js'`.
**Keep local**: `makeBarePeer`, `makePeer`, `makeFilledPeer`, `makeFilteredFilledPeer`, `makeFilteredEmptyPeer` — these are echo-loop-specific and build a src+mv schema on top of the shared wiring.  `makeBarePeer` calls `createInMemoryProvider` from the harness.
`COLUMNS_PER_FRESH_INSERT` is used inside nested describe blocks; can import from harness or keep local — import from harness.

### `snapshot-bootstrap.spec.ts`
Remove local: `createInMemoryProvider`, `collect`.
Import those from `'./_peer-harness.js'`.
Keep everything else (all test-specific: `fullWatch`, `upd`, `cvEntry`, `toStream`, `Spies`, `installSpies`, `rowTimeKind`, `rowTimeHasPlan`).

### `store-adapter-seam.spec.ts`
Remove local: `createInMemoryProvider`, `collect`.
Import those from `'./_peer-harness.js'`.
Keep everything else.

### `store-adapter-pk-collation.spec.ts`
Remove local: `createInMemoryProvider` (simpler variant), `collect`.
Import from `'./_peer-harness.js'`.
Note: the local version returned only `KVStoreProvider` (no `stores` map); change callers to
`const { provider } = createInMemoryProvider()` in `beforeEach` / to destructure the returned object.

## Acceptance checks

- `node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-sync/test/**/*.spec.ts"` stays green (412 passing).
- `tsc -p packages/quereus-sync/tsconfig.test.json` exits 0.
- No e2e spec defines its own `createInMemoryProvider` / `makePeer` / `relay` / `settle` etc.

## Edge cases & interactions

- **`relay` return type**: echo-loop uses `res.applied` and `res` as `ApplyResult`; relay/drain only
  check `.applied`.  Returning `ApplyResult` satisfies both.
- **echo-loop's `makePeer` vs shared `makePeer`**: echo-loop's local `makePeer` creates a src+mv
  schema, not an orders table.  It should NOT import `makePeer` from the harness to avoid a name
  collision — only import the primitives it needs.
- **pk-collation `createInMemoryProvider`**: its original returned only `KVStoreProvider`; calling
  `createInMemoryProvider().provider` fixes the mismatch with zero other changes to that spec.
- **`changesFor` return type**: echo-loop casts elements to `{ table: string }` — `Change` has
  `table: string`, so `Change[]` is compatible.
- **`settle` before `changesFor`**: the shared `changesFor` calls `settle()` internally (as all
  three local variants do).  Echo-loop callers that also call `settle()` explicitly before
  `changesFor` are fine — double-settling is harmless.
- **`SiteId` type**: harness uses `Uint8Array` in signatures to avoid exporting the alias; callers
  that need `SiteId` by name import it from `../../src/clock/site.js`.

## TODO

- Create `packages/quereus-sync/test/sync/_peer-harness.ts` with the full implementation
- Update `store-and-forward-relay-e2e.spec.ts`
- Update `sync-drain-e2e.spec.ts`
- Update `echo-loop-quiescence.spec.ts`
- Update `snapshot-bootstrap.spec.ts`
- Update `store-adapter-seam.spec.ts`
- Update `store-adapter-pk-collation.spec.ts`
- Run `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` and the Mocha suite to confirm green
