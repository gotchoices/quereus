/**
 * Cardinality feedback, planner half: the observed row-count overlay's record/shift
 * policy (docs/progressive-optimizer.md §3.4), its precedence against module-reported
 * and catalog counts at the one base-table row-count seam (`plannedRowCount`, §3.3), the
 * rows-per-key override's precedence against catalog statistics (`plannedRowsPerKey`),
 * and re-planning prepared statements on a shift or a module-reported size drift (§3.6).
 *
 * The policy tests construct their own `CardinalityFeedbackManager` over the database's
 * schema manager so they can watch `onShift` directly and vary the tuning per test.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CardinalityFeedbackManager, FeedbackReplanState } from '../../src/core/database-cardinality-feedback.js';
import { DEFAULT_TUNING, type OptimizerTuning } from '../../src/planner/optimizer-tuning.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import { databaseRowCountSources, plannedRowsPerKey } from '../../src/planner/stats/table-cardinality.js';
import type { TableSchema } from '../../src/schema/table.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { ModuleRowCount } from '../../src/vtab/module.js';

/** A memory module whose planner row count is whatever the test last set. */
class ReportingMemoryModule extends MemoryTableModule {
	answer: ModuleRowCount | undefined;

	getRowCount(): ModuleRowCount | undefined {
		return this.answer;
	}
}

describe('Cardinality feedback overlay', () => {
	// Unfiltered on purpose: with both sides at the no-statistics default the hash join
	// wins, and only a learned size for `big` makes the primary-key seek cheaper.
	const joinSql = 'select m.x, b.w from mid m join big b on b.id = m.big_id';
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

	/** The emit-time spec of a seek on `columns`, planned at `plannedRowsPerKey` rows per key. */
	function spec(columns: number[], plannedRowsPerKey = 2000) {
		return { columns, key: columns.join(','), plannedRowsPerKey };
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
				reportedRows: () => undefined,
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
			expect(overlay.observedRows(t)?.rows).to.equal(undefined);

			// Baseline is the default (1000): 20x.
			overlay.record(t, 20_000);
			expect(overlay.observedRows(t)?.rows).to.equal(20_000);
			expect(shifts).to.deep.equal(['main.t']);

			// 2.5x from baseline 20,000: recorded silently.
			overlay.record(t, 50_000);
			expect(overlay.observedRows(t)?.rows).to.equal(50_000);
			expect(shifts).to.have.length(1);

			// 12.5x from baseline 20,000 (not from the previous 50,000).
			overlay.record(t, 250_000);
			expect(shifts).to.have.length(2);

			overlay.record(t, 0);
			expect(overlay.observedRows(t)?.rows).to.equal(0);
			expect(shifts).to.have.length(3);

			expect(overlay.snapshot()).to.deep.equal([{
				schemaName: 'main', tableName: 't', rows: 0, atLeast: undefined, catalogRows: undefined,
				baselineRows: 0, observations: 4, shifts: 3, perKey: [],
			}]);
		});

		it('records a floor only above the current estimate, raising it until an exact count clears it', () => {
			const t = table('t');
			const stats = new CatalogStatsProvider(undefined, databaseRowCountSources(db, overlay));

			// Not above the 1000-row default the table plans at today.
			overlay.recordAtLeast(t, 1000);
			expect(overlay.snapshot()).to.deep.equal([]);

			// Raises the unknown table; 5x from the baseline (the default) is no shift.
			overlay.recordAtLeast(t, 5000);
			expect(stats.tableRows(t)).to.equal(5000);
			overlay.recordAtLeast(t, 3000);
			expect(stats.tableRows(t)).to.equal(5000);
			expect(shifts).to.deep.equal([]);

			// The newer, complete count supersedes the floor, even below it; a floor it covers is ignored.
			overlay.record(t, 4000);
			overlay.recordAtLeast(t, 4000);
			expect(stats.tableRows(t)).to.equal(4000);

			// 40x from the baseline: shifts, and raises the exact count it exceeds.
			overlay.recordAtLeast(t, 40_000);
			expect(stats.tableRows(t)).to.equal(40_000);
			expect(shifts).to.deep.equal(['main.t']);
			expect(overlay.snapshot()).to.deep.equal([{
				schemaName: 'main', tableName: 't', rows: 4000, atLeast: 40_000, catalogRows: undefined,
				baselineRows: 40_000, observations: 3, shifts: 1, perKey: [],
			}]);
		});

		it('answers only for the schema object it observed, and ignores superseded ones', async () => {
			const original = table('t');
			overlay.record(original, 20_000);

			await db.exec('analyze t');
			const analyzed = table('t');
			expect(analyzed).to.not.equal(original);
			expect(overlay.observedRows(analyzed)?.rows).to.equal(undefined);

			overlay.record(original, 50_000);
			expect(overlay.observedRows(original)?.rows).to.equal(undefined);
			expect(overlay.snapshot()).to.deep.equal([]);
		});

		function rowsPerKey(t: TableSchema) {
			return overlay.snapshot().find(entry => entry.tableName === t.name)?.perKey ?? [];
		}

		it('records rows per key only for a table planned above minRows, shifting on a 10x move of the mean from the planned baseline', () => {
			const t = table('t');

			// `t` plans at the 1000-row default: nothing is learned about its keys.
			overlay.recordRowsPerKey(t, spec([0]), 40, 10);
			expect(overlay.snapshot()).to.deep.equal([]);

			overlay.record(t, 20_000);
			shifts.length = 0;
			// 4 against the 2000 the plan priced the seek at: a shift, and the mean is the new baseline.
			overlay.recordRowsPerKey(t, spec([0]), 40, 10);
			expect(rowsPerKey(t)).to.deep.equal([
				{ keyColumns: ['id'], rowsPerKey: 4, samples: 10, baselineRowsPerKey: 4, shifts: 1 },
			]);
			expect(shifts).to.deep.equal(['main.t']);
			expect(overlay.snapshot()[0].observations).to.equal(2);
			expect(overlay.observedRowsPerKey(t, [0])).to.equal(4);

			// Mean 7 against baseline 4: within 10x, recorded silently.
			overlay.recordRowsPerKey(t, spec([0], 4), 100, 10);
			expect(rowsPerKey(t)[0]).to.include({ rowsPerKey: 7, baselineRowsPerKey: 4, shifts: 1 });
			expect(shifts).to.have.length(1);
			expect(overlay.observedRowsPerKey(t, [1]), 'another column set').to.equal(undefined);
		});

		it('tracks the exact running mean up to 32 samples, then weighs each sample 1/32, and a window-sized batch replaces it', () => {
			const t = table('t');
			overlay.record(t, 20_000);
			const mean = () => rowsPerKey(t)[0].rowsPerKey;

			overlay.recordRowsPerKey(t, spec([0]), 40, 10);
			overlay.recordRowsPerKey(t, spec([0]), 8, 1);
			expect(mean()).to.be.closeTo((4 * 10 + 8) / 11, 1e-12);

			// 21 more samples reach the window exactly: still the exact mean of all 32.
			overlay.recordRowsPerKey(t, spec([0]), 2100, 21);
			expect(mean()).to.be.closeTo((40 + 8 + 2100) / 32, 1e-12);
			expect(rowsPerKey(t)[0].samples).to.equal(32);

			// Past the window one sample weighs 1/32, whatever the count so far.
			overlay.recordRowsPerKey(t, spec([0]), 0, 1);
			expect(mean()).to.be.closeTo((2148 / 32) * (31 / 32), 1e-12);

			// A batch at least the window's size replaces the mean outright.
			overlay.recordRowsPerKey(t, spec([0]), 700, 100);
			expect(mean()).to.equal(7);
			expect(rowsPerKey(t)[0].samples).to.equal(133);
		});

		it('evicts the least recently recorded column set past maxKeySetsPerTable', async () => {
			await db.exec('create table keyed (id integer primary key, a integer, b integer, c integer, d integer)');
			tuning = { ...DEFAULT_TUNING, cardinalityFeedback: { ...DEFAULT_TUNING.cardinalityFeedback, maxKeySetsPerTable: 2 } };
			const keyed = table('keyed');
			overlay.record(keyed, 20_000);

			overlay.recordRowsPerKey(keyed, spec([1]), 10, 1);
			overlay.recordRowsPerKey(keyed, spec([2]), 20, 1);
			overlay.recordRowsPerKey(keyed, spec([3]), 30, 1);
			expect(rowsPerKey(keyed).map(entry => entry.keyColumns)).to.deep.equal([['b'], ['c']]);

			// A record refreshes recency: `b` survives and `c` goes.
			overlay.recordRowsPerKey(keyed, spec([2]), 20, 1);
			overlay.recordRowsPerKey(keyed, spec([1, 4]), 5, 1);
			expect(rowsPerKey(keyed).map(entry => entry.keyColumns)).to.deep.equal([['b'], ['a', 'd']]);
			expect(rowsPerKey(keyed)[0].samples).to.equal(2);
		});

		it('evicts the least-recently-used table past maxTables, without a shift', () => {
			tuning = { ...DEFAULT_TUNING, cardinalityFeedback: { ...DEFAULT_TUNING.cardinalityFeedback, maxTables: 2 } };
			overlay.record(table('t'), 20_000);
			overlay.record(table('u'), 20_000);
			overlay.observedRows(table('t'));
			shifts.length = 0;

			overlay.record(table('w'), 20_000);

			expect(overlay.observedRows(table('u'))?.rows).to.equal(undefined);
			expect(overlay.observedRows(table('t'))?.rows).to.equal(20_000);
			expect(overlay.observedRows(table('w'))?.rows).to.equal(20_000);
			expect(shifts).to.deep.equal(['main.w']);
		});
	});

	async function createJoinTables(): Promise<void> {
		await db.exec('create table big (id integer primary key, v integer, w integer)');
		await db.exec('create table mid (id integer primary key, big_id integer, x integer)');
	}

	// A non-unique index on a foreign key: without statistics the module prices a seek at
	// 10% of `child` per key, which with `child` known at 8,000 rows makes the index-nested-loop
	// candidate dearer than hashing the whole table; four rows per key makes it the winner.
	const parentChildSql = "select p.name, c.note from parent p join child c on c.parent_id = p.id where p.name = 'p7'";
	const CHILD_PARENT_ID = 1;

	async function createParentChild(): Promise<void> {
		await db.exec('create table parent (id integer primary key, name text)');
		await db.exec('create table child (id integer primary key, parent_id integer, note text)');
		await db.exec('create index child_parent on child (parent_id)');
	}

	describe('precedence', () => {
		function planNodeTypes(sql = joinSql): Record<string, number> {
			const stmt = db.prepare(sql);
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

		it('an observed rows per key reaches the seek and the join candidate unless the catalog covers the column set', async () => {
			await createParentChild();
			const overlay = db._cardinalityFeedback;
			overlay.record(table('child'), 8000);
			const unobserved = planNodeTypes(parentChildSql);
			expect(unobserved).to.include.keys('HashJoin');
			expect(unobserved).to.not.have.property('IndexSeek');

			overlay.recordRowsPerKey(table('child'), spec([CHILD_PARENT_ID], 800), 40, 10);
			expect(plannedRowsPerKey(table('child'), [CHILD_PARENT_ID], db._rowCountSources)).to.equal(4);
			const observed = planNodeTypes(parentChildSql);
			expect(observed).to.include.keys('Join', 'IndexSeek');
			expect(observed).to.not.have.property('HashJoin');

			// Statistics covering `parent_id`: the catalog wins even over an entry recorded
			// against the analyzed schema, and the module's statistics-backed estimate stands.
			await db.exec("insert into child select value, (value - 1) % 2000 + 1, 'n' || value from generate_series(1, 8000)");
			await db.exec('analyze child');
			overlay.recordRowsPerKey(table('child'), spec([CHILD_PARENT_ID], 800), 40, 10);
			expect(overlay.observedRowsPerKey(table('child'), [CHILD_PARENT_ID])).to.equal(4);
			expect(plannedRowsPerKey(table('child'), [CHILD_PARENT_ID], db._rowCountSources)).to.equal(undefined);

			// Statistics covering only some columns of a composite set (a column added since
			// the last ANALYZE): coverage fails wholesale and the observation answers, as both
			// modules' fallback does. The memory backend drops statistics on ALTER, so the
			// partly-covered schema is a by-value copy with one column's entry removed.
			const analyzed = table('child');
			const partial = new Map(analyzed.statistics!.columnStats);
			partial.delete('note');
			const partlyCovered: TableSchema = { ...analyzed, statistics: { ...analyzed.statistics!, columnStats: partial } };
			const note = analyzed.columns.findIndex(c => c.name === 'note');
			const sources = { ...db._rowCountSources, observedRowsPerKey: () => 2.4 };
			expect(plannedRowsPerKey(partlyCovered, [CHILD_PARENT_ID, note], sources)).to.equal(2);
			expect(plannedRowsPerKey(partlyCovered, [CHILD_PARENT_ID], sources)).to.equal(undefined);
		});

		it('ranks exact module count, observed, approximate module count, catalog, then default', async () => {
			const module = new ReportingMemoryModule();
			db.registerModule('reporting', module);
			await db.exec('create table s (id integer primary key) using reporting');
			await db.exec('create table u (id integer primary key) using reporting');
			await db.exec('insert into s values (1), (2), (3), (4), (5)');
			await db.exec('analyze s');
			const s = table('s');
			db._cardinalityFeedback.record(s, 20_000);
			const tableRows = (t: TableSchema) => db.optimizer.getStats().tableRows(t);

			module.answer = { rows: 7, exact: true };
			expect(tableRows(s), 'exact module count beats the overlay').to.equal(7);
			module.answer = { rows: 9, exact: false };
			expect(tableRows(s), 'overlay beats an approximate module count').to.equal(20_000);
			db._cardinalityFeedback.clear();
			expect(tableRows(s), 'approximate module count beats the catalog').to.equal(9);
			module.answer = undefined;
			expect(tableRows(s), 'a declining module falls through to the catalog').to.equal(5);
			expect(tableRows(table('u')), 'nothing known: the naive default').to.equal(1000);
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
				expect(first).to.have.length(300);

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

		it('re-plans at the execution after one-shot seeks shifted the rows per key of a table it reads', async () => {
			await db.exec('pragma cardinality_feedback = true');
			await createParentChild();
			await db.exec("insert into parent select value, 'p' || value from generate_series(1, 2000)");
			await db.exec("insert into child select value, (value - 1) % 2000 + 1, 'n' || value from generate_series(1, 8000)");
			async function notes(stmt: Statement): Promise<string[]> {
				const out: string[] = [];
				for await (const row of stmt.all()) out.push(row.note as string);
				return out.sort();
			}

			const stmt = db.prepare(parentChildSql);
			try {
				expect(stmt.getPlanShape().nodeTypes).to.include.keys('HashJoin');
				// Scans both tables in full: `child` is recorded at 8,000 — under 10x of the
				// default, so no count shift — which opens its rows-per-key gate.
				const first = await notes(stmt);
				expect(first).to.have.length(4);

				// Each one-shot seek yields the parent's four children; the first sample (4
				// against the 800 its plan priced the seek at) shifts, the rest agree with the mean.
				for (const parentId of [1, 2, 3]) {
					let rows = 0;
					for await (const _row of db.eval('select note from child where parent_id = ?', [parentId])) rows++;
					expect(rows).to.equal(4);
				}
				const [child] = db._cardinalityFeedback.snapshot().filter(entry => entry.tableName === 'child');
				expect(child.shifts, 'no count shift').to.equal(0);
				expect(child.perKey).to.deep.equal([
					{ keyColumns: ['parent_id'], rowsPerKey: 4, samples: 3, baselineRowsPerKey: 4, shifts: 1 },
				]);

				// The shift only marked the cached plan; it is dropped when the next run starts.
				expect(stmt.getPlanShape().nodeTypes).to.include.keys('HashJoin');
				expect(await notes(stmt)).to.deep.equal(first);

				const replanned = stmt.getPlanShape().nodeTypes;
				expect(replanned).to.include.keys('Join', 'IndexSeek');
				expect(replanned).to.not.have.property('HashJoin');
			} finally {
				await stmt.finalize();
			}
		});

		it('re-plans when a module-reported size drifts 10x from the one the plan was costed with', async () => {
			const module = new ReportingMemoryModule();
			db.registerModule('reporting', module);
			await db.exec('create table big (id integer primary key, v integer, w integer) using reporting');
			await db.exec('create table mid (id integer primary key, big_id integer, x integer)');
			await db.exec('insert into big select value, value, value from generate_series(1, 200)');
			await db.exec('insert into mid select value, value % 200 + 1, value % 5 from generate_series(1, 300)');
			// With a cooldown of one every drift re-plans at once, so a plan that survives saw none.
			const tuning = db.optimizer.tuning;
			db.optimizer.updateTuning({ ...tuning, cardinalityFeedback: { ...tuning.cardinalityFeedback, replanCooldown: 1 } });
			module.answer = { rows: 50, exact: true };

			const stmt = db.prepare(joinSql);
			try {
				const initial = stmt.getPlanShape().nodeTypes;
				expect(initial).to.include.keys('HashJoin');
				expect(initial).to.not.have.property('IndexSeek');
				const first = await joinedWs(stmt);
				expect(first).to.have.length(300);

				module.answer = { rows: 20_000, exact: true };
				expect(await joinedWs(stmt)).to.deep.equal(first);
				const replanned = stmt.getPlanShape().nodeTypes;
				expect(replanned).to.include.keys('Join', 'IndexSeek');
				expect(replanned).to.not.have.property('HashJoin');

				// 1.5x from the 20,000 the new plan was costed with, not 600x from the first 50.
				const plan = stmt.compile();
				module.answer = { rows: 30_000, exact: true };
				expect(await joinedWs(stmt)).to.deep.equal(first);
				expect(stmt.compile()).to.equal(plan);
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

	describe('cardinality_feedback()', () => {
		it('reads the overlay at execution, not plan time: one prepared statement sees a later observation', async () => {
			await db.exec('pragma cardinality_feedback = true');
			await createJoinTables();
			await db.exec('insert into big select value, value, value from generate_series(1, 20000)');

			const stmt = db.prepare('select table_name, observed_rows from cardinality_feedback()');
			async function rows(): Promise<unknown[]> {
				const out: unknown[] = [];
				for await (const row of stmt.all()) out.push(row);
				return out;
			}
			try {
				expect(await rows()).to.deep.equal([]);

				let scanned = 0;
				for await (const _row of db.eval('select v from big')) scanned++;
				expect(scanned).to.equal(20_000);

				expect(await rows()).to.deep.equal([{ table_name: 'big', observed_rows: 20_000 }]);
			} finally {
				await stmt.finalize();
			}
		});
	});
});
