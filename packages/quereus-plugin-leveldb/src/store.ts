/**
 * LevelDB-based KVStore implementation for Node.js.
 *
 * Uses classic-level for LevelDB bindings.
 */

import { ClassicLevel } from 'classic-level';
import type { KVStore, KVEntry, WriteBatch, IterateOptions, KVStoreOptions, WriteOptions } from '@quereus/store';

/**
 * LevelDB implementation of KVStore.
 */
export class LevelDBStore implements KVStore {
  private db: ClassicLevel<Uint8Array, Uint8Array>;
  private closed = false;

  private constructor(db: ClassicLevel<Uint8Array, Uint8Array>) {
    this.db = db;
  }

  /**
   * Open a LevelDB store.
   */
  static async open(options: KVStoreOptions): Promise<LevelDBStore> {
    const db = new ClassicLevel<Uint8Array, Uint8Array>(options.path, {
      keyEncoding: 'view',
      valueEncoding: 'view',
      createIfMissing: options.createIfMissing ?? true,
      errorIfExists: options.errorIfExists ?? false,
    });

    await db.open();
    return new LevelDBStore(db);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    // classic-level returns undefined for missing keys (doesn't throw)
    return await this.db.get(key);
  }

  async put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
    this.checkOpen();
    // classic-level forwards `sync` to the underlying LevelDB write, fsync'ing the
    // log before resolving when requested.
    await this.db.put(key, value, { sync: options?.sync });
  }

  async delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
    this.checkOpen();
    await this.db.del(key, { sync: options?.sync });
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    // classic-level returns undefined for missing keys
    const value = await this.db.get(key);
    return value !== undefined;
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();

    const iteratorOptions: Record<string, unknown> = {
      keys: true,
      values: true,
    };

    if (options?.gte) iteratorOptions.gte = options.gte;
    if (options?.gt) iteratorOptions.gt = options.gt;
    if (options?.lte) iteratorOptions.lte = options.lte;
    if (options?.lt) iteratorOptions.lt = options.lt;
    if (options?.reverse) iteratorOptions.reverse = true;
    if (options?.limit !== undefined) iteratorOptions.limit = options.limit;

    const iterator = this.db.iterator(iteratorOptions);

    try {
      for await (const [key, value] of iterator) {
        yield { key, value };
      }
    } finally {
      await iterator.close();
    }
  }

  batch(): WriteBatch {
    this.checkOpen();
    return new LevelDBWriteBatch(this.db);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.db.close();
    }
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();
    // LevelDB doesn't have a native count, so we iterate and count
    // For large datasets, this could be optimized with sampling
    let count = 0;
    for await (const _ of this.iterate(options)) {
      count++;
    }
    return count;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('LevelDBStore is closed');
    }
  }
}

/**
 * WriteBatch implementation for LevelDB.
 */
class LevelDBWriteBatch implements WriteBatch {
  private db: ClassicLevel<Uint8Array, Uint8Array>;
  private ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'del'; key: Uint8Array }> = [];

  constructor(db: ClassicLevel<Uint8Array, Uint8Array>) {
    this.db = db;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'del', key });
  }

  async write(): Promise<void> {
    if (this.ops.length > 0) {
      await this.db.batch(this.ops);
      this.ops = [];
    }
  }

  clear(): void {
    this.ops = [];
  }
}

