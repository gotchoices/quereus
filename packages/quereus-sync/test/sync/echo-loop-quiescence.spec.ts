/**
 * Two-peer echo-loop quiescence integration test for the
 * `quereus.sync.replicate` change-log opt-in (docs/migration.md § Synced vs.
 * local derived tables).
 *
 * The load-bearing invariant: a replicated derivation write closes its own echo
 * loop — it does NOT ping-pong between synced peers.
 *
 *   Peer A                                  Peer B
 *   ──────                                  ──────
 *   insert into src (local DML)
 *     ├─ src DML       → DataChangeEvent ─┐  (ordinary store DML auto-emits;
 *     │                                   │   handleDataChange records it LOCAL)
 *     └─ mv maintenance (tag on)          │
 *           → derived DataChangeEvent ────┤  A.changeLog = { src change, mv change }
 *                                         │
 *           ── A.getChangesSince(B) ──────┼──► B.applyChanges(...) via createStoreAdapter:
 *                                         │     1. applyExternalRowChanges(src row)  → committed
 *                                         │     2. applyExternalRowChanges(mv  row)  → committed (A's derived row)
 *                                         │        (both emit module events remote:true → NOT re-logged)
 *                                         │     3. ONE db.ingestExternalRowChanges(batch):
 *                                         │          src change → MV maintenance re-derives mv row
 *                                         │          → reads mv's COMMITTED state (already has A's row)
 *                                         │          → value-identical → SUPPRESSED → no BackingRowChange
 *                                         │          → no DataChangeEvent → handleDataChange records NOTHING
 *                                         ▼
 *                                 B.changeLog has ZERO B-origin entries  ← quiescence
 *                                 B's `select * from mv` == A's          ← convergence
 *
 * Quiescence holds BY CONSTRUCTION of the store adapter: it applies every
 * batched table's rows to committed storage (steps 1 + 2) BEFORE the single
 * end-of-invocation `ingestExternalRowChanges` seam call (step 3). So by the
 * time B's seam re-derives the MV from the ingested source change, A's relayed
 * MV row is already committed in B's MV backing → the maintenance upsert is
 * value-identical → `mv-noop-upsert-suppression` fires → no event → no echo. If
 * a future change reordered the seam call before the per-table storage writes,
 * this test would go red — that is the regression it guards.
 *
 * Single-flavor by design: this exercises the bare `StoreModule` peer (as the
 * seam suite does). The echo invariant is module-agnostic, so the
 * IsolationModule(StoreModule) flavor (covered by the store-host unit suite)
 * adds nothing here.
 */

import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type DataChangeEvent,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type ApplyResult } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';

/** Per-store-key in-memory KV provider (copied from store-adapter-seam.spec.ts). */
function createInMemoryProvider(): { provider: KVStoreProvider; stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const provider: KVStoreProvider = {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
	return { provider, stores };
}

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

/** A self-contained sync peer: real Database + StoreModule + adapter + SyncManager. */
interface Peer {
	readonly name: string;
	readonly db: Database;
	readonly provider: KVStoreProvider;
	readonly events: StoreEventEmitter;
	readonly storeModule: StoreModule;
	readonly manager: SyncManagerImpl;
}

/**
 * Build a peer with identical schema: a synced `src` base table and a tagged
 * 1:1 projection MV (`quereus.sync.replicate = true`). The MV is a clean
 * keyed passthrough — no key coarsening — so re-derivation at any peer is a pure
 * byte-identical function of the source row (the determinism contract).
 *
 * Schema is created directly on each peer (not schema-synced): this pins data
 * echo, not DDL propagation.
 */
async function makePeer(name: string): Promise<Peer> {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const applyToStore = createStoreAdapter({ db, storeModule, events });
	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		events,
		{ ...DEFAULT_SYNC_CONFIG },
		new SyncEventEmitterImpl(),
		applyToStore,
		(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
	);

	await db.exec('create table src (id integer primary key, v text) using store');
	await db.exec(
		'create materialized view mv using store as select id, v from src '
		+ 'with tags ("quereus.sync.replicate" = true)',
	);

	return { name, db, provider, events, storeModule, manager };
}

async function closePeer(peer: Peer): Promise<void> {
	await peer.db.close();
	await peer.provider.closeAll();
}

/**
 * One-directional full DATA relay (real-db analogue of `performBidirectionalSync`):
 * `from`'s data changes excluding `to`-origin → `to`. Uses full sync (no
 * `sinceHLC`), so `getChangesSince(to.siteId)` returns every change `from` holds
 * that did not originate at `to` — exactly the set `to` should ingest.
 *
 * Schema migrations are stripped: each peer creates its schema directly via
 * `db.exec` (the ticket pins data echo, NOT DDL propagation — covered
 * elsewhere), but the SyncManager records each peer's local DDL as schema
 * migrations regardless. Relaying a peer's `create table`/`create materialized
 * view` DDL to the other (which already holds the table) errors "already
 * exists", so we sync only the data changes — modelling two peers that already
 * agree on schema.
 */
async function relay(from: Peer, to: Peer): Promise<ApplyResult> {
	const sets = await from.manager.getChangesSince(to.manager.getSiteId());
	const dataOnly = sets.map(cs => ({ ...cs, schemaMigrations: [] }));
	const res = await to.manager.applyChanges(dataOnly);
	await to.manager.updatePeerSyncState(from.manager.getSiteId(), from.manager.getCurrentHLC());
	return res;
}

/** Flatten a peer's relayable change log for a given peer-id exclusion. */
async function changesFor(peer: Peer, excludeSiteId: Uint8Array): Promise<readonly unknown[]> {
	const sets = await peer.manager.getChangesSince(excludeSiteId);
	return sets.flatMap(cs => cs.changes);
}

describe('echo-loop quiescence across two synced peers', () => {
	let A: Peer;
	let B: Peer;

	beforeEach(async () => {
		A = await makePeer('A');
		B = await makePeer('B');
	});

	afterEach(async () => {
		await closePeer(A);
		await closePeer(B);
	});

	it('A→B: a replicated derivation converges on B and closes its own echo loop', async () => {
		// Subscribe BEFORE the relay so we can prove B's ingest fires no LOCAL mv event.
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// (1) Incremental source write on A. The src DML emits a local event AND the
		// tagged MV's row-time maintenance emits a local derived event → A logs both.
		await A.db.exec("insert into src values (1, 'x')");

		// Sanity: A's change log carries BOTH a src and an mv change. A fresh/neutral
		// peer id excludes nothing, so this is A's complete relayable log.
		const aLog = await changesFor(A, generateSiteId());
		const aTables = new Set(aLog.map(c => (c as { table: string }).table));
		expect(aTables.has('src'), 'A logged the source change').to.equal(true);
		expect(aTables.has('mv'), 'A logged the derived mv change').to.equal(true);

		// (2) Relay A→B: A's src + mv changes ingest.
		const res = await relay(A, B);
		expect(res.applied, "B applied A's relayed changes").to.be.greaterThan(0);

		// (3) Convergence: B's src and mv equal A's.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([{ id: 1, v: 'x' }]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
		expect(
			await collect(B.db, 'select id, v from mv'),
			"B's mv deep-equals A's mv",
		).to.deep.equal(await collect(A.db, 'select id, v from mv'));

		// (4) Quiescence (the headline): B logged ZERO B-origin entries. Passing A's
		// site id excludes the relayed A-origin changes (commitChangeMetadata records
		// them under the ORIGIN's HLC), so what remains would be B's own echo — and
		// there is none, because B's re-derivation of the source change was
		// value-identical to A's already-committed relayed mv row → suppressed.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo recorded (quiescence)',
		).to.have.length(0);

		// (4b) Stronger form: during B's ingest, the only mv event was the relayed
		// row applied with remote:true. The seam re-derivation produced NO local
		// (non-remote) mv event — the direct proof that suppression fired.
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during ingest (suppressed re-derivation)').to.have.length(0);
	});

	it('negative control: relaying ONLY the source change makes B re-derive locally (proves suppression is real, not absence of maintenance)', async () => {
		// The quiescence assertions above prove a NEGATIVE — no local mv event. That
		// proof is only meaningful if B's seam re-derivation actually FIRES (and is
		// then suppressed). Were store-backed MV maintenance ever to stop running on
		// external ingest, every quiescence test would still pass green while silently
		// becoming vacuous. This control pins the machinery live: relay ONLY A's src
		// change (drop the relayed mv row), so B has nothing pre-committed to match —
		// its re-derivation MUST write the mv row and emit a LOCAL event, recording a
		// B-origin echo. That echo is exactly the ping-pong the full-relay tests prove
		// is suppressed.
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		await A.db.exec("insert into src values (1, 'x')");

		const sets = await A.manager.getChangesSince(B.manager.getSiteId());
		const srcOnly = sets.map(cs => ({
			...cs,
			schemaMigrations: [],
			changes: cs.changes.filter(c => (c as { table: string }).table === 'src'),
		}));
		await B.manager.applyChanges(srcOnly);

		// B re-derived the mv row from src alone → it converges...
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
		// ...and the un-suppressed re-derivation fired a LOCAL (non-remote) mv event,
		// which the sync layer logged as a B-origin echo.
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents.length, 'B re-derived mv locally from src alone').to.be.greaterThan(0);
		const bEcho = await changesFor(B, A.manager.getSiteId());
		expect(
			bEcho.some(c => (c as { table: string }).table === 'mv'),
			'B logged a B-origin mv echo (the ping-pong the quiescence tests prove is suppressed)',
		).to.equal(true);
	});

	it('B→A round-trip: the reverse relay carries nothing and adds no spurious change on A', async () => {
		await A.db.exec("insert into src values (1, 'x')");
		await relay(A, B); // B converged + quiescent (asserted above).

		// A's complete change log before the reverse relay (neutral id excludes nothing).
		const neutral = generateSiteId();
		const aBefore = (await changesFor(A, neutral)).length;

		// Reverse relay: B has no B-origin changes, so the payload is empty and
		// applyChanges tolerates the empty set (no throw, applied === 0).
		const res = await relay(B, A);
		expect(res.applied, 'empty reverse relay applies nothing').to.equal(0);

		// A gained no spurious local change, and its mv is unchanged.
		//
		// NOTE: we compare A's FULL log before/after (neutral exclusion) rather than
		// the ticket's literal `A.getChangesSince(B.siteId)`-flattens-to-0: that
		// exclusion drops B-origin changes, NOT A's own legitimate src+mv entries, so
		// it is non-zero by construction and cannot detect a spurious change. The
		// before/after-count invariant is the faithful "A gained nothing" assertion.
		const aAfter = (await changesFor(A, neutral)).length;
		expect(aAfter, "A's change log unchanged by the empty relay").to.equal(aBefore);
		expect(await collect(A.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
	});

	it('a follow-up UPDATE on the source stays quiescent across the loop (steady state)', async () => {
		await A.db.exec("insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental UPDATE: re-derives the mv row on A (local) and logs it.
		await A.db.exec("update src set v = 'y' where id = 1");
		await relay(A, B);

		// Convergence at the new value.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([{ id: 1, v: 'y' }]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'y' }]);

		// Quiescence holds across the update too — no B-origin echo, no local mv event.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo after the update',
		).to.have.length(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during the update ingest').to.have.length(0);
	});

	it('a DELETE on the source derives an MV tombstone and stays quiescent (tombstone path)', async () => {
		await A.db.exec("insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental DELETE: drops the mv row on A (local) and logs the tombstone.
		await A.db.exec('delete from src where id = 1');
		await relay(A, B);

		// Convergence: both src and mv are empty on B.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([]);

		// Quiescence: B's re-derivation of the deleted source row resolves to an
		// already-absent mv row → value-identical (both absent) → suppressed. No
		// B-origin echo, no local mv event during the delete ingest.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo after the delete',
		).to.have.length(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during the delete ingest').to.have.length(0);
	});
});
