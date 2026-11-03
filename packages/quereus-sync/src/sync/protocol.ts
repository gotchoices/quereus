/**
 * Sync protocol types - transport-agnostic data structures.
 *
 * These types define the sync protocol without assuming any transport layer.
 * Applications can serialize these to JSON, MessagePack, protobuf, etc.
 * and send via WebSocket, HTTP, WebRTC, or any other transport.
 */

import type { AssertionViolation, Row, SqlValue } from '@quereus/quereus';
import { type HLC, compareHLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { joinKeyParts } from '../metadata/keys.js';

// ============================================================================
// Change Types
// ============================================================================

/**
 * A single column modification within a row.
 */
export interface ColumnChange {
  readonly type: 'column';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];      // Primary key values identifying the row
  readonly column: string;      // Column name
  readonly value: SqlValue;     // New value
  readonly hlc: HLC;            // When this change occurred
  /**
   * Optional per-cell before-image: the value this write overwrote at the origin.
   * Sourced from the prior *tracked* cell version (not the engine's `oldRow`), so
   * it pairs semantically with `value`/`hlc`. Absent on the first write of a cell
   * (no prior version) and on snapshot-reconstructed cells. Purely additive and
   * best-effort: producers may omit it, receivers ignore it when absent.
   */
  readonly priorValue?: SqlValue;
  /** HLC of the overwritten cell version. Present iff `priorValue` is. */
  readonly priorHlc?: HLC;
}

/**
 * A row deletion.
 */
export interface RowDeletion {
  readonly type: 'delete';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];      // Primary key of deleted row
  readonly hlc: HLC;            // When deletion occurred
  /**
   * Optional last-known row image at the origin: the row's column-ordered values
   * just before it was deleted. Sourced from the engine's `oldRow` at delete time
   * (no extra read), so it pairs with `pk`/`hlc`. The row side of the per-cell
   * before-image — lets a receiver show or undo what was removed without having
   * reconstructed it beforehand. Absent when the delete carried no `oldRow`
   * (relayed/synthesized deletes) and on snapshot-reconstructed tombstones. Purely
   * additive and best-effort: producers may omit it, receivers ignore it when absent.
   */
  readonly priorRow?: Row;
}

/**
 * Union type for all change kinds.
 */
export type Change = ColumnChange | RowDeletion;

// ============================================================================
// Schema Migration Types
// ============================================================================

/**
 * Types of schema migrations.
 */
export type SchemaMigrationType =
  | 'create_table'
  | 'drop_table'
  | 'rename_table'
  | 'add_column'
  | 'drop_column'
  | 'add_index'
  | 'drop_index'
  | 'alter_column';

/**
 * The kind of schema object a migration names.
 *
 * A migration's object name means different things per type — for an index
 * migration it is the INDEX name, for every other type it is the TABLE name — so
 * the kind is what keeps a table and a same-named index in separate migration
 * streams (see {@link migrationObjectKind} and the `sm:` key layout in
 * `metadata/keys.ts`).
 */
export type SchemaObjectKind = 'table' | 'index';

/**
 * The object kind a migration type names. Derived, never carried on the wire:
 * `SchemaMigration.type` already travels, so both ends compute the same kind and
 * cannot disagree.
 */
export function migrationObjectKind(type: SchemaMigrationType): SchemaObjectKind {
	switch (type) {
		case 'add_index':
		case 'drop_index':
			return 'index';
		// create/drop/rename table and the three column-level types all name a TABLE.
		default:
			return 'table';
	}
}

/**
 * A schema migration record.
 */
export interface SchemaMigration {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  /** The object's name AFTER this migration (for a `rename_table`, the NEW name). */
  readonly table: string;
  /**
   * `rename_table` only: the table name before the rename. The migration itself
   * is keyed under the NEW name (`table`), so every subsequent alteration of the
   * renamed table stays in one contiguous version stream where the table lives.
   */
  readonly fromTable?: string;
  readonly ddl: string;           // The DDL statement
  readonly hlc: HLC;              // When migration occurred
  /**
   * Monotonic per (object kind, object name), from 1 for ordinary migrations.
   *
   * Version {@link BASELINE_SCHEMA_VERSION} (0) is a **baseline**: a `create_table`
   * or `add_index` recorded by a device that found itself writing to an object its
   * migrations never brought into existence (created before sync attached). It
   * says "here is this object's definition, for any device that has none". A
   * receiver that already has the object keeps its own shape (never a conflict);
   * one that lacks it creates it. Ordinary versions start at 1, so a baseline can
   * never collide with a real migration; two baselines compete only with each
   * other, by HLC. See docs/sync-schema.md § Baselines.
   */
  readonly schemaVersion: number;
}

/** The `schemaVersion` of a baseline migration — see {@link SchemaMigration.schemaVersion}. */
export const BASELINE_SCHEMA_VERSION = 0;

export function isBaselineVersion(schemaVersion: number): boolean {
	return schemaVersion === BASELINE_SCHEMA_VERSION;
}

/**
 * What {@link orderMigrations} needs to know about each item it orders: the
 * migration's HLC, the stream it belongs to (`(schema, object kind, name)`) and
 * whether it is a baseline. A `SchemaMigration` satisfies it directly.
 */
export type MigrationOrderKey = Pick<SchemaMigration, 'hlc' | 'type' | 'schema' | 'table' | 'schemaVersion'>;

/**
 * Order migrations causally: ascending HLC, stable, so migrations that cannot be
 * distinguished by HLC keep arrival order — then each baseline (version 0) is moved
 * ahead of the first alteration or drop of its own object.
 *
 * Every consumer replays DDL as a plain array in list order, and migrations are
 * order-dependent across objects as well as within one: `create index` fails
 * outright if its table's `create table` has not run. Neither the `sm:` key order
 * (schema, then object kind, then name — every index before every table) nor
 * changeset arrival order is causal, so both snapshot and delta paths sort here.
 *
 * A baseline is recorded whenever a device first writes to an object it never
 * announced, so its HLC says nothing about where the object's history begins: a
 * fresh receiver replaying `[alter_column, older-shape baseline]` in HLC order would
 * create the old shape and end without the altered column, and one replaying
 * `[drop_table, baseline]` would end with a table every other device dropped. Moving
 * the baseline ahead of the stream's first alteration or drop gives both the
 * intended end state. It stays behind a `rename_table` (a receiver holding the old
 * name must rename first, or the baseline creates an empty table under the new name
 * and the rename then collides with it) and behind a real `create_table` /
 * `add_index` (that create already defines the object, so the baseline only has to
 * keep it; ahead of it, the real create would be judged against the baseline's
 * shape instead).
 *
 * Generic over anything a `keyOf` can reduce to a {@link MigrationOrderKey}, so a
 * consumer carrying something alongside each migration (the streaming snapshot
 * pairs each with the `SchemaChangeToApply` it built at chunk time) orders the
 * pairs directly rather than re-deriving this order.
 */
export function orderMigrations<T>(items: readonly T[], keyOf: (item: T) => MigrationOrderKey): T[] {
	const ordered = [...items].sort((a, b) => compareHLC(keyOf(a).hlc, keyOf(b).hlc));
	// NOTE: one scan of the list per baseline, so quadratic in the worst case. A
	// replica's migration list is one record per DDL statement ever run, and a baseline
	// is one per table announced, so both are small; if a snapshot's migration list ever
	// grows large, index each stream's first displacer once instead.
	for (let i = 0; i < ordered.length; i++) {
		const key = keyOf(ordered[i]);
		if (!isBaselineVersion(key.schemaVersion)) continue;
		const stream = migrationStreamKey(key);
		const target = ordered.findIndex(item => {
			const candidate = keyOf(item);
			return displacesBaseline(candidate.type) && migrationStreamKey(candidate) === stream;
		});
		// Moving one element to an earlier index shifts the ones between it and the
		// target right by one; `i` then names an element already visited, and the next
		// iteration reaches the element that followed the moved one.
		if (target !== -1 && target < i) ordered.splice(target, 0, ...ordered.splice(i, 1));
	}
	return ordered;
}

/** The migration kinds a baseline must run ahead of: everything that alters or removes its object. */
function displacesBaseline(type: SchemaMigrationType): boolean {
	return type === 'alter_column' || type === 'add_column' || type === 'drop_column'
		|| type === 'drop_table' || type === 'drop_index';
}

function migrationStreamKey(key: MigrationOrderKey): string {
	return joinKeyParts(key.schema, migrationObjectKind(key.type), key.table);
}

// ============================================================================
// Transaction-Grouped Changes
// ============================================================================

/**
 * Exactly one source transaction's worth of changes.
 *
 * A ChangeSet **is** one commit: `getChangesSince` emits one ChangeSet per source
 * transaction (grouped by HLC identity `(wallTime, counter, siteId)`), never
 * splitting a commit across ChangeSets and never merging two commits into one. All
 * changes within a ChangeSet are applied atomically.
 */
export interface ChangeSet {
  /** Origin replica (the single site that produced this transaction). */
  readonly siteId: SiteId;
  /**
   * Deterministic id of this one source transaction — `deterministicTxnId(base)`
   * over the transaction's base HLC `(wallTime, counter, siteId)`. Stable across
   * peers (every replica that replays the transaction derives the same id), not a
   * random UUID.
   */
  readonly transactionId: string;
  /**
   * The transaction's commit boundary: its **maximum** fact HLC (the last
   * `opSeq`). A consumer that sets `lastSyncHLC = ChangeSet.hlc` and re-fetches
   * resumes strictly *after* the whole transaction.
   */
  readonly hlc: HLC;
  /** Data changes in this transaction, in `opSeq` (intra-transaction write) order. */
  readonly changes: Change[];
  /** Schema migrations in this transaction (DDL sorts below the same tx's DML). */
  readonly schemaMigrations: SchemaMigration[];
}

// ============================================================================
// Sync API Types
// ============================================================================

/**
 * Result of applying changes from a peer.
 */
/** Rejection detail for a change that failed server-side validation. */
export interface ApplyRejection {
  reason: string;
  code?: string;
  table?: string;
  column?: string;
}

export interface ApplyResult {
  /** Changes successfully applied (winner was remote) */
  applied: number;
  /** Changes skipped (already present or local won) */
  skipped: number;
  /** Conflicts resolved via LWW */
  conflicts: number;
  /** Number of transactions processed */
  transactions: number;
  /** Changes rejected by server-side validation hooks */
  rejected?: ApplyRejection[];
  /**
   * Changes diverted because they referenced a table outside the local basis
   * (an out-of-basis straggler delta). Omitted when none were diverted. The
   * disposition (`ignore` / `quarantine` / `store-and-forward`) is governed by
   * {@link SyncConfig.unknownTableDisposition}; see also the `onUnknownTable`
   * event and `getUnknownTableStats()`.
   */
  unknownTable?: number;
}

/**
 * Snapshot wire-format version, stamped into both snapshot forms (the streaming
 * header chunk and the non-streaming `Snapshot`). Both apply paths REFUSE a
 * snapshot whose stamp is missing or different, before touching any local state
 * — same posture as the `fv:` sync-metadata format gate in `SyncManagerImpl.create`.
 * Recovery is to regenerate the snapshot from a live peer (the coordinator's S3
 * store persists serialized chunks at rest, so an old stored snapshot read by
 * new code would otherwise silently mis-parse). Bump on ANY breaking change to
 * snapshot entry shapes.
 *
 * Version 1: column-version entries are explicit `{ column, hlc, value, pk }`
 * records and no snapshot shape carries a pk identity — the receiver always
 * derives its own (see docs/sync.md § Row identity vs. address).
 */
export const SNAPSHOT_WIRE_FORMAT_VERSION = 1;

/**
 * One column-version entry in a snapshot (streaming chunk or non-streaming
 * table snapshot).
 */
export interface ColumnVersionEntry {
  readonly column: string;
  readonly hlc: HLC;
  readonly value: SqlValue;
  /**
   * The row's raw pk (its ADDRESS). The pk IDENTITY deliberately does NOT
   * travel: the receiver derives its own from this pk and its local table
   * keying, so a sender with different keying (e.g. a raw-keyed relay) cannot
   * file the receiver's bookkeeping under unreachable identities.
   */
  readonly pk: SqlValue[];
}

/**
 * Full snapshot of a table for initial sync or recovery.
 */
export interface TableSnapshot {
  readonly schema: string;
  readonly table: string;
  /**
   * Every live cell of the table, one record per `(row, column)` — the table's
   * ONLY payload. Grouping cells into rows is the receiver's job (it groups by
   * its own derived pk identity), so no pre-grouped row images travel.
   */
  readonly columnVersions: ReadonlyArray<ColumnVersionEntry>;
}

/**
 * A tombstone (deletion record) carried in a non-streaming snapshot. A GLOBAL
 * collection on `Snapshot` (not nested under `TableSnapshot`) so a fully-deleted
 * row — a tombstone with no live column-versions, hence no `TableSnapshot` — still
 * travels. Mirrors the streaming `SnapshotTombstoneChunk` entry shape. Carries
 * only the raw pk (the row's address); the receiver derives its own identity.
 */
export interface SnapshotTombstone {
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  readonly hlc: HLC;
  readonly createdAt: number;
  /** Last-known row image before deletion; absent on snapshot-reconstructed tombstones. */
  readonly priorRow?: Row;
}

/**
 * Full database snapshot.
 */
export interface Snapshot {
  readonly siteId: SiteId;
  readonly hlc: HLC;
  /** Wire-format stamp; see {@link SNAPSHOT_WIRE_FORMAT_VERSION}. */
  readonly snapshotFormat: number;
  readonly tables: TableSnapshot[];
  readonly schemaMigrations: SchemaMigration[];
  /**
   * GLOBAL tombstone collection (table-independent) so a fully-deleted row — a
   * tombstone with no live column-versions — travels the bootstrap. See
   * {@link SnapshotTombstone}.
   */
  readonly tombstones: SnapshotTombstone[];
  /**
   * The sender's delta floor (`SyncManager.getDeltaFloor`): tombstones it
   * pruned before this snapshot are in nobody's copy, so the receiver inherits
   * them as its own floor (`max(own, this)`). Absent when the sender never
   * pruned, or on a snapshot persisted before the field existed — the receiver's
   * floor is then left as it was.
   */
  readonly deltaFloor?: HLC;
}

// ============================================================================
// Streaming Snapshot
// ============================================================================

/**
 * Snapshot chunk types for streaming.
 *
 * Listed in EMISSION ORDER, which is load-bearing — all DDL precedes all table data:
 *
 *   header → schema-migration* → [table-start, column-versions*, table-end]*
 *          → tombstone* → footer
 *
 * The receiver flushes rows to the store in bounded batches rather than buffering
 * the whole snapshot, and DDL only beats DML *within* one flush — so a `create
 * table` emitted after its rows arrives too late for the flushes those rows already
 * triggered. See docs/sync-protocol.md § Streaming Snapshot API.
 */
export type SnapshotChunkType =
  | 'header'
  | 'schema-migration'
  | 'table-start'
  | 'column-versions'
  | 'table-end'
  | 'tombstone'
  | 'footer';

/**
 * Header chunk - sent first with metadata.
 */
export interface SnapshotHeaderChunk {
  readonly type: 'header';
  readonly siteId: SiteId;
  readonly hlc: HLC;
  /** Wire-format stamp; see {@link SNAPSHOT_WIRE_FORMAT_VERSION}. */
  readonly snapshotFormat: number;
  readonly tableCount: number;
  readonly migrationCount: number;
  /** Unique identifier for this snapshot transfer. */
  readonly snapshotId: string;
  /** The sender's delta floor; see the same field on {@link Snapshot}. */
  readonly deltaFloor?: HLC;
}

/**
 * Table start chunk - marks beginning of a table's data.
 */
export interface SnapshotTableStartChunk {
  readonly type: 'table-start';
  readonly schema: string;
  readonly table: string;
  /** Estimated number of column version entries for this table. */
  readonly estimatedEntries: number;
}

/**
 * Column versions chunk - batch of column version entries.
 */
export interface SnapshotColumnVersionsChunk {
  readonly type: 'column-versions';
  readonly schema: string;
  readonly table: string;
  /**
   * One record per live cell. No pk identity travels — the receiver groups
   * cells into rows by DERIVING its own identity from each entry's raw pk
   * (see {@link ColumnVersionEntry.pk}).
   */
  readonly entries: ReadonlyArray<ColumnVersionEntry>;
}

/**
 * Tombstone chunk - a batch of deletion records for one `(schema, table)`.
 *
 * Emitted as its own stream section (a GLOBAL pass over every tombstone), NOT
 * folded into the column-version table sections, so a fully-deleted row — whose
 * columns are gone but whose tombstone remains — still travels even when its
 * table has no live column-versions left. An explicit entry object (not a
 * positional tuple) because `priorRow` is optional.
 */
export interface SnapshotTombstoneChunk {
  readonly type: 'tombstone';
  readonly schema: string;
  readonly table: string;
  readonly entries: ReadonlyArray<{
    readonly pk: SqlValue[];
    readonly hlc: HLC;
    readonly createdAt: number;
    /** Last-known row image before deletion; absent on snapshot-reconstructed tombstones. */
    readonly priorRow?: Row;
  }>;
}

/**
 * Table end chunk - marks end of a table's data.
 */
export interface SnapshotTableEndChunk {
  readonly type: 'table-end';
  readonly schema: string;
  readonly table: string;
  readonly entriesWritten: number;
}

/**
 * Schema migration chunk.
 */
export interface SnapshotSchemaMigrationChunk {
  readonly type: 'schema-migration';
  readonly migration: SchemaMigration;
}

/**
 * Footer chunk - sent last with checksum/stats.
 */
export interface SnapshotFooterChunk {
  readonly type: 'footer';
  readonly snapshotId: string;
  readonly totalTables: number;
  readonly totalEntries: number;
  readonly totalMigrations: number;
}

/**
 * Union of all snapshot chunk types.
 */
export type SnapshotChunk =
  | SnapshotHeaderChunk
  | SnapshotTableStartChunk
  | SnapshotColumnVersionsChunk
  | SnapshotTombstoneChunk
  | SnapshotTableEndChunk
  | SnapshotSchemaMigrationChunk
  | SnapshotFooterChunk;

/**
 * Progress info during snapshot streaming.
 */
export interface SnapshotProgress {
  readonly snapshotId: string;
  readonly tablesProcessed: number;
  readonly totalTables: number;
  readonly entriesProcessed: number;
  readonly totalEntries: number;
  readonly currentTable?: string;
}

// ============================================================================
// Apply-to-Store Callback Types
// ============================================================================

/**
 * Options for applying changes to the store.
 */
export interface ApplyToStoreOptions {
  /**
   * Mark resulting events as remote (from sync).
   * When true, the store should emit events with `remote: true`,
   * preventing the SyncManager from re-recording CRDT metadata.
   */
  readonly remote: boolean;
  /**
   * Bootstrap flush: one chunk of a known-complete wholesale snapshot load.
   * The adapter skips the engine seam (no per-flush MV maintenance, no
   * per-row watch capture) — storage rows are applied and remote module
   * events still emitted. A `bootstrapFinalize` call converges afterwards.
   */
  readonly bootstrap?: boolean;
  /**
   * Finalize a bootstrap: no data/schema changes carried. The adapter
   * converges every MV (`refreshAllMaterializedViews`) and fires a coarse
   * `notifyExternalChange` per bootstrapped table.
   */
  readonly bootstrapFinalize?: boolean;
  /** Bootstrapped base tables (for the finalize coarse watch notification). */
  readonly bootstrapTables?: ReadonlyArray<{ schema: string; table: string }>;
}

/**
 * A data change to apply to the store.
 */
export interface DataChangeToApply {
  readonly type: 'insert' | 'update' | 'delete';
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  /** Column values to apply. Keys are column names, values are column values. */
  readonly columns?: Record<string, SqlValue>;
}

/**
 * A schema change to apply to the store.
 */
export interface SchemaChangeToApply {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  /** The object's name AFTER the migration (for a `rename_table`, the NEW name). */
  readonly table: string;
  /** `rename_table` only: the table name before the rename. */
  readonly fromTable?: string;
  /** The DDL statement to execute. */
  readonly ddl: string;
  /**
   * The DDL this device's OWN migration of the same type, at the same
   * `(object kind, object name, schema version)`, recorded — when it has one.
   *
   * The decision compares against this: the state the incoming migration was
   * meant to produce, rather than the object's CURRENT shape, which the
   * receiver's own later migrations have moved on from. Two peers that each ran
   * the identical `create table orders` both record the identical canonical DDL
   * at version 1, so the duplicate create stays decidable however much either
   * peer alters the table afterwards.
   *
   * Absent when this device has no same-type record at that version (a table
   * created before sync was attached, or a version whose record is some other
   * migration type) — the decision then falls back to the current-shape
   * comparison.
   */
  readonly localDDLAtVersion?: string;
  /**
   * Present when the migration is a baseline (`schemaVersion` 0, see
   * {@link SchemaMigration.schemaVersion}): a definition for a receiver that has
   * none. The store adapter keeps an existing object over it rather than
   * reporting a conflict, and runs a baseline `add_index` only on a table the same
   * apply created from a baseline. Set by {@link toSchemaChange}, so every ingress
   * path shares one rule.
   */
  readonly baseline?: true;
}

/**
 * Narrow a migration to the fields the store adapter replays.
 *
 * `localDDLAtVersion` is what this device's OWN migration at the same version
 * recorded — see {@link SchemaChangeToApply.localDDLAtVersion}. Every ingress
 * path resolves it with {@link sameVersionLocalDDL} so one rule decides what
 * counts as "the same version".
 */
export function toSchemaChange(
	migration: SchemaMigration,
	localDDLAtVersion?: string,
): SchemaChangeToApply {
	return {
		type: migration.type,
		schema: migration.schema,
		table: migration.table,
		// Present-only, so a non-rename migration carries no phantom key.
		...(migration.fromTable !== undefined ? { fromTable: migration.fromTable } : {}),
		ddl: migration.ddl,
		...(localDDLAtVersion !== undefined ? { localDDLAtVersion } : {}),
		...(isBaselineVersion(migration.schemaVersion) ? { baseline: true as const } : {}),
	};
}

/**
 * The local record's DDL, but only when it answers the question the decision
 * asks: what did THIS device's migration of the SAME type at that version say?
 *
 * A same-version record of a different type is a different question — a table
 * created before sync was attached records its first alteration at version 1, and
 * comparing an incoming `create_table` against that `ALTER TABLE` text would
 * manufacture a conflict out of nothing.
 */
export function sameVersionLocalDDL(
	local: { readonly type: SchemaMigrationType; readonly ddl: string } | undefined,
	migration: SchemaMigration,
): string | undefined {
	return local !== undefined && local.type === migration.type ? local.ddl : undefined;
}

/**
 * The migration-record read {@link toSchemaChangeWithLocalRecord} needs, stated
 * structurally so this module does not have to import the metadata store (which
 * imports this one). `SchemaMigrationStore` satisfies it.
 */
export interface MigrationVersionLookup {
	getMigration(
		schemaName: string,
		kind: SchemaObjectKind,
		objectName: string,
		version: number,
	): Promise<{ readonly type: SchemaMigrationType; readonly ddl: string } | undefined>;
}

/**
 * {@link toSchemaChange} for an ingress path that has NOT already fetched the
 * local record at the migration's version (the two snapshot consumers).
 *
 * Must run BEFORE the caller records the incoming migration at that key —
 * afterwards the lookup returns the incoming DDL itself and the comparison is
 * vacuous.
 *
 * NOTE: reads `migration.schemaVersion` directly rather than repeating the
 * `?? getCurrentVersion() + 1` fallback its callers apply when RECORDING. The
 * field is required on the wire, so the two agree; a peer that somehow omitted it
 * would look up a version that resolves to no record and fall back to the
 * current-shape comparison — the pre-existing behaviour, not a new failure.
 */
export async function toSchemaChangeWithLocalRecord(
	lookup: MigrationVersionLookup,
	migration: SchemaMigration,
): Promise<SchemaChangeToApply> {
	const local = await lookup.getMigration(
		migration.schema,
		migrationObjectKind(migration.type),
		migration.table,
		migration.schemaVersion,
	);
	return toSchemaChange(migration, sameVersionLocalDDL(local, migration));
}

/**
 * Result of applying changes to the store.
 */
export interface ApplyToStoreResult {
  /** Number of data changes successfully applied. */
  dataChangesApplied: number;
  /** Number of schema changes successfully applied. */
  schemaChangesApplied: number;
  /**
   * The schema changes whose DDL this call actually RAN, in the order they ran —
   * not the ones it found already applied (whose tables, and so whose sync
   * bookkeeping, survive untouched) and not the ones that errored. The consumer
   * drives table-identity transitions from this list (a `drop_table` that ran
   * retires the table's generation; a `rename_table` that ran moves it — see
   * `metadata/table-identity.ts`). Absent ⇒ the consumer treats EVERY admitted
   * `create_table` / `drop_table` / `rename_table` as executed, which is the rule
   * for a deployment with no `applyToStore` at all (a relay-only coordinator has
   * no catalog to converge against, so every admitted migration is its truth);
   * the store adapter always fills it.
   */
  executedSchemaChanges?: SchemaChangeToApply[];
  /** Errors encountered (empty if all succeeded). */
  errors: Array<{ change: DataChangeToApply | SchemaChangeToApply; error: Error }>;
  /**
   * Commit-time global-assertion violations the engine seam **collected** rather
   * than threw (the adapter drives the incremental seam in report mode under the
   * trust-the-origin posture: the data lands and the batch commits regardless).
   * One entry per violated local assertion; omitted/empty when none. The consumer
   * surfaces these to the host via `onAssertionViolation` after a successful apply
   * — they do NOT abort convergence. Orthogonal to `errors` (a genuine per-change
   * storage failure still aborts the whole apply).
   */
  assertionViolations?: AssertionViolation[];
}

/**
 * Callback interface for applying remote changes to the store.
 *
 * The SyncManager uses this callback to apply changes from remote replicas.
 * The implementation should:
 * 1. Execute the changes against the actual data store
 * 2. Emit events with `remote: true` when `options.remote` is true
 *
 * This allows the store plugin to handle the actual data manipulation
 * while the sync module handles CRDT metadata.
 */
export type ApplyToStoreCallback = (
  dataChanges: DataChangeToApply[],
  schemaChanges: SchemaChangeToApply[],
  options: ApplyToStoreOptions
) => Promise<ApplyToStoreResult>;

// ============================================================================
// Peer State Tracking
// ============================================================================

/**
 * Tracks sync state with a specific peer.
 */
export interface PeerSyncState {
  readonly peerSiteId: SiteId;
  /** Last HLC we've synced up to with this peer */
  readonly lastSyncHLC: HLC;
  /** When we last successfully synced */
  readonly lastSyncTime: number;
}

// ============================================================================
// Conflict Resolution
// ============================================================================

/**
 * Context passed to a custom conflict resolver for a single column conflict.
 */
export interface ConflictContext {
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  readonly column: string;
  readonly localValue: SqlValue;
  readonly localHlc: HLC;
  readonly remoteValue: SqlValue;
  readonly remoteHlc: HLC;
  /**
   * The incoming change's before-image: the value the remote write overwrote at
   * its origin. Lets a resolver / transition validator see what the remote side
   * changed *from*. Absent when the incoming change carried no prior (first write
   * at the origin, snapshot-loaded cell, or a producer that omits it). Informational
   * only — it does not affect resolution.
   */
  readonly remotePriorValue?: SqlValue;
  /** HLC of the remote before-image. Present iff `remotePriorValue` is. */
  readonly remotePriorHlc?: HLC;
}

/**
 * Result of a conflict resolution: keep the local value or accept the remote one.
 */
export type ConflictResolution = 'local' | 'remote';

/**
 * A function that decides which side wins when a remote column change
 * conflicts with an existing local value.
 */
export type ConflictResolver = (ctx: ConflictContext) => ConflictResolution;

// ============================================================================
// Unknown-table disposition
// ============================================================================

/**
 * What the apply path does with inbound changes for a table outside the local
 * basis (a straggler delta referencing a table this receiver no longer has —
 * see `docs/migration.md` § 4 Contract).
 *
 * - `ignore` — drop the diverted changes (telemetry still fires). The deliberate
 *   opt-out for deployments that do not want to retain post-retirement straggler
 *   traffic; the write loss is intentional and observable, not silent.
 * - `quarantine` (default) — durably hold the diverted changes for manual / late
 *   processing. No write loss, operator-inspectable, and bounded: quarantine
 *   entries GC at the retention horizon like tombstones.
 * - `store-and-forward` — durably hold the diverted changes (identically to
 *   `quarantine`) **and** mark them forwardable, so peers that still have the
 *   table receive them via outbound delta sync. The hold + forwardable mark is
 *   implemented in `sync-store-and-forward-hold`; the outbound relay wiring (the
 *   actual re-offer through `getChangesSince`, and now `getChangesToPush`) lands
 *   in the sibling ticket `sync-store-and-forward-relay`. A forwarded change keeps its **original
 *   `hlc` + `siteId`**, which is what makes the relay loop-free and convergent.
 */
export type UnknownTableDisposition = 'ignore' | 'quarantine' | 'store-and-forward';

// ============================================================================
// Basis-table eviction
// ============================================================================

/**
 * Global default policy for reclaiming a detached basis table's local storage
 * (`docs/migration.md` § 4 Contract — retention-horizon retirement). A per-table
 * `quereus.sync.evict` reserved tag overrides this for one table.
 *
 * - `horizon` (default) — evict a detached table once it has been quiet (no
 *   directly-mapped write network-wide) for {@link horizonMs} (defaulting to
 *   {@link SyncConfig.retentionHorizonMs}).
 * - `never` — never auto-evict (storage lingers until the app drops it).
 * - `immediate` — evict a detached table on the first sweep after detach (zero
 *   horizon). Still requires the table to be `detached` — never drops an in-basis
 *   table.
 */
export interface BasisEvictionConfig {
  /** Global default mode. `horizon` (default) | `never` | `immediate`. */
  mode: 'horizon' | 'never' | 'immediate';
  /** Override horizon for `horizon` mode; defaults to {@link SyncConfig.retentionHorizonMs}. */
  horizonMs?: number;
}

/**
 * Reclaim a detached basis table's local storage by name. Wired by the host
 * (the worker) to a store-side reclaim-by-name helper
 * (`StoreModule.reclaimDetachedTable`); `indexNames` is the captured secondary-
 * index name list the lifecycle record retained from before detach (the table
 * schema — and its index list — is gone once detached, so the provider's
 * `deleteTableStores` needs it supplied rather than prefix-scanned, which could
 * clobber sibling `*_idx_*` tables).
 *
 * Must be idempotent: storage already gone (the app issued a real `drop table`)
 * is treated as success — the sweep still clears the record and emits the event.
 */
export type DropLocalTableCallback = (
  schema: string,
  table: string,
  indexNames: readonly string[],
) => Promise<void>;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Sync module configuration.
 */
export interface SyncConfig {
  /**
   * Retention horizon in milliseconds: changes older than this are not
   * guaranteed deliverable. Bounds tombstone GC AND delta-sync eligibility,
   * and is the bound retirement guidance keys off (drop a legacy basis table
   * no sooner than the horizon after its last directly-mapped write).
   * Default: 30 days (30 * 24 * 60 * 60 * 1000)
   */
  retentionHorizonMs: number;

  /**
   * Whether deleted rows can be resurrected by later writes.
   * If false (default), a tombstoned row blocks EVERY subsequent column write —
   * regardless of the write's HLC — until the tombstone is pruned
   * (see TombstoneStore.isDeletedAndBlocking).
   * If true, an insert/update with HLC later than the tombstone's can resurrect
   * a deleted row; writes at or before it stay blocked.
   * A delete arriving in the same apply batch as column writes for its row blocks
   * them by this same rule (change-applicator's in-batch reconciliation).
   */
  allowResurrection: boolean;

  /**
   * Maximum number of changes to return in a single sync batch.
   * Default: 1000
   */
  batchSize: number;

  /**
   * Pre-configured site ID. If not provided, one will be generated.
   */
  siteId?: SiteId;

  /**
   * Custom conflict resolver for column-level conflicts.
   * When absent, the fast-path HLC comparison (LWW) is used directly.
   * When present, both the local and remote values/HLCs are fetched and
   * passed to this function for every conflicting column write.
   */
  conflictResolver?: ConflictResolver;

  /**
   * What to do with inbound changes that reference a table outside the local
   * basis (an out-of-basis straggler delta — see {@link UnknownTableDisposition}
   * and `docs/migration.md` § 4 Contract). Default: `quarantine` (durably hold
   * to prevent silent write loss). Telemetry (`onUnknownTable` + the cumulative
   * counter) fires regardless of disposition.
   *
   * Detection requires a basis oracle (`getTableSchema`); when absent, detection
   * is inert and the store adapter's defensive throw remains the fallback.
   */
  unknownTableDisposition: UnknownTableDisposition;

  /**
   * Default policy for reclaiming a detached basis table's local storage
   * (`docs/migration.md` § 4 Contract). Default `{ mode: 'horizon' }`, which
   * evicts a detached table once it has been quiet for `retentionHorizonMs`. A
   * per-table `quereus.sync.evict` reserved tag overrides this for one table.
   * The eviction sweep ({@link SyncManager.evictExpiredBasisTables}) is
   * host-driven (no timer inside the library) and is a no-op when no
   * `dropLocalTable` reclaim callback is wired (e.g. a relay-only coordinator).
   */
  basisEviction?: BasisEvictionConfig;

  /**
   * When true (default), replay a reappeared table's held out-of-basis changes
   * immediately — as a SEPARATE post-commit apply — the moment the table comes back
   * (an inbound create_table, or a lens redeploy re-mapping it into the basis), instead
   * of waiting for the host's periodic drainHeldChanges sweep. Idempotent with the sweep
   * (a second drain returns 0). A no-op on a relay-only peer (no basis oracle ⇒ every
   * group is skipped). Set false to leave all drain timing to the host's periodic sweep.
   */
  drainOnReappear: boolean;
}

/**
 * Default sync configuration.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
  allowResurrection: false,
  batchSize: 1000,
  unknownTableDisposition: 'quarantine',
  basisEviction: { mode: 'horizon' },
  drainOnReappear: true,
};

