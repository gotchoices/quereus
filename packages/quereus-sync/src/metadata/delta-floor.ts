/**
 * Delta floor: the HLC below which this replica can no longer produce a
 * complete incremental delta.
 *
 * A reconnecting peer asks for "changes since T". A delete is served from its
 * tombstone, so once a tombstone is pruned at the retention horizon any delta
 * that should have carried that delete is silently incomplete. The floor is the
 * greatest HLC of any tombstone this replica has pruned: a request `since T` is
 * complete iff `T >= floor` (replies carry changes strictly after `T`, so a
 * tombstone at exactly `T` was already delivered).
 *
 * The floor is raised in the SAME `WriteBatch` as the tombstone deletes it
 * accounts for (`SyncManagerImpl.pruneTombstones`) — a crash between the two
 * would reopen the silent-gap bug — and only ever moves forward. It travels in
 * snapshot headers so a replica rebuilt from a snapshot inherits the sender's
 * incompleteness (`deltaFloor` on `SnapshotHeaderChunk` / `Snapshot`).
 *
 * Deliberately NOT a wall-clock test: a watermark is the HLC of the last change
 * a peer received, not the time it last synced, so a quiet database would age
 * every watermark past a time horizon while nothing was pruned.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { SYNC_KEY_PREFIX } from './keys.js';

/** Single-record store under the `df:` key; the value is one serialized HLC. */
export class DeltaFloorStore {
  constructor(private readonly kv: KVStore) {}

  /** The floor, or `undefined` when nothing deliverable has ever been pruned. */
  async get(): Promise<HLC | undefined> {
    const data = await this.kv.get(SYNC_KEY_PREFIX.DELTA_FLOOR);
    if (!data) return undefined;
    return deserializeHLC(data);
  }

  /**
   * Whether an incremental request `since sinceHLC` can still be served in
   * full: true when nothing was pruned, or the watermark is at/after the floor.
   */
  async admits(sinceHLC: HLC): Promise<boolean> {
    const floor = await this.get();
    return floor === undefined || compareHLC(sinceHLC, floor) >= 0;
  }

  /**
   * Queue a forward-only raise onto `batch`: the stored floor becomes
   * `max(current, hlc)`. Reads the current value now; the caller owns the
   * batch's write and must not interleave another raise before it lands.
   * Batch-only on purpose: every raise accounts for tombstone deletes that
   * must land in the same write (`pruneTombstones`, the snapshot metadata
   * clear), so there is no standalone variant to reach for by mistake.
   */
  async raiseBatch(batch: WriteBatch, hlc: HLC): Promise<void> {
    const current = await this.get();
    if (current && compareHLC(hlc, current) <= 0) return;
    batch.put(SYNC_KEY_PREFIX.DELTA_FLOOR, serializeHLC(hlc));
  }
}
