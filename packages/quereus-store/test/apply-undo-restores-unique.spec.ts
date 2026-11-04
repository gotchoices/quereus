/**
 * A failed `apply schema` puts back a UNIQUE it dropped without judging it against the stored
 * rows, on the store backend too (docs/schema-undo-plan.md § Guards during an unwind). Redefining
 * the collation is how the public API makes stored rows collide without touching them.
 *
 * The memory backend's half is in the engine's `test/apply-schema-restore.spec.ts`. The sqllogic
 * runner, which is what reaches the store from the engine's side, cannot redefine a collation.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { createIsolatedStoreModule, StoreModule } from '../src/index.js';
import { createProvider, indexStoreSize, rows } from './refused-ddl-residue.js';

const exact = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const folded = (a: string, b: string): number => exact(a.toLowerCase(), b.toLowerCase());

describe('A failed apply restores a UNIQUE the stored rows no longer satisfy', () => {
	const stacks = [
		{ stack: 'bare store', moduleOver: (provider: ReturnType<typeof createProvider>) => new StoreModule(provider) },
		{ stack: 'isolated store', moduleOver: (provider: ReturnType<typeof createProvider>) => createIsolatedStoreModule({ provider }) },
	];

	for (const { stack, moduleOver } of stacks) {
		it(`${stack}: keeps the rows, builds the covering store, and enforces the constraint`, async () => {
			const provider = createProvider();
			const db = new Database();
			db.registerModule('store', moduleOver(provider));
			db.setOption('default_vtab_module', 'store');
			db.registerCollation('FOLD', exact, { normalizer: s => s });
			await db.exec('create table t (id integer primary key, b integer null)');
			await db.exec('insert into t values (1, 1), (2, 1)');
			await db.exec('create table e (id integer primary key, x text collate FOLD null, constraint c unique (x))');
			await db.exec("insert into e values (1, 'a'), (2, 'A')");
			db.registerCollation('FOLD', folded, { normalizer: s => s.toLowerCase() });
			await db.exec(`
				declare schema main {
					table t { id integer primary key, b integer null, constraint ub unique (b) }
					table e { id integer primary key, x text collate FOLD null }
				}
			`);

			const failure: Error = await db.exec('apply schema main').then(() => { throw new Error('the apply should fail'); }, e => e as Error);
			expect(failure.message).to.match(/UNIQUE constraint failed: t \(b\)/);
			expect(failure.message).to.not.match(/could not be restored/);

			expect((await rows(db, 'diff schema main')).map(r => r.ddl)).to.include('ALTER TABLE e DROP CONSTRAINT c');
			expect(await rows(db, 'select id from e order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
			expect(indexStoreSize(provider, 'e', 'c'), 'the covering store holds both colliding rows').to.equal(2);
			await db.exec("insert into e values (3, 'b')");
			let duplicate: Error | undefined;
			await db.exec("insert into e values (4, 'B')").catch(e => { duplicate = e as Error; });
			expect(duplicate?.message).to.match(/UNIQUE constraint failed/);

			await db.close();
		});
	}
});
