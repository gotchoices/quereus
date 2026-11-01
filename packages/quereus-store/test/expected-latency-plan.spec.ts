/**
 * A provider-declared latency (`KVStoreProvider.costProfile.firstRowLatencyMs` and
 * `.perRowLatencyMs`) has to reach the query planner.
 *
 * The engine reads a module's latency off `VirtualTableModule.costProfile`. `StoreModule`
 * surfaces its provider's resolved profile there, so a provider over a network-backed
 * key-value store — exactly the case the planner's latency machinery exists for — can tell
 * the planner it is slow to answer.
 *
 * Two properties are pinned here:
 *
 *  1. **A provider that declares nothing resolves to `0`,** which is observably identical to
 *     omitting the hint. Every other spec in this package runs on such a provider, so drift
 *     here would be a silent re-baseline rather than a finding.
 *  2. **A declared value reaches an actual PLANNER DECISION,** not merely the module field:
 *     the join below becomes the batched one-branch fan-out when the provider declares 30 ms
 *     and stays the serial index-nested-loop when it declares nothing. Asserting both
 *     directions is what makes this a regression guard rather than a snapshot.
 *
 * How a malformed declaration resolves is the engine's rule (`resolveModuleCostProfile`,
 * pinned in the engine's `test/vtab/cost-profile.spec.ts`), not this package's.
 *
 * The 30 ms is frankly synthetic: the in-tree backends declare only in-process presets, far
 * below it (see the store README, § Backend cost profile). It is chosen to clear the planner's latency gates, all of
 * which sit at 25 ms — `tuning.parallel.batchedOuterThresholdMs` and neighbours. Fixing a
 * real backend's number is a separate question this test deliberately does not depend on.
 *
 * Plan shape is read through the package's public `serializePlanTree`, because the node
 * classes themselves (`FanOutLookupJoinNode`, `EagerPrefetchNode`) are engine-internal and
 * not exported — so an `instanceof` assertion like the engine's own
 * `test/optimizer/index-nested-loop-batched.spec.ts` uses is not available from here.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, serializePlanTree } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule, type KVStoreProvider } from '../src/index.js';
import { createInMemoryProvider } from '../src/testing/index.js';

/** Above every 25 ms latency gate in `optimizer-tuning.ts`, and nothing more than that. */
const HIGH_LATENCY_MS = 30;

/**
 * An in-memory provider whose cost profile declares a first-row latency (and optionally a
 * per-row one), or no `costProfile` at all when `firstRowLatencyMs` is omitted — the shape
 * a pre-profile third-party provider has, and the one `resolveCostProfile` routes down its
 * parity path.
 */
function providerDeclaring(firstRowLatencyMs?: number, perRowLatencyMs?: number): KVStoreProvider {
	if (firstRowLatencyMs === undefined) return createInMemoryProvider();
	const costProfile = perRowLatencyMs === undefined
		? { firstRowLatencyMs }
		: { firstRowLatencyMs, perRowLatencyMs };
	return createInMemoryProvider({ costProfile });
}

/** One node of the tree `serializePlanTree` emits — only the fields these assertions read. */
interface PlanNodeInfo {
	readonly id: string;
	readonly nodeType: string;
	readonly properties: Record<string, unknown>;
	readonly children: PlanNodeInfo[];
	readonly relations: PlanNodeInfo[];
}

/**
 * Every DISTINCT node of `sql`'s optimized plan whose type is `nodeType`.
 *
 * Deduped by `id`: `serializePlanTree` lists a relational child under BOTH `children` and
 * `relations`, so a naive walk reports one fan-out several times over.
 */
function nodesOfType(db: Database, sql: string, nodeType: string): PlanNodeInfo[] {
	const root = JSON.parse(serializePlanTree(db.getPlan(sql))) as PlanNodeInfo;
	const found = new Map<string, PlanNodeInfo>();
	const seen = new Set<string>();
	const walk = (n: PlanNodeInfo): void => {
		if (seen.has(n.id)) return;
		seen.add(n.id);
		if (n.nodeType === nodeType) found.set(n.id, n);
		for (const c of [...(n.children ?? []), ...(n.relations ?? [])]) walk(c);
	};
	walk(root);
	return [...found.values()];
}

describe('provider-declared first-row latency', () => {
	describe('resolution', () => {
		it('takes a declared value through to the module', () => {
			expect(new StoreModule(providerDeclaring(HIGH_LATENCY_MS)).costProfile.firstRowLatencyMs).to.equal(HIGH_LATENCY_MS);
		});

		it('resolves an undeclared provider to 0', () => {
			expect(new StoreModule(providerDeclaring()).costProfile.firstRowLatencyMs).to.equal(0);
		});
	});

	describe('reaching the planner', () => {
		/** Every database `planJoinOver` opened this test, closed by the hook below. */
		const opened: Database[] = [];

		/**
		 * Outer `s` (4 rows, one NULL key, one key matching nothing) on the memory module,
		 * joined to a `StoreModule` inner over `provider`. Mirrors the fixture in the
		 * engine's `test/optimizer/index-nested-loop-batched.spec.ts`, including its
		 * `batchedOuterMinRows: 0` — a four-row synthetic outer clears nothing at the 256-row
		 * default, and the cardinality gate is not what this file is testing.
		 *
		 * NOTE: lowering that gate is not a shortcut around an untested claim — a fixture big
		 * enough to satisfy it plans a HASH JOIN, not a fan-out. Measured: this same fixture
		 * with a 300-row outer and the shipped tuning untouched plans `HashJoin` over an
		 * `IndexScan`. That is the cost model working as documented, not the wiring failing:
		 * under a 30 ms declaration the seek plan only overtakes hash join once the INNER
		 * table is enormous (`docs/optimizer-joins.md` puts the break-even near 128k inner
		 * rows at 25 ms and a 20k-row outer), and building an inner table that size is not a
		 * unit test. So the latency-vs-no-latency contrast below is the tractable way to pin
		 * the wiring; the shape's behavior at production cardinalities belongs to the
		 * engine's own join specs.
		 */
		async function planJoinOver(provider: KVStoreProvider): Promise<Database> {
			const db = new Database();
			opened.push(db);
			db.registerModule('store', new StoreModule(provider));
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, batchedOuterMinRows: 0 },
			});
			await db.exec('create table s (id integer primary key, k integer null)');
			await db.exec('insert into s values (1, 5), (2, 7), (3, 999), (4, null)');
			await db.exec('create table big (id integer primary key, w integer) using store');
			const rows: string[] = [];
			for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i % 10})`);
			await db.exec(`insert into big values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			return db;
		}

		const SQL = 'select s.id, big.w from s join big on big.id = s.k order by s.id';

		afterEach(async () => {
			for (const db of opened.splice(0)) await db.close();
		});

		it('plans the join as a batched fan-out when the provider declares 30 ms', async () => {
			const db = await planJoinOver(providerDeclaring(HIGH_LATENCY_MS));
			const fanouts = nodesOfType(db, SQL, 'FanOutLookupJoin');
			expect(fanouts, 'exactly one fan-out').to.have.lengthOf(1);
			expect(fanouts[0].properties.outerMode).to.equal('batched');
			expect(nodesOfType(db, SQL, 'EagerPrefetch'), 'batched implies a prefetched outer').to.have.lengthOf(1);
		});

		it('leaves the same join alone when the provider declares nothing', async () => {
			const db = await planJoinOver(providerDeclaring());
			expect(nodesOfType(db, SQL, 'FanOutLookupJoin'), 'no fan-out at zero latency').to.have.lengthOf(0);
			expect(nodesOfType(db, SQL, 'EagerPrefetch')).to.have.lengthOf(0);
		});

		/**
		 * The plan the declaration unlocks has to RUN, not merely form. A batched fan-out over
		 * a `StoreModule` drives concurrent seeks into an async coordinator whose module is
		 * `concurrencyMode: 'serial'` — a combination no engine-side spec reaches, since the
		 * engine's own batched-fan-out coverage runs against the memory module. Asserting both
		 * plans against the same literal is what makes the latency hint a plan-CHOICE knob
		 * rather than an answer-changing one.
		 */
		it('returns the same rows batched as it does serially', async () => {
			const batched = await planJoinOver(providerDeclaring(HIGH_LATENCY_MS));
			const serial = await planJoinOver(providerDeclaring());
			const expected = [{ id: 1, w: 5 }, { id: 2, w: 7 }];
			expect(await asyncIterableToArray(batched.eval(SQL)), 'batched fan-out').to.deep.equal(expected);
			expect(await asyncIterableToArray(serial.eval(SQL)), 'serial index-nested-loop').to.deep.equal(expected);
		});
	});

	/**
	 * The per-row hint (`costProfile.perRowLatencyMs`) takes the same path, through
	 * the isolation wrapper's forwarding getter. 50-row memory outer `po` against a 5,000-row
	 * isolated-store inner `pi`, keyed on `pi`'s primary key, at 30 ms first-row latency
	 * (30,000 units at `latencyCostPerMs` 1000; `po` is in-process, so its drain is 0):
	 *
	 *   first-row only:   hash  = 0.8×50 + 0.4×5,000 + 30 ms             =    32,040
	 *                     INL   = 50 × (1.0 + 0.5 + 0.3 + 30,000)         = 1,500,090  → hash
	 *   plus 1 ms/row:    hash  = 2,040 + (30 + 5,000×1) ms               = 5,032,040
	 *                     INL   = 50 × (1.8 + (30 + 1×1) × 1,000)         = 1,550,090  → INL
	 *
	 * Fifty seeks lose to one open on first-row latency alone; pricing the 5,000 rows hash
	 * drains is what hands the seek plan the win. The 50-row outer sits below the default
	 * `batchedOuterMinRows` (256), so no batched fan-out competes.
	 */
	describe('per-row latency reaching the planner', () => {
		const opened: Database[] = [];
		const SQL = 'select po.id, pi.v from po join pi on pi.id = po.k';

		async function planWith(rowLatencyMs?: number): Promise<Database> {
			const provider = providerDeclaring(HIGH_LATENCY_MS, rowLatencyMs);
			const db = new Database();
			opened.push(db);
			db.registerModule('store', createIsolatedStoreModule({ provider }));
			await db.exec('create table po (id integer primary key, k integer)');
			await db.exec('insert into po select value, value * 7 % 5000 + 1 from generate_series(1, 50)');
			await db.exec('create table pi (id integer primary key, v integer) using store');
			await db.exec('insert into pi select value, value from generate_series(1, 5000)');
			for await (const _ of db.eval('analyze')) { /* consume */ }
			return db;
		}

		afterEach(async () => {
			for (const db of opened.splice(0)) await db.close();
		});

		it('seeks with a declared per-row latency, hashes without one', async () => {
			// An index-nested-loop serializes as a `Join` whose inner is an `IndexSeek`.
			const perRow = await planWith(1);
			expect(nodesOfType(perRow, SQL, 'IndexSeek'), 'per-row latency → seek').to.have.lengthOf(1);
			expect(nodesOfType(perRow, SQL, 'HashJoin')).to.have.lengthOf(0);
			const firstRowOnly = await planWith();
			expect(nodesOfType(firstRowOnly, SQL, 'HashJoin'), 'first-row only → hash').to.have.lengthOf(1);
			expect(nodesOfType(firstRowOnly, SQL, 'IndexSeek')).to.have.lengthOf(0);
		});
	});
});
