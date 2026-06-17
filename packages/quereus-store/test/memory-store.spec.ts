/**
 * Tests for InMemoryKVStore implementation.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '../src/common/memory-store.js';

/** Helper: collect all entries from an async iterable. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iter) result.push(item);
	return result;
}

describe('InMemoryKVStore', () => {
	let store: InMemoryKVStore;

	beforeEach(() => {
		store = new InMemoryKVStore();
	});

	afterEach(async () => {
		await store.close();
	});

	describe('get / put / delete / has', () => {
		it('returns undefined for missing key', async () => {
			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
		});

		it('puts and gets a value', async () => {
			const key = new Uint8Array([1, 2]);
			const val = new Uint8Array([10, 20]);
			await store.put(key, val);
			expect(await store.get(key)).to.deep.equal(val);
		});

		it('overwrites existing value', async () => {
			const key = new Uint8Array([1]);
			await store.put(key, new Uint8Array([10]));
			await store.put(key, new Uint8Array([20]));
			expect(await store.get(key)).to.deep.equal(new Uint8Array([20]));
		});

		it('deletes a key', async () => {
			const key = new Uint8Array([1]);
			await store.put(key, new Uint8Array([10]));
			await store.delete(key);
			expect(await store.get(key)).to.be.undefined;
		});

		it('has returns true for existing key', async () => {
			const key = new Uint8Array([1]);
			await store.put(key, new Uint8Array([10]));
			expect(await store.has(key)).to.be.true;
		});

		it('has returns false for missing key', async () => {
			expect(await store.has(new Uint8Array([99]))).to.be.false;
		});

		it('put/delete accept and silently ignore the WriteOptions durability hint', async () => {
			// An in-memory store has no crash window, so `sync: true` is a no-op — it
			// must neither throw nor change observable behavior.
			const key = new Uint8Array([7]);
			await store.put(key, new Uint8Array([70]), { sync: true });
			expect(await store.get(key)).to.deep.equal(new Uint8Array([70]));
			await store.delete(key, { sync: true });
			expect(await store.get(key)).to.be.undefined;
		});

		it('stores copies to prevent external mutation', async () => {
			const key = new Uint8Array([1]);
			const val = new Uint8Array([10]);
			await store.put(key, val);
			val[0] = 99; // mutate original
			expect(await store.get(key)).to.deep.equal(new Uint8Array([10]));
		});
	});

	describe('iterate', () => {
		beforeEach(async () => {
			// Insert keys [0x01], [0x02], [0x03], [0x04], [0x05]
			for (let i = 1; i <= 5; i++) {
				await store.put(new Uint8Array([i]), new Uint8Array([i * 10]));
			}
		});

		it('iterates all entries in sorted order', async () => {
			const entries = await collect(store.iterate());
			expect(entries).to.have.length(5);
			expect(entries[0].key).to.deep.equal(new Uint8Array([1]));
			expect(entries[4].key).to.deep.equal(new Uint8Array([5]));
		});

		it('supports gte bound', async () => {
			const entries = await collect(store.iterate({ gte: new Uint8Array([3]) }));
			expect(entries).to.have.length(3);
			expect(entries[0].key).to.deep.equal(new Uint8Array([3]));
		});

		it('supports gt bound', async () => {
			const entries = await collect(store.iterate({ gt: new Uint8Array([3]) }));
			expect(entries).to.have.length(2);
			expect(entries[0].key).to.deep.equal(new Uint8Array([4]));
		});

		it('supports lte bound', async () => {
			const entries = await collect(store.iterate({ lte: new Uint8Array([3]) }));
			expect(entries).to.have.length(3);
			expect(entries[2].key).to.deep.equal(new Uint8Array([3]));
		});

		it('supports lt bound', async () => {
			const entries = await collect(store.iterate({ lt: new Uint8Array([3]) }));
			expect(entries).to.have.length(2);
			expect(entries[1].key).to.deep.equal(new Uint8Array([2]));
		});

		it('supports limit', async () => {
			const entries = await collect(store.iterate({ limit: 2 }));
			expect(entries).to.have.length(2);
		});

		it('supports reverse', async () => {
			const entries = await collect(store.iterate({ reverse: true }));
			expect(entries).to.have.length(5);
			expect(entries[0].key).to.deep.equal(new Uint8Array([5]));
			expect(entries[4].key).to.deep.equal(new Uint8Array([1]));
		});

		it('supports combined gte + lt', async () => {
			const entries = await collect(store.iterate({
				gte: new Uint8Array([2]),
				lt: new Uint8Array([4]),
			}));
			expect(entries).to.have.length(2);
			expect(entries[0].key).to.deep.equal(new Uint8Array([2]));
			expect(entries[1].key).to.deep.equal(new Uint8Array([3]));
		});

		it('returns empty when range has no matches', async () => {
			const entries = await collect(store.iterate({
				gte: new Uint8Array([10]),
			}));
			expect(entries).to.have.length(0);
		});

		it('supports reverse with bounds', async () => {
			const entries = await collect(store.iterate({
				gte: new Uint8Array([2]),
				lte: new Uint8Array([4]),
				reverse: true,
			}));
			expect(entries).to.have.length(3);
			expect(entries[0].key).to.deep.equal(new Uint8Array([4]));
			expect(entries[2].key).to.deep.equal(new Uint8Array([2]));
		});

		it('supports reverse with exclusive bounds (gt + lt)', async () => {
			const entries = await collect(store.iterate({
				gt: new Uint8Array([1]),
				lt: new Uint8Array([5]),
				reverse: true,
			}));
			expect(entries).to.have.length(3);
			expect(entries[0].key).to.deep.equal(new Uint8Array([4]));
			expect(entries[2].key).to.deep.equal(new Uint8Array([2]));
		});

		it('supports reverse with limit', async () => {
			const entries = await collect(store.iterate({
				reverse: true,
				limit: 2,
			}));
			expect(entries).to.have.length(2);
			expect(entries[0].key).to.deep.equal(new Uint8Array([5]));
			expect(entries[1].key).to.deep.equal(new Uint8Array([4]));
		});
	});

	describe('batch', () => {
		it('batch put writes on write()', async () => {
			const b = store.batch();
			b.put(new Uint8Array([1]), new Uint8Array([10]));
			b.put(new Uint8Array([2]), new Uint8Array([20]));
			expect(await store.has(new Uint8Array([1]))).to.be.false; // not yet written
			await b.write();
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('batch delete removes keys on write()', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			const b = store.batch();
			b.delete(new Uint8Array([1]));
			expect(await store.has(new Uint8Array([1]))).to.be.true; // not yet deleted
			await b.write();
			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});

		it('batch clear discards pending ops', async () => {
			const b = store.batch();
			b.put(new Uint8Array([1]), new Uint8Array([10]));
			b.clear();
			await b.write();
			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});
	});

	describe('close', () => {
		it('throws on get after close', async () => {
			await store.close();
			try {
				await store.get(new Uint8Array([1]));
				expect.fail('should have thrown');
			} catch (e: any) {
				expect(e.message).to.match(/closed/i);
			}
		});

		it('throws on put after close', async () => {
			await store.close();
			try {
				await store.put(new Uint8Array([1]), new Uint8Array([2]));
				expect.fail('should have thrown');
			} catch (e: any) {
				expect(e.message).to.match(/closed/i);
			}
		});
	});

	describe('approximateCount', () => {
		it('returns total count without options', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			expect(await store.approximateCount()).to.equal(2);
		});

		it('returns count within range', async () => {
			for (let i = 1; i <= 5; i++) {
				await store.put(new Uint8Array([i]), new Uint8Array([i * 10]));
			}
			expect(await store.approximateCount({ gte: new Uint8Array([2]), lt: new Uint8Array([4]) })).to.equal(2);
		});
	});

	describe('clear / size', () => {
		it('clear removes all data', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			store.clear();
			expect(store.size).to.equal(0);
			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});

		it('size reflects current entry count', async () => {
			expect(store.size).to.equal(0);
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			expect(store.size).to.equal(1);
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			expect(store.size).to.equal(2);
			await store.delete(new Uint8Array([1]));
			expect(store.size).to.equal(1);
		});
	});
});

