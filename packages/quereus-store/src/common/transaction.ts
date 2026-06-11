/**
 * Transaction coordinator for virtual table modules.
 *
 * Manages a shared WriteBatch across all tables in a transaction,
 * providing multi-table atomicity.
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import { bytesToHex, compareBytes } from './bytes.js';
import type { DataChangeEvent, StoreEventEmitter } from './events.js';
import type { KVStore } from './kv-store.js';

/** Operation recorded in the transaction. */
interface PendingOp {
  type: 'put' | 'delete';
  store?: KVStore;
  key: Uint8Array;
  value?: Uint8Array;
}

/**
 * The coordinator's default store: either a concrete handle or a lazy thunk
 * resolved on first need (commit of default-store ops). The thunk form lets a
 * coordinator be constructed synchronously before its store has ever been
 * opened — e.g. by a synchronous `connect()` that must not await storage.
 */
export type DefaultStoreSource = KVStore | (() => Promise<KVStore>);

/**
 * View of buffered ops targeting a specific store, with last-write-wins semantics.
 *
 * Returned views are LIVE references into the coordinator's incremental index —
 * O(1) to obtain, but callers must treat them as read-only snapshots-in-time
 * and must not retain them across further coordinator mutations.
 */
export interface PendingStoreOps {
  /** Pending puts (key/value) for this store, keyed by hex-encoded key. */
  puts: ReadonlyMap<string, { key: Uint8Array; value: Uint8Array }>;
  /** Hex-encoded keys with a pending delete for this store. */
  deletes: ReadonlySet<string>;
}

/**
 * Key-ordered view of buffered ops targeting a specific store: the merge input
 * for read-your-own-writes scans. `puts` is sorted ascending by encoded key
 * bytes (the KVStore iteration order).
 *
 * Unlike {@link PendingStoreOps}, both members are point-in-time COPIES: a
 * merge scan holds this view across awaits where further coordinator
 * mutations can interleave (e.g. pipelined DML over an open cursor), so the
 * view must stay stable for the scan's lifetime.
 */
export interface OrderedPendingOps {
  /** Pending puts sorted ascending by encoded key bytes. */
  puts: ReadonlyArray<{ key: Uint8Array; value: Uint8Array }>;
  /** Hex-encoded keys with a pending delete for this store. */
  deletes: ReadonlySet<string>;
}

/** Mutable index bucket backing the read-only views above. */
interface PendingBucket {
  puts: Map<string, { key: Uint8Array; value: Uint8Array }>;
  deletes: Set<string>;
}

/** Shared empty view returned when a store has no pending ops. */
const EMPTY_PENDING: PendingStoreOps = Object.freeze({
  puts: new Map<string, { key: Uint8Array; value: Uint8Array }>(),
  deletes: new Set<string>(),
});
const EMPTY_ORDERED: OrderedPendingOps = Object.freeze({
  puts: [],
  deletes: new Set<string>(),
});

/** Savepoint snapshot recording position in the operation/event arrays. */
interface SavepointSnapshot {
  opIndex: number;
  eventIndex: number;
}

/** Callback for transaction lifecycle events. */
export interface TransactionCallbacks {
  onCommit: () => void;
  onRollback: () => void;
}

/**
 * Coordinates transactions across multiple tables.
 *
 * All mutations within a transaction are buffered in a shared WriteBatch.
 * On commit, the batch is written atomically and events are fired.
 * On rollback, the batch and events are discarded.
 *
 * Buffered ops are additionally indexed per target store with last-write-wins
 * semantics (see {@link getPendingOpsForStore} / {@link getOrderedPendingOps}),
 * so reads that need to see intra-transaction writes are O(1) rather than a
 * re-scan of the op log. The default store may be a lazy thunk
 * ({@link DefaultStoreSource}); ops queued without an explicit store target the
 * default bucket by *role*, never by handle identity, so an unresolved default
 * can never misfile them.
 */
export class TransactionCoordinator {
  private storeSource: DefaultStoreSource;
  /** Concrete default store once known (immediately for a handle, on first resolve for a thunk). */
  private resolvedStore: KVStore | null;
  private storePromise: Promise<KVStore> | null = null;
  private eventEmitter?: StoreEventEmitter;

  // Transaction state
  private inTransaction = false;
  private pendingOps: PendingOp[] = [];
  private pendingEvents: DataChangeEvent[] = [];
  private savepointStack: SavepointSnapshot[] = [];
  private callbacks: TransactionCallbacks[] = [];
  /**
   * Incremental last-write-wins index over `pendingOps`, bucketed per target
   * store. The `null` key is the default-store bucket (ops queued with no
   * explicit store); explicit stores key their own bucket — except an explicit
   * handle that IS the resolved default, which folds into the default bucket
   * so both addressing forms see the same ops (see {@link bucketKey}).
   */
  private pendingIndex = new Map<KVStore | null, PendingBucket>();

  constructor(store: DefaultStoreSource, eventEmitter?: StoreEventEmitter) {
    this.storeSource = store;
    this.resolvedStore = typeof store === 'function' ? null : store;
    this.eventEmitter = eventEmitter;
  }

  /** Register callbacks for transaction lifecycle events. */
  registerCallbacks(callbacks: TransactionCallbacks): void {
    this.callbacks.push(callbacks);
  }

  /** Check if a transaction is active. */
  isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** Begin a transaction. */
  begin(): void {
    if (this.inTransaction) {
      // Already in transaction - no-op (matches SQLite semantics)
      return;
    }
    this.inTransaction = true;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepointStack = [];
    this.pendingIndex = new Map();
  }

  /** Queue a put operation. If store is provided, targets that store instead of the default. */
  put(key: Uint8Array, value: Uint8Array, store?: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'put', store, key, value });
    const bucket = this.bucketFor(this.bucketKey(store));
    const hex = bytesToHex(key);
    bucket.puts.set(hex, { key, value });
    bucket.deletes.delete(hex);
  }

  /** Queue a delete operation. If store is provided, targets that store instead of the default. */
  delete(key: Uint8Array, store?: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'delete', store, key });
    const bucket = this.bucketFor(this.bucketKey(store));
    const hex = bytesToHex(key);
    bucket.deletes.add(hex);
    bucket.puts.delete(hex);
  }

  /** Queue a data change event (fired on commit). */
  queueEvent(event: DataChangeEvent): void {
    if (!this.inTransaction) {
      // If not in transaction, emit immediately
      this.eventEmitter?.emitDataChange(event);
      return;
    }
    this.pendingEvents.push(event);
  }

  /** Commit the transaction. */
  async commit(): Promise<void> {
    if (!this.inTransaction) {
      return;
    }

    try {
      // Group pending operations by target store. Buckets share the index's
      // addressing (`bucketKey`), so an explicit handle that is the resolved
      // default lands in the default bucket — one batch per physical store.
      if (this.pendingOps.length > 0) {
        const opsByStore = new Map<KVStore | null, PendingOp[]>();
        for (const op of this.pendingOps) {
          const target = this.bucketKey(op.store);
          let ops = opsByStore.get(target);
          if (!ops) { ops = []; opsByStore.set(target, ops); }
          ops.push(op);
        }

        // Resolve the default store lazily here — and only when default-bucket
        // ops exist, so a coordinator that only ever targeted explicit stores
        // never opens the default. Resolving BEFORE any batch is written keeps
        // a failed resolve from stranding a partial multi-store commit.
        const defaultStore = opsByStore.has(null) ? await this.resolveStore() : null;

        // Write a batch per store.
        for (const [target, ops] of opsByStore) {
          const targetStore = target ?? defaultStore!;
          const batch = targetStore.batch();
          for (const op of ops) {
            if (op.type === 'put') {
              batch.put(op.key, op.value!);
            } else {
              batch.delete(op.key);
            }
          }
          await batch.write();
        }
      }

      // Fire all pending events
      for (const event of this.pendingEvents) {
        this.eventEmitter?.emitDataChange(event);
      }

      // Notify callbacks
      for (const cb of this.callbacks) {
        cb.onCommit();
      }
    } finally {
      this.clearTransaction();
    }
  }

  /** Rollback the transaction. */
  rollback(): void {
    if (!this.inTransaction) {
      return;
    }

    // Notify callbacks
    for (const cb of this.callbacks) {
      cb.onRollback();
    }

    this.clearTransaction();
  }

  /** Create a savepoint at the given depth. */
  createSavepoint(_depth: number): void {
    if (!this.inTransaction) {
      // Start implicit transaction
      this.begin();
    }
    this.savepointStack.push({
      opIndex: this.pendingOps.length,
      eventIndex: this.pendingEvents.length,
    });
  }

  /** Release savepoints down to the target depth. */
  releaseSavepoint(targetDepth: number): void {
    this.savepointStack.length = targetDepth;
  }

  /** Rollback to a savepoint at the target depth (preserves the savepoint). */
  rollbackToSavepoint(targetDepth: number): void {
    if (targetDepth >= this.savepointStack.length) {
      throw new QuereusError(`Savepoint depth ${targetDepth} not found`, StatusCode.NOTFOUND);
    }

    const snapshot = this.savepointStack[targetDepth];

    // Truncate operations and events back to the snapshot
    this.pendingOps = this.pendingOps.slice(0, snapshot.opIndex);
    this.pendingEvents = this.pendingEvents.slice(0, snapshot.eventIndex);

    // Rebuild the pending index from the truncated log: last-write-wins can't
    // be incrementally undone (the pre-image is gone), and rollback-to is rare
    // enough that an O(ops) replay is fine.
    this.rebuildPendingIndex();

    // Remove savepoints above the target, but preserve the target itself
    this.savepointStack.length = targetDepth + 1;
  }

  /** Clear all transaction state. */
  private clearTransaction(): void {
    this.inTransaction = false;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepointStack = [];
    this.pendingIndex = new Map();
  }

  /**
   * Get the underlying default store for direct reads.
   * Throws MISUSE when the coordinator was constructed with a lazy thunk that
   * has not resolved yet (nothing has needed the concrete handle so far).
   */
  getStore(): KVStore {
    if (!this.resolvedStore) {
      throw new QuereusError('Default store not yet resolved (lazily constructed coordinator)', StatusCode.MISUSE);
    }
    return this.resolvedStore;
  }

  /** Resolve (and cache) the concrete default store. */
  private resolveStore(): Promise<KVStore> {
    if (this.resolvedStore) {
      return Promise.resolve(this.resolvedStore);
    }
    if (!this.storePromise) {
      this.storePromise = (this.storeSource as () => Promise<KVStore>)().then(store => {
        this.resolvedStore = store;
        return store;
      }).catch(err => {
        // Allow a later retry rather than caching the rejection forever.
        this.storePromise = null;
        throw err;
      });
    }
    return this.storePromise;
  }

  /**
   * Map a per-op / per-query store argument to its index bucket. `undefined`
   * means "the default store" (the `null` bucket); an explicit handle that is
   * the resolved default also folds into the default bucket so both addressing
   * forms see the same ops.
   *
   * CONTRACT: while the default is an unresolved thunk, callers must address
   * it by omission, never by handle. The handle may well exist elsewhere (e.g.
   * opened through the owning module's store cache), but passing it here
   * before resolution would file ops in a handle-keyed bucket invisible to
   * default-bucket readers. In-package callers honor this: data-store ops are
   * always queued/read with no store argument; explicit handles are used only
   * for index stores, which are never the default.
   */
  private bucketKey(store?: KVStore): KVStore | null {
    if (store === undefined) return null;
    if (this.resolvedStore !== null && store === this.resolvedStore) return null;
    return store;
  }

  /** Get or create the mutable index bucket for a bucket key. */
  private bucketFor(key: KVStore | null): PendingBucket {
    let bucket = this.pendingIndex.get(key);
    if (!bucket) {
      bucket = { puts: new Map(), deletes: new Set() };
      this.pendingIndex.set(key, bucket);
    }
    return bucket;
  }

  /** Rebuild the per-store index by replaying the (truncated) op log. */
  private rebuildPendingIndex(): void {
    this.pendingIndex = new Map();
    for (const op of this.pendingOps) {
      const bucket = this.bucketFor(this.bucketKey(op.store));
      const hex = bytesToHex(op.key);
      if (op.type === 'put') {
        bucket.puts.set(hex, { key: op.key, value: op.value! });
        bucket.deletes.delete(hex);
      } else {
        bucket.deletes.add(hex);
        bucket.puts.delete(hex);
      }
    }
  }

  /**
   * Pending ops targeting the given store (or the default if omitted),
   * collapsed to last-write-wins. Used by reads that need to see
   * intra-transaction writes (e.g. UNIQUE constraint checks). O(1): returns
   * the live indexed view (see {@link PendingStoreOps} for caveats).
   */
  getPendingOpsForStore(store?: KVStore): PendingStoreOps {
    return this.pendingIndex.get(this.bucketKey(store)) ?? EMPTY_PENDING;
  }

  /**
   * Key-ordered pending view for the given store (or the default if omitted):
   * puts sorted ascending by encoded key bytes plus the delete set — the merge
   * input for read-your-own-writes scans. Copies and sorts on demand (pending
   * sets are transaction-sized), so the returned view is a stable snapshot
   * even when coordinator mutations interleave with a long-lived merge scan.
   */
  getOrderedPendingOps(store?: KVStore): OrderedPendingOps {
    const bucket = this.pendingIndex.get(this.bucketKey(store));
    if (!bucket || (bucket.puts.size === 0 && bucket.deletes.size === 0)) {
      return EMPTY_ORDERED;
    }
    const puts = Array.from(bucket.puts.values()).sort((a, b) => compareBytes(a.key, b.key));
    return { puts, deletes: new Set(bucket.deletes) };
  }
}
