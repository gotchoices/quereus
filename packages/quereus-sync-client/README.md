# @quereus/sync-client

> **Stability: Experimental** — a research track; the API and the wire protocol it speaks
> may change or disappear without notice, in any release including a patch. See
> [Stability Tiers](../../docs/stability.md#tiers).

WebSocket sync client for [Quereus](https://github.com/gotchoices/quereus). Handles connection management, reconnection, and bidirectional change synchronization.

## Features

- **Automatic reconnection**: Exponential backoff (1s → 60s max) on connection loss
- **Local change batching**: Debounces rapid changes into efficient batches
- **Delta sync**: Only sends changes since last successful sync
- **Snapshot bootstrap**: A new (empty) device downloads a full copy of the database, with progress reporting and automatic resume of an interrupted transfer
- **Framework agnostic**: Works in any JavaScript environment with WebSocket support
- **Type-safe**: Full TypeScript support

## Installation

```bash
npm install @quereus/sync-client
```

## Quick Start

```typescript
import { SyncClient } from '@quereus/sync-client';
import { createSyncModule } from '@quereus/sync';

// Assuming you have a SyncManager from sync
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents);

// Create the sync client
const client = new SyncClient({
  syncManager,
  syncEvents,
  onStatusChange: (status) => {
    console.log('Connection status:', status.status);
  },
  onRemoteChanges: (result, changeSets) => {
    console.log(`Applied ${result.applied} changes`);
  },
  onError: (error) => {
    console.error('Sync error:', error);
  },
});

// Connect to the sync server
await client.connect('wss://your-server.com/sync/ws', 'a1-s1', authToken);

// Changes are synced automatically via syncEvents listener
// When done:
await client.disconnect();
```

## API

### `SyncClient`

Main class for WebSocket-based synchronization.

#### Constructor Options

```typescript
interface SyncClientOptions {
  /** SyncManager from @quereus/sync */
  syncManager: SyncManager;

  /** SyncEventEmitter for local change notifications */
  syncEvents: SyncEventEmitter;

  /** Called when connection status changes */
  onStatusChange?: (status: SyncStatus) => void;

  /** Called when remote changes are applied */
  onRemoteChanges?: (result: ApplyResult, changeSets: ChangeSet[]) => void;

  /** Called on sync events (for logging/UI) */
  onSyncEvent?: (event: SyncEvent) => void;

  /** Called on errors */
  onError?: (error: Error) => void;

  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;

  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;

  /** Maximum reconnect delay in ms (default: 60000) */
  maxReconnectDelayMs?: number;

  /** Debounce window for local changes in ms (default: 50) */
  localChangeDebounceMs?: number;

  /** Auto-download a full snapshot on first connect to a replica with no sync history (default: true). Rows written before sync attached have no history; `unrecordedRows` decides what happens to them */
  bootstrapOnEmpty?: boolean;

  /** What an automatic snapshot does about rows sync has never recorded: 'refuse' stops before deleting anything, 'replace' deletes them, 'adopt' records and pushes them instead (default: 'refuse') */
  unrecordedRows?: 'refuse' | 'replace' | 'adopt';

  /** Snapshot stall watchdog: abort if no chunk arrives within this window in ms (default: 60000) */
  snapshotChunkTimeoutMs?: number;

  /** Fine-grained snapshot transfer progress */
  onSnapshotProgress?: (progress: SnapshotProgress) => void;
}
```

#### Methods

- `connect(url: string, databaseId: string, token?: string): Promise<void>` - Connect to sync server
- `disconnect(): Promise<void>` - Disconnect and stop reconnection attempts
- `requestSnapshot(): Promise<void>` - Explicitly download a full snapshot. **Do not write to the database while it is landing** — a concurrent local write is overwritten by the snapshot and never pushed. Each table the snapshot covers ends up holding exactly the snapshot's rows, so local rows it lacks are deleted, unpushed ones and rows sync has never recorded included
- `hasPendingSnapshot(): Promise<boolean>` - Whether an interrupted snapshot left the local database partial (usable before connecting; the next connect resumes the transfer)
- `status: SyncStatus` - Current connection status (getter property)
- `isConnected: boolean` - Whether the WebSocket is open (getter property)
- `isSynced: boolean` - Whether the client is fully synced (getter property)
- `isBootstrapping: boolean` - Whether a snapshot transfer is in flight (getter property)

### Data written before sync was turned on

Rows written before sync attached have no sync records, so a snapshot from the server would delete them. By default the client stops first:

```typescript
const client = new SyncClient({
  syncManager,
  syncEvents,
  onError: (error) => {
    if (error instanceof UnrecordedRowsError) {
      console.warn('Sync stopped. Tables with local-only rows:', error.tables);
    }
  },
});
```

The client then has status `error`, has closed the socket and will not reconnect. `connect()` has already resolved by that point, so use `onError` or the status rather than its promise. To let the snapshot delete those rows, create a new `SyncClient` with `unrecordedRows: 'replace'` and connect; the `SyncManager` and its data carry over. An explicit `requestSnapshot()` is never checked. See [Rows sync has never recorded](../../docs/sync.md#rows-sync-has-never-recorded).

To keep those rows instead, use `unrecordedRows: 'adopt'`. On first attach the client records them as local changes and pushes them, along with `create table` and `create index` for any table no migration announces, so other devices and new devices receive them. This cannot be undone once pushed: the rows have no real timestamp, so they get the time of adoption and beat any older edit of the same key on the server. It cannot be combined with `readOnly`. See [Adopting rows](../../docs/sync.md#adopting-rows).

### Serialization Helpers

The package exports helpers for ChangeSet serialization:

```typescript
import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from '@quereus/sync-client';
```

## Connection States

The client goes through these states:

```
DISCONNECTED → CONNECTING → SYNCING → SYNCED
                    ↑                    │
                    └────────────────────┘ (on connection loss)
```

- `disconnected`: Not connected
- `connecting`: WebSocket connecting, handshake in progress
- `bootstrapping`: A full snapshot is streaming in — the local database is partial; hold writes until it finishes
- `syncing`: Connected, exchanging initial changes
- `synced`: Fully synchronized, real-time updates active
- `error`: Connection error (will auto-reconnect if enabled, except after a fatal server error, a protocol version mismatch, or a refusal over unrecorded rows, which last until the next `connect()`)

## Protocol

The client implements the Quereus sync WebSocket protocol:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `handshake` | Client→Server | Authenticate with siteId and token |
| `handshake_ack` | Server→Client | Confirm connection |
| `get_changes` | Client→Server | Request changes since HLC |
| `changes` | Server→Client | Initial/requested changes |
| `snapshot_required` | Server→Client | Our watermark predates pruned deletes; the client pushes all its unsent local changes, batch by batch, takes a full snapshot, then catches up |
| `apply_changes` | Client→Server | Send local changes |
| `apply_result` | Server→Client | Confirm changes applied |
| `push_changes` | Server→Client | Real-time changes from other clients |
| `get_snapshot` | Client→Server | Request a full snapshot stream |
| `resume_snapshot` | Client→Server | Resume an interrupted snapshot from a checkpoint |
| `snapshot_chunk` | Server→Client | One streamed snapshot chunk |
| `snapshot_complete` | Server→Client | Snapshot stream finished |
| `ping`/`pong` | Both | Keepalive |

## Related Packages

- [`@quereus/sync`](../quereus-sync/) - Sync module (provides SyncManager)
- [`@quereus/sync-coordinator`](../sync-coordinator/) - Server-side coordinator
- [`@quereus/store`](../quereus-store/) - Storage base layer

## License

MIT

