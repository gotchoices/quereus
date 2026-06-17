/**
 * Quarantine store for held out-of-basis straggler changes.
 *
 * When a long-offline peer (a "straggler") reconnects and sends changes for a
 * table the receiver has since retired, the apply path diverts those changes
 * here instead of silently dropping them (see `docs/migration.md` § 4 Contract,
 * Unknown-table disposition, and `change-applicator.ts`). The raw wire `Change`
 * is stored verbatim so a manual / late replay has full fidelity.
 *
 * Entries are:
 *   - **idempotent** — keyed by the change's HLC (+ type/pk/column), so applying
 *     the same straggler batch twice yields exactly one entry per change.
 *   - **durable within the admission unit** — `put` stages into a caller-owned
 *     {@link WriteBatch} that lands before the apply's clock watermark advances,
 *     so a crash never strands a straggler's change with no re-delivery.
 *   - **bounded** — {@link pruneOlderThan} GCs entries past the retention horizon
 *     (mirroring tombstone TTL), so cost is zero with no stragglers and bounded
 *     by the horizon otherwise.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { hlcToJson, hlcFromJson, type SerializedHLC } from '../clock/hlc.js';
import type { Change } from '../sync/protocol.js';
import { encodeSqlValue, decodeSqlValue } from './column-version.js';
import { buildQuarantineKey, buildQuarantineScanBounds } from './keys.js';

/**
 * A held inbound change plus the wall-clock time it was received (for GC).
 */
export interface QuarantineEntry {
  readonly change: Change;
  readonly receivedAt: number;
}

/**
 * JSON shape persisted as the quarantine value. Compact keys keep the encoding
 * small; SqlValue/HLC use the same JSON-safe encoders as column versions so
 * Uint8Array / bigint survive the round-trip.
 */
interface SerializedQuarantineEntry {
  /** Change type discriminator. */
  readonly t: 'column' | 'delete';
  readonly s: string;        // schema
  readonly tb: string;       // table
  readonly pk: unknown[];    // encodeSqlValue per element
  readonly h: SerializedHLC; // change HLC
  readonly r: number;        // receivedAt (ms)
  readonly col?: string;     // column (column changes only)
  readonly v?: unknown;      // encodeSqlValue(value) (column changes only)
  readonly pv?: unknown;     // encodeSqlValue(priorValue) — before-image, present iff prior exists
  readonly ph?: SerializedHLC; // hlcToJson(priorHlc) — before-image, present iff prior exists
}

/**
 * Serialize a quarantine entry (the raw change + receivedAt) to bytes.
 */
export function serializeQuarantineEntry(entry: QuarantineEntry): Uint8Array {
  const c = entry.change;
  const base: SerializedQuarantineEntry = {
    t: c.type,
    s: c.schema,
    tb: c.table,
    pk: c.pk.map(encodeSqlValue),
    h: hlcToJson(c.hlc),
    r: entry.receivedAt,
  };
  // Preserve the per-cell before-image verbatim so a late/manual replay keeps the
  // full wire fidelity the module promises (present together or not at all).
  const prior = c.type === 'column' && c.priorHlc !== undefined
    ? { pv: encodeSqlValue(c.priorValue ?? null), ph: hlcToJson(c.priorHlc) }
    : undefined;
  const obj: SerializedQuarantineEntry = c.type === 'column'
    ? { ...base, col: c.column, v: encodeSqlValue(c.value), ...prior }
    : base;
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Deserialize a quarantine entry from bytes.
 */
export function deserializeQuarantineEntry(buffer: Uint8Array): QuarantineEntry {
  const obj = JSON.parse(new TextDecoder().decode(buffer)) as SerializedQuarantineEntry;
  const hlc = hlcFromJson(obj.h);
  const pk = obj.pk.map(decodeSqlValue);
  if (obj.t === 'column') {
    // Restore the before-image when present (spread only then — keeps prior-less
    // changes free of phantom undefined fields, matching the producer path).
    const prior = obj.ph !== undefined
      ? { priorValue: decodeSqlValue(obj.pv), priorHlc: hlcFromJson(obj.ph) }
      : undefined;
    return {
      change: { type: 'column', schema: obj.s, table: obj.tb, pk, column: obj.col!, value: decodeSqlValue(obj.v), hlc, ...prior },
      receivedAt: obj.r,
    };
  }
  return {
    change: { type: 'delete', schema: obj.s, table: obj.tb, pk, hlc },
    receivedAt: obj.r,
  };
}

/**
 * Quarantine store operations.
 */
export class QuarantineStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Stage a held change into a caller-owned batch. HLC-keyed, so re-staging the
   * same change overwrites its own entry (idempotent re-apply).
   */
  put(batch: WriteBatch, change: Change, receivedAt: number): void {
    const entryType = change.type === 'column' ? 'column' : 'delete';
    const column = change.type === 'column' ? change.column : undefined;
    const key = buildQuarantineKey(change.schema, change.table, change.hlc, entryType, change.pk, column);
    batch.put(key, serializeQuarantineEntry({ change, receivedAt }));
  }

  /**
   * List held changes, optionally scoped to a schema (and table). For operator
   * inspection — the volume is bounded by the retention horizon.
   */
  async list(schemaName?: string, tableName?: string): Promise<QuarantineEntry[]> {
    const bounds = buildQuarantineScanBounds(schemaName, tableName);
    const entries: QuarantineEntry[] = [];
    for await (const entry of this.kv.iterate(bounds)) {
      entries.push(deserializeQuarantineEntry(entry.value));
    }
    return entries;
  }

  /**
   * Prune held changes received strictly before `cutoff` (a wall-clock ms
   * timestamp). The caller passes `Date.now() - retentionHorizonMs`, matching
   * the tombstone TTL test (`now - receivedAt > retentionHorizonMs`). Returns
   * the number pruned.
   */
  async pruneOlderThan(cutoff: number): Promise<number> {
    const bounds = buildQuarantineScanBounds();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const { receivedAt } = deserializeQuarantineEntry(entry.value);
      if (receivedAt < cutoff) {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.write();
    return count;
  }
}
