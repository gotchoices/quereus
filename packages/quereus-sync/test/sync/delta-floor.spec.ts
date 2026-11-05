/**
 * Delta floor: pruning a tombstone must make the replica REFUSE an incremental
 * request whose watermark predates that tombstone, instead of answering it
 * with a delta that silently lacks the delete.
 *
 * The reproduction is the relay case: an origin peer inserts then deletes a
 * row, a relay with an instantly-expiring horizon applies both, prunes, and a
 * peer whose watermark sits between the insert and the delete asks for a delta.
 *
 * A watermark, and so the floor, is a position in the relay's change log (where it
 * filed a change), not the change's write time: a delete that reached the relay late
 * is needed by every peer that has not read that far, however old its HLC.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, replyWatermark, type ChangeSet, type SyncConfig } from '../../src/sync/protocol.js';
import { MAX_OPSEQ, compareHLC, createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

/** Local-change capture runs fire-and-forget after the commit; let it settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25));

/** Every tombstone is instantly past a negative horizon, so prunes are deterministic. */
const EXPIRE_IMMEDIATELY: Partial<SyncConfig> = { retentionHorizonMs: -1 };

async function makeRelay(): Promise<SyncManagerImpl> {
  return SyncManagerImpl.create(
    new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG, ...EXPIRE_IMMEDIATELY }, new SyncEventEmitterImpl(),
  );
}

describe('delta floor', () => {
  const reader = generateSiteId();

  /** What `reader` would resume from after reading everything `relay` has filed past `since`. */
  async function readThrough(relay: SyncManagerImpl, since?: HLC): Promise<HLC> {
    return replyWatermark(await relay.getChangesSince(reader, since))!;
  }

  function foreignDelete(origin: Uint8Array, wallTime: bigint, pk: number): ChangeSet {
    const hlc = createHLC(wallTime, 0, origin);
    return {
      siteId: origin,
      transactionId: `txn-${pk}`,
      hlc,
      changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [pk], hlc }],
      schemaMigrations: [],
    };
  }

  it('refuses a watermark below a pruned delete, admits one at it, and admits anything before any prune', async () => {
    const source = new FakeTransactionSource();
    const origin = await SyncManagerImpl.create(
      new InMemoryKVStore(), source, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
    );
    const relay = await makeRelay();

    source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['x', 'y'] });
    await settle();
    const inserts: ChangeSet[] = await origin.getChangesSince(relay.getSiteId());
    await relay.applyChanges(inserts);
    const watermark = await readThrough(relay);

    source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y'] });
    await settle();
    await relay.applyChanges(await origin.getChangesSince(relay.getSiteId(), replyWatermark(inserts)));
    const deletePosition = await readThrough(relay, watermark);

    // Nothing pruned yet: any watermark is servable, including one the relay
    // has never heard of (the old peer-state arm refused every unknown peer).
    expect(await relay.getDeltaFloor()).to.equal(undefined);
    expect(await relay.canDeltaSync(watermark)).to.be.true;

    expect(await relay.pruneTombstones()).to.equal(1);

    // The floor is exactly where the relay filed the pruned delete. A peer at the
    // pre-delete watermark needed that delete and can no longer get it; a peer at the
    // delete's own position already had it (replies are strictly after `since`).
    expect(await relay.getDeltaFloor()).to.deep.equal(deletePosition);
    expect(await relay.canDeltaSync(watermark)).to.be.false;
    expect(await relay.canDeltaSync(deletePosition)).to.be.true;
  });

  it('raises the floor to where a late delete was filed, not to its older write time', async () => {
    const relay = await makeRelay();
    const origin = generateSiteId();
    const now = BigInt(Date.now());

    await relay.applyChanges([foreignDelete(origin, now, 1)]);
    const beforeLateDelete = await readThrough(relay);

    // Written a second BEFORE the delete the reader already has, and reaching the relay after it.
    await relay.applyChanges([foreignDelete(origin, now - 1000n, 2)]);
    const lateDeletePosition = await readThrough(relay, beforeLateDelete);
    expect(compareHLC(lateDeletePosition, beforeLateDelete)).to.be.greaterThan(0);

    expect(await relay.pruneTombstones()).to.equal(2);

    // The reader has passed the late delete's write time but not its position, so it still needs it.
    expect(await relay.getDeltaFloor()).to.deep.equal(lateDeletePosition);
    expect(await relay.canDeltaSync(beforeLateDelete)).to.be.false;
    expect(await relay.canDeltaSync(lateDeletePosition)).to.be.true;
  });

  it('only ever moves forward: pruning a tombstone filed earlier leaves the floor where a later one put it', async () => {
    const source = new FakeTransactionSource();
    const replica = await SyncManagerImpl.create(
      new InMemoryKVStore(), source, { ...DEFAULT_SYNC_CONFIG, ...EXPIRE_IMMEDIATELY }, new SyncEventEmitterImpl(),
    );

    // Its own delete is filed first and stays until delivered; another site's is filed after it.
    source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y'] });
    await settle();
    await replica.applyChanges([foreignDelete(generateSiteId(), BigInt(Date.now()), 2)]);

    expect(await replica.pruneTombstones()).to.equal(1);
    const floor = await replica.getDeltaFloor();
    expect(floor).to.not.equal(undefined);

    await replica.updatePeerSentState(generateSiteId(), { ...replica.getCurrentHLC(), opSeq: MAX_OPSEQ });
    expect(await replica.pruneTombstones()).to.equal(1);
    expect(await replica.getDeltaFloor()).to.deep.equal(floor);
  });
});
