/**
 * Serialization helpers for ChangeSet transport over JSON.
 *
 * - SiteIds use base64url encoding (via siteIdToBase64/siteIdFromBase64)
 * - HLCs use standard base64 encoding (via btoa/atob in browser, Buffer in Node)
 * - Uint8Array values use `{ __bin: "<base64>" }` tagged encoding
 */

import {
  serializeHLC,
  deserializeHLC,
  siteIdToBase64,
  siteIdFromBase64,
  encodeSqlValue,
  decodeSqlValue,
  type ChangeSet,
  type Change,
  type ColumnChange,
  type RowDeletion,
  type SchemaMigration,
  type HLC,
} from '@quereus/sync';
import type { SqlValue } from '@quereus/quereus';
import type { SerializedChangeSet } from './types.js';

// ============================================================================
// Base64 helpers (work in both browser and Node.js)
// ============================================================================

/**
 * Encode bytes to base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Browser: use btoa
  if (typeof btoa === 'function') {
    return btoa(String.fromCharCode(...bytes));
  }
  // Node.js: use Buffer
  return Buffer.from(bytes).toString('base64');
}

/**
 * Decode base64 string to bytes.
 */
function base64ToBytes(str: string): Uint8Array {
  // Browser: use atob
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  }
  // Node.js: use Buffer
  return new Uint8Array(Buffer.from(str, 'base64'));
}

// ============================================================================
// ChangeSet Serialization
// ============================================================================

/**
 * Serialize a ChangeSet for JSON transport.
 * Encodes Uint8Array values in changes and PKs so they survive JSON round-trip.
 *
 * @param cs - The ChangeSet to serialize
 * @returns A JSON-serializable object
 */
export function serializeChangeSet(cs: ChangeSet): SerializedChangeSet {
  return {
    siteId: siteIdToBase64(cs.siteId),
    transactionId: cs.transactionId,
    hlc: bytesToBase64(serializeHLC(cs.hlc)),
    changes: cs.changes.map(c => {
      const base = {
        type: c.type,
        schema: c.schema,
        table: c.table,
        pk: c.pk.map(v => encodeSqlValue(v)),
        hlc: bytesToBase64(serializeHLC(c.hlc)),
      };
      if (c.type === 'column') {
        const cc = c as ColumnChange;
        return {
          ...base,
          column: cc.column,
          value: encodeSqlValue(cc.value),
          // Carry the per-cell before-image (value + HLC) present-only: write both
          // together gated on priorHlc, never a phantom key. priorHlc reuses the same
          // base64-binary HLC encoding as `hlc`; priorValue rides encodeSqlValue.
          ...(cc.priorHlc !== undefined
            ? {
                priorValue: encodeSqlValue(cc.priorValue ?? null),
                priorHlc: bytesToBase64(serializeHLC(cc.priorHlc)),
              }
            : {}),
        };
      }
      const rd = c as RowDeletion;
      return {
        ...base,
        // Carry the row before-image present-only. An empty array is present:
        // [].map(...) is still [] and [] !== undefined, so the conditional spread
        // preserves the empty-present vs absent boundary.
        ...(rd.priorRow !== undefined
          ? { priorRow: rd.priorRow.map(v => encodeSqlValue(v)) }
          : {}),
      };
    }),
    schemaMigrations: cs.schemaMigrations.map(m => ({
      ...m,
      hlc: bytesToBase64(serializeHLC(m.hlc)),
    })),
  };
}

/**
 * Deserialize a ChangeSet from JSON transport format.
 * Decodes tagged Uint8Array values in changes and PKs.
 *
 * @param obj - The serialized ChangeSet object
 * @returns The deserialized ChangeSet
 */
export function deserializeChangeSet(obj: SerializedChangeSet): ChangeSet {
  return {
    siteId: siteIdFromBase64(obj.siteId),
    transactionId: obj.transactionId,
    hlc: deserializeHLC(base64ToBytes(obj.hlc)),
    changes: obj.changes.map(c => {
      const base = {
        type: c.type,
        schema: c.schema,
        table: c.table,
        pk: (c.pk as unknown[]).map(v => decodeSqlValue(v)),
        hlc: deserializeHLC(base64ToBytes(c.hlc)),
      };
      if (c.type === 'column') {
        return {
          ...base,
          column: c.column!,
          value: decodeSqlValue(c.value),
          // Mirror serialize: attach the before-image only when the serialized
          // object carries it, so absent stays absent (not a phantom undefined).
          ...(c.priorHlc !== undefined
            ? {
                priorValue: decodeSqlValue(c.priorValue),
                priorHlc: deserializeHLC(base64ToBytes(c.priorHlc)),
              }
            : {}),
        };
      }
      return {
        ...base,
        ...(c.priorRow !== undefined
          ? { priorRow: (c.priorRow as unknown[]).map(v => decodeSqlValue(v)) }
          : {}),
      };
    }) as Change[],
    schemaMigrations: obj.schemaMigrations.map(m => ({
      ...m,
      hlc: deserializeHLC(base64ToBytes(m.hlc)),
    })) as SchemaMigration[],
  };
}

/**
 * Serialize an HLC for transport (base64 encoding).
 *
 * @param hlc - The HLC to serialize
 * @returns Base64-encoded string
 */
export function serializeHLCForTransport(hlc: HLC): string {
  return bytesToBase64(serializeHLC(hlc));
}

/**
 * Deserialize an HLC from transport format.
 *
 * @param str - Base64-encoded HLC string
 * @returns The deserialized HLC
 */
export function deserializeHLCFromTransport(str: string): HLC {
  return deserializeHLC(base64ToBytes(str));
}

