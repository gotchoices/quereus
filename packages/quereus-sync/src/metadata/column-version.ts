/**
 * Column version tracking for LWW conflict resolution.
 *
 * Each column of each row has an associated HLC timestamp.
 * When merging changes, the column with the higher HLC wins.
 */

import type { SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, type SerializedHLC, serializeHLC, deserializeHLC, compareHLC, hlcToJson, hlcFromJson } from '../clock/hlc.js';
import { buildColumnVersionKey, buildColumnVersionScanBounds, encodePkIdentity, parseColumnVersionKey } from './keys.js';
import type { PkKeyingResolver } from './pk-identity.js';
import { writeIdentityBatch, type TableIdentityResolver } from './table-identity.js';

/**
 * Column version record stored in the KV store.
 *
 * `pk` is the row's ADDRESS — the raw primary-key values, one spelling from the
 * row's equivalence class. It lives in the VALUE because the record's KEY files
 * under the derived, lossy pk IDENTITY (see `keys.ts`) which cannot be decoded
 * back to values.
 *
 * NOTE: this repeats the pk in EVERY cell record of a row, so metadata size grows
 * with (pk width × column count). Fine at current scale; if sync metadata volume
 * ever becomes a concern for wide tables with long pks, add one per-row
 * identity→pk record and drop `pk` from the cell records.
 *
 * `priorHlc`/`priorValue` are an optional per-cell before-image: the cell version
 * this one replaced (its replica-local lineage). They are written together (both
 * present or both absent) and are absent on the first write of a cell and on
 * snapshot-reconstructed cells (a snapshot is a fresh basis with no history).
 */
export interface ColumnVersion {
  hlc: HLC;
  value: SqlValue;
  pk: SqlValue[];        // raw pk (the row's address; the key holds only the identity)
  priorHlc?: HLC;        // hlc of the version this one replaced
  priorValue?: SqlValue; // value of the version this one replaced
}

/**
 * Write-side shape: everything but the pk, which the store methods take as
 * their own parameter (they need it for the key identity anyway) and embed.
 */
export type ColumnVersionData = Omit<ColumnVersion, 'pk'>;

/**
 * Self-describing JSON payload for the value portion of a serialized column
 * version. `v` is the current value; `k` is the raw pk; `pv`/`ph` are the
 * optional before-image (value + HLC), present together or not at all. All
 * values go through `encodeSqlValue` so `Uint8Array`/`bigint` round-trip.
 */
interface SerializedColumnVersionPayload {
  v: unknown;          // encodeSqlValue(value)
  k: unknown[];        // encodeSqlValue per raw pk cell
  pv?: unknown;        // encodeSqlValue(priorValue) — present iff prior exists
  ph?: SerializedHLC;  // hlcToJson(priorHlc) — present iff prior exists
}

/**
 * Serialize a column version for storage.
 * Format: 30 bytes HLC + JSON payload `{ v, k, pv?, ph? }`.
 *
 * Uint8Array values are encoded as `{"__bin":"<base64>"}` (bigint as
 * `{"__bigint":"..."}`) so they survive the JSON round-trip; the same encoding
 * covers the pk cells and the before-image (`pv`). The before-image fields are
 * omitted entirely when the version has no prior, keeping first-writes and
 * snapshot cells compact.
 */
export function serializeColumnVersion(cv: ColumnVersion): Uint8Array {
  const hlcBytes = serializeHLC(cv.hlc);
  const payload: SerializedColumnVersionPayload = {
    v: encodeSqlValue(cv.value),
    k: cv.pk.map(encodeSqlValue),
  };
  if (cv.priorHlc !== undefined) {
    payload.ph = hlcToJson(cv.priorHlc);
    payload.pv = encodeSqlValue(cv.priorValue ?? null);
  }
  const valueBytes = new TextEncoder().encode(JSON.stringify(payload));

  const result = new Uint8Array(hlcBytes.length + valueBytes.length);
  result.set(hlcBytes, 0);
  result.set(valueBytes, hlcBytes.length);
  return result;
}

/**
 * Deserialize a column version from storage. Tolerant of the before-image being
 * absent (first-writes and snapshot-reconstructed cells carry none).
 */
export function deserializeColumnVersion(buffer: Uint8Array): ColumnVersion {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const payload = JSON.parse(new TextDecoder().decode(buffer.slice(30))) as SerializedColumnVersionPayload;
  const cv: ColumnVersion = { hlc, value: decodeSqlValue(payload.v), pk: payload.k.map(decodeSqlValue) };
  if (payload.ph !== undefined) {
    cv.priorHlc = hlcFromJson(payload.ph);
    cv.priorValue = decodeSqlValue(payload.pv);
  }
  return cv;
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
 *
 * Every pk-taking method derives the record key's pk IDENTITY through the
 * per-table {@link PkKeyingResolver} passed at construction, so callers keep
 * addressing rows by raw pk while the storage keys collapse spellings. The
 * table component of the key is the table's GENERATION, resolved through the
 * {@link TableIdentityResolver}: a read for a name that has never filed anything
 * finds nothing, and a batch write mints the name's generation into the SAME
 * batch, so the record and the mapping that makes it reachable commit together
 * (see `metadata/table-identity.ts`).
 */
export class ColumnVersionStore {
  constructor(
    private readonly kv: KVStore,
    private readonly keying: PkKeyingResolver,
    private readonly tables: TableIdentityResolver,
  ) {}

  private identity(schemaName: string, tableName: string, pk: SqlValue[]): string {
    return encodePkIdentity(pk, this.keying(schemaName, tableName));
  }

  /**
   * Get the version of a specific column.
   */
  async getColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string
  ): Promise<ColumnVersion | undefined> {
    // Keying first: an unknown-to-the-oracle table still throws there (by design,
    // see pk-identity.ts) before the generation lookup can report "nothing filed".
    const identity = this.identity(schemaName, tableName, pk);
    const generation = this.tables.generationOf(schemaName, tableName);
    if (generation === undefined) return undefined;
    return this.getColumnVersionByIdentity(generation, identity, column);
  }

  /**
   * Get the version of a specific column by table generation and pk IDENTITY
   * (as recovered from a parsed `cv:`/`cl:` key — no name and no raw pk needed).
   */
  async getColumnVersionByIdentity(
    generation: string,
    identity: string,
    column: string
  ): Promise<ColumnVersion | undefined> {
    const key = buildColumnVersionKey(generation, identity, column);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeColumnVersion(data);
  }

  /**
   * Set the version of a specific column (standalone write — one batch, so the
   * generation mint, when needed, lands with the record, and the identity index is
   * re-read if it does not).
   */
  async setColumnVersion(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersionData
  ): Promise<void> {
    await writeIdentityBatch(this.kv, this.tables, batch =>
      this.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version));
  }

  /**
   * Set column version in a batch. The key's pk IDENTITY is always derived
   * locally through this store's keying resolver — there is deliberately no
   * caller-supplied-identity variant (a snapshot receiver trusting a sender's
   * identity was the bug fixed by deriving on ingress; see docs/sync.md
   * § Row identity vs. address). The table generation is ensured into the same
   * batch.
   */
  setColumnVersionBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string,
    version: ColumnVersionData
  ): void {
    const identity = this.identity(schemaName, tableName, pk);
    const generation = this.tables.ensure(schemaName, tableName, batch);
    batch.put(buildColumnVersionKey(generation, identity, column), serializeColumnVersion({ ...version, pk }));
  }

  /**
   * Get all column versions for a row.
   */
  async getRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Map<string, ColumnVersion>> {
    const identity = this.identity(schemaName, tableName, pk);
    const versions = new Map<string, ColumnVersion>();
    const generation = this.tables.generationOf(schemaName, tableName);
    if (generation === undefined) return versions;
    const bounds = buildColumnVersionScanBounds(generation, identity);

    for await (const entry of this.kv.iterate(bounds)) {
      // Every key component is length-prefixed, so the column name comes back
      // verbatim even when it (or the table name, or the identity) contains
      // `:` or `.` — see `metadata/keys.ts`.
      const parsed = parseColumnVersionKey(entry.key);
      if (!parsed) continue;

      versions.set(parsed.column, deserializeColumnVersion(entry.value));
    }

    return versions;
  }

  /**
   * Whether the row has any committed cell record. Reads at most one entry and parses
   * none, where `getRowVersions` would parse every cell of a row that has them.
   */
  async hasRowVersions(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<boolean> {
    const identity = this.identity(schemaName, tableName, pk);
    const generation = this.tables.generationOf(schemaName, tableName);
    if (generation === undefined) return false;
    const bounds = buildColumnVersionScanBounds(generation, identity);
    for await (const _entry of this.kv.iterate({ ...bounds, limit: 1 })) return true;
    return false;
  }

  /**
   * Queue deletion of ONE column's cell record into `batch`, whether or not a
   * committed record exists — the caller may be removing a record that is only
   * STAGED in this same batch (the local-capture delete cleanup; see
   * `deleteRowVersionsAndLogEntries`).
   */
  deleteColumnVersionBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    column: string
  ): void {
    const identity = this.identity(schemaName, tableName, pk);
    // A staged-only cell was written through `setColumnVersionBatch`, which ensured
    // the generation, so a name with none has nothing staged or committed to delete.
    const generation = this.tables.generationOf(schemaName, tableName);
    if (generation === undefined) return;
    batch.delete(buildColumnVersionKey(generation, identity, column));
  }

  /**
   * Queue deletion of every column version of a row into `batch`, returning the
   * versions that were removed (column → version). A column in `keepColumns` is
   * skipped entirely — neither staged for deletion nor included in the returned
   * map (its paired `cl:` entry must survive too; see
   * `deleteRowVersionsAndLogEntries`).
   *
   * The returned map is what lets a caller drop the paired `cl:` change-log
   * entries in the SAME batch — each entry's key embeds the version's HLC, which
   * is only recoverable from the record being deleted.
   *
   * NOTE: this fully deserializes each cell (a JSON parse of the value) when the
   * change-log caller only needs the 30-byte HLC prefix. If deleting wide rows or
   * rows with large blob cells ever shows up as slow, read just the HLC prefix
   * here instead of reusing `getRowVersions`.
   */
  async deleteRowVersionsBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    keepColumns?: ReadonlySet<string>
  ): Promise<Map<string, ColumnVersion>> {
    const identity = this.identity(schemaName, tableName, pk);
    const versions = await this.getRowVersions(schemaName, tableName, pk);
    const generation = this.tables.generationOf(schemaName, tableName);
    if (generation === undefined) return versions; // nothing filed ⇒ `versions` is empty
    for (const column of [...versions.keys()]) {
      if (keepColumns?.has(column)) {
        versions.delete(column);
        continue;
      }
      batch.delete(buildColumnVersionKey(generation, identity, column));
    }
    return versions;
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

