/**
 * Tests for TransactionCoordinator.
 */

import { expect } from 'chai';
import { TransactionCoordinator, type PendingStoreOps, type TransactionCallbacks } from '../src/common/transaction.js';
import { StoreEventEmitter, type DataChangeEvent } from '../src/common/events.js';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import type { AtomicBatch, KVStore } from '../src/common/kv-store.js';
import { bytesToHex, compareBytes } from '../src/common/bytes.js';

describe('TransactionCoordinator', () => {
	let store: InMemoryKVStore;
	let emitter: StoreEventEmitter;
	let coordinator: TransactionCoordinator;

	beforeEach(() => {
		store = new InMemoryKVStore();
		emitter = new StoreEventEmitter();
		coordinator = new TransactionCoordinator(store, emitter);
	});

	afterEach(async () => {
		await store.close();
	});

	describe('begin / isInTransaction', () => {
		it('starts not in transaction', () => {
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('enters transaction after begin', () => {
			coordinator.begin();
			expect(coordinator.isInTransaction()).to.be.true;
		});

		it('begin is idempotent when already in transaction', () => {
			coordinator.begin();
			coordinator.begin(); // no-op
			expect(coordinator.isInTransaction()).to.be.true;
		});
	});

	describe('put / delete outside transaction', () => {
		it('throws when put called outside transaction', () => {
			expect(() => coordinator.put(new Uint8Array([1]), new Uint8Array([2]))).to.throw(/outside transaction/i);
		});

		it('throws when delete called outside transaction', () => {
			expect(() => coordinator.delete(new Uint8Array([1]))).to.throw(/outside transaction/i);
		});
	});

	describe('commit', () => {
		it('writes pending operations to the store', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('fires pending events on commit', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(0);
			await coordinator.commit();
			expect(events).to.have.length(2);
		});

		it('commit when not in transaction is a no-op', async () => {
			await coordinator.commit(); // should not throw
		});

		it('notifies callbacks on commit', async () => {
			let committed = false;
			coordinator.registerCallbacks({ onCommit: () => { committed = true; }, onRollback: () => {} });
			coordinator.begin();
			await coordinator.commit();
			expect(committed).to.be.true;
		});
	});

	describe('rollback', () => {
		it('discards pending operations', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.rollback();

			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('discards pending events', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.rollback();
			expect(events).to.have.length(0);
		});

		it('rollback when not in transaction is a no-op', () => {
			coordinator.rollback(); // should not throw
		});

		it('notifies callbacks on rollback', () => {
			let rolledBack = false;
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => { rolledBack = true; } });
			coordinator.begin();
			coordinator.rollback();
			expect(rolledBack).to.be.true;
		});
	});

	describe('queueEvent outside transaction', () => {
		it('emits immediately when not in transaction', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(1);
		});
	});

	describe('savepoints', () => {
		it('creates and releases savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.releaseSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('rollback to savepoint discards ops after savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('rollback to savepoint also discards queued events', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.createSavepoint(0);
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(events).to.have.length(1);
			expect(events[0].type).to.equal('insert');
		});

		it('nested savepoints', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.createSavepoint(1);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]));
			coordinator.rollbackToSavepoint(1);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
		});

		it('rollbackToSavepoint with invalid depth warns and returns (no throw)', () => {
			coordinator.begin();
			// Out-of-range depth within an active transaction: warn-and-return, matching memory.
			expect(() => coordinator.rollbackToSavepoint(5)).to.not.throw();
		});
	});

	describe('savepoint ops after a commit clear', () => {
		it('rollbackToSavepoint after commit does not throw', async () => {
			// Simulate a store DDL-commit clearing the stack: begin → createSavepoint → commit.
			coordinator.begin();
			coordinator.createSavepoint(0);
			await coordinator.commit(); // clears savepointStack via clearTransaction()

			// Engine still broadcasts rollback-to at depth 0 — must not throw.
			expect(() => coordinator.rollbackToSavepoint(0)).to.not.throw();
		});

		it('releaseSavepoint after commit does not pad the stack', async () => {
			coordinator.begin();
			coordinator.createSavepoint(0);
			await coordinator.commit(); // stack cleared

			// releaseSavepoint(1) on an empty stack would pad with undefined → guard must fire.
			expect(() => coordinator.releaseSavepoint(1)).to.not.throw();

			// Follow-up savepoint round-trip on the same coordinator must still work correctly.
			coordinator.begin();
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(1);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.rollbackToSavepoint(1);
			await coordinator.commit();
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('in-transaction out-of-range rollbackToSavepoint also warns and returns', () => {
			// Depth uniformity: the guard fires regardless of whether the stack was
			// cleared by a commit or simply never reached that depth.
			coordinator.begin();
			coordinator.createSavepoint(0);
			expect(() => coordinator.rollbackToSavepoint(5)).to.not.throw();
		});
	});

	describe('getStore', () => {
		it('returns the underlying store', () => {
			expect(coordinator.getStore()).to.equal(store);
		});
	});

	describe('multi-store operations', () => {
		let indexStore: InMemoryKVStore;

		beforeEach(() => {
			indexStore = new InMemoryKVStore();
		});

		afterEach(async () => {
			await indexStore.close();
		});

		it('commit writes to both default and explicit stores', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await indexStore.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			// Ensure no cross-contamination
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([1]))).to.be.undefined;
		});

		it('rollback discards operations on all stores', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			coordinator.rollback();

			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('delete targets the explicit store', async () => {
			// Pre-populate the index store
			await indexStore.put(new Uint8Array([5]), new Uint8Array([50]));

			coordinator.begin();
			coordinator.delete(new Uint8Array([5]), indexStore);
			await coordinator.commit();

			expect(await indexStore.get(new Uint8Array([5]))).to.be.undefined;
		});

		it('savepoint rollback discards multi-store ops after savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]), indexStore);
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]));
			coordinator.put(new Uint8Array([4]), new Uint8Array([40]), indexStore);
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			// Before savepoint: committed
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await indexStore.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			// After savepoint: rolled back
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
			expect(await indexStore.get(new Uint8Array([4]))).to.be.undefined;
		});
	});

	describe('pending-op index (getPendingOpsForStore)', () => {
		/** A recorded op, mirroring what the coordinator buffers. */
		interface RefOp { type: 'put' | 'delete'; store?: KVStore; key: Uint8Array; value?: Uint8Array }

		/**
		 * Reference implementation replicating the legacy full-array-scan
		 * semantics of getPendingOpsForStore, for equivalence checking.
		 */
		function referenceView(ops: RefOp[], defaultStore: KVStore, target?: KVStore): PendingStoreOps {
			const t = target ?? defaultStore;
			const puts = new Map<string, { key: Uint8Array; value: Uint8Array }>();
			const deletes = new Set<string>();
			for (const op of ops) {
				const opStore = op.store ?? defaultStore;
				if (opStore !== t) continue;
				const hex = bytesToHex(op.key);
				if (op.type === 'put') {
					puts.set(hex, { key: op.key, value: op.value! });
					deletes.delete(hex);
				} else {
					deletes.add(hex);
					puts.delete(hex);
				}
			}
			return { puts, deletes };
		}

		function expectViewsEqual(actual: PendingStoreOps, expected: PendingStoreOps): void {
			expect([...actual.deletes].sort()).to.deep.equal([...expected.deletes].sort());
			const actualPuts = [...actual.puts.entries()]
				.map(([hex, p]) => [hex, bytesToHex(p.value)])
				.sort((a, b) => a[0].localeCompare(b[0]));
			const expectedPuts = [...expected.puts.entries()]
				.map(([hex, p]) => [hex, bytesToHex(p.value)])
				.sort((a, b) => a[0].localeCompare(b[0]));
			expect(actualPuts).to.deep.equal(expectedPuts);
		}

		/** Deterministic PRNG (mulberry32) so the property run is reproducible. */
		function mulberry32(seed: number): () => number {
			let a = seed >>> 0;
			return () => {
				a = (a + 0x6d2b79f5) >>> 0;
				let t = a;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		it('matches legacy array-scan semantics over random op sequences', () => {
			const rand = mulberry32(0xc0ffee);
			const idx1 = new InMemoryKVStore();
			const idx2 = new InMemoryKVStore();

			for (let round = 0; round < 50; round++) {
				const ops: RefOp[] = [];
				coordinator.begin();
				for (let i = 0; i < 40; i++) {
					const key = new Uint8Array([Math.floor(rand() * 8)]);
					const isPut = rand() < 0.6;
					// Address the default store as `undefined` or via its handle, plus
					// two explicit index stores — all four addressing forms in one log.
					const pick = rand();
					const target: KVStore | undefined =
						pick < 0.4 ? undefined : pick < 0.6 ? store : pick < 0.8 ? idx1 : idx2;
					if (isPut) {
						const value = new Uint8Array([Math.floor(rand() * 256)]);
						coordinator.put(key, value, target);
						ops.push({ type: 'put', store: target, key, value });
					} else {
						coordinator.delete(key, target);
						ops.push({ type: 'delete', store: target, key });
					}
				}

				for (const target of [undefined, store, idx1, idx2]) {
					expectViewsEqual(
						coordinator.getPendingOpsForStore(target),
						referenceView(ops, store, target),
					);
				}
				coordinator.rollback();
			}
		});

		it('last-write-wins: put then delete then put on the same key', () => {
			const key = new Uint8Array([7]);
			coordinator.begin();
			coordinator.put(key, new Uint8Array([1]));
			coordinator.delete(key);
			let view = coordinator.getPendingOpsForStore();
			expect(view.deletes.has(bytesToHex(key))).to.be.true;
			expect(view.puts.has(bytesToHex(key))).to.be.false;

			coordinator.put(key, new Uint8Array([2]));
			view = coordinator.getPendingOpsForStore();
			expect(view.deletes.has(bytesToHex(key))).to.be.false;
			expect(view.puts.get(bytesToHex(key))!.value).to.deep.equal(new Uint8Array([2]));
		});

		it('clears on commit and rollback', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			await coordinator.commit();
			expect(coordinator.getPendingOpsForStore().puts.size).to.equal(0);

			coordinator.begin();
			coordinator.delete(new Uint8Array([1]));
			coordinator.rollback();
			expect(coordinator.getPendingOpsForStore().deletes.size).to.equal(0);
		});

		it('rollback-to-savepoint rebuild equals a from-scratch replay', () => {
			const k1 = new Uint8Array([1]);
			const k2 = new Uint8Array([2]);
			coordinator.begin();
			coordinator.put(k1, new Uint8Array([10]));
			coordinator.delete(k2);
			coordinator.createSavepoint(0);
			coordinator.put(k1, new Uint8Array([99])); // overwrite
			coordinator.put(k2, new Uint8Array([20])); // un-deletes k2
			coordinator.rollbackToSavepoint(0);

			// State must equal the pre-savepoint log replayed from scratch.
			const view = coordinator.getPendingOpsForStore();
			expect(view.puts.get(bytesToHex(k1))!.value).to.deep.equal(new Uint8Array([10]));
			expect(view.puts.has(bytesToHex(k2))).to.be.false;
			expect(view.deletes.has(bytesToHex(k2))).to.be.true;

			// And the index must keep tracking ops queued after the rollback-to.
			coordinator.put(k2, new Uint8Array([21]));
			const after = coordinator.getPendingOpsForStore();
			expect(after.puts.get(bytesToHex(k2))!.value).to.deep.equal(new Uint8Array([21]));
			expect(after.deletes.has(bytesToHex(k2))).to.be.false;
		});

		it('savepoint rebuild restores per-store separation', () => {
			const idx = new InMemoryKVStore();
			const key = new Uint8Array([5]);
			coordinator.begin();
			coordinator.put(key, new Uint8Array([1]), idx);
			coordinator.createSavepoint(0);
			coordinator.put(key, new Uint8Array([2])); // default store, same key bytes
			coordinator.rollbackToSavepoint(0);

			expect(coordinator.getPendingOpsForStore().puts.size).to.equal(0);
			expect(coordinator.getPendingOpsForStore(idx).puts.get(bytesToHex(key))!.value)
				.to.deep.equal(new Uint8Array([1]));
		});
	});

	describe('getOrderedPendingOps', () => {
		it('returns puts sorted ascending by key bytes plus the delete set', () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([3, 1]), new Uint8Array([30]));
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2, 0xff]), new Uint8Array([20]));
			coordinator.delete(new Uint8Array([9]));

			const ordered = coordinator.getOrderedPendingOps();
			const keys = ordered.puts.map(p => Array.from(p.key));
			expect(keys).to.deep.equal([[1], [2, 0xff], [3, 1]]);
			for (let i = 1; i < ordered.puts.length; i++) {
				expect(compareBytes(ordered.puts[i - 1].key, ordered.puts[i].key)).to.be.lessThan(0);
			}
			expect(ordered.deletes.has(bytesToHex(new Uint8Array([9])))).to.be.true;
		});

		it('returns an empty view when there are no ops for the store', () => {
			coordinator.begin();
			const ordered = coordinator.getOrderedPendingOps();
			expect(ordered.puts).to.have.length(0);
			expect(ordered.deletes.size).to.equal(0);
		});

		it('addresses the default bucket via undefined or the resolved handle', () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			expect(coordinator.getOrderedPendingOps().puts).to.have.length(1);
			expect(coordinator.getOrderedPendingOps(store).puts).to.have.length(1);
		});

		it('returns a stable snapshot unaffected by later coordinator mutations', () => {
			// Merge scans hold the view across awaits where pipelined DML can queue
			// further ops — those must not bleed into an in-flight scan's view.
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.delete(new Uint8Array([2]));

			const view = coordinator.getOrderedPendingOps();
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]));
			coordinator.delete(new Uint8Array([4]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20])); // un-deletes 2

			expect(view.puts.map(p => Array.from(p.key))).to.deep.equal([[1]]);
			expect([...view.deletes]).to.deep.equal([bytesToHex(new Uint8Array([2]))]);
		});
	});

	describe('lazy default store', () => {
		it('constructs synchronously and resolves only at commit', async () => {
			let opened = 0;
			const target = new InMemoryKVStore();
			const lazy = new TransactionCoordinator(async () => { opened++; return target; });

			lazy.begin();
			lazy.put(new Uint8Array([1]), new Uint8Array([10]));
			expect(opened).to.equal(0);

			await lazy.commit();
			expect(opened).to.equal(1);
			expect(await target.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});

		it('never resolves the default when only explicit stores are written', async () => {
			let opened = 0;
			const idx = new InMemoryKVStore();
			const lazy = new TransactionCoordinator(async () => { opened++; return new InMemoryKVStore(); });

			lazy.begin();
			lazy.put(new Uint8Array([1]), new Uint8Array([10]), idx);
			await lazy.commit();

			expect(opened).to.equal(0);
			expect(await idx.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});

		it('resolves the thunk once across multiple commits', async () => {
			let opened = 0;
			const target = new InMemoryKVStore();
			const lazy = new TransactionCoordinator(async () => { opened++; return target; });

			for (let i = 0; i < 3; i++) {
				lazy.begin();
				lazy.put(new Uint8Array([i]), new Uint8Array([i * 10]));
				await lazy.commit();
			}
			expect(opened).to.equal(1);
		});

		it('getStore throws before resolution and returns the handle after', async () => {
			const target = new InMemoryKVStore();
			const lazy = new TransactionCoordinator(async () => target);
			expect(() => lazy.getStore()).to.throw(/not yet resolved/i);

			lazy.begin();
			lazy.put(new Uint8Array([1]), new Uint8Array([10]));
			await lazy.commit();
			expect(lazy.getStore()).to.equal(target);
		});

		it('folds an explicit handle into the default bucket once resolved', async () => {
			const target = new InMemoryKVStore();
			const lazy = new TransactionCoordinator(async () => target);

			// Resolve via a first commit.
			lazy.begin();
			lazy.put(new Uint8Array([0]), new Uint8Array([0]));
			await lazy.commit();

			// Now address the default store explicitly by handle: same bucket.
			lazy.begin();
			lazy.put(new Uint8Array([1]), new Uint8Array([10]), target);
			expect(lazy.getPendingOpsForStore().puts.size).to.equal(1);
			expect(lazy.getPendingOpsForStore(target).puts.size).to.equal(1);
			await lazy.commit();
			expect(await target.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});
	});

	describe('atomic batch path', () => {
		/**
		 * A shared-domain in-memory AtomicBatch factory with spies. `InMemoryKVStore`
		 * cannot crash, so "atomic" is modeled trivially (buffer ops keyed by store
		 * handle, apply on write); the spies let the coordinator's atomic-path
		 * routing be asserted deterministically.
		 */
		interface AtomicSpy {
			factory: () => AtomicBatch | undefined;
			beginCalls: number;
			writeCalls: number;
			/** When false, the factory yields undefined → coordinator falls back. */
			yieldBatch: boolean;
			/** When true, the produced batch's write() rejects. */
			failWrite: boolean;
			/** Every store handle passed to put/delete (to assert per-store folding). */
			storeHandles: KVStore[];
		}

		function makeAtomicSpy(): AtomicSpy {
			const spy: AtomicSpy = {
				factory: () => undefined,
				beginCalls: 0,
				writeCalls: 0,
				yieldBatch: true,
				failWrite: false,
				storeHandles: [],
			};
			spy.factory = () => {
				spy.beginCalls++;
				if (!spy.yieldBatch) return undefined;
				const ops: Array<{ type: 'put' | 'delete'; store: KVStore; key: Uint8Array; value?: Uint8Array }> = [];
				return {
					put(store, key, value) {
						spy.storeHandles.push(store);
						ops.push({ type: 'put', store, key, value });
					},
					delete(store, key) {
						spy.storeHandles.push(store);
						ops.push({ type: 'delete', store, key });
					},
					async write() {
						spy.writeCalls++;
						if (spy.failWrite) throw new Error('atomic write failed');
						for (const op of ops) {
							if (op.type === 'put') {
								await op.store.put(op.key, op.value!);
							} else {
								await op.store.delete(op.key);
							}
						}
						ops.length = 0;
					},
					clear() {
						ops.length = 0;
					},
				};
			};
			return spy;
		}

		/** Monkey-patch a store's batch() to count fallback-path invocations. */
		function spyBatch(target: InMemoryKVStore): () => number {
			const orig = target.batch.bind(target);
			let n = 0;
			target.batch = () => { n++; return orig(); };
			return () => n;
		}

		it('routes through the atomic batch when the factory yields one (data + index together)', async () => {
			const spy = makeAtomicSpy();
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const idxBatchCount = spyBatch(idx);
			const coord = new TransactionCoordinator(store, emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));        // default/data store
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);  // index store
			await coord.commit();

			// One atomic commit, no per-store batch() fallback.
			expect(spy.beginCalls).to.equal(1);
			expect(spy.writeCalls).to.equal(1);
			expect(dataBatchCount()).to.equal(0);
			expect(idxBatchCount()).to.equal(0);
			// Data + index landed together.
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('falls back to per-store batch() when the factory yields undefined', async () => {
			const spy = makeAtomicSpy();
			spy.yieldBatch = false;
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const idxBatchCount = spyBatch(idx);
			const coord = new TransactionCoordinator(store, emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			await coord.commit();

			expect(spy.beginCalls).to.equal(1);
			expect(spy.writeCalls).to.equal(0);
			expect(dataBatchCount()).to.equal(1);
			expect(idxBatchCount()).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('byte-identical fallback when no factory is supplied at all', async () => {
			// The capability-absent default: a coordinator with no factory must
			// behave exactly as before (per-store batch loop).
			const idx = new InMemoryKVStore();
			const dataBatchCount = spyBatch(store);
			const coord = new TransactionCoordinator(store, emitter);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			await coord.commit();

			expect(dataBatchCount()).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('a rejected atomic write propagates, clears state, and leaks no ops', async () => {
			const spy = makeAtomicSpy();
			spy.failWrite = true;
			const coord = new TransactionCoordinator(store, emitter, spy.factory);

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));

			let err: unknown;
			try { await coord.commit(); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.match(/atomic write failed/);
			// finally { clearTransaction() } still ran.
			expect(coord.isInTransaction()).to.be.false;
			// write() threw before applying — nothing landed.
			expect(await store.get(new Uint8Array([1]))).to.be.undefined;

			// No ops leak into the next transaction; a now-succeeding write commits clean.
			spy.failWrite = false;
			coord.begin();
			coord.put(new Uint8Array([2]), new Uint8Array([20]));
			await coord.commit();
			expect(await store.get(new Uint8Array([1]))).to.be.undefined; // not resurrected
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('fires pending events and commit callbacks on the atomic path', async () => {
			const spy = makeAtomicSpy();
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			let committed = false;
			const coord = new TransactionCoordinator(store, emitter, spy.factory);
			coord.registerCallbacks({ onCommit: () => { committed = true; }, onRollback: () => {} });

			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));
			coord.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			await coord.commit();

			expect(spy.writeCalls).to.equal(1);
			expect(events).to.have.length(1);
			expect(committed).to.be.true;
		});

		it('routes a default-only bucket through one atomic batch', async () => {
			const spy = makeAtomicSpy();
			const coord = new TransactionCoordinator(store, emitter, spy.factory);
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));
			await coord.commit();
			expect(spy.writeCalls).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
		});

		it('routes an index-only bucket without ever resolving the default store', async () => {
			const spy = makeAtomicSpy();
			const idx = new InMemoryKVStore();
			let opened = 0;
			const coord = new TransactionCoordinator(
				async () => { opened++; return new InMemoryKVStore(); },
				emitter,
				spy.factory,
			);
			coord.begin();
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			await coord.commit();
			expect(spy.writeCalls).to.equal(1);
			expect(opened).to.equal(0); // default bucket empty → never resolved
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			await idx.close();
		});

		it('folds default-addressed-by-handle ops into one store entry (no double-write)', async () => {
			const spy = makeAtomicSpy();
			// `store` is a concrete handle → resolvedStore === store from construction,
			// so an explicit `store` handle folds into the default (null) bucket.
			const coord = new TransactionCoordinator(store, emitter, spy.factory);
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));         // by omission
			coord.put(new Uint8Array([1]), new Uint8Array([99]), store);  // by handle, same key
			await coord.commit();

			expect(spy.writeCalls).to.equal(1);
			// Both ops addressed the single resolved default handle.
			expect(new Set(spy.storeHandles).size).to.equal(1);
			expect(spy.storeHandles[0]).to.equal(store);
			// Last-write-wins applied in order.
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([99]));
		});

		it('commit after rollback-to-savepoint writes exactly the surviving ops via the atomic batch', async () => {
			const spy = makeAtomicSpy();
			const idx = new InMemoryKVStore();
			const coord = new TransactionCoordinator(store, emitter, spy.factory);
			coord.begin();
			coord.put(new Uint8Array([1]), new Uint8Array([10]));
			coord.put(new Uint8Array([2]), new Uint8Array([20]), idx);
			coord.createSavepoint(0);
			coord.put(new Uint8Array([3]), new Uint8Array([30]));
			coord.put(new Uint8Array([4]), new Uint8Array([40]), idx);
			coord.rollbackToSavepoint(0);
			await coord.commit();

			expect(spy.writeCalls).to.equal(1);
			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await idx.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
			expect(await idx.get(new Uint8Array([4]))).to.be.undefined;
			await idx.close();
		});

		it('opens no atomic batch for an empty transaction', async () => {
			const spy = makeAtomicSpy();
			const coord = new TransactionCoordinator(store, emitter, spy.factory);
			coord.begin();
			await coord.commit();
			expect(spy.beginCalls).to.equal(0);
			expect(spy.writeCalls).to.equal(0);
		});
	});
});
