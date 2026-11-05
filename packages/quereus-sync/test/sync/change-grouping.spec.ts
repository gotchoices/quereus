/**
 * Unit tests for transaction grouping (`buildTransactionChangeSets`).
 *
 * These exercise the pure grouping/bounding logic in isolation: one ChangeSet
 * per source transaction per filing tick, never merged; ordering and bounding by
 * filing position; oversized-transaction telemetry; DDL grouping; the `cursor`.
 */

import { expect } from 'chai';
import {
	buildTransactionChangeSets,
	filedAtOrigin,
	groupByTransactionAndTick,
	type FiledChange,
} from '../../src/sync/change-grouping.js';
import { createHLC, deterministicTxnId, compareHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, type SiteId } from '../../src/clock/site.js';
import type { Change, ColumnChange, SchemaMigration } from '../../src/sync/protocol.js';

const SITE = generateSiteId();
const OTHER_SITE = generateSiteId();

/** Build a column change whose HLC is `(wallTime, counter, site, opSeq)`. */
function col(
	wallTime: number,
	counter: number,
	opSeq: number,
	site: SiteId = SITE,
	column = `c${opSeq}`,
): ColumnChange {
	return {
		type: 'column',
		schema: 'main',
		table: 'users',
		pk: [1],
		column,
		value: `v${opSeq}`,
		hlc: createHLC(BigInt(wallTime), counter, site, opSeq),
	};
}

function migration(
	wallTime: number,
	counter: number,
	opSeq: number,
	site: SiteId = SITE,
): SchemaMigration {
	return {
		type: 'create_table',
		schema: 'main',
		table: 'users',
		ddl: 'create table users (id integer primary key)',
		hlc: createHLC(BigInt(wallTime), counter, site, opSeq),
		schemaVersion: 1,
	};
}

function base(wallTime: number, counter: number, site: SiteId = SITE): HLC {
	return createHLC(BigInt(wallTime), counter, site, 0);
}

/** A change another site wrote, filed by `SITE` at `(wallTime, counter, SITE, opSeq)`. */
function filedLate(change: ColumnChange, wallTime: number, counter: number, opSeq: number): FiledChange {
	return { change, position: createHLC(BigInt(wallTime), counter, SITE, opSeq) };
}

describe('change-grouping', () => {
	describe('buildTransactionChangeSets', () => {
		it('returns [] for an empty stream', () => {
			expect(buildTransactionChangeSets([], [], 1000)).to.deep.equal([]);
		});

		it('groups one transaction (N facts) into one ChangeSet in opSeq order', () => {
			// Deliberately out of opSeq order to verify the grouper sorts.
			const changes: Change[] = [col(1000, 0, 2), col(1000, 0, 0), col(1000, 0, 1)];

			const result = buildTransactionChangeSets(filedAtOrigin(changes), [], 1000);

			expect(result).to.have.lengthOf(1);
			const cs = result[0];
			expect(cs.changes.map(c => (c as ColumnChange).column)).to.deep.equal(['c0', 'c1', 'c2']);
			// hlc is the group's max fact HLC (last opSeq).
			expect(cs.hlc.opSeq).to.equal(2);
			// Deterministic id derived from the base (wallTime, counter, siteId).
			expect(cs.transactionId).to.equal(deterministicTxnId(base(1000, 0)));
			expect(cs.schemaMigrations).to.deep.equal([]);
		});

		it('never merges two transactions: distinct transactionId and hlc', () => {
			const t1 = [col(1000, 0, 0), col(1000, 0, 1)];
			const t2 = [col(1000, 1, 0), col(1000, 1, 1)];

			const result = buildTransactionChangeSets(filedAtOrigin([...t2, ...t1]), [], 1000);

			expect(result).to.have.lengthOf(2);
			// Ordered by base HLC ascending regardless of input order.
			expect(result[0].transactionId).to.equal(deterministicTxnId(base(1000, 0)));
			expect(result[1].transactionId).to.equal(deterministicTxnId(base(1000, 1)));
			expect(result[0].transactionId).to.not.equal(result[1].transactionId);
			expect(compareHLC(result[0].hlc, result[1].hlc)).to.be.lessThan(0);
		});

		it('bounds at transaction granularity: stops once cumulative >= batchSize', () => {
			const t1 = [col(1000, 0, 0), col(1000, 0, 1)];
			const t2 = [col(1000, 1, 0), col(1000, 1, 1)];
			const t3 = [col(1000, 2, 0), col(1000, 2, 1)];

			// batchSize 3: after t1 cumulative=2 (<3, continue); after t2 cumulative=4 (>=3, stop).
			const result = buildTransactionChangeSets(filedAtOrigin([...t1, ...t2, ...t3]), [], 3);

			expect(result).to.have.lengthOf(2);
			expect(result[0].changes).to.have.lengthOf(2);
			expect(result[1].changes).to.have.lengthOf(2);
			// t3 is not returned this round.
			expect(result.map(cs => cs.transactionId)).to.not.include(
				deterministicTxnId(base(1000, 2)),
			);
		});

		it('never splits an oversized transaction; reports it via onOversized', () => {
			const facts = [0, 1, 2, 3, 4].map(opSeq => col(1000, 0, opSeq));
			const oversized: Array<{ id: string; count: number }> = [];

			const result = buildTransactionChangeSets(filedAtOrigin(facts), [], 2, (id, count) =>
				oversized.push({ id, count }),
			);

			expect(result).to.have.lengthOf(1);
			expect(result[0].changes).to.have.lengthOf(5);
			expect(oversized).to.deep.equal([
				{ id: deterministicTxnId(base(1000, 0)), count: 5 },
			]);
		});

		it('forms a DDL-only ChangeSet for a transaction with no data facts', () => {
			const result = buildTransactionChangeSets([], [migration(1000, 0, 0)], 1000);

			expect(result).to.have.lengthOf(1);
			expect(result[0].changes).to.deep.equal([]);
			expect(result[0].schemaMigrations).to.have.lengthOf(1);
			expect(result[0].hlc.opSeq).to.equal(0);
			expect(result[0].transactionId).to.equal(deterministicTxnId(base(1000, 0)));
		});

		it('groups DDL + DML of the same transaction into one ChangeSet (DDL at lower opSeq)', () => {
			// Migration takes opSeq 0; data facts take 1, 2 — same base.
			const result = buildTransactionChangeSets(
				filedAtOrigin([col(1000, 0, 1), col(1000, 0, 2)]),
				[migration(1000, 0, 0)],
				1000,
			);

			expect(result).to.have.lengthOf(1);
			const cs = result[0];
			expect(cs.schemaMigrations).to.have.lengthOf(1);
			expect(cs.changes).to.have.lengthOf(2);
			// Group hlc is the max fact (last DML opSeq), not the migration.
			expect(cs.hlc.opSeq).to.equal(2);
			// Filed where it was written, so the resume position is the hlc itself.
			expect(cs.cursor).to.equal(undefined);
		});

		it('orders and cuts by filing position, and resumes from the position, when an old change was filed late', () => {
			// OTHER_SITE wrote at 900; SITE filed it at tick (2000, 0), after its own writes at 1000 and 1500.
			const late = filedLate(col(900, 0, 0, OTHER_SITE), 2000, 0, 0);
			const own = filedAtOrigin([col(1000, 0, 0), col(1500, 0, 0)]);

			const firstTwo = buildTransactionChangeSets([late, ...own], [], 2);

			// Origin order would put the late change first and cut after the 1000 write, leaving
			// the reply's greatest hlc at 1000 with the 1500 write and nothing else to resume past.
			expect(firstTwo.map(cs => cs.hlc.wallTime)).to.deep.equal([1000n, 1500n]);

			const all = buildTransactionChangeSets([late, ...own], [], 1000);
			expect(all.map(cs => cs.hlc.wallTime)).to.deep.equal([1000n, 1500n, 900n]);
			expect(all[2].cursor).to.deep.equal(late.position);
			expect(all[2].transactionId).to.equal(deterministicTxnId(base(900, 0, OTHER_SITE)));
		});

		it('splits one transaction filed at two ticks into two ChangeSets, each with its own cursor', () => {
			const first = filedLate(col(900, 0, 0, OTHER_SITE), 2000, 0, 0);
			const between = filedLate(col(950, 0, 0, OTHER_SITE), 2000, 1, 0);
			const second = filedLate(col(900, 0, 1, OTHER_SITE), 2000, 2, 0);

			const result = buildTransactionChangeSets([second, between, first], [], 1000);

			expect(result.map(cs => cs.transactionId)).to.deep.equal([
				deterministicTxnId(base(900, 0, OTHER_SITE)),
				deterministicTxnId(base(950, 0, OTHER_SITE)),
				deterministicTxnId(base(900, 0, OTHER_SITE)),
			]);
			expect(result.map(cs => cs.cursor)).to.deep.equal([first.position, between.position, second.position]);
		});

		it("strips a migration's own position and files a late one with its transaction's data", () => {
			const lateMigration = { ...migration(900, 0, 0, OTHER_SITE), position: createHLC(2000n, 0, SITE, 0) };
			const data = filedLate(col(900, 0, 1, OTHER_SITE), 2000, 0, 1);

			const result = buildTransactionChangeSets([data], [lateMigration], 1000);

			expect(result).to.have.lengthOf(1);
			expect(result[0].schemaMigrations).to.deep.equal([migration(900, 0, 0, OTHER_SITE)]);
			expect(result[0].cursor).to.deep.equal(data.position);
		});
	});

	describe('groupByTransactionAndTick', () => {
		it('separates transactions from different sites at the same (wallTime, counter)', () => {
			const groups = groupByTransactionAndTick(
				filedAtOrigin([col(1000, 0, 0, SITE), col(1000, 0, 0, OTHER_SITE)]),
				[],
			);
			expect(groups).to.have.lengthOf(2);
		});
	});
});
