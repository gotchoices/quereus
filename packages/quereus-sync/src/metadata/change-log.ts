/**
 * Change log: an index over the live `cv:` / `tb:` records, ordered by FILING POSITION.
 *
 * Each entry points at one record and is keyed by where this replica filed that record's
 * fact (`metadata/filing-position.ts`), so `getChangesSince()` reads facts in the order
 * they reached this replica without scanning all data. A fact's origin timestamp, which
 * can be far older than its position when the fact arrived late, is the entry's value.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import type { SqlValue } from '@quereus/quereus';
import { type HLC, compareHLC, serializeHLC, deserializeHLC } from '../clock/hlc.js';
import {
  buildChangeLogKey,
  buildChangeLogScanBoundsAfter,
  buildAllChangeLogScanBounds,
  parseChangeLogKey,
  encodePkIdentity,
  type ChangeLogEntryType,
} from './keys.js';
import { type FiledAt, filingPosition } from './filing-position.js';
import type { PkKeyingResolver } from './pk-identity.js';
import { writeIdentityBatch, type TableIdentityResolver } from './table-identity.js';

/**
 * Change log entry stored in KV.
 *
 * Carries the table GENERATION (resolve it to the table's current name through
 * `TableIdentityStore.nameOf`; `undefined` means a retired table's orphan entry)
 * and the pk IDENTITY (the derived, lossy string the row's records are filed
 * under), NOT the raw pk, which cannot be decoded back from the identity.
 * Consumers resolve the entry to its live `cv:`/`tb:` record (which holds the raw
 * pk in its value) via the `*ByIdentity` getters.
 *
 * An entry is live only while its record is filed at the entry's own `position`.
 */
export interface ChangeLogEntry {
  /** Where this replica filed the fact: the entry's key, and the order the log is read in. */
  readonly position: HLC;
  /**
   * The fact's origin timestamp. Stored as the entry's value when it differs from
   * `position`; an empty value means the two are equal (a fact written here, or an
   * entry written before positions existed).
   */
  readonly hlc: HLC;
  readonly entryType: ChangeLogEntryType;
  readonly generation: string;
  readonly identity: string;
  readonly column?: string;
}

const NO_VALUE = new Uint8Array(0);

/** An entry's value: the origin timestamp when the fact was filed somewhere else, else nothing. */
function originValue(filed: FiledAt): Uint8Array {
  return compareHLC(filingPosition(filed), filed.hlc) === 0 ? NO_VALUE : serializeHLC(filed.hlc);
}

function parseEntry(key: Uint8Array, value: Uint8Array): ChangeLogEntry | null {
  const parsed = parseChangeLogKey(key);
  if (!parsed) return null;
  return { ...parsed, hlc: value.length === 0 ? parsed.position : deserializeHLC(value) };
}

/**
 * Change log store, indexed by filing position.
 *
 * Each mutation (column update or row deletion) creates an entry in the
 * change log, keyed by the position it was filed at. This allows efficient range
 * scans to find everything filed after a given position.
 *
 * Every writer and deleter takes the record's {@link FiledAt} (or the parsed entry,
 * which is one) rather than a bare HLC: the key is the POSITION, and a caller holding
 * only an origin timestamp would address the wrong entry for any fact that arrived late.
 *
 * Every pk-taking method derives the key's pk IDENTITY through the per-table
 * {@link PkKeyingResolver} passed at construction and the table component through
 * the {@link TableIdentityResolver} (ensured into the batch on write, like the
 * record stores); `deleteEntryByIdentityBatch` serves callers that already hold a
 * parsed key.
 */
export class ChangeLogStore {
  constructor(
    private readonly kv: KVStore,
    private readonly keying: PkKeyingResolver,
    private readonly tables: TableIdentityResolver,
  ) {}

  private identity(schema: string, table: string, pk: SqlValue[]): string {
    return encodePkIdentity(pk, this.keying(schema, table));
  }

  /**
   * Record a column change in the change log (standalone write — one batch, so
   * the generation mint, when needed, lands with the entry).
   */
  async recordColumnChange(
    filed: FiledAt,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): Promise<void> {
    await writeIdentityBatch(this.kv, this.tables, batch =>
      this.recordColumnChangeBatch(batch, filed, schema, table, pk, column));
  }

  /**
   * Record a column change in a batch. The key's pk IDENTITY is always derived
   * locally — no caller-supplied-identity WRITE variant exists (see
   * `ColumnVersionStore.setColumnVersionBatch`); `deleteEntryByIdentityBatch`
   * below remains for DELETE-side callers holding a parsed key.
   */
  recordColumnChangeBatch(
    batch: WriteBatch,
    filed: FiledAt,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.ensure(schema, table, batch);
    batch.put(buildChangeLogKey(filingPosition(filed), 'column', generation, identity, column), originValue(filed));
  }

  /**
   * Record a row deletion in the change log (standalone write; see
   * {@link recordColumnChange}).
   */
  async recordDeletion(
    filed: FiledAt,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): Promise<void> {
    await writeIdentityBatch(this.kv, this.tables, batch =>
      this.recordDeletionBatch(batch, filed, schema, table, pk));
  }

  /**
   * Record a row deletion in a batch.
   */
  recordDeletionBatch(
    batch: WriteBatch,
    filed: FiledAt,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.ensure(schema, table, batch);
    batch.put(buildChangeLogKey(filingPosition(filed), 'delete', generation, identity), originValue(filed));
  }

  /**
   * Get all change log entries filed strictly after a given position, in filing order
   * (oldest first). A fact with an origin timestamp above `sincePosition` is always among
   * them, because a position is never below its fact's origin.
   */
  async *getChangesSince(sincePosition: HLC): AsyncIterable<ChangeLogEntry> {
    yield* this.entriesIn(buildChangeLogScanBoundsAfter(sincePosition));
  }

  /**
   * Get all change log entries, in filing order.
   */
  async *getAllChanges(): AsyncIterable<ChangeLogEntry> {
    yield* this.entriesIn(buildAllChangeLogScanBounds());
  }

  private async *entriesIn(bounds: { gte: Uint8Array; lt: Uint8Array }): AsyncIterable<ChangeLogEntry> {
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseEntry(entry.key, entry.value);
      if (parsed) yield parsed;
    }
  }

  /**
   * Delete change log entries filed before a given position.
   * Used for pruning old entries after they've been synced to all peers.
   *
   * NOTE: intentionally unwired — no production caller invokes this, and that is
   * deliberate, not an oversight. The change log no longer leaks (entries are
   * deleted with the `cv:`/`tb:` record they point at, so its size tracks live
   * data), so horizon pruning is now a behaviour change rather than a leak fix:
   * it drops index entries for cells that are still LIVE, which silently breaks
   * any peer whose watermark predates the horizon — their delta scan would start
   * past the pruned range and never learn about those cells.
   *
   * Precondition before wiring it up: the server must REFUSE delta sync for a
   * watermark below the pruned range and fall back to a snapshot. The refusal
   * exists now — `SyncManager.canDeltaSync` compares against the delta floor
   * (`metadata/delta-floor.ts`), the coordinator consults it before serving
   * `get_changes`, and the client recovers via snapshot — but the floor is only
   * raised by `pruneTombstones`. Wiring this up means raising the floor to
   * `beforePosition` in the SAME batch as these deletes, exactly as the tombstone
   * prune does. Tracked as `feat-sync-changelog-horizon-pruning`.
   */
  async pruneEntriesBefore(beforePosition: HLC): Promise<number> {
    const bounds = buildAllChangeLogScanBounds();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (!parsed) continue;

      // Prune entries strictly before the boundary. Iteration is in key order
      // (lexicographic == compareHLC over positions), so the first entry at-or-after
      // the boundary means every remaining entry is too — stop. Comparing via
      // compareHLC keeps opSeq (and siteId) participating consistently.
      if (compareHLC(parsed.position, beforePosition) >= 0) break;

      batch.delete(entry.key);
      count++;
    }

    await batch.write();
    return count;
  }

  /**
   * Delete the change log entry of the record `filed` describes, by raw pk. A name
   * that never filed anything has no entry to delete.
   */
  deleteEntryBatch(
    batch: WriteBatch,
    filed: FiledAt,
    entryType: ChangeLogEntryType,
    schema: string,
    table: string,
    pk: SqlValue[],
    column?: string
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.generationOf(schema, table);
    if (generation === undefined) return;
    this.deleteEntryByIdentityBatch(batch, filed, entryType, generation, identity, column);
  }

  /**
   * Delete the change log entry of the record `filed` describes, by table generation
   * and pk IDENTITY — for callers that hold a parsed key rather than a name and raw pk
   * (the tombstone prune sweep and the change-log repair, whose generation may be
   * retired and so have no name at all).
   */
  deleteEntryByIdentityBatch(
    batch: WriteBatch,
    filed: FiledAt,
    entryType: ChangeLogEntryType,
    generation: string,
    identity: string,
    column?: string
  ): void {
    batch.delete(buildChangeLogKey(filingPosition(filed), entryType, generation, identity, column));
  }
}
