/**
 * Column version tracking for LWW conflict resolution.
 *
 * Each column of each row has an associated HLC timestamp.
 * When merging changes, the column with the higher HLC wins.
 */

import type { SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { buildColumnVersionKey, buildColumnVersionScanBounds } from './keys.js';

/**
 * Column version record stored in the KV store.
 */
export interface ColumnVersion {
  hlc: HLC;
  value: SqlValue;
}

/**
 * Serialize a column version for storage.
 * Format: 30 bytes HLC + JSON value
 *
 * Uint8Array values are encoded as `{"__bin":"<base64>"}` so they survive
 * the JSON round-trip (plain JSON.stringify turns Uint8Array into an object
 * with numeric keys, which loses type information).
 */
export function serializeColumnVersion(cv: ColumnVersion): Uint8Array {
  const hlcBytes = serializeHLC(cv.hlc);
  const valueJson = JSON.stringify(encodeSqlValue(cv.value));
  const valueBytes = new TextEncoder().encode(valueJson);

  const result = new Uint8Array(hlcBytes.length + valueBytes.length);
  result.set(hlcBytes, 0);
  result.set(valueBytes, hlcBytes.length);
  return result;
}

/**
 * Deserialize a column version from storage.
 */
export function deserializeColumnVersion(buffer: Uint8Array): ColumnVersion {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const valueJson = new TextDecoder().decode(buffer.slice(30));
  const value = decodeSqlValue(JSON.parse(valueJson));
  return { hlc, value };
}

// ============================================================================
// SqlValue JSON encoding helpers
// ============================================================================

/**
 * Encode a SqlValue for safe JSON serialization.
 * Uint8Array → `{ __bin: "<base64>" }`, bigint → `{ __bigint: "<string>" }`.
 */
export function encodeSqlValue(v: SqlValue): unknown {
  if (v instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < v.byteLength; i++) binary += String.fromCharCode(v[i]);
    return { __bin: btoa(binary) };
  }
  if (typeof v === 'bigint') {
    return { __bigint: v.toString() };
  }
  return v;
}

/**
 * Decode a SqlValue from JSON, reversing encodeSqlValue.
 *
 * Also recovers the legacy corrupted format where Uint8Array was serialized
 * by plain JSON.stringify as `{"0":65,"1":66,...}` (object with consecutive
 * integer keys and byte-range values).
 */
export function decodeSqlValue(v: unknown): SqlValue {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.__bin === 'string') {
      const binary = atob(obj.__bin);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    if (typeof obj.__bigint === 'string') {
      return BigInt(obj.__bigint);
    }
    // Legacy recovery: detect Uint8Array corrupted by JSON.stringify → {"0":n,"1":n,...}
    const keys = Object.keys(obj);
    if (keys.length > 0 && keys.every((k, i) => k === String(i))) {
      const allBytes = keys.every(k => {
        const val = obj[k];
        return typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 255;
      });
      if (allBytes) {
        const bytes = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) bytes[i] = obj[String(i)] as number;
        return bytes;
      }
    }
  }
  return v as SqlValue;
}

/**
 * Column version store operations.
 */
export class ColumnVersionStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get the version of a specific column.
   */
  async getColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string
  ): Promise<ColumnVersion | undefined> {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeColumnVersion(data);
  }

  /**
   * Set the version of a specific column.
   */
  async setColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersion
  ): Promise<void> {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    await this.kv.put(key, serializeColumnVersion(version));
  }

  /**
   * Set column version in a batch.
   */
  setColumnVersionBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersion
  ): void {
    const key = buildColumnVersionKey(schemaName, tableName, pk, column);
    batch.put(key, serializeColumnVersion(version));
  }

  /**
   * Get all column versions for a row.
   */
  async getRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Map<string, ColumnVersion>> {
    const bounds = buildColumnVersionScanBounds(schemaName, tableName, pk);
    const versions = new Map<string, ColumnVersion>();

    for await (const entry of this.kv.iterate(bounds)) {
      // Extract column name from key
      const keyStr = new TextDecoder().decode(entry.key);
      const lastColon = keyStr.lastIndexOf(':');
      const column = keyStr.slice(lastColon + 1);

      versions.set(column, deserializeColumnVersion(entry.value));
    }

    return versions;
  }

  /**
   * Delete all column versions for a row.
   */
  async deleteRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<void> {
    const bounds = buildColumnVersionScanBounds(schemaName, tableName, pk);
    const batch = this.kv.batch();

    for await (const entry of this.kv.iterate(bounds)) {
      batch.delete(entry.key);
    }

    await batch.write();
  }

  /**
   * Check if a column write should be applied (LWW comparison).
   * Returns true if the incoming HLC is newer than the current version.
   */
  async shouldApplyWrite(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    incomingHLC: HLC
  ): Promise<boolean> {
    const current = await this.getColumnVersion(schemaName, tableName, pk, column);
    if (!current) return true;
    return compareHLC(incomingHLC, current.hlc) > 0;
  }
}

