/**
 * Schema migration tracking for sync.
 *
 * Tracks DDL changes (CREATE TABLE, ALTER TABLE, etc.) with HLC timestamps.
 * Uses first-writer-wins for conflict resolution on schema changes.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import {
  buildAllSchemaMigrationsScanBounds,
  buildSchemaMigrationKey,
  buildSchemaMigrationScanBounds,
  parseSchemaMigrationKey,
} from './keys.js';
import {
  orderMigrations,
  type SchemaMigration,
  type SchemaMigrationType,
  type SchemaObjectKind,
} from '../sync/protocol.js';
import { positionField } from './filing-position.js';

/**
 * High bit of the type-length byte: set when a 30-byte filing position follows the type.
 * Type names are short ASCII, so the bit was always clear before positions existed and a
 * record written then reads as "no position".
 */
const HAS_POSITION = 0x80;
const TYPE_LENGTH_MASK = 0x7f;

/**
 * Stored schema migration record.
 */
export interface StoredMigration {
  type: SchemaMigrationType;
  /** `rename_table` only: the table name before the rename. */
  fromTable?: string;
  /** `alter primary key` only: the table's column layout — see `SchemaMigration.columns`. */
  columns?: string[];
  ddl: string;
  hlc: HLC;
  /**
   * Where this replica filed the migration (`metadata/filing-position.ts`); absent when
   * it equals `hlc`, which is every migration recorded here. `getChangesSince` serves a
   * migration to a peer whose watermark is below this, however old its `hlc`.
   */
  position?: HLC;
  schemaVersion: number;
}

/**
 * Serialize a migration for storage.
 * Format: 30 bytes HLC + 4 bytes version + 1 byte type length + type
 *         + 30 bytes filing position, only when the type-length byte's high bit is set
 *         + 2 bytes fromTable byte-length (big-endian; 0 = absent) + fromTable
 *         + 4 bytes columns byte-length (big-endian; 0 = absent) + columns (a JSON string array)
 *         + ddl
 *
 * The optional slots sit BEFORE the ddl because the ddl is "rest of buffer" —
 * nothing can be appended after it. Inserting a slot is an incompatible layout
 * change, covered by the `fv:` gate (SYNC_METADATA_FORMAT_VERSION in keys.ts: 5 added
 * `fromTable`, 7 added `columns`). The position is the exception: it is announced by a
 * bit no earlier record sets ({@link HAS_POSITION}), so earlier records stay readable
 * and the format version did not move.
 */
export function serializeMigration(migration: StoredMigration): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(migration.type);
  const fromBytes = encoder.encode(migration.fromTable ?? '');
  const columnsBytes = encoder.encode(migration.columns === undefined ? '' : JSON.stringify(migration.columns));
  const ddlBytes = encoder.encode(migration.ddl);
  const hlcBytes = serializeHLC(migration.hlc);
  const { position } = positionField(migration.hlc, migration.position);
  const positionBytes = position === undefined ? new Uint8Array(0) : serializeHLC(position);
  if (typeBytes.length > TYPE_LENGTH_MASK) {
    throw new Error(`Migration type name too long to store: ${migration.type}`);
  }

  const buffer = new Uint8Array(
    30 + 4 + 1 + typeBytes.length + positionBytes.length
      + 2 + fromBytes.length + 4 + columnsBytes.length + ddlBytes.length,
  );
  let offset = 0;

  // HLC (30 bytes)
  buffer.set(hlcBytes, offset);
  offset += 30;

  // Schema version (4 bytes, big-endian)
  const view = new DataView(buffer.buffer);
  view.setUint32(offset, migration.schemaVersion, false);
  offset += 4;

  // Type length (1 byte, high bit = a position follows) + type
  buffer[offset] = typeBytes.length | (position === undefined ? 0 : HAS_POSITION);
  offset += 1;
  buffer.set(typeBytes, offset);
  offset += typeBytes.length;

  // Filing position (30 bytes), present only when it differs from the HLC
  buffer.set(positionBytes, offset);
  offset += positionBytes.length;

  // fromTable byte-length (2 bytes, big-endian; 0 = absent) + fromTable
  view.setUint16(offset, fromBytes.length, false);
  offset += 2;
  buffer.set(fromBytes, offset);
  offset += fromBytes.length;

  // columns byte-length (4 bytes, big-endian; 0 = absent) + columns
  view.setUint32(offset, columnsBytes.length, false);
  offset += 4;
  buffer.set(columnsBytes, offset);
  offset += columnsBytes.length;

  // DDL (rest of buffer)
  buffer.set(ddlBytes, offset);

  return buffer;
}

/**
 * Deserialize a migration from storage.
 */
export function deserializeMigration(buffer: Uint8Array): StoredMigration {
  const decoder = new TextDecoder();
  let offset = 0;

  // HLC (30 bytes)
  const hlc = deserializeHLC(buffer.slice(0, 30));
  offset += 30;

  // Schema version (4 bytes)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const schemaVersion = view.getUint32(offset, false);
  offset += 4;

  // Type length (high bit = a position follows) + type
  const typeLength = buffer[offset] & TYPE_LENGTH_MASK;
  const hasPosition = (buffer[offset] & HAS_POSITION) !== 0;
  offset += 1;
  const type = decoder.decode(buffer.slice(offset, offset + typeLength)) as SchemaMigrationType;
  offset += typeLength;

  const position = hasPosition ? deserializeHLC(buffer.slice(offset, offset + 30)) : undefined;
  if (hasPosition) offset += 30;

  // fromTable (2-byte big-endian byte-length; 0 = absent)
  const fromLength = view.getUint16(offset, false);
  offset += 2;
  const fromTable = fromLength > 0
    ? decoder.decode(buffer.slice(offset, offset + fromLength))
    : undefined;
  offset += fromLength;

  // columns (4-byte big-endian byte-length; 0 = absent)
  const columnsLength = view.getUint32(offset, false);
  offset += 4;
  const columns = columnsLength > 0
    ? JSON.parse(decoder.decode(buffer.slice(offset, offset + columnsLength))) as string[]
    : undefined;
  offset += columnsLength;

  // DDL
  const ddl = decoder.decode(buffer.slice(offset));

  return {
    type,
    ...(fromTable !== undefined ? { fromTable } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ddl,
    hlc,
    ...(position !== undefined ? { position } : {}),
    schemaVersion,
  };
}

/**
 * Schema migration store operations.
 *
 * Every method is keyed by `(schemaName, kind, objectName)`: the object name
 * alone is ambiguous, since an index migration names an INDEX while every other
 * migration type names a TABLE. Callers derive `kind` from the migration type
 * with {@link import('../sync/protocol.js').migrationObjectKind}.
 */
export class SchemaMigrationStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get a specific migration by version.
   */
  async getMigration(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    version: number
  ): Promise<StoredMigration | undefined> {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, version);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeMigration(data);
  }

  /**
   * Record a new migration.
   */
  async recordMigration(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    migration: StoredMigration
  ): Promise<void> {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, migration.schemaVersion);
    await this.kv.put(key, serializeMigration(migration));
  }

  /**
   * Record migration in a batch.
   */
  recordMigrationBatch(
    batch: WriteBatch,
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    migration: StoredMigration
  ): void {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, migration.schemaVersion);
    batch.put(key, serializeMigration(migration));
  }

  /**
   * Get the current schema version for one object (a table's, or an index's).
   */
  async getCurrentVersion(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string
  ): Promise<number> {
    const bounds = buildSchemaMigrationScanBounds(schemaName, kind, objectName);
    let maxVersion = 0;

    for await (const entry of this.kv.iterate({ ...bounds, reverse: true, limit: 1 })) {
      const migration = deserializeMigration(entry.value);
      maxVersion = migration.schemaVersion;
    }

    return maxVersion;
  }

  /**
   * Get all migrations for one object.
   */
  async *getAllMigrations(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string
  ): AsyncIterable<StoredMigration> {
    const bounds = buildSchemaMigrationScanBounds(schemaName, kind, objectName);

    for await (const entry of this.kv.iterate(bounds)) {
      yield deserializeMigration(entry.value);
    }
  }

  /**
   * Every migration on this replica as a wire record, in causal (HLC) order, each
   * carrying the position this replica filed it at when that differs from its HLC.
   *
   * The producers that ship DDL — both snapshot paths and the delta collector —
   * all need the whole set, and all need it causally ordered: DDL replays in list
   * order, so a `create index` ahead of its table's `create table` fails outright.
   * `sm:` key order is (schema, object kind, object name), which puts every index
   * migration ahead of every table migration in a schema, so the scan order can
   * never be used directly.
   */
  async listAllMigrations(): Promise<SchemaMigration[]> {
    const migrations: SchemaMigration[] = [];

    for await (const entry of this.kv.iterate(buildAllSchemaMigrationsScanBounds())) {
      const parsed = parseSchemaMigrationKey(entry.key);
      if (!parsed) continue;

      const stored = deserializeMigration(entry.value);
      migrations.push({
        type: stored.type,
        schema: parsed.schema,
        table: parsed.table,
        ...(stored.fromTable !== undefined ? { fromTable: stored.fromTable } : {}),
        ...(stored.columns !== undefined ? { columns: stored.columns } : {}),
        ddl: stored.ddl,
        hlc: stored.hlc,
        ...(stored.position !== undefined ? { position: stored.position } : {}),
        schemaVersion: stored.schemaVersion,
      });
    }

    return orderMigrations(migrations, migration => migration);
  }

  /**
   * Check if a migration conflicts with an existing one.
   * Returns the existing migration if there's a conflict, undefined otherwise.
   */
  async checkConflict(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    version: number,
    incomingHLC: HLC
  ): Promise<StoredMigration | undefined> {
    const existing = await this.getMigration(schemaName, kind, objectName, version);
    if (!existing) return undefined;

    // First-writer-wins: if existing has lower HLC, it wins
    if (compareHLC(existing.hlc, incomingHLC) < 0) {
      return existing;  // Existing wins, return it as the conflict winner
    }

    return undefined;  // Incoming wins or they're equal
  }
}

