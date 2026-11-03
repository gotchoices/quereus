/**
 * The table-identity index (`metadata/table-identity.ts`) is updated the moment a
 * transition is staged into a batch, so a batch that fails to commit leaves it ahead
 * of disk — and `ensure` never re-persists a mapping the index already holds. The
 * standalone store writers must therefore re-read the index when their write fails,
 * or every later record for that name is filed under a generation no `tg:` record
 * names, and a reopened replica cannot resolve any of them.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { ColumnVersionStore } from '../../src/metadata/column-version.js';
import { RAW_PK_KEYING, encodeRawPkIdentity } from '../../src/metadata/keys.js';
import { TableIdentityStore } from '../../src/metadata/table-identity.js';
import { generateSiteId } from '../../src/clock/site.js';

/** An in-memory KV whose NEXT batch write rejects, once, when `failNextWrite` is called. */
function makeFlakyKV(): { kv: InMemoryKVStore; failNextWrite: () => void } {
	const kv = new InMemoryKVStore();
	let failNext = false;
	const origBatch = kv.batch.bind(kv);
	kv.batch = () => {
		const batch = origBatch();
		if (failNext) {
			failNext = false;
			batch.write = async () => { throw new Error('simulated storage failure'); };
		}
		return batch;
	};
	return { kv, failNextWrite: () => { failNext = true; } };
}

describe('table identity index after a failed standalone write', () => {
	it('re-reads the index so the next write persists the mapping a reopened replica needs', async () => {
		const { kv, failNextWrite } = makeFlakyKV();
		const tables = new TableIdentityStore(kv);
		await tables.load();
		const store = new ColumnVersionStore(kv, () => RAW_PK_KEYING, tables);
		const hlc = { wallTime: BigInt(Date.now()), counter: 0, siteId: generateSiteId(), opSeq: 0 };

		failNextWrite();
		let error: Error | undefined;
		try {
			await store.setColumnVersion('main', 't', [1], 'c', { hlc, value: 'lost' });
		} catch (e) {
			error = e as Error;
		}
		expect(error?.message, 'the failed write surfaces').to.match(/simulated storage failure/);

		await store.setColumnVersion('main', 't', [1], 'c', { hlc, value: 'kept' });

		const reopened = new TableIdentityStore(kv);
		await reopened.load();
		const generation = reopened.generationOf('main', 't');
		expect(generation, 'the mapping landed with the successful write').to.not.be.undefined;
		expect(generation).to.equal(tables.generationOf('main', 't'));
		const record = await store.getColumnVersionByIdentity(generation!, encodeRawPkIdentity([1]), 'c');
		expect(record?.value).to.equal('kept');
	});
});

describe('table identity when a name is reused while its retirement is scanning', () => {
	it('keeps the mapping a concurrent commit filed for the name', async () => {
		const kv = new InMemoryKVStore();
		const tables = new TableIdentityStore(kv);
		await tables.load();
		const seed = kv.batch();
		tables.ensure('main', 't', seed);
		await seed.write();

		const retireBatch = kv.batch();
		const retiring = tables.retire('main', 't', retireBatch);

		// The retirement is suspended in its record scan, so this runs as a local
		// `create table t` committing in that gap would.
		const createBatch = kv.batch();
		const reborn = tables.ensure('main', 't', createBatch);
		await createBatch.write();

		await retiring;
		await retireBatch.write();

		const reopened = new TableIdentityStore(kv);
		await reopened.load();
		expect(reopened.generationOf('main', 't')).to.equal(reborn);
	});
});
