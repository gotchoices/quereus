/**
 * Tests for LevelDB store implementation.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LevelDBStore } from '../src/store.js';

describe('LevelDBStore', () => {
  let testDir: string;
  let store: LevelDBStore;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `quereus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    store = await LevelDBStore.open({ path: testDir });
  });

  afterEach(async () => {
    await store.close();
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Basic operations', () => {
    it('should put and get a value', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      await store.put(key, value);
      const result = await store.get(key);

      expect(result).to.deep.equal(value);
    });

    it('should return undefined for non-existent key', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const result = await store.get(key);

      expect(result).to.be.undefined;
    });

    it('should delete a key', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      await store.put(key, value);
      await store.delete(key);
      const result = await store.get(key);

      expect(result).to.be.undefined;
    });

    it('should check if key exists with has()', async () => {
      const key = new Uint8Array([10, 20, 30]);
      const value = new Uint8Array([40, 50, 60]);

      expect(await store.has(key)).to.be.false;
      await store.put(key, value);
      expect(await store.has(key)).to.be.true;
    });

    it('should forward the WriteOptions sync hint without error and persist', async () => {
      // classic-level forwards { sync } to the underlying write; the durable delete
      // is what the clean-shutdown marker consume relies on. Here we only assert the
      // hint is accepted and the write/delete still take effect.
      const key = new Uint8Array([42]);
      const value = new Uint8Array([1, 2, 3]);

      await store.put(key, value, { sync: true });
      expect(await store.get(key)).to.deep.equal(value);

      await store.delete(key, { sync: true });
      expect(await store.get(key)).to.be.undefined;
    });

    it('should overwrite existing values', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value1 = new Uint8Array([4, 5, 6]);
      const value2 = new Uint8Array([7, 8, 9]);

      await store.put(key, value1);
      await store.put(key, value2);
      const result = await store.get(key);

      expect(result).to.deep.equal(value2);
    });
  });

  describe('Iteration', () => {
    beforeEach(async () => {
      // Insert test data
      await store.put(new Uint8Array([1]), new Uint8Array([10]));
      await store.put(new Uint8Array([2]), new Uint8Array([20]));
      await store.put(new Uint8Array([3]), new Uint8Array([30]));
      await store.put(new Uint8Array([4]), new Uint8Array([40]));
      await store.put(new Uint8Array([5]), new Uint8Array([50]));
    });

    it('should iterate all entries in order', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate()) {
        entries.push(entry);
      }

      expect(entries.length).to.equal(5);
      expect(entries[0].key[0]).to.equal(1);
      expect(entries[4].key[0]).to.equal(5);
    });

    it('should iterate with gte bound', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ gte: new Uint8Array([3]) })) {
        entries.push(entry);
      }

      expect(entries.length).to.equal(3);
      expect(entries[0].key[0]).to.equal(3);
    });

    it('should iterate with lt bound', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ lt: new Uint8Array([3]) })) {
        entries.push(entry);
      }

      expect(entries.length).to.equal(2);
      expect(entries[1].key[0]).to.equal(2);
    });

    it('should iterate in reverse', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ reverse: true })) {
        entries.push(entry);
      }

      expect(entries.length).to.equal(5);
      expect(entries[0].key[0]).to.equal(5);
      expect(entries[4].key[0]).to.equal(1);
    });

    it('should respect limit', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ limit: 2 })) {
        entries.push(entry);
      }

      expect(entries.length).to.equal(2);
    });
  });

  describe('Batch operations', () => {
    it('should execute batch put operations', async () => {
      const batch = store.batch();
      batch.put(new Uint8Array([1]), new Uint8Array([10]));
      batch.put(new Uint8Array([2]), new Uint8Array([20]));
      batch.put(new Uint8Array([3]), new Uint8Array([30]));
      await batch.write();

      expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
      expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
      expect(await store.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
    });

    it('should execute batch delete operations', async () => {
      await store.put(new Uint8Array([100]), new Uint8Array([10]));
      await store.put(new Uint8Array([101]), new Uint8Array([20]));

      const batch = store.batch();
      batch.delete(new Uint8Array([100]));
      batch.delete(new Uint8Array([101]));
      await batch.write();

      expect(await store.has(new Uint8Array([100]))).to.be.false;
      expect(await store.has(new Uint8Array([101]))).to.be.false;
    });
  });
});

