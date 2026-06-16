/**
 * Tests for TombstoneStore.
 */

import { expect } from 'chai';
import { TombstoneStore, serializeTombstone, deserializeTombstone, type Tombstone } from '../../src/metadata/tombstones.js';
import { type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/store';

describe('Tombstone', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId, opSeq: 0 },
        createdAt: Date.now(),
      };

      const serialized = serializeTombstone(tombstone);
      const deserialized = deserializeTombstone(serialized);

      expect(deserialized.hlc.wallTime).to.equal(tombstone.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(tombstone.hlc.counter);
      expect(deserialized.createdAt).to.equal(tombstone.createdAt);
    });
  });

  describe('TombstoneStore', () => {
    let store: TombstoneStore;
    let kv: InMemoryKVStore;
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

    beforeEach(() => {
      kv = new InMemoryKVStore();
      store = new TombstoneStore(kv, TTL);
    });

    it('should store and retrieve tombstones', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], hlc);
      const retrieved = await store.getTombstone('main', 'users', [1]);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.hlc.counter).to.equal(1);
    });

    it('should return undefined for non-existent tombstones', async () => {
      const result = await store.getTombstone('main', 'users', [999]);
      expect(result).to.be.undefined;
    });

    it('should block writes when tombstone exists and resurrection not allowed', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with older HLC should be blocked
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.true;
    });

    it('should allow resurrection when enabled', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };
      const writeHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with newer HLC should not be blocked when resurrection allowed
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, true);
      expect(isBlocked).to.be.false;
    });

    it('should not block when no tombstone exists', async () => {
      const siteId = generateSiteId();
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };

      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.false;
    });
  });
});

