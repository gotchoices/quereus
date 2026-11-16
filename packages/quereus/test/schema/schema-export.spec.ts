import { expect } from 'chai';
import { Database, MemoryTableModule, exportSchemaDeclaration } from '../../src/index.js';
import { astToString, quoteIdentifier } from '../../src/emit/ast-stringify.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * `exportSchemaDeclaration` is the inverse of `declare schema` + `apply schema`. Two
 * properties pin that, over schemas built with direct DDL:
 *
 *  - Same-database fixpoint: declaring the export on the database it came from
 *    leaves `diff schema` with nothing to do.
 *  - Fresh-database round trip: applying the export to a new database and exporting
 *    again reproduces the same text byte for byte.
 */

interface Scenario {
	readonly name: string;
	/** Run on both databases before any DDL: modules and schemas the DDL needs. */
	readonly prepare?: (db: Database) => void;
	readonly ddl: string;
	/** Exported schemas, in the order a fresh database applies them (a referenced schema first). */
	readonly schemas: readonly string[];
}

function registerMem2(db: Database): void {
	db.registerModule('mem2', new MemoryTableModule());
}

const scenarios: readonly Scenario[] = [
	{
		name: 'tables, constraints, indexes, a view and an assertion, with quoted and dotted names',
		schemas: ['main'],
		ddl: `
			create table "Parent" (
				id integer primary key,
				"Name" text not null collate nocase,
				code text,
				constraint uq_code unique (code) with tags ("quereus.expose_implicit_index" = true)
			) with tags ("quereus.id" = 'parent-1', note = 'it''s');
			create table "child.items" (
				id integer primary key,
				parent_id integer references "Parent"(id),
				other_id integer,
				qty integer check (qty > 0),
				total integer generated always as (qty * 2) stored,
				label text default 'none' unique,
				constraint fk_other foreign key (other_id) references "Parent"(id) on delete cascade,
				constraint ck_label check (length(label) < 50)
			);
			create index ix_child_qty on "child.items" (qty desc) where qty > 1;
			create unique index "IxCode" on "Parent" (code collate nocase) with tags (purpose = 'lookup');
			create view "V1" (pid, n) as select id, "Name" from "Parent" where id > 0 with tags (kind = 'report');
			create assertion a_qty check (not exists (select 1 from "child.items" where qty > 100));
		`,
	},
	{
		name: 'maintained tables and materialized views, on the default and a non-default module',
		prepare: registerMem2,
		schemas: ['main'],
		ddl: `
			create table src (id integer primary key, v integer);
			create materialized view mv_default as select id, v from src where v > 0;
			create materialized view mv_other using mem2 as select id, v * 2 as w from src;
			create table plain_other (id integer primary key, note text) using mem2;
			create table mt (id integer primary key, v integer) maintained as select id, v from src;
			create view v_over_mv as select id from mv_default;
		`,
	},
	{
		// A table rename rewrites the stored view body, and `alter view … set tags` leaves
		// the view's original statement text behind: the export must read neither text.
		name: 'views changed after creation by a table rename and by new tags',
		schemas: ['main'],
		ddl: `
			create table t0 (a integer primary key, b text);
			create view v_renamed as select a, b from t0 where a > 0;
			create view v_tagged as select a from t0 with tags (stage = 'draft');
			alter table t0 rename to t1;
			alter view v_tagged set tags (stage = 'final');
		`,
	},
	{
		name: 'a non-main schema, and a foreign key into it from main',
		prepare: db => { db.schemaManager.addSchema('aux'); },
		schemas: ['aux', 'main'],
		ddl: `
			create table aux.parent (id integer primary key, tag text);
			create table aux.child (id integer primary key, pid integer references parent(id));
			create index ix_aux_child on aux.child (pid);
			create view aux.v_parent as select id, tag from aux.parent;
			create assertion aux.a_tag check (not exists (select 1 from aux.parent where tag = 'bad'));
			create table main.orders (id integer primary key, pid integer references aux.parent(id));
		`,
	},
];

async function rows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function exportText(db: Database, schemaName: string): string {
	return astToString(exportSchemaDeclaration(db, schemaName));
}

describe('exportSchemaDeclaration', () => {
	for (const scenario of scenarios) {
		it(`round-trips ${scenario.name}`, async () => {
			const source = new Database();
			const fresh = new Database();
			try {
				scenario.prepare?.(source);
				await source.exec(scenario.ddl);
				const exported = new Map(scenario.schemas.map(name => [name, exportText(source, name)]));

				for (const [name, text] of exported) {
					await source.exec(text);
					const diff = await rows(source, `diff schema ${quoteIdentifier(name)}`);
					expect(diff.map(r => r.ddl), `diff of '${name}' against its own export:\n${text}`).to.deep.equal([]);
				}

				scenario.prepare?.(fresh);
				for (const [name, text] of exported) {
					await fresh.exec(text);
					await fresh.exec(`apply schema ${quoteIdentifier(name)}`);
				}
				for (const [name, text] of exported) {
					expect(exportText(fresh, name), `re-export of '${name}'`).to.equal(text);
				}
			} finally {
				await source.close();
				await fresh.close();
			}
		});
	}
});
