/**
 * Cardinality feedback, planner half: the observed row-count overlay's record/shift
 * policy (docs/progressive-optimizer.md §3.4), its precedence over the catalog at the
 * one base-table row-count seam (`plannedRowCount`, §3.3), and re-planning prepared
 * statements on a shift (§3.6).
 *
 * The policy tests construct their own `CardinalityFeedbackManager` over the database's
 * schema manager so they can watch `onShift` directly and vary the tuning per test.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CardinalityFeedbackManager, FeedbackReplanState } from '../../src/core/database-cardinality-feedback.js';
import { DEFAULT_TUNING, type OptimizerTuning } from '../../src/planner/optimizer-tuning.js';
import type { TableSchema } from '../../src/schema/table.js';

describe('Cardinality feedback overlay', () => {
	const joinSql = 'select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1';
	let db: Database;

	beforeEach(() => {
		db = new Database();
		// A background ANALYZE would swap schemas and void recorded entries mid-test.
		db.setOption('auto_analyze', false);
	});

	afterEach(async () => {
		await db.close();
	});

	function table(name: string): TableSchema {
		const found = db.schemaManager.findTable(name, 'main');
		if (!found) throw new Error(`table ${name} not found`);
		return found;
	}

	describe('record policy', () => {
		let tuning: OptimizerTuning;
		let shifts: string[];
		let overlay: CardinalityFeedbackManager;

		beforeEach(async () => {
			await db.exec('create table t (id integer primary key)');
			await db.exec('create table u (id integer primary key)');
			await db.exec('create table w (id integer primary key)');
			tuning = DEFAULT_TUNING;
			shifts = [];
			overlay = new CardinalityFeedbackManager({
				schemaManager: db.schemaManager,
				getTuning: () => tuning,
				getAutocommit: () => true,
				onShift: key => shifts.push(key),
			});
		});

		afterEach(() => {
			overlay.dispose();
		});

		it('records past the floor and shifts only on a 10x move from the baseline', () => {
			const t = table('t');

			// Both the 1000-row default and the observation are at the floor.
			overlay.record(t, 1000);
			expect(overlay.observedRows(t)).to.equal(undefined);

			// Baseline is the default (1000): 20x.
			overlay.record(t, 20_000);
			expect(overlay.observedRows(t)).to.equal(20_000);
			expect(shifts).to.deep.equal(['main.t']);

			// 2.5x from baseline 20,000: recorded silently.
			overlay.record(t, 50_000);
			expect(overlay.observedRows(t)).to.equal(50_000);
			expect(shifts).to.have.length(1);

			// 12.5x from baseline 20,000 (not from the previous 50,000).
			overlay.record(t, 250_000);
			expect(shifts).to.have.length(2);

			overlay.record(t, 0);
			expect(overlay.observedRows(t)).to.equal(0);
			expect(shifts).to.have.length(3);

			expect(overlay.snapshot()).to.deep.equal([{
				schemaName: 'main', tableName: 't', rows: 0, catalogRows: undefined,
				baselineRows: 0, observations: 4, shifts: 3,
			}]);
		});

		it('answers only for the schema object it observed, and ignores superseded ones', async () => {
			const original = table('t');
			overlay.record(original, 20_000);

			await db.exec('analyze t');
			const analyzed = table('t');
			expect(analyzed).to.not.equal(original);
			expect(overlay.observedRows(analyzed)).to.equal(undefined);

			overlay.record(original, 50_000);
			expect(overlay.observedRows(original)).to.equal(undefined);
			expect(overlay.snapshot()).to.deep.equal([]);
		});

		it('evicts the least-recently-used table past maxTables, without a shift', () => {
			tuning = { ...DEFAULT_TUNING, cardinalityFeedback: { ...DEFAULT_TUNING.cardinalityFeedback, maxTables: 2 } };
			overlay.record(table('t'), 20_000);
			overlay.record(table('u'), 20_000);
			overlay.observedRows(table('t'));
			shifts.length = 0;

			overlay.record(table('w'), 20_000);

			expect(overlay.observedRows(table('u'))).to.equal(undefined);
			expect(overlay.observedRows(table('t'))).to.equal(20_000);
			expect(overlay.observedRows(table('w'))).to.equal(20_000);
			expect(shifts).to.deep.equal(['main.w']);
		});
	});

	async function createJoinTables(): Promise<void> {
		await db.exec('create table big (id integer primary key, v integer, w integer)');
		await db.exec('create table mid (id integer primary key, big_id integer, x integer)');
	}

	describe('precedence', () => {
		function planNodeTypes(): Record<string, number> {
			const stmt = db.prepare(joinSql);
			try {
				return stmt.getPlanShape().nodeTypes;
			} finally {
				void stmt.finalize();
			}
		}

		it('an observed size reaches the plan: the join flips from hash to a primary-key seek', async () => {
			await createJoinTables();

			const unobserved = planNodeTypes();
			expect(unobserved).to.include.keys('HashJoin', 'IndexScan');
			expect(unobserved).to.not.have.property('IndexSeek');

			db._cardinalityFeedback.record(table('big'), 20_000);
			// The plan flip below is driven by the scan's estimate alone; this pins the
			// other reader of the seam, so an unwired provider cannot pass.
			expect(db.optimizer.getStats().tableRows(table('big'))).to.equal(20_000);

			const observed = planNodeTypes();
			expect(observed).to.include.keys('Join', 'IndexSeek');
			expect(observed).to.not.have.property('HashJoin');
		});
	});

	describe('re-planning prepared statements', () => {
		async function joinedWs(stmt: Statement): Promise<number[]> {
			const ws: number[] = [];
			for await (const row of stmt.all()) ws.push(row.w as number);
			return ws.sort((a, b) => a - b);
		}

		it('re-plans at the execution after the one whose scan shifted a table it reads', async () => {
			await db.exec('pragma cardinality_feedback = true');
			await createJoinTables();
			await db.exec('insert into big select value, value, value from generate_series(1, 20000)');
			await db.exec('insert into mid select value, (value * 7) % 20000 + 1, value % 5 from generate_series(1, 300)');

			const stmt = db.prepare(joinSql);
			try {
				expect(stmt.getPlanShape().nodeTypes).to.include.keys('HashJoin', 'IndexScan');
				const first = await joinedWs(stmt);
				expect(first).to.have.length(60);

				// The shift only marked the cached plan; it is dropped when the next run starts.
				expect(stmt.getPlanShape().nodeTypes).to.include.keys('HashJoin');
				expect(await joinedWs(stmt)).to.deep.equal(first);

				const replanned = stmt.getPlanShape().nodeTypes;
				expect(replanned).to.include.keys('Join', 'IndexSeek');
				expect(replanned).to.not.have.property('HashJoin');
			} finally {
				await stmt.finalize();
			}
		});

		it('paces re-plans: the first immediate, then 8, 16, ... executions apart, capped at 64x', () => {
			const cooldown = 8;
			const state = new FeedbackReplanState();
			/** Marks a shift right away and counts execution starts until one drops the plan. */
			function executionsToReplan(): number {
				state.markShift();
				let executions = 1;
				while (!state.onExecutionStart(cooldown)) executions++;
				return executions;
			}

			expect(state.onExecutionStart(cooldown), 'unmarked').to.equal(false);
			// Each mark arrives right after the previous re-plan and waits out the cooldown.
			expect(Array.from({ length: 9 }, executionsToReplan)).to.deep.equal([1, 8, 16, 32, 64, 128, 256, 512, 512]);

			// A mark arriving once the cooldown has already passed fires at once.
			for (let i = 0; i < 600; i++) expect(state.onExecutionStart(cooldown)).to.equal(false);
			expect(executionsToReplan()).to.equal(1);

			// Dropping the plan for another reason (schema change, rebind) consumes the mark.
			for (let i = 0; i < 600; i++) state.onExecutionStart(cooldown);
			state.markShift();
			state.onPlanDropped();
			expect(state.onExecutionStart(cooldown)).to.equal(false);
		});
	});
});
