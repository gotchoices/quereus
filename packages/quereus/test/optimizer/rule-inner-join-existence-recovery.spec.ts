import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

const PHYSICAL_JOIN_OPS = new Set(['HASHJOIN', 'MERGEJOIN', 'BLOOMJOIN']);

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function hasPhysicalJoin(rows: readonly PlanRow[]): boolean {
	return rows.some(r => PHYSICAL_JOIN_OPS.has(r.op));
}

/** Existence-flag descriptors on the (logical) JoinNode in the optimized plan. */
function joinExistence(rows: readonly PlanRow[]): string[] | undefined {
	const join = rows.find(r => r.op === 'JOIN' && r.properties);
	if (!join?.properties) return undefined;
	const props = JSON.parse(join.properties) as { existence?: string[] };
	return props.existence;
}

/** joinType of the first join op carrying properties (semi/anti/left/inner/…). */
function joinTypeOf(rows: readonly PlanRow[]): string | undefined {
	const join = rows.find(r => JOIN_OPS.has(r.op) && r.properties);
	if (!join?.properties) return undefined;
	return (JSON.parse(join.properties) as { joinType?: string }).joinType;
}

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/**
 * Baseline: run `sql` with ONLY the inner-recovery rule disabled, so the
 * flag-bearing nested-loop left join survives and `where flag` filters the
 * appended boolean. Every recovered inner-join shape must return byte-identical
 * rows to this baseline.
 */
async function resultsNoRecovery(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([...(base.disabledRules ?? []), 'inner-join-existence-recovery']),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

describe('ruleInnerJoinExistenceRecovery', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// exc→exp with NO declared FK; a known match pattern so flag values are pinned.
	//   cc=1 (pr=1) matches pv=10; cc=2 (pr=9) no match; cc=3 (pr=2) matches pv=20; cc=4 (pr=null) no match
	async function seedExisting(): Promise<void> {
		await db.exec('create table exc (cc integer primary key, pr integer null, cv integer null) using memory');
		await db.exec('create table exp (pp integer primary key, pv integer null) using memory');
		await db.exec('insert into exp values (1, 10), (2, 20)');
		await db.exec('insert into exc values (1, 1, 100), (2, 9, 200), (3, 2, 300), (4, null, 400)');
	}

	// Right side NOT unique on the join column: cc=1 matches THREE fparent rows
	// (pp=1), cc=2 matches none. A plain `left join … where flag` FANS OUT (K rows
	// per matched left row); a semi rewrite would (wrongly) collapse to one. An
	// INNER join keeps all K — the headline capability the semi rule cannot do.
	async function setupFanOut(): Promise<void> {
		await db.exec('create table fchild (cc integer primary key) using memory');
		await db.exec('create table fparent (id integer primary key, pp integer) using memory');
		await db.exec('insert into fchild values (1), (2)');
		await db.exec('insert into fparent values (10, 1), (11, 1), (12, 1)');
	}

	describe('inner recovery (where flag + right column demanded)', () => {
		it('recovers an inner join from a probe-only flag with a right column demanded (flag gone, joinType inner)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pv: 10 },
				{ cc: 3, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('re-enables physical join selection (the flag no longer pins nested-loop)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
		});

		it('result equality vs the no-recovery (nested-loop+flag) baseline', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';
			expect(await results(db, q)).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('probe normal forms (all positive ⇒ inner)', () => {
		const forms: ReadonlyArray<string> = ['hasP', 'hasP = true', 'hasP is true', 'hasP is not false', 'not not hasP'];
		for (const probe of forms) {
			it(`\`where ${probe}\` recovers an inner join`, async () => {
				await seedExisting();
				const q =
					`select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where ${probe} order by c.cc`;

				const rows = await planRows(db, q);
				expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
				expect(joinTypeOf(rows)).to.equal('inner');

				const out = await results(db, q);
				expect(out).to.deep.equal([
					{ cc: 1, pv: 10 },
					{ cc: 3, pv: 20 },
				]);
				expect(out).to.deep.equal(await resultsNoRecovery(db, q));
			});
		}
	});

	describe('fan-out + right column (the case the semi rule cannot handle)', () => {
		it('keeps all K fanned-out rows (no collapse) — inner join over a non-unique right', async () => {
			await setupFanOut();
			// cc=1 matches three fparent rows (id 10,11,12). The semi rule abstains
			// (fan-out guard AND right column demanded); the inner rule fires and keeps
			// every matched pair, byte-identical to the baseline.
			const q =
				'select c.cc as cc, p.id as pid from fchild c left join fparent p on p.pp = c.cc exists right as h where h order by c.cc, pid';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pid: 10 },
				{ cc: 1, pid: 11 },
				{ cc: 1, pid: 12 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('residual AND-conjunct (split, retained above the inner join)', () => {
		it('`where hasP and cv > 150` recovers an inner join with the residual filter retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP and c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			// Matched: cc 1 (cv 100) and cc 3 (cv 300). cv > 150 keeps only cc 3.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ cc: 3, pv: 20 }]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-fire rejections', () => {
		it('negative probe `where not hasP` + right column ⇒ stays a left join (anti rows have a NULL right side)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where not hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained on a negative probe').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			// Unmatched rows: cc 2 (pr 9) and cc 4 (pr null), both with NULL pv.
			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 2, pv: null },
				{ cc: 4, pv: null },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('no right column demanded ⇒ semijoin-existence-recovery wins (semi, NOT inner)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows), 'semi rule wins the no-right-col half').to.equal('semi');

			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 3]);
		});

		it('flag also selected: `select cc, hasP, p.pv … where hasP` keeps the flag', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasP, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained when selected').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasP: true, pv: 10 },
				{ cc: 3, hasP: true, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('OR-probe: `where hasP or cv > 150` keeps the flag (not a probe shape)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP or c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained on OR-probe').to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('`where hasP is not null` keeps the flag (constant over the never-null flag, not a probe)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP is not null order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});

		it('two demanded flags (one probed, one selected): no conversion, flags retained', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, p.pv as pv, hasB from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasA order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasA', 'exists right as hasB']);
			expect(joinTypeOf(rows)).to.equal('left');

			const out = await results(db, q);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('cascade with join-existence-pruning', () => {
		it('undemanded sibling flag is pruned first, THEN the sole survivor + right col recovers an inner join', async () => {
			await seedExisting();
			// hasA is unused → join-existence-pruning drops it, leaving a SOLE hasB,
			// which (with p.pv demanded) this rule recovers to an inner join.
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB where hasB order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			expect(joinTypeOf(rows)).to.equal('inner');

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, pv: 10 },
				{ cc: 3, pv: 20 },
			]);
			expect(out).to.deep.equal(await resultsNoRecovery(db, q));
		});
	});

	describe('no-op when disabled', () => {
		it('the flag-bearing nested-loop left join survives when the rule is disabled', async () => {
			await seedExisting();
			db.optimizer.updateTuning({
				...DEFAULT_TUNING,
				disabledRules: new Set(['inner-join-existence-recovery']),
			});
			const q =
				'select c.cc as cc, p.pv as pv from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasP']);
			expect(joinTypeOf(rows)).to.equal('left');
		});
	});
});
