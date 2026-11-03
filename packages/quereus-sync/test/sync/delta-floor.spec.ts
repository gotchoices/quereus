/**
 * Delta floor: pruning a tombstone must make the replica REFUSE an incremental
 * request whose watermark predates that tombstone, instead of answering it
 * with a delta that silently lacks the delete.
 *
 * The reproduction is the relay case: an origin peer inserts then deletes a
 * row, a relay with an instantly-expiring horizon applies both, prunes, and a
 * peer whose watermark sits between the insert and the delete asks for a delta.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type ChangeSet, type SyncConfig } from '../../src/sync/protocol.js';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
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
    const watermark: HLC = inserts[inserts.length - 1].hlc;

    source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y'] });
    await settle();
    const deletes: ChangeSet[] = await origin.getChangesSince(relay.getSiteId(), watermark);
    await relay.applyChanges(deletes);
    const deleteHlc: HLC = deletes[deletes.length - 1].hlc;

    // Nothing pruned yet: any watermark is servable, including one the relay
    // has never heard of (the old peer-state arm refused every unknown peer).
    expect(await relay.getDeltaFloor()).to.equal(undefined);
    expect(await relay.canDeltaSync(watermark)).to.be.true;

    expect(await relay.pruneTombstones()).to.equal(1);

    // The floor is exactly the pruned delete's HLC. A peer at the pre-delete
    // watermark needed that delete and can no longer get it; a peer at the
    // delete's own HLC already had it (replies are strictly after `since`).
    expect(await relay.getDeltaFloor()).to.deep.equal(deleteHlc);
    expect(await relay.canDeltaSync(watermark)).to.be.false;
    expect(await relay.canDeltaSync(deleteHlc)).to.be.true;
  });

  it('only ever moves forward: pruning an older tombstone after a newer one leaves the floor at the newer HLC', async () => {
    const relay = await makeRelay();
    const origin = generateSiteId();
    const deleteAt = (wallTime: bigint, pk: number): ChangeSet => {
      const hlc = createHLC(wallTime, 0, origin);
      return {
        siteId: origin,
        transactionId: `txn-${pk}`,
        hlc,
        changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [pk], hlc }],
        schemaMigrations: [],
      };
    };
    const now = BigInt(Date.now());

    await relay.applyChanges([deleteAt(now, 1)]);
    expect(await relay.pruneTombstones()).to.equal(1);
    const newer = await relay.getDeltaFloor();
    expect(newer?.wallTime).to.equal(now);

    // A straggler delete with an OLDER HLC arrives (and is pruned) later.
    await relay.applyChanges([deleteAt(now - 1000n, 2)]);
    expect(await relay.pruneTombstones()).to.equal(1);
    expect(await relay.getDeltaFloor()).to.deep.equal(newer);
  });
});
