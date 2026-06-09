/**
 * FD-derived key bag over-claim regression (ticket `fd-derived-key-bag-overclaim`).
 *
 * `keysOf` reads a bag as a set when a *determination* / *equality* FD becomes
 * all-columns-covering on a narrow relation and `deriveKeysFromFds` then derives
 * a spurious unique key. The two FD shapes are structurally indistinguishable
 * from a genuine `K → (all_cols \ K)` key FD, so the fix lives at the four
 * producers (mirroring ticket `join-fanning-isset-overclaim`): a
 * determination/equality FD contributes an all-covering key only when one of its
 * endpoints is a genuine superkey at that node.
 *
 * Four producer sites, each with a repro (DISTINCT wrongly eliminated → must now
 * survive + return the correctly-deduplicated rows) and a control (a genuinely
 * unique endpoint ⇒ DISTINCT must still be eliminated):
 *
 *   1. ProjectNode injective bidirectional FD  (`select -c, c` with c non-unique)
 *   2. join equi-pair bidirectional FD         (`g.k = g2.w` fan-out)
 *   3. LEFT-outer side-key FD survives fan-out  (`l left join r on l.k = r.w`)
 *   4. filter `a = b` equality bidirectional FD (`where a = b`, a/b non-unique)
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { DistinctNode } from '../src/planner/nodes/distinct-node.js';

function findNodes<T extends PlanNode>(plan: PlanNode, ctor: new (...args: never[]) => T): T[] {
	const out: T[] = [];
	const stack: PlanNode[] = [plan];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node instanceof ctor) out.push(node as T);
		for (const child of node.getChildren()) stack.push(child);
	}
	return out;
}

async function rowCount(db: Database, sql: string): Promise<number> {
	let n = 0;
	for await (const _ of db.eval(sql)) n++;
	return n;
}

describe('FD-derived key bag over-claim: producer-side gating', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			-- Site 1: c_real1 is NOT unique (PK is the text column).
			create table t1 (c_text0 text not null primary key, c_real1 real);
			insert into t1 values ('a', 1.5), ('b', 1.5), ('c', 2.0);
			-- Site 1 control: c0 IS the (unique) PK.
			create table tpk (c0 integer primary key, x integer);
			insert into tpk values (1, 10), (2, 20), (3, 30);

			-- Site 2: g.k = g2.w fans out (k/w non-unique).
			create table g (id integer primary key, k integer, v integer);
			create table g2 (id integer primary key, w integer);
			insert into g values (1, 100, 5);
			insert into g2 values (10, 100), (11, 100);
			-- Site 2 control: pk = pk (1:1, no fan-out), matching data.
			create table h (id integer primary key, w integer);
			create table h2 (id integer primary key, z integer);
			insert into h values (1, 100), (2, 200);
			insert into h2 values (1, 5), (2, 6);

			-- Site 3: l left join r on l.k = r.w fans out the single l row.
			create table l (id integer primary key, k integer);
			create table r (id integer primary key, w integer);
			insert into l values (1, 100);
			insert into r values (10, 100), (11, 100);
			-- Site 3 control: l.k = r2.id is key-covered (≤1:1, no fan-out).
			create table r2 (id integer primary key, c integer);
			insert into r2 values (100, 7), (101, 8);

			-- Site 4: a = b over non-unique a/b.
			create table tab (id integer primary key, a integer, b integer);
			insert into tab values (1, 1, 1), (2, 1, 1), (3, 2, 2);
			-- Site 4 control: a IS the (unique) PK.
			create table tpk2 (a integer primary key, b integer);
			insert into tpk2 values (1, 1), (2, 5), (3, 3);
		`);
	});
	afterEach(async () => { await db.close(); });

	// ---- Site 1: ProjectNode injective bidirectional FD ----
	it('site 1 — DISTINCT over an injective projection of a NON-unique column is RETAINED', async () => {
		const sql = 'select distinct -t1.c_real1, t1.c_real1 from t1';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (c_real1 not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (-c,c) pairs').to.equal(2);
	});

	it('site 1 control — DISTINCT over an injective projection of the PK is ELIMINATED', () => {
		const sql = 'select distinct -tpk.c0, tpk.c0 from tpk';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'injective over a unique col is still a set')
			.to.have.length(0);
	});

	// ---- Site 2: join equi-pair bidirectional FD ----
	it('site 2 — DISTINCT over equi columns of a fanning join is RETAINED', async () => {
		const sql = 'select distinct g.k, g2.w from g join g2 on g.k = g2.w';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (k/w not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (k,w) pair').to.equal(1);
	});

	it('site 2 control — DISTINCT over a pk=pk (1:1) join is ELIMINATED', () => {
		const sql = 'select distinct h.id, h2.z from h join h2 on h.id = h2.id';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'preserved PK keeps the body a set')
			.to.have.length(0);
	});

	// ---- Site 3: LEFT-outer side-key FD survives fan-out ----
	it('site 3 — DISTINCT over a fanning LEFT join is RETAINED', async () => {
		const sql = 'select distinct l.id, l.k from l left join r on l.k = r.w';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (l fanned out)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (id,k) row').to.equal(1);
	});

	it('site 3 control — DISTINCT over a key-covered (non-fanning) LEFT join is ELIMINATED', () => {
		const sql = 'select distinct l.id, l.k from l left join r2 on l.k = r2.id';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'left key survives a ≤1:1 left join')
			.to.have.length(0);
	});

	// ---- Site 3b: RIGHT-outer mirror — the FANNED side is on the right ----
	// The implement handoff flagged the RIGHT arm of `propagateJoinFds` as having no
	// dedicated DISTINCT repro (only LEFT was pinned). `r right join l` makes `l` the
	// preserved (right) side; `r.w = l.k` does not cover `r`'s key, so `l` fans out and
	// its key FD must be dropped in right's own indices BEFORE the shift.
	it('site 3b — DISTINCT over a fanning RIGHT join is RETAINED', async () => {
		const sql = 'select distinct l.id, l.k from r right join l on r.w = l.k';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (right side l fanned out)')
			.to.have.length.greaterThan(0);
		// Without the gate the fanned (id,k)=(1,100) row would emit twice; the surviving
		// DISTINCT collapses it to the one genuine distinct pair.
		expect(await rowCount(db, sql), 'one distinct (id,k) row').to.equal(1);
	});

	it('site 3b control — DISTINCT over a key-covered (non-fanning) RIGHT join is ELIMINATED', () => {
		// `r2.id = l.k` covers r2's PK (the left side), so the preserved right side `l`
		// matches ≤1 left row and does not fan — its key survives ⇒ the body is a set.
		const sql = 'select distinct l.id, l.k from r2 right join l on r2.id = l.k';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'right key survives a ≤1:1 right join')
			.to.have.length(0);
	});

	// ---- Site 4: filter `a = b` equality bidirectional FD ----
	it('site 4 — DISTINCT over `a = b` with NON-unique a/b is RETAINED', async () => {
		const sql = 'select distinct a, b from tab where a = b';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 4 control — DISTINCT over `a = b` where a is the PK is ELIMINATED', () => {
		const sql = 'select distinct a, b from tpk2 where a = b';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ b unique under a=b ⇒ set')
			.to.have.length(0);
	});
});
