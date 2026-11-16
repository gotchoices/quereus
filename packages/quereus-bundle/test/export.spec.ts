import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import { exportBundle, type ExportOptions } from '../src/index.js';

async function exportText(db: Database, options: ExportOptions): Promise<string> {
	let text = '';
	for await (const chunk of exportBundle(db, options)) text += chunk;
	return text;
}

describe('exportBundle', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table "order" (id integer primary key, customer text null, placed date null, note json null);
			create table item (
				order_id integer references "order"(id), line integer, sku text, qty integer,
				total integer generated always as (qty * 2),
				primary key (order_id, line)
			);
			create view big_orders as select id from "order" where id > 1;
			insert into "order" values (1, 'Ada', '2026-11-16', '{"gift": true}'), (2, 'true', null, null), (3, null, null, '[1, 2]');
			insert into item (order_id, line, sku, qty) values (1, 1, 'A-1', 3), (2, 1, 'B: 2', 1);
		`);
	});

	afterEach(async () => {
		await db.close();
	});

	it('writes the header, parent-first batches of positional rows, and the trailer', async () => {
		const text = await exportText(db, { batchSize: 2 });

		expect(text.replace(/^created: .*$/m, 'created: <time>')).to.equal(`quereus-bundle: 1
created: <time>
schemas:
  - name: main
    declaration: |-
      declare schema main { table item (order_id INTEGER not null, line INTEGER not null, sku TEXT not null collate binary, qty INTEGER not null, total INTEGER not null generated always as (qty * 2), primary key (order_id, line), constraint _fk_item_order_id foreign key (order_id) references "order"(id) on delete restrict on update restrict); table "order" (id INTEGER not null primary key, customer TEXT null collate binary, placed DATE null, note JSON null); view big_orders as select id from "order" where id > 1; }
tables:
  - schema: main
    table: order
    columns: [id, customer, placed, note]
  - schema: main
    table: item
    columns: [order_id, line, sku, qty]
---
data: {schema: main, table: order}
rows:
  - [1, Ada, 2026-11-16, {gift: true}]
  - [2, "true", null, null]
---
data: {schema: main, table: order}
rows:
  - [3, null, null, [1, 2]]
---
data: {schema: main, table: item}
rows:
  - [1, 1, A-1, 3]
  - [2, 1, "B: 2", 1]
---
end:
  tables:
    - {schema: main, table: order, rows: 3}
    - {schema: main, table: item, rows: 2}
`);
	});

	it('under skip-table, keeps the rows before an unencodable value, records the error in the trailer and moves on', async () => {
		db.createScalarFunction('date_at', { numArgs: 1 }, id => (id === 2 ? new Date(0) as unknown as SqlValue : id));
		await db.exec(`create table odd (id integer primary key, v any null);
			insert into odd select value, date_at(value) from generate_series(1, 3);`);
		const errors: string[] = [];

		const text = await exportText(db, {
			schema: false, errorPolicy: 'skip-table', tables: (_s, t) => t !== 'item',
			onError: e => { errors.push(`${e.kind} ${e.table} ${e.rowIndex}`); },
		});

		expect(errors).to.deep.equal(['value odd 1']);
		expect(text).to.contain(`data: {schema: main, table: odd}
rows:
  - [1, 1]
---`);
		expect(text).to.match(/- \{schema: main, table: odd, rows: 1, error: "Cannot export column 'v' of row 1 in main\.odd: [^"]*"\}\n {4}- \{schema: main, table: order, rows: 3\}\n$/);
		expect(db.getAutocommit()).to.equal(true);
	});

	it('ends the read transaction it opened when the consumer stops early', async () => {
		let documents = 0;
		for await (const _chunk of exportBundle(db, { batchSize: 1 })) {
			if (++documents === 2) break; // the header, then the first data document
		}

		expect(db.getAutocommit()).to.equal(true);
		await db.exec(`insert into "order" (id) values (4)`);
	});
});
