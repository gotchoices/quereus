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
 *     ├─ src DML       → DataChangeEvent ─┐  (one commit group at the engine
 *     │                                   │   boundary; recorded LOCAL under one HLC)
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
 *                                         │          → no DataChangeEvent → empty commit group → records NOTHING
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
import { DEFAULT_SYNC_CONFIG, type ApplyResult, type ColumnChange } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { deterministicTxnId } from '../../src/clock/hlc.js';

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

/**
 * Local-change capture is anchored to the engine transaction boundary and runs
 * fire-and-forget *after* the commit (the `onTransactionCommit` listener cannot
 * await the async metadata write). In production the sync loop is driven by the
 * post-capture `onLocalChange` event, so there is no race; this manual-relay
 * harness reads the change log directly, so it must let the capture settle
 * before reading. (A generous in-memory delay; the handler completes in
 * microtasks.)
 */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 25));

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
 * Build the peer WIRING — provider, store event emitter, Database, StoreModule,
 * store adapter, and SyncManager — and stop **before** any `create table`. Both
 * `makePeer` (empty-source schema) and `makeFilledPeer` (source seeded before the
 * tagged MV is created) layer their schema on top of this one shared core, so the
 * cold-fill grouping fixtures and the echo-loop fixtures share a single wiring
 * definition rather than duplicating it.
 */
async function makeBarePeer(name: string): Promise<Peer> {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const applyToStore = createStoreAdapter({ db, storeModule, events });
	// Local-change capture is sourced from the engine transaction boundary: each
	// committed local transaction (the src DML and its tagged-MV derivation) is
	// grouped and recorded under one HLC.
	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		db,
		{ ...DEFAULT_SYNC_CONFIG },
		new SyncEventEmitterImpl(),
		applyToStore,
		(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
	);

	return { name, db, provider, events, storeModule, manager };
}

/**
 * Build a peer with identical schema: a synced `src` base table and a tagged
 * 1:1 projection MV (`quereus.sync.replicate = true`). The MV is a clean
 * keyed passthrough — no key coarsening — so re-derivation at any peer is a pure
 * byte-identical function of the source row (the determinism contract).
 *
 * The MV is created over an EMPTY `src`, so its create-fill emits nothing; this
 * peer only exercises subsequent row-time maintenance. Schema is created directly
 * on each peer (not schema-synced): this pins data echo, not DDL propagation.
 */
async function makePeer(name: string): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text) using store');
	await peer.db.exec(
		'create materialized view mv using store as select id, v from src '
		+ 'with tags ("quereus.sync.replicate" = true)',
	);

	return peer;
}

/**
 * Build a peer whose `src` is POPULATED before the tagged MV is created, so the
 * MV's create-fill is **non-empty** — the headline migration scenario (turn on
 * replication for an MV over a source that already holds rows).
 *
 * Sequence is load-bearing: create `src` → seed it in ONE multi-row insert (one
 * engine transaction → one src ChangeSet, keeping the "seed is its own group"
 * sanity assertion clean) → THEN create the tagged MV. Because the MV is created
 * after the seed, `materializeView` → `host.replaceContents` diffs the cold rows
 * against an empty before-image and queues one insert per row; the create runs
 * under `db._ensureTransaction()`, so the store emitter batches the deltas and
 * flushes them as one grouped change-set under a single HLC at the engine commit.
 */
async function makeFilledPeer(
	name: string,
	seedRows: ReadonlyArray<{ id: number; v: string }>,
): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text) using store');
	// One multi-row insert → ONE src transaction. N single-row inserts would be N
	// src ChangeSets and muddy the "the seed is its own group" sanity check.
	const values = seedRows.map(r => `(${r.id}, '${r.v}')`).join(', ');
	await peer.db.exec(`insert into src values ${values}`);
	// MV created AFTER the seed → create-fill sees the seeded rows as cold inserts.
	await peer.db.exec(
		'create materialized view mv using store as select id, v from src '
		+ 'with tags ("quereus.sync.replicate" = true)',
	);

	return peer;
}

async function closePeer(peer: Peer): Promise<void> {
	await peer.db.close();
	await peer.provider.closeAll();
}

/**
 * Apply one local SQL write and let its transaction-boundary capture settle, so
 * the peer's change log reflects the write before any subsequent relay/read.
 */
async function localWrite(peer: Peer, sql: string): Promise<void> {
	await peer.db.exec(sql);
	await settle();
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
	await settle(); // flush `from`'s pending local capture before reading its log
	const sets = await from.manager.getChangesSince(to.manager.getSiteId());
	const dataOnly = sets.map(cs => ({ ...cs, schemaMigrations: [] }));
	const res = await to.manager.applyChanges(dataOnly);
	await settle(); // flush `to`'s re-derivation capture from the apply
	await to.manager.updatePeerSyncState(from.manager.getSiteId(), from.manager.getCurrentHLC());
	return res;
}

/** Flatten a peer's relayable change log for a given peer-id exclusion. */
async function changesFor(peer: Peer, excludeSiteId: Uint8Array): Promise<readonly unknown[]> {
	await settle(); // flush any pending local capture before reading the log
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
		await localWrite(A, "insert into src values (1, 'x')");

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

		await localWrite(A, "insert into src values (1, 'x')");

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
		await localWrite(A, "insert into src values (1, 'x')");
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
		await localWrite(A, "insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental UPDATE: re-derives the mv row on A (local) and logs it.
		await localWrite(A, "update src set v = 'y' where id = 1");
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
		await localWrite(A, "insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental DELETE: drops the mv row on A (local) and logs the tombstone.
		await localWrite(A, 'delete from src where id = 1');
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

/**
 * Cold-fill grouping: enabling replication on a materialized view built over a
 * source that ALREADY holds rows publishes the create-fill rows to a peer,
 * delivered as ONE grouped change-set under a single HLC (not N ungrouped
 * singletons) — the headline migration scenario (docs/migration.md § Synced vs.
 * local derived tables).
 *
 * Coverage gap this fills: the `replaceContents` replicating-arm UNIT suite drives
 * the host directly OUTSIDE any engine transaction, so it proves the *deltas* but
 * not the engine-transaction *grouping*; the echo-loop suite above builds its MV
 * over an EMPTY source, so create-fill emits nothing and only row-time maintenance
 * is exercised. This block asserts the create-fill's grouped publication
 * (producer side) and grouped, quiescent delivery (peer side) end to end.
 */
describe('create-fill of a populated source publishes one grouped change-set', () => {
	// N = 3 distinct rows so the per-row changes are distinguishable.
	const SEED: ReadonlyArray<{ id: number; v: string }> = [
		{ id: 1, v: 'a' },
		{ id: 2, v: 'b' },
		{ id: 3, v: 'c' },
	];
	const N = SEED.length;
	// Granularity is per-COLUMN, not per-row: `recordColumnVersions`
	// (sync-manager-impl.ts) emits one ColumnChange for every column where
	// `!oldRow || oldValue !== newValue`. A create-fill row is a FRESH insert (no
	// old row), so EVERY column is recorded — including the PK `id` — giving 2
	// ColumnChanges per cold row for the `mv(id, v)` schema (NOT 1). The cold-fill
	// change count is therefore `rows × columnsPerFreshInsert`. Written in terms of
	// the column count (not a flat "N") so a future multi-column MV doesn't silently
	// break the reasoning. (An UPDATE, by contrast, records only the differing
	// columns — see the steady-state tests in the suite above.)
	const COLUMNS_PER_FRESH_INSERT = 2; // id + v — PK included for a fresh insert

	let A: Peer; // producer: src seeded BEFORE the tagged MV → non-empty create-fill
	let B: Peer; // peer: MV over an empty src → its own create-fill emits nothing

	beforeEach(async () => {
		A = await makeFilledPeer('A', SEED);
		B = await makePeer('B');
		await settle(); // flush A's fire-and-forget create-fill capture before reading its log
	});

	afterEach(async () => {
		await closePeer(A);
		await closePeer(B);
	});

	it('A: the create-fill surfaces as exactly one ChangeSet (N changes, one transaction, one base HLC)', async () => {
		// Neutral peer id excludes nothing → A's complete relayable log.
		const sets = await A.manager.getChangesSince(generateSiteId());

		const mvSets = sets.filter(cs => cs.changes.some(c => c.table === 'mv'));
		// THE GROUPING CRUX: the create-fill is exactly ONE ChangeSet. N ungrouped
		// singletons (the regression this test exists to catch) would be N sets.
		expect(mvSets.length, 'create-fill is exactly one grouped ChangeSet').to.equal(1);

		const mvSet = mvSets[0];
		const mvChanges = mvSet.changes.filter(c => c.table === 'mv');

		// Non-empty guard: an accidental seed-AFTER-MV ordering regression would make
		// create-fill empty and the test vacuously green — go red instead.
		expect(mvChanges.length, 'create-fill is non-empty').to.be.greaterThan(0);
		// Granularity: one ColumnChange per cold row × column (PK included for a fresh insert).
		expect(mvChanges.length, 'one ColumnChange per cold row × column').to.equal(N * COLUMNS_PER_FRESH_INSERT);
		// Every change is a column write of one of the MV's columns.
		expect(
			mvChanges.every(c => c.type === 'column' && (c.column === 'id' || c.column === 'v')),
			'each mv change is a column write of id or v',
		).to.equal(true);
		// The non-PK column `v` is written once per cold row.
		expect(
			mvChanges.filter(c => c.type === 'column' && c.column === 'v').length,
			'one v-column write per cold row',
		).to.equal(N);

		// All mv changes belong to ONE transaction: each shares the set's
		// transactionId and the same base HLC (wallTime/counter/siteId equal; only
		// opSeq differs). They share `mvSet.hlc` by construction; assert the per-change
		// base matches it to make the "single HLC" claim explicit and regression-proof.
		for (const c of mvChanges) {
			expect(deterministicTxnId(c.hlc), 'mv change belongs to the set transaction').to.equal(mvSet.transactionId);
			expect(c.hlc.wallTime, 'same base wallTime').to.equal(mvSet.hlc.wallTime);
			expect(c.hlc.counter, 'same base counter').to.equal(mvSet.hlc.counter);
			expect(Array.from(c.hlc.siteId), 'same base siteId').to.deep.equal(Array.from(mvSet.hlc.siteId));
		}

		// The cold rows are distinguishable: one distinct `v` value per seeded row.
		const vValues = mvChanges
			.filter((c): c is ColumnChange => c.type === 'column' && c.column === 'v')
			.map(c => c.value)
			.sort();
		expect(vValues, 'distinct v value per cold row').to.deep.equal(['a', 'b', 'c']);

		// Sanity: the seed produced its OWN separate src ChangeSet — create-fill is its
		// own commit group, NOT fused into the seed's transaction.
		const srcSets = sets.filter(cs => cs.changes.some(c => c.table === 'src'));
		expect(srcSets.length, 'seed is exactly one src ChangeSet').to.equal(1);
		expect(
			srcSets[0].transactionId,
			'create-fill txn is distinct from the seed txn (not fused)',
		).to.not.equal(mvSet.transactionId);
	});

	it('A→B: the create-fill is delivered remotely as a grouped transaction, converges, and stays quiescent', async () => {
		// Subscribe BEFORE the relay so we can prove B's ingest applies the relayed mv
		// rows remote:true and fires NO local re-derivation (the suppression proof the
		// echo-loop suite uses for the row-time path — reused here for the cold path).
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Precondition: B's own create-fill is empty (B's src was empty when B's MV was
		// created), so B holds ZERO B-origin mv changes before the relay. Were a future
		// change to seed B too, B would publish its own fill and the convergence
		// deep-equal could mask divergence — pin it.
		const bBefore = await changesFor(B, A.manager.getSiteId());
		expect(
			bBefore.some(c => (c as { table: string }).table === 'mv'),
			'B has no B-origin mv change before the relay',
		).to.equal(false);

		const res = await relay(A, B);
		expect(res.applied, "B applied A's relayed create-fill").to.be.greaterThan(0);

		// Convergence: B's mv equals the seeded rows AND equals A's mv; likewise src.
		const seededRows = SEED.map(r => ({ id: r.id, v: r.v }));
		expect(await collect(B.db, 'select id, v from mv order by id')).to.deep.equal(seededRows);
		expect(
			await collect(B.db, 'select id, v from mv order by id'),
			"B's mv deep-equals A's mv",
		).to.deep.equal(await collect(A.db, 'select id, v from mv order by id'));
		expect(await collect(B.db, 'select id, v from src order by id')).to.deep.equal(seededRows);

		// Delivery grouping + quiescence proof.
		//
		// NOTE on the grouping proof choice: `ApplyResult.transactions` counts the FULL
		// relayed ChangeSet array (the empty create-table-src set + the seed set + the
		// mv create-fill set), so it does NOT cleanly isolate "the mv fill = 1
		// transaction". The producer-side test above already pins the fill to exactly
		// one ChangeSet; here we use the remote-event proof the echo-loop suite uses:
		// every mv insert arrived remote:true (relayed, not re-derived), with NO local
		// mv event, and B logs zero B-origin echo.
		const remoteMvEvents = bEvents.filter(e => e.tableName === 'mv' && e.remote);
		expect(remoteMvEvents.length, 'B received the mv create-fill as remote inserts').to.be.greaterThan(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv re-derivation on B (cold-fill suppressed)').to.have.length(0);
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo recorded (cold-fill quiescence)',
		).to.have.length(0);
	});

	it('A: refreshing the converged MV publishes nothing new (refresh wired, no double-publish)', async () => {
		// A's create-fill already published the cold rows (asserted above). A refresh
		// over the now-converged MV recomputes the IDENTICAL committed set → diffs to
		// zero deltas → emits nothing (replaceContents suppression). This proves the
		// refresh path is wired through the same grouped seam and does not re-publish.
		const before = await A.manager.getChangesSince(generateSiteId());
		const beforeMvChanges = before.flatMap(cs => cs.changes).filter(c => c.table === 'mv').length;
		expect(beforeMvChanges, 'create-fill present before the refresh').to.equal(N * COLUMNS_PER_FRESH_INSERT);

		const aEvents: DataChangeEvent[] = [];
		A.events.onDataChange(e => aEvents.push(e));

		await A.db.exec('refresh materialized view mv');
		await settle();

		// Direct suppression proof: zero mv data events fired during the refresh.
		const refreshMvEvents = aEvents.filter(e => e.tableName === 'mv');
		expect(refreshMvEvents, 'refresh emitted no mv data event (suppressed)').to.have.length(0);

		// And A's relayable log is unchanged: still exactly one mv ChangeSet with the
		// same change count — the refresh did not double-publish the fill.
		const after = await A.manager.getChangesSince(generateSiteId());
		const afterMvSets = after.filter(cs => cs.changes.some(c => c.table === 'mv'));
		expect(afterMvSets.length, 'still exactly one mv ChangeSet after refresh').to.equal(1);
		const afterMvChanges = after.flatMap(cs => cs.changes).filter(c => c.table === 'mv').length;
		expect(afterMvChanges, 'no new mv changes published by refresh').to.equal(beforeMvChanges);

		// DEFERRED — the non-empty refresh-grouping half (a refresh that diffs to >= 1
		// delta and groups it under one HLC) needs the committed MV to have DRIFTED from
		// its body WITHOUT row-time maintenance having applied it (the "stale table"
		// trigger in rebuildBacking's docstring, materialized-view-helpers.ts:1391).
		// That cannot be staged in this synced-MV harness without hacking internals, so
		// it is filed as backlog ticket `sync-refresh-stale-fill-grouped-changeset-test`.
		// The unit suite already covers refresh-path delta correctness; residual
		// grouping risk is low.
	});
});
