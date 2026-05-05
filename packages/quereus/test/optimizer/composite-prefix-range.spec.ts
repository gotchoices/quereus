import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Composite index prefix-equality + trailing-range', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupEvents(): Promise<void> {
		await db.exec(`CREATE TABLE events (
			id INTEGER PRIMARY KEY,
			category TEXT,
			year INTEGER,
			month INTEGER,
			title TEXT
		) USING memory`);
		await db.exec(`INSERT INTO events VALUES
			(1, 'tech', 2023, 6, 'OldConf'),
			(2, 'tech', 2024, 3, 'DevCon'),
			(3, 'tech', 2024, 9, 'CodeFest'),
			(4, 'tech', 2025, 1, 'FutureTech'),
			(5, 'music', 2024, 5, 'SoundWave'),
			(6, 'music', 2024, 11, 'BeatDrop'),
			(7, 'music', 2025, 2, 'Harmony'),
			(8, 'art', 2024, 7, 'Canvas')`);
		await db.exec("CREATE INDEX idx_cat_year ON events(category, year)");
	}

	it('idx(a,b) with WHERE a = val AND b > val returns correct rows', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year > 2023 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['CodeFest', 'DevCon', 'FutureTech']);
	});

	it('idx(a,b) with WHERE a = val AND b >= val AND b <= val (BETWEEN)', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year >= 2024 AND year <= 2024 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['CodeFest', 'DevCon']);
	});

	it('idx(a,b) with WHERE a = val AND b > val AND b < val (both bounds)', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'music' AND year > 2023 AND year < 2026 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['BeatDrop', 'Harmony', 'SoundWave']);
	});

	it('does not return rows outside the prefix', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year > 2024 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		// Should only return tech events after 2024, not music or art
		expect(results.map(r => r.title)).to.deep.equal(['FutureTech']);
	});

	it('explain shows IndexSeek for prefix-range query', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year > 2023";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
	});

	it('3-column index: idx(a,b,c) with WHERE a = val AND b = val AND c > val', async () => {
		await db.exec(`CREATE TABLE logs (
			id INTEGER PRIMARY KEY,
			app TEXT,
			level TEXT,
			ts INTEGER,
			msg TEXT
		) USING memory`);
		await db.exec(`INSERT INTO logs VALUES
			(1, 'web', 'error', 100, 'e1'),
			(2, 'web', 'error', 200, 'e2'),
			(3, 'web', 'error', 300, 'e3'),
			(4, 'web', 'warn', 150, 'w1'),
			(5, 'api', 'error', 250, 'a1')`);
		await db.exec("CREATE INDEX idx_app_level_ts ON logs(app, level, ts)");

		const q = "SELECT msg FROM logs WHERE app = 'web' AND level = 'error' AND ts > 100 ORDER BY msg";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.msg)).to.deep.equal(['e2', 'e3']);
	});

	it('prefix-range on composite primary key', async () => {
		await db.exec(`CREATE TABLE scores (
			student_id INTEGER,
			subject TEXT,
			score INTEGER,
			PRIMARY KEY (student_id, subject)
		) USING memory`);
		await db.exec(`INSERT INTO scores VALUES
			(1, 'art', 80),
			(1, 'math', 90),
			(1, 'science', 85),
			(2, 'art', 70),
			(2, 'math', 95)`);

		const q = "SELECT subject, score FROM scores WHERE student_id = 1 AND subject > 'art' ORDER BY subject";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.subject)).to.deep.equal(['math', 'science']);
	});

	it('existing single-column range scan still works (regression)', async () => {
		await setupEvents();
		// Drop the composite index and use a single-column one
		await db.exec("DROP INDEX idx_cat_year");
		await db.exec("CREATE INDEX idx_year ON events(year)");
		const q = "SELECT title FROM events WHERE year > 2024 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['FutureTech', 'Harmony']);
	});

	it('existing full equality seek still works (regression)', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year = 2024 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['CodeFest', 'DevCon']);
	});

	it('prefix-range with only upper bound', async () => {
		await setupEvents();
		const q = "SELECT title FROM events WHERE category = 'tech' AND year < 2024 ORDER BY title";
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results.map(r => r.title)).to.deep.equal(['OldConf']);
	});
});
