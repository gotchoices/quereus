/**
 * Basis-table lifecycle store — durable per-basis-table classification + the
 * mapped-since / unmapped-since bookkeeping that drives legacy-table retirement
 * (`docs/migration.md` § 2 Converge).
 *
 * Each shared (basis) table is classified into one of four states relative to
 * the app's current lens deployments and the basis schema's own derivations:
 *
 *   - `directly-mapped`        — some deployed lens backs a logical column with it.
 *   - `derivation-source-only` — referenced *solely* as a maintained table's
 *                                source (the "this table is now legacy" signal).
 *   - `unreferenced`           — in the basis, but neither mapped nor a
 *                                derivation source.
 *   - `detached`               — no longer in the basis schema; physical storage
 *                                may linger (an eviction candidate).
 *
 * The classification is recomputed on every lens deploy
 * ({@link import('../sync/sync-manager-impl.js').SyncManagerImpl.recordLensDeployment}).
 * Records are KV-durable so the classification — and its timestamps — survive a
 * restart with no prior deploy in the session.
 *
 * The record is a flat JSON-safe object (strings / numbers / booleans /
 * `string[]`), so serialization is a plain `JSON.stringify`; no custom
 * SqlValue / HLC encoding is needed (unlike `quarantine.ts` / `column-version.ts`).
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { buildBasisLifecycleKey, buildAllBasisLifecycleScanBounds } from './keys.js';

/** The aggregate lifecycle state of one basis table. */
export type BasisLifecycleState =
  | 'directly-mapped'
  | 'derivation-source-only'
  | 'unreferenced'
  | 'detached';

/**
 * The persisted lifecycle record for one basis table.
 *
 * `mappedBy` stores each deployed logical schema's contribution separately and
 * the aggregate `state` ORs them, so a basis table mapped by logical schema `A`
 * but not `B` stays `directly-mapped` until the *last* mapper drops it — without
 * the recorder having to enumerate every deployed logical schema (no public
 * enumerator exists; see the recorder's per-schema-contribution note).
 */
export interface BasisTableLifecycleRecord {
  /** Basis schema name (original case where known, else the lowercased key part). */
  schema: string;
  /** Basis table name (original case where known, else the lowercased key part). */
  table: string;
  /** Aggregate state across all deployed logical schemas + the basis derivations. */
  state: BasisLifecycleState;
  /** Logical schema names (lowercased) whose latest deploy directly maps this table. */
  mappedBy: string[];
  /** True iff some maintained table in the current basis lists it in `sourceTables`. */
  derivationSource: boolean;
  /** True iff the table is present in the basis schema as of the last deploy. */
  inBasis: boolean;
  /** Wall-clock ms when the aggregate state last entered `directly-mapped`. */
  mappedSince?: number;
  /** Wall-clock ms when it last left `directly-mapped` (the retirement hint timestamp). */
  unmappedSince?: number;
  /** Populated by `basis-eviction-policy` (dynamic signal); reserved here. */
  lastDirectlyMappedWriteAt?: number;
  /** Populated by `basis-eviction-policy` (override knob); reserved here. */
  evictPolicy?: 'never' | 'immediate' | number;
}

/**
 * Aggregate one basis table's state from its three orthogonal facts.
 * `directly-mapped` wins over `derivation-source-only`, which wins over plain
 * basis membership; a table no longer in the basis is `detached`.
 */
export function classifyBasisLifecycle(
  mappedBy: ReadonlyArray<string>,
  derivationSource: boolean,
  inBasis: boolean,
): BasisLifecycleState {
  if (mappedBy.length > 0) return 'directly-mapped';
  if (derivationSource) return 'derivation-source-only';
  if (inBasis) return 'unreferenced';
  return 'detached';
}

/**
 * Split a lowercased `schema.table` relation key into its parts (first dot is the
 * separator — schema names carry no dots). Used as the display-name fallback for
 * a key that no current basis enumeration provides original case for (a stored
 * detached record, or a derivation source that resolved to no basis member).
 */
export function splitRelKey(key: string): { schema: string; table: string } {
  const dot = key.indexOf('.');
  if (dot === -1) return { schema: '', table: key };
  return { schema: key.slice(0, dot), table: key.slice(dot + 1) };
}

/**
 * True iff the recomputed record differs from the prior in any persisted field —
 * the gate that keeps an idempotent re-apply (identical deploy) from rewriting
 * every record. Compares the comparable fields explicitly rather than by
 * stringify so field-presence/order quirks never produce a false diff. Reserved
 * eviction-policy fields are carried through unchanged, so they only differ when
 * `basis-eviction-policy` actually mutated them.
 */
export function basisLifecycleRecordChanged(
  a: BasisTableLifecycleRecord,
  b: BasisTableLifecycleRecord,
): boolean {
  return a.state !== b.state
    || a.derivationSource !== b.derivationSource
    || a.inBasis !== b.inBasis
    || a.mappedSince !== b.mappedSince
    || a.unmappedSince !== b.unmappedSince
    || a.lastDirectlyMappedWriteAt !== b.lastDirectlyMappedWriteAt
    || a.evictPolicy !== b.evictPolicy
    || a.mappedBy.length !== b.mappedBy.length
    || a.mappedBy.some((v, i) => v !== b.mappedBy[i]);
}

/** Serialize a lifecycle record to bytes (flat JSON — see file header). */
export function serializeBasisLifecycleRecord(record: BasisTableLifecycleRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/** Deserialize a lifecycle record from bytes. */
export function deserializeBasisLifecycleRecord(buffer: Uint8Array): BasisTableLifecycleRecord {
  return JSON.parse(new TextDecoder().decode(buffer)) as BasisTableLifecycleRecord;
}

/**
 * KV-backed store for basis-table lifecycle records. Owns read / write / iterate;
 * the transition detection + timestamp stamping live in the recorder, which
 * stages writes into a single batch per deploy.
 */
export class BasisLifecycleStore {
  constructor(private readonly kv: KVStore) {}

  /** Read one record by basis `schema.table`, or undefined when none is stored. */
  async get(schemaName: string, tableName: string): Promise<BasisTableLifecycleRecord | undefined> {
    const value = await this.kv.get(buildBasisLifecycleKey(schemaName, tableName));
    return value ? deserializeBasisLifecycleRecord(value) : undefined;
  }

  /**
   * Stage a record write into a caller-owned batch (keyed by `schema.table`
   * lowercased, so re-recording overwrites its own entry). The recorder folds
   * all of a deploy's changed records into one batch.
   */
  put(batch: WriteBatch, record: BasisTableLifecycleRecord): void {
    batch.put(buildBasisLifecycleKey(record.schema, record.table), serializeBasisLifecycleRecord(record));
  }

  /**
   * Read every stored record, keyed by lowercased `schema.table` — the recorder's
   * starting point for transition detection (it OR-folds the new deploy over these).
   */
  async getAll(): Promise<Map<string, BasisTableLifecycleRecord>> {
    const result = new Map<string, BasisTableLifecycleRecord>();
    for await (const entry of this.kv.iterate(buildAllBasisLifecycleScanBounds())) {
      const record = deserializeBasisLifecycleRecord(entry.value);
      result.set(`${record.schema}.${record.table}`.toLowerCase(), record);
    }
    return result;
  }

  /** List every stored record (introspection — bounded by the basis table count). */
  async list(): Promise<BasisTableLifecycleRecord[]> {
    const records: BasisTableLifecycleRecord[] = [];
    for await (const entry of this.kv.iterate(buildAllBasisLifecycleScanBounds())) {
      records.push(deserializeBasisLifecycleRecord(entry.value));
    }
    return records;
  }
}
