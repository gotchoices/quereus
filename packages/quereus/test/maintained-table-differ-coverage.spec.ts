import { expect } from 'chai';
import { Database } from '../src/index.js';
import { isMaintainedTable } from '../src/schema/derivation.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';

/**
 * Review-stage coverage for ticket 6.3 (maintained-table-differ-transitions) —
 * interaction paths the implement-stage specs left unexercised:
 *
 *  1. The declared-shape **table form** (`table X { cols } maintained as …`) end
 *     to end through `declare/apply schema` — the migration-capstone uses only the
 *     `materialized view` sugar, yet docs promise both forms apply identically.
 *  2. **Form parity**: the table form and the sugar form normalize to the same
 *     declared record, so re-declaring the OTHER form over a live maintained table
 *     is an empty diff (closes the dropped "sugar vs table-form compare equal"
 *     matrix case noted in the handoff).
 *  3. **Orphan maintained table + its source dropped in one apply** — undeclared
 *     MVs used to drop EARLY (before source tables); an orphan maintained table
 *     now drops via `tablesToDrop` (FK-ordered only). Confirm apply tolerates it.
 */
describe('Maintained-table differ — review coverage', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function rows(sql: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		for await (const r of db.eval(sql)) out.push({ ...r });
		return out;
	}

	it('fresh-creates a maintained table from the declared-shape table form', async () => {
		await db.exec(`create table src (id integer primary key, v integer) using memory`);
		await db.exec(`insert into src values (1, 10), (2, 20)`);
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			table m { id integer primary key, v integer } maintained as select id, v from src
		}`);
		await db.exec('apply schema main');

		const m = db.schemaManager.getTable('main', 'm');
		expect(m, 'm exists').to.not.be.undefined;
		expect(isMaintainedTable(m!), 'm is maintained').to.be.true;
		expect(await rows('select id, v from m order by id')).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// Converged: re-applying the same table-form declaration is a no-op.
		const diff = computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
		expect(diff.tablesToAlter.find(a => a.tableName === 'm'), 'table form converges').to.be.undefined;
	});

	it('the table form and the MV sugar compare equal against the same live maintained table', async () => {
		await db.exec(`create table src (id integer primary key, v integer) using memory`);
		// Create via the sugar…
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			materialized view m as select id, v from src
		}`);
		await db.exec('apply schema main');
		// …then re-declare the identical derivation via the table form.
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			table m { id integer primary key, v integer } maintained as select id, v from src
		}`);
		const diff = computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
		const mAlter = diff.tablesToAlter.find(a => a.tableName === 'm');
		expect(mAlter?.setMaintained, 'table-form == sugar ⇒ no re-attach').to.be.undefined;
		expect(mAlter?.dropMaintained, 'no detach').to.be.undefined;
		expect(diff.tablesToDrop, 'no drop').to.deep.equal([]);
	});

	it('drops an orphan maintained table and its source in the same apply', async () => {
		await db.exec(`create table s (id integer primary key, v integer) using memory`);
		await db.exec(`insert into s values (1, 10)`);
		await db.exec(`declare schema main {
			table s { id integer primary key, v integer }
			materialized view m as select id, v from s
		}`);
		await db.exec('apply schema main');

		// Empty schema: both m (orphan maintained) and s drop. The orphan maintained
		// table no longer drops EARLY (it is a table now), so this verifies dropping
		// the source out from under it in the same migration is tolerated.
		await db.exec(`declare schema main {}`);
		await db.exec('apply schema main');
		expect(db.schemaManager.getTable('main', 'm'), 'orphan maintained dropped').to.be.undefined;
		expect(db.schemaManager.getTable('main', 's'), 'source dropped').to.be.undefined;
	});

	it('detaches a maintained table while dropping its former source in one apply', async () => {
		await db.exec(`create table s (id integer primary key, v integer) using memory`);
		await db.exec(`insert into s values (1, 10)`);
		await db.exec(`declare schema main {
			table s { id integer primary key, v integer }
			materialized view m as select id, v from s
		}`);
		await db.exec('apply schema main');

		// m becomes plain (detach), s is dropped. Detach runs EARLY, so it precedes
		// the source drop; m keeps its rows and becomes writable.
		await db.exec(`declare schema main {
			table m { id integer primary key, v integer }
		}`);
		await db.exec('apply schema main');
		expect(db.schemaManager.getTable('main', 's'), 'source dropped').to.be.undefined;
		const m = db.schemaManager.getTable('main', 'm');
		expect(m, 'm survives as plain table').to.not.be.undefined;
		expect(isMaintainedTable(m!), 'm is no longer maintained').to.be.false;
		expect(await rows('select id, v from m')).to.deep.equal([{ id: 1, v: 10 }]);
	});
});
