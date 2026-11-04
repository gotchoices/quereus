import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { TableSchema, TagChangeInfo } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * `IsolationModule.alterTags` mirrors the underlying's hook, and a tag edit moves no row, so
 * every connection's staged rows must survive it unpoisoned and still commit.
 */

class TagHookModule extends MemoryTableModule {
	readonly calls: TagChangeInfo[] = [];

	async alterTags(db: Database, schemaName: string, tableName: string, change: TagChangeInfo): Promise<TableSchema> {
		this.calls.push(change);
		return { ...db.schemaManager.getTable(schemaName, tableName)!, tags: { marker: 'from-module' } };
	}
}

async function ids(db: Database): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const row of db.eval('select id from t order by id')) out.push(row.id);
	return out;
}

describe('IsolationModule alterTags forwarding', () => {
	it('forwards once, leaving both connections\' staged rows usable', async () => {
		const underlying = new TagHookModule();
		const iso = new IsolationModule({ underlying });
		const issuer = new Database();
		const other = new Database();
		issuer.registerModule('isolated', iso);
		other.registerModule('isolated', iso);
		try {
			await issuer.exec('create table t (id integer primary key, name text) using isolated');
			other.schemaManager.getMainSchema().addTable(issuer.schemaManager.getTable('main', 't')!);

			await issuer.exec('begin');
			await issuer.exec("insert into t values (1, 'issuer')");
			await other.exec('begin');
			await other.exec("insert into t values (2, 'other')");

			await issuer.exec("alter table t set tags (k = 'x')");

			expect(underlying.calls).to.have.lengthOf(1);
			expect(underlying.calls[0]).to.deep.include({ mode: 'replace', tags: { k: 'x' } });
			expect(issuer.schemaManager.getTable('main', 't')!.tags).to.deep.equal({ marker: 'from-module' });
			expect(await ids(issuer), 'issuer reads its own staged row').to.deep.equal([1]);
			expect(await ids(other), 'the other connection reads its own staged row').to.deep.equal([2]);

			await issuer.exec('commit');
			await other.exec('commit');

			expect(await ids(issuer), 'both staged rows committed').to.deep.equal([1, 2]);
		} finally {
			await issuer.close();
			await other.close();
		}
	});

	it('has no hook when the underlying has none', () => {
		const iso = new IsolationModule({ underlying: new MemoryTableModule() });
		expect(iso.alterTags).to.be.undefined;
	});
});
