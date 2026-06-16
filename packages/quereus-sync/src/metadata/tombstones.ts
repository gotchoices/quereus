/**
 * Tombstone tracking for deletion synchronization.
 *
 * When a row is deleted, a tombstone is created with the deletion HLC.
 * Tombstones prevent deleted rows from being resurrected by older writes.
 */

import type { SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { buildTombstoneKey, buildTombstoneScanBounds, decodePK } from './keys.js';

/**
 * Tombstone record.
 */
export interface Tombstone {
  hlc: HLC;
  createdAt: number;  // Wall clock time for TTL calculation
}

/**
 * Serialize a tombstone for storage.
 * Format: 30 bytes HLC + 8 bytes createdAt
 */
export function serializeTombstone(tombstone: Tombstone): Uint8Array {
  const result = new Uint8Array(38);
  const hlcBytes = serializeHLC(tombstone.hlc);
  result.set(hlcBytes, 0);

  const view = new DataView(result.buffer);
  view.setBigUint64(30, BigInt(tombstone.createdAt), false);

  return result;
}

/**
 * Deserialize a tombstone from storage.
 */
export function deserializeTombstone(buffer: Uint8Array): Tombstone {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const createdAt = Number(view.getBigUint64(30, false));
  return { hlc, createdAt };
}

/**
 * Tombstone store operations.
 */
export class TombstoneStore {
  constructor(
    private readonly kv: KVStore,
    private readonly tombstoneTTL: number
  ) {}

  /**
   * Get the tombstone for a row, if it exists.
   */
  async getTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Tombstone | undefined> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeTombstone(data);
  }

  /**
   * Create a tombstone for a deleted row.
   */
  async setTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    hlc: HLC
  ): Promise<void> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const tombstone: Tombstone = { hlc, createdAt: Date.now() };
    await this.kv.put(key, serializeTombstone(tombstone));
  }

  /**
   * Set tombstone in a batch.
   */
  setTombstoneBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    hlc: HLC
  ): void {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const tombstone: Tombstone = { hlc, createdAt: Date.now() };
    batch.put(key, serializeTombstone(tombstone));
  }

  /**
   * Delete a tombstone (used when resurrecting a row).
   */
  async deleteTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<void> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    await this.kv.delete(key);
  }

  /**
   * Check if a row is deleted and the deletion should block a write.
   * Returns true if the row is deleted and the incoming HLC is older than the deletion.
   */
  async isDeletedAndBlocking(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    incomingHLC: HLC,
    allowResurrection: boolean
  ): Promise<boolean> {
    const tombstone = await this.getTombstone(schemaName, tableName, pk);
    if (!tombstone) return false;

    if (allowResurrection) {
      // Resurrection allowed: only block if incoming is older
      return compareHLC(incomingHLC, tombstone.hlc) <= 0;
    } else {
      // No resurrection: any tombstone blocks writes
      return true;
    }
  }

  /**
   * Prune expired tombstones.
   * Returns the number of tombstones deleted.
   */
  async pruneExpired(schemaName: string, tableName: string): Promise<number> {
    const bounds = buildTombstoneScanBounds(schemaName, tableName);
    const now = Date.now();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const tombstone = deserializeTombstone(entry.value);
      if (now - tombstone.createdAt > this.tombstoneTTL) {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.write();
    return count;
  }

  /**
   * Get all tombstones for a table (for sync).
   */
  async *getAllTombstones(
    schemaName: string,
    tableName: string
  ): AsyncIterable<{ pk: SqlValue[]; tombstone: Tombstone }> {
    const bounds = buildTombstoneScanBounds(schemaName, tableName);

    for await (const entry of this.kv.iterate(bounds)) {
      // Extract PK from key: tb:{schema}.{table}:{pk_json}
      const keyStr = new TextDecoder().decode(entry.key);
      const firstColon = keyStr.indexOf(':');
      const secondColon = keyStr.indexOf(':', firstColon + 1);
      const pkJson = keyStr.slice(secondColon + 1);
      const pk = decodePK(pkJson);

      yield { pk, tombstone: deserializeTombstone(entry.value) };
    }
  }
}

