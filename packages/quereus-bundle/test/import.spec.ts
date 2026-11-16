import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, exportSchemaDeclaration, sqlValueIdentical, type Row } from '@quereus/quereus';
import { astToString } from '@quereus/quereus/emit';
import { exportBundle, importBundle, type ExportOptions } from '../src/index.js';

async function exportText(db: Database, options: ExportOptions = {}): Promise<string> {
	let text = '';
	for await (const chunk of exportBundle(db, options)) text += chunk;
	return text;
}

async function rowsOf(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	const statement = db.prepare(sql);
	try {
		for await (const row of statement.iterateRows()) rows.push(row);
	} finally {
		await statement.finalize();
	}
	return rows;
}

function sameRows(actual: Row[], expected: Row[]): boolean {
	return actual.length === expected.length
		&& actual.every((row, i) => row.length === expected[i].length && row.every((v, j) => sqlValueIdentical(v, expected[i][j])));
}

/** A hand-written bundle of table `t (id, v)`: one data document per entry of `documents`, then the trailer. */
function tBundle(documents: string[][], options: { trailer?: boolean } = {}): string {
	const rows = documents.reduce((n, d) => n + d.length, 0);
	return [
		'quereus-bundle: 1\ncreated: 2026-11-16T00:00:00.000Z\ntables:\n  - schema: main\n    table: t\n    columns: [id, v]\n',
		...documents.map(d => `data: {schema: main, table: t}\nrows:\n${d.map(r => `  - ${r}\n`).join('')}`),
		...(options.trailer === false ? [] : [`end:\n  tables:\n    - {schema: main, table: t, rows: ${rows}}\n`]),
	].join('---\n');
}

describe('importBundle', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('round-trips schema and data into a fresh database', async () => {
		const source = new Database();
		try {
			await source.exec(`
				create table node (id integer primary key, parent_id integer null references node(id), label text);
				create table item (id integer primary key, node_id integer references node(id), qty integer, total integer generated always as (qty * 2));
				create table vals (id integer primary key, b blob null, j json null, d date null, big integer null, r real null);
				create view labels as select label from node;
				create materialized view node_counts as select node_id, count(*) as n from item group by node_id;
				create index item_big_qty on item (qty) where qty > 1;
				create assertion qty_positive check (not exists (select 1 from item where qty <= 0));
				insert into node values (3, null, 'root'), (4, 3, 'branch'), (1, 4, 'leaf a'), (2, 4, 'leaf b');
				insert into item (id, node_id, qty) values (1, 1, 2), (2, 1, 5), (3, 2, 1);
			`);
			for (const values of [
				[1, new Uint8Array([0, 1, 255]), '{"a": [1, 2.5, null]}', '2026-11-16', 9223372036854775807n, -0],
				[2, null, null, null, -9007199254740993n, 0.1],
			]) {
				const insert = source.prepare('insert into vals values (?, ?, ?, ?, ?, ?)');
				await insert.run(values);
				await insert.finalize();
			}
			const declaration = astToString(exportSchemaDeclaration(source, 'main'));

			// Batches of two put leaves 1 and 2, whose parent is node 4, a batch ahead of it.
			const report = await importBundle(db, await exportText(source, { batchSize: 2 }));

			expect(report.errors).to.deep.equal([]);
			expect(report.ok).to.equal(true);
			expect(db.declaredSchemaManager.getDeclaredSchema('main')).to.equal(undefined);
			expect(db.options.getBooleanOption('foreign_keys')).to.equal(true);
			await db.exec(declaration);
			expect(await rowsOf(db, 'diff schema main')).to.deep.equal([]);
			for (const sql of ['select * from node order by id', 'select * from item order by id', 'select * from vals order by id', 'select * from node_counts order by node_id']) {
				const [actual, expected] = [await rowsOf(db, sql), await rowsOf(source, sql)];
				expect(sameRows(actual, expected), sql).to.equal(true);
				expect(actual.length, sql).to.be.greaterThan(0);
			}
		} finally {
			await source.close();
		}
	});

	it('under skip-row, reports the failing row and keeps the others in its document', async () => {
		await db.exec('create table t (id integer primary key, v text)');

		const report = await importBundle(db, tBundle([['[1, a]', '[2, null]', '[3, c]']]), { errorPolicy: 'skip-row' });

		expect(report.errors.map(e => [e.kind, e.documentIndex, e.rowIndex])).to.deep.equal([['row', 1, 1]]);
		expect(await rowsOf(db, 'select id from t order by id')).to.deep.equal([[1], [3]]);
		expect(report.tables).to.deep.equal([{ schema: 'main', table: 't', rowsRead: 3, rowsApplied: 2, rowsFailed: 1, batchesFailed: 0, expectedRows: 3 }]);
	});

	it('under abort, keeps the batches before a failed one and loads nothing after it', async () => {
		await db.exec('create table t (id integer primary key, v text)');

		const report = await importBundle(db, tBundle([['[1, a]'], ['[2, b]', '[3, null]'], ['[4, d]']]));

		expect(report.ok).to.equal(false);
		expect(report.errors.map(e => [e.kind, e.documentIndex, e.rowIndex])).to.deep.equal([['batch', 2, 1]]);
		expect(await rowsOf(db, 'select id from t order by id')).to.deep.equal([[1]]);
	});

	it('refuses a destructive plan unless allowed', async () => {
		const source = new Database();
		try {
			await source.exec(`create table t (id integer primary key, v text); insert into t values (1, 'a');`);
			const text = await exportText(source);
			await db.exec('create table extra (id integer primary key)');

			const refused = await importBundle(db, text);

			expect(refused.errors.map(e => e.kind)).to.deep.equal(['destructive']);
			expect(refused.errors[0].message).to.match(/drop table/i);
			expect(db.schemaManager.findTable('extra', 'main')).to.not.equal(undefined);
			expect(db.schemaManager.findTable('t', 'main')).to.equal(undefined);

			const allowed = await importBundle(db, text, { allowDestructive: true });

			expect(allowed.ok).to.equal(true);
			expect(db.schemaManager.findTable('extra', 'main')).to.equal(undefined);
			expect(await rowsOf(db, 'select * from t')).to.deep.equal([[1, 'a']]);
		} finally {
			await source.close();
		}
	});

	// One-character chunks put a chunk boundary at every offset, including inside the
	// header's `tables:` indentation, which the `yaml` lexer misreads unless fed whole lines.
	it('under skip-batch, loses only a document with a YAML error, and says where it is, whatever the chunking', async () => {
		await db.exec('create table t (id integer primary key, v text)');

		const text = tBundle([['[1, a]'], ['[2, "bad \\q escape"]'], ['[3, c]']]);
		const report = await importBundle(db, text.split(''), { errorPolicy: 'skip-batch' });

		expect(report.errors[0]).to.include({ kind: 'format', documentIndex: 2, line: 14 });
		expect(await rowsOf(db, 'select id from t order by id')).to.deep.equal([[1], [3]]);
	});

	it('reports a bundle without its trailer as truncated, keeping the rows it loaded', async () => {
		await db.exec('create table t (id integer primary key, v text)');

		const report = await importBundle(db, tBundle([['[1, a]']], { trailer: false }));

		expect(report.errors.map(e => e.kind)).to.deep.equal(['truncated']);
		expect(await rowsOf(db, 'select id from t')).to.deep.equal([[1]]);
	});

	it('refuses a declaration that is not exactly one declare schema statement', async () => {
		await db.exec('create table t (id integer primary key)');
		const text = 'quereus-bundle: 1\ncreated: 2026-11-16T00:00:00.000Z\nschemas:\n  - name: main\n'
			+ '    declaration: "declare schema main { table t (id integer primary key) }; drop table t"\n---\nend:\n  tables: []\n';

		const report = await importBundle(db, text);

		expect(report.errors.map(e => e.kind)).to.deep.equal(['schema']);
		expect(db.schemaManager.findTable('t', 'main')).to.not.equal(undefined);
	});

	it('loads an orphaned foreign key and reports the constraint it breaks', async () => {
		await db.exec(`create table p (id integer primary key);
			create table c (id integer primary key, pid integer, constraint c_to_p foreign key (pid) references p(id));`);
		const text = 'quereus-bundle: 1\ncreated: 2026-11-16T00:00:00.000Z\ntables:\n  - schema: main\n    table: c\n    columns: [id, pid]\n'
			+ '---\ndata: {schema: main, table: c}\nrows:\n  - [1, 7]\n---\nend:\n  tables:\n    - {schema: main, table: c, rows: 1}\n';

		const report = await importBundle(db, text);

		expect(report.errors.map(e => [e.kind, e.table])).to.deep.equal([['foreign-key', 'c']]);
		expect(report.errors[0].message).to.contain('c_to_p');
		expect(await rowsOf(db, 'select * from c')).to.deep.equal([[1, 7]]);
	});
});
