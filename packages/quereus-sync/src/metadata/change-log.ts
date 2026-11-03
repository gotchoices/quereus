/**
 * HLC-indexed change log for efficient delta sync.
 *
 * The change log stores references to changes indexed by HLC timestamp,
 * enabling efficient getChangesSince() queries without scanning all data.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import type { SqlValue } from '@quereus/quereus';
import { type HLC, compareHLC } from '../clock/hlc.js';
import {
  buildChangeLogKey,
  buildChangeLogScanBoundsAfter,
  buildAllChangeLogScanBounds,
  parseChangeLogKey,
  encodePkIdentity,
  type ChangeLogEntryType,
} from './keys.js';
import type { PkKeyingResolver } from './pk-identity.js';
import { writeIdentityBatch, type TableIdentityResolver } from './table-identity.js';

/**
 * Change log entry stored in KV.
 *
 * Carries the table GENERATION (resolve it to the table's current name through
 * `TableIdentityStore.nameOf`; `undefined` means a retired table's orphan entry)
 * and the pk IDENTITY (the derived, lossy string the row's records are filed
 * under), NOT the raw pk — the entry's value is empty and the identity cannot be
 * decoded back. Consumers resolve the entry to its live `cv:`/`tb:` record (which
 * holds the raw pk in its value) via the `*ByIdentity` getters.
 */
export interface ChangeLogEntry {
  readonly hlc: HLC;
  readonly entryType: ChangeLogEntryType;
  readonly generation: string;
  readonly identity: string;
  readonly column?: string;
}

/**
 * Change log store for HLC-indexed change tracking.
 *
 * Each mutation (column update or row deletion) creates an entry in the
 * change log, keyed by HLC. This allows efficient range scans to find
 * all changes since a given timestamp.
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
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): Promise<void> {
    await writeIdentityBatch(this.kv, this.tables, batch =>
      this.recordColumnChangeBatch(batch, hlc, schema, table, pk, column));
  }

  /**
   * Record a column change in a batch. The key's pk IDENTITY is always derived
   * locally — no caller-supplied-identity WRITE variant exists (see
   * `ColumnVersionStore.setColumnVersionBatch`); `deleteEntryByIdentityBatch`
   * below remains for DELETE-side callers holding a parsed key.
   */
  recordColumnChangeBatch(
    batch: WriteBatch,
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.ensure(schema, table, batch);
    // Value is empty - all info is in the key
    batch.put(buildChangeLogKey(hlc, 'column', generation, identity, column), new Uint8Array(0));
  }

  /**
   * Record a row deletion in the change log (standalone write; see
   * {@link recordColumnChange}).
   */
  async recordDeletion(
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): Promise<void> {
    await writeIdentityBatch(this.kv, this.tables, batch =>
      this.recordDeletionBatch(batch, hlc, schema, table, pk));
  }

  /**
   * Record a row deletion in a batch.
   */
  recordDeletionBatch(
    batch: WriteBatch,
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.ensure(schema, table, batch);
    batch.put(buildChangeLogKey(hlc, 'delete', generation, identity), new Uint8Array(0));
  }

  /**
   * Get all change log entries after a given HLC.
   * Returns entries in HLC order (oldest first).
   */
  async *getChangesSince(sinceHLC: HLC): AsyncIterable<ChangeLogEntry> {
    const bounds = buildChangeLogScanBoundsAfter(sinceHLC);
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (parsed) {
        yield parsed;
      }
    }
  }

  /**
   * Get all change log entries.
   */
  async *getAllChanges(): AsyncIterable<ChangeLogEntry> {
    const bounds = buildAllChangeLogScanBounds();
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (parsed) {
        yield parsed;
      }
    }
  }

  /**
   * Delete change log entries up to a given HLC.
   * Used for pruning old entries after they've been synced to all peers.
   *
   * NOTE: intentionally unwired — no production caller invokes this, and that is
   * deliberate, not an oversight. The change log no longer leaks (entries are
   * deleted with the `cv:`/`tb:` record they point at, so its size tracks live
   * data), so horizon pruning is now a behaviour change rather than a leak fix:
   * it drops index entries for cells that are still LIVE, which silently breaks
   * any peer whose `sinceHLC` predates the horizon — their delta scan would start
   * past the pruned range and never learn about those cells.
   *
   * Precondition before wiring it up: the server must REFUSE delta sync for a
   * `sinceHLC` below the pruned range and fall back to a snapshot. The refusal
   * exists now — `SyncManager.canDeltaSync` compares against the delta floor
   * (`metadata/delta-floor.ts`), the coordinator consults it before serving
   * `get_changes`, and the client recovers via snapshot — but the floor is only
   * raised by `pruneTombstones`. Wiring this up means raising the floor to
   * `beforeHLC` in the SAME batch as these deletes, exactly as the tombstone
   * prune does. Tracked as `feat-sync-changelog-horizon-pruning`.
   */
  async pruneEntriesBefore(beforeHLC: HLC): Promise<number> {
    const bounds = buildAllChangeLogScanBounds();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (!parsed) continue;

      // Prune entries strictly before the boundary HLC. Iteration is in HLC key
      // order (lexicographic == compareHLC), so the first entry at-or-after the
      // boundary means every remaining entry is too — stop. Comparing via
      // compareHLC keeps opSeq (and siteId) participating consistently.
      if (compareHLC(parsed.hlc, beforeHLC) >= 0) break;

      batch.delete(entry.key);
      count++;
    }

    await batch.write();
    return count;
  }

  /**
   * Delete a specific change log entry by raw pk. A name that never filed
   * anything has no entry to delete.
   */
  deleteEntryBatch(
    batch: WriteBatch,
    hlc: HLC,
    entryType: ChangeLogEntryType,
    schema: string,
    table: string,
    pk: SqlValue[],
    column?: string
  ): void {
    const identity = this.identity(schema, table, pk);
    const generation = this.tables.generationOf(schema, table);
    if (generation === undefined) return;
    this.deleteEntryByIdentityBatch(batch, hlc, entryType, generation, identity, column);
  }

  /**
   * Delete a specific change log entry by table generation and pk IDENTITY — for
   * callers that hold a parsed key rather than a name and raw pk (the tombstone
   * prune sweep and the change-log repair, whose generation may be retired and so
   * have no name at all).
   */
  deleteEntryByIdentityBatch(
    batch: WriteBatch,
    hlc: HLC,
    entryType: ChangeLogEntryType,
    generation: string,
    identity: string,
    column?: string
  ): void {
    const key = buildChangeLogKey(hlc, entryType, generation, identity, column);
    batch.delete(key);
  }
}

