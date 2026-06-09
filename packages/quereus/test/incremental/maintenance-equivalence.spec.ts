import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode, type SqlValue } from '../../src/common/types.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Maintenance-equivalence property harness — the correctness oracle for row-time
 * materialized-view maintenance (`MaintenancePlan`'s `'inverse-projection'` arm).
 *
 * For a zoo of eligible covering-index body shapes, it asserts the fundamental
 * invariant after every random source mutation and after rollback:
 *
 *     read(MV backing)  ==  evaluate(body against source)        (as multisets)
 *
 * The MV is read via `select * from mv` (resolves to its synchronously-maintained
 * backing table); the oracle re-runs the MV's defining SELECT *live* against the
 * source table. Maintenance and live evaluation must agree for any mutation
 * sequence — including predicate-scope transitions and key-changing updates — and
 * must revert in lockstep when the enclosing transaction rolls back.
 *
 * This is the regression net every subsequent incremental-maintenance ticket runs
 * against; new body shapes are admitted only once they stay green here. Runs under
 * `yarn test` (Mocha + ts-node/esm), no separate config.
 *
 * Shape sets covered: covering-index (`'inverse-projection'`), single-source aggregate
 * (`'residual-recompute'`), and single-source lateral-TVF fan-out (`'prefix-delete'`).
 * Shapes NOT covered here (future tickets extend the harness): fanning keyed joins and
 * MV-over-MV chains over these arms.
 */

/** An eligible covering-index body shape: its defining SELECT is both the MV body and
 *  the live oracle. Every shape projects the source PK (`id`) so it is a keyed set. */
interface BodyShape {
	readonly label: string;
	readonly body: string;
}

/** All shapes read the same source `src (id pk, a, b, k)`; only the body varies so the
 *  one mutation generator drives them all (inserts / non-key updates / key-changing
 *  updates / deletes against the shared columns). */
const SHAPES: readonly BodyShape[] = [
	// Single-column passthrough projection (PK only), no predicate.
	{ label: 'single-column passthrough (PK only), no predicate', body: 'select id from src' },
	// Multi-column passthrough with a partial WHERE — random mutations move rows in and
	// out of the `k > 5` true-region (predicate-scope transitions).
	{ label: 'multi-column passthrough + partial WHERE (predicate-scope transitions)', body: 'select id, a, b from src where k > 5' },
	// Projection that reorders source columns (a permutation, not identity) while still
	// covering the PK.
	{ label: 'column-reordering projection (permutation, not identity)', body: 'select b, a, id from src' },
	// Passthrough whose maintenance is exercised primarily by key-changing UPDATEs (the
	// generator below mutates `id` itself).
	{ label: 'passthrough exercised by key-changing UPDATEs', body: 'select id, a from src' },
	// --- Deterministic expression-projection columns (materialized-view-rowtime-
	//     expression-projections). The PK stays passthrough; the computed columns must
	//     equal the live body's value after every mutation, proving maintenance evaluates
	//     project(row) (not just permutes columns). ---
	// Arithmetic computed columns alongside the PK.
	{ label: 'arithmetic expression columns', body: 'select id, a + 1 as a1, b * 2 as b2 from src' },
	// Deterministic function + CAST computed columns (abs over a value that straddles 0).
	{ label: 'function + cast expression columns', body: 'select id, abs(a - 5) as aa, cast(b as text) as bt from src' },
	// CASE expression column.
	{ label: 'CASE expression column', body: 'select id, case when k > 5 then a else b end as cab from src' },
	// Expression column UNDER a partial WHERE — computed value must track rows moving in
	// and out of the `k > 5` scope (predicate-scope transitions) and key-changing updates.
	{ label: 'expression column + partial WHERE (predicate-scope transitions)', body: 'select id, a, a * b as ab from src where k > 5' },
];

/** One random source mutation. Key-changing updates rewrite the PK itself; collisions
 *  are tolerated (see {@link applyMutation}). */
type Mutation =
	| { readonly kind: 'insert'; readonly id: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'update'; readonly id: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'updateKey'; readonly oldId: number; readonly newId: number; readonly a: number; readonly b: number; readonly k: number }
	| { readonly kind: 'delete'; readonly id: number };

// A small id space (so inserts/key-changes collide and predicate transitions recur)
// and a `k` range straddling the `k > 5` boundary.
const idArb = fc.integer({ min: 1, max: 6 });
const valArb = fc.integer({ min: 0, max: 10 });

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
	fc.record({ kind: fc.constant('insert' as const), id: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('update' as const), id: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('updateKey' as const), oldId: idArb, newId: idArb, a: valArb, b: valArb, k: valArb }),
	fc.record({ kind: fc.constant('delete' as const), id: idArb }),
);

function sqlFor(m: Mutation): string {
	switch (m.kind) {
		case 'insert': return `insert into src (id, a, b, k) values (${m.id}, ${m.a}, ${m.b}, ${m.k})`;
		case 'update': return `update src set a = ${m.a}, b = ${m.b}, k = ${m.k} where id = ${m.id}`;
		case 'updateKey': return `update src set id = ${m.newId}, a = ${m.a}, b = ${m.b}, k = ${m.k} where id = ${m.oldId}`;
		case 'delete': return `delete from src where id = ${m.id}`;
	}
}

/**
 * Apply one mutation, tolerating PK-collision constraint violations. A plain ABORT
 * constraint failure is statement-atomic — it reverts both the source write and its
 * row-time backing maintenance (53-materialized-views-rowtime.sqllogic §2), leaving
 * the transaction open and source/MV still equivalent. Any *other* error (e.g. an
 * `INTERNAL` from maintenance) propagates and fails the property — that is the bug
 * class this harness is built to catch.
 */
async function execTolerant(db: Database, sql: string): Promise<void> {
	try {
		await db.exec(sql);
	} catch (e) {
		if (e instanceof QuereusError && e.code === StatusCode.CONSTRAINT) return;
		throw e;
	}
}

async function applyMutation(db: Database, m: Mutation): Promise<void> {
	await execTolerant(db, sqlFor(m));
}

/** Canonical, order-stable serialization of a single result row's values. Rows are
 *  compared positionally (the MV's `select *` and the body share an identical column
 *  order), so a value array is a faithful row key. */
function canonRow(values: readonly SqlValue[]): string {
	return JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** Read a query as an order-insensitive multiset of canonical rows. */
async function readMultiset(db: Database, sql: string): Promise<string[]> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(canonRow(Object.values(row) as SqlValue[]));
	}
	return rows.sort();
}

/** Assert `read(MV) == evaluate(body)` as multisets. */
async function assertEquivalent(db: Database, body: string, phase: string): Promise<void> {
	const fromMv = await readMultiset(db, 'select * from mv');
	// The oracle must recompute `body` LIVE from the source. The body is, by
	// construction, the MV's own defining SELECT, so the read-side query-rewrite rule
	// (`rule-materialized-view-rewrite`) would otherwise redirect it to the very
	// backing this oracle exists to check — making the comparison vacuous. Disable it
	// for the oracle read only (the `select * from mv` above resolves to the backing
	// directly, independent of the rule).
	const prev = db.optimizer.tuning;
	db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
	let fromBody: string[];
	try {
		fromBody = await readMultiset(db, body);
	} finally {
		db.optimizer.updateTuning(prev);
	}
	expect(fromMv, `${phase}: MV backing diverged from live body`).to.deep.equal(fromBody);
}

/**
 * Single-source aggregate body shapes (`select g…, agg(…) from src [where P] group by g…`)
 * maintained by the `'residual-recompute'` arm. The shared `mutationArb` drives the
 * cases needed: `insert` adds rows; `update`/`updateKey` rewrite `k`/`a`, so they move
 * rows across `group by k` / `group by a, k` groups (group-key-changing updates) and
 * across the `a > 3` partial-WHERE scope; `delete` (plus collisions) empties groups. The
 * oracle re-runs the same aggregate body live, so incremental maintenance and live
 * evaluation must agree — including emptied groups, where the residual returns zero rows
 * and the backing row must disappear.
 */
const AGGREGATE_SHAPES: readonly BodyShape[] = [
	{ label: 'group by k: count + sum (group-key-changing updates, emptied groups)', body: 'select k, count(*) as c, sum(a) as s from src group by k' },
	{ label: 'group by k + partial WHERE a > 3 (predicate-scope transitions)', body: 'select k, count(*) as c, sum(a) as s from src where a > 3 group by k' },
	{ label: 'group by k: count + sum + min + max', body: 'select k, count(*) as c, sum(a) as s, min(b) as mn, max(b) as mx from src group by k' },
	{ label: 'multi-column group by (a, k)', body: 'select a, k, count(*) as c, sum(b) as s from src group by a, k' },
];

/**
 * Define one equivalence suite per body shape: after every random mutation (and after
 * rollback), the synchronously-maintained MV backing must equal the live body as a
 * multiset. Shared by the covering-index (`'inverse-projection'`), single-source
 * aggregate (`'residual-recompute'`), and full-rebuild (`'full-rebuild'`) shape sets.
 *
 * `afterCreate` (optional) runs once per case immediately after the MV is created, before
 * any mutation — the full-rebuild suites use it to swap the registered bounded-delta plan
 * for a freshly-built `'full-rebuild'` plan over the same body (see {@link forceFullRebuild}),
 * so the SAME property then exercises the floor arm end-to-end.
 */
function defineEquivalenceSuite(
	suiteTitle: string,
	shapes: readonly BodyShape[],
	afterCreate?: (db: Database) => void,
): void {
	describe(suiteTitle, () => {
		for (const shape of shapes) {
			describe(shape.label, () => {
				let db: Database;

				beforeEach(async () => {
					db = new Database();
					await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
					// Committed seed straddling the `k > 5` / `a > 3` predicates, restored to
					// before every run by the always-rolled-back transaction below.
					await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2), (3, 7, 1, 9)');
					await db.exec(`create materialized view mv as ${shape.body}`);
					if (afterCreate) afterCreate(db);
				});

				afterEach(async () => { await db.close(); });

				it('read(MV) == evaluate(body) across random mutations, in-txn and after rollback', async () => {
					await fc.assert(fc.asyncProperty(
						fc.array(mutationArb, { minLength: 1, maxLength: 10 }),
						async (mutations) => {
							// Equivalent against the committed baseline.
							await assertEquivalent(db, shape.body, 'baseline');

							await db.exec('begin');
							try {
								for (const m of mutations) await applyMutation(db, m);
								// Reads-own-writes: the MV backing reflects every pending source
								// write mid-transaction, matching the live body.
								await assertEquivalent(db, shape.body, 'in-transaction');
							} finally {
								await db.exec('rollback');
							}

							// Maintenance reverted in lockstep with the rolled-back source writes.
							await assertEquivalent(db, shape.body, 'post-rollback');
						},
					), { numRuns: 40 });
				});
			});
		}
	});
}

/**
 * Single-source lateral-TVF fan-out body shapes (`select T.pk…, …, f.value from T cross
 * join lateral generate_series(1, <col>) f`) maintained by the `'prefix-delete'` arm. Each
 * base row fans out to `<col>` rows keyed by the generated `value`; the backing PK is the
 * composite product key `(id, value)`. The shared `mutationArb` drives every case: `insert`
 * adds a base row's whole fan-out; `update` rewrites `a`/`k`, growing/shrinking the fan-out
 * (and moving rows across the `k > 5` partial-WHERE scope); `updateKey` rewrites the base PK
 * `id`, moving the entire prefix (the by-prefix delete of the OLD prefix + recompute of the
 * NEW); `delete` (plus collisions) removes a slice. `generate_series(1, n)` for `n ≤ 0`
 * yields zero rows — a base row with `a`/`k` ≤ 0, or out of the WHERE scope, contributes no
 * backing rows, so the oracle and the maintained backing must agree on the empty fan-out.
 */
const LATERAL_TVF_SHAPES: readonly BodyShape[] = [
	{ label: 'lateral generate_series fan-out (PK + fan-out value)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.a) f' },
	{ label: 'lateral fan-out + passthrough columns (id, a, k, value)', body: 'select src.id, src.a, src.k, f.value from src cross join lateral generate_series(1, src.a) f' },
	{ label: 'lateral fan-out + partial WHERE k>5 (scope transitions on/off)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.a) f where src.k > 5' },
	{ label: 'lateral fan-out driven by k (column other than a)', body: 'select src.id, f.value from src cross join lateral generate_series(1, src.k) f' },
];

defineEquivalenceSuite('Materialized-view maintenance equivalence (covering-index shapes)', SHAPES);
defineEquivalenceSuite('Materialized-view maintenance equivalence (single-source aggregate shapes)', AGGREGATE_SHAPES);
defineEquivalenceSuite('Materialized-view maintenance equivalence (lateral-TVF fan-out shapes)', LATERAL_TVF_SHAPES);

/**
 * Lateral-TVF fan-out (`'prefix-delete'`) under a NON-binary (`text collate NOCASE`)
 * **base primary key** — the one collation shape the integer-PK fan-out suite above never
 * reaches. The `delete-by-prefix` primitive the arm deletes a base row's whole fan-out
 * slice with early-terminates its prefix scan on a *binary* compare (`scan-layer.ts`),
 * while the backing btree orders the base-PK prefix by the column's NOCASE collation. This
 * is reasoned sound for this arm — the backing base-PK column inherits the source PK
 * collation, and source-PK uniqueness collapses each NOCASE class to a single binary value,
 * so a base row's fan-out rows are binary-homogeneous and contiguous — and this suite is the
 * end-to-end exercise of that reasoning that the prior harness lacked.
 *
 * The id space is a small set of single letters in BOTH cases (`a`/`A`, `b`/`B`, …) so the
 * random mutations routinely:
 *   - collide under NOCASE (insert `'A'` while `'a'` exists → tolerated CONSTRAINT, the
 *     PK-uniqueness collapse);
 *   - rewrite the PK case-only (`update … set id='A' where id='a'` — the *same* PK under
 *     NOCASE, which still moves the stored byte value the backing keys on);
 *   - move the whole prefix (`'a' → 'b'`) and grow/shrink/empty the fan-out (`n` straddles 0).
 * Letters chosen so NOCASE order ≠ binary order is irrelevant to the oracle, but it ensures
 * the maintained backing exercises the NOCASE-ordered btree under the binary prefix delete.
 * The oracle re-runs the same body live; maintained backing and live body must agree as
 * multisets mid-transaction (reads-own-writes) and after rollback.
 */
describe('Materialized-view maintenance equivalence (lateral-TVF fan-out, NOCASE base PK)', () => {
	let db: Database;
	const body = 'select t.id, f.value from t cross join lateral generate_series(1, t.n) f';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id text collate NOCASE primary key, n integer)');
		// Committed seed straddling the empty-fan-out boundary (cherry n=0 → no backing rows).
		await db.exec("insert into t (id, n) values ('apple', 2), ('Banana', 3), ('cherry', 0)");
		await db.exec(`create materialized view mv as ${body}`);
	});

	afterEach(async () => { await db.close(); });

	type TextMutation =
		| { readonly kind: 'insert'; readonly id: string; readonly n: number }
		| { readonly kind: 'update'; readonly id: string; readonly n: number }
		| { readonly kind: 'updateKey'; readonly oldId: string; readonly newId: string; readonly n: number }
		| { readonly kind: 'delete'; readonly id: string };

	// Single letters in both cases — `'a'`/`'A'` are the SAME PK under NOCASE, so inserts
	// collide and key-changes are sometimes case-only rewrites, sometimes real moves.
	const idArb = fc.constantFrom('a', 'A', 'b', 'B', 'c', 'C', 'd');
	// `n` straddles 0 so a fan-out can grow, shrink, or empty (generate_series(1, n≤0) → 0 rows).
	const nArb = fc.integer({ min: -1, max: 4 });

	const textMutationArb: fc.Arbitrary<TextMutation> = fc.oneof(
		fc.record({ kind: fc.constant('insert' as const), id: idArb, n: nArb }),
		fc.record({ kind: fc.constant('update' as const), id: idArb, n: nArb }),
		fc.record({ kind: fc.constant('updateKey' as const), oldId: idArb, newId: idArb, n: nArb }),
		fc.record({ kind: fc.constant('delete' as const), id: idArb }),
	);

	const textSqlFor = (m: TextMutation): string => {
		switch (m.kind) {
			case 'insert': return `insert into t (id, n) values ('${m.id}', ${m.n})`;
			case 'update': return `update t set n = ${m.n} where id = '${m.id}'`;
			case 'updateKey': return `update t set id = '${m.newId}', n = ${m.n} where id = '${m.oldId}'`;
			case 'delete': return `delete from t where id = '${m.id}'`;
		}
	};

	it('read(MV) == evaluate(body) across random NOCASE-PK mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(textMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');

				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, textSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}

				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});

	it('a case-only base-PK rewrite (same NOCASE PK) re-keys the whole fan-out slice', async () => {
		await assertEquivalent(db, body, 'baseline');
		// 'apple' → 'APPLE' is the SAME PK under NOCASE but a different stored byte value the
		// backing keys on: the old slice is deleted by prefix and the new fan-out upserted, so
		// every backing row's id must now read the new byte value 'APPLE' and none read 'apple'.
		await db.exec("update t set id = 'APPLE' where id = 'apple'");
		await assertEquivalent(db, body, 'after case-only rewrite');
		// Distinct stored id byte-values: lowercase 'apple' is gone (re-keyed), 'APPLE' present,
		// 'Banana' untouched (cherry n=0 contributes no backing rows). canonRow is byte-exact.
		const ids = await readMultiset(db, 'select distinct id from mv');
		expect(ids, 'old-case slice re-keyed to the new byte value').to.deep.equal(
			[canonRow(['APPLE']), canonRow(['Banana'])].sort(),
		);
	});
});

/**
 * 1:1 inner-join body (`select t.id, t.fk, p.name from t join p on t.fk = p.id`) maintained
 * by the `'join-residual'` arm. T's NOT-NULL FK `t.fk → p.id` makes the inner join provably
 * 1:1 on T (no row loss via enforced referential integrity, no fan-out via p's unique PK),
 * so the backing is keyed on T's PK and each T row maps to one backing row.
 *
 * Random mutations drive BOTH sources: t inserts / FK-moving updates / key-changing updates
 * / deletes exercise the forward (T-PK-keyed) residual; p inserts / name updates / deletes
 * exercise the reverse (P-PK-keyed) lookup residual (upsert-only — inner-join + RI membership
 * is determined by `t.fk`, so a p write only re-derives the joined `name`). FK violations (a
 * `t.fk` with no matching p, a p delete with referencing children, or a colliding key-change)
 * surface as tolerated CONSTRAINT errors, statement-atomic on both source and backing. The
 * oracle re-runs the same join body live; the maintained backing must equal it as a multiset,
 * mid-transaction (reads-own-writes) and after rollback.
 */
describe('Materialized-view maintenance equivalence (1:1 inner-join shape)', () => {
	let db: Database;
	const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
		// Committed seed: p ids 1..4, t rows referencing them (two share fk=1).
		await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		await db.exec('insert into t (id, fk) values (1, 1), (2, 1), (3, 2), (4, 3)');
		await db.exec(`create materialized view mv as ${body}`);
	});

	afterEach(async () => { await db.close(); });

	type JoinMutation =
		| { readonly kind: 't-insert'; readonly id: number; readonly fk: number }
		| { readonly kind: 't-updateFk'; readonly id: number; readonly fk: number }
		| { readonly kind: 't-updateKey'; readonly oldId: number; readonly newId: number; readonly fk: number }
		| { readonly kind: 't-delete'; readonly id: number }
		| { readonly kind: 'p-insert'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-updateName'; readonly id: number; readonly name: string }
		| { readonly kind: 'p-delete'; readonly id: number };

	const tIdArb = fc.integer({ min: 1, max: 6 });
	// fk sometimes references a missing p (→ tolerated FK violation) and sometimes a new p.
	const fkArb = fc.integer({ min: 1, max: 8 });
	const newPArb = fc.integer({ min: 5, max: 8 });
	const nameArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'z');

	const joinMutationArb: fc.Arbitrary<JoinMutation> = fc.oneof(
		fc.record({ kind: fc.constant('t-insert' as const), id: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-updateFk' as const), id: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-updateKey' as const), oldId: tIdArb, newId: tIdArb, fk: fkArb }),
		fc.record({ kind: fc.constant('t-delete' as const), id: tIdArb }),
		fc.record({ kind: fc.constant('p-insert' as const), id: newPArb, name: nameArb }),
		fc.record({ kind: fc.constant('p-updateName' as const), id: fc.integer({ min: 1, max: 8 }), name: nameArb }),
		fc.record({ kind: fc.constant('p-delete' as const), id: newPArb }),
	);

	const joinSqlFor = (m: JoinMutation): string => {
		switch (m.kind) {
			case 't-insert': return `insert into t (id, fk) values (${m.id}, ${m.fk})`;
			case 't-updateFk': return `update t set fk = ${m.fk} where id = ${m.id}`;
			case 't-updateKey': return `update t set id = ${m.newId}, fk = ${m.fk} where id = ${m.oldId}`;
			case 't-delete': return `delete from t where id = ${m.id}`;
			case 'p-insert': return `insert into p (id, name) values (${m.id}, '${m.name}')`;
			case 'p-updateName': return `update p set name = '${m.name}' where id = ${m.id}`;
			case 'p-delete': return `delete from p where id = ${m.id}`;
		}
	};

	it('read(MV) == evaluate(body) across random t/p mutations, in-txn and after rollback', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(joinMutationArb, { minLength: 1, maxLength: 12 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');

				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, joinSqlFor(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}

				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 60 });
	});

	it('a removed join row (delete of a t row) drops exactly its backing row', async () => {
		await assertEquivalent(db, body, 'baseline');
		expect((await readMultiset(db, 'select * from mv')).length, 'baseline row count').to.equal(4);
		// Delete t id=2 (fk=1). Its joined row disappears; the other fk=1 row (id=1) stays.
		await db.exec('delete from t where id = 2');
		await assertEquivalent(db, body, 'after removed join row');
		expect((await readMultiset(db, 'select * from mv')).length, 'after t-delete row count').to.equal(3);
	});

	it('a lookup-side (p) name update refreshes every joined backing row for that p', async () => {
		await db.exec("update p set name = 'A!' where id = 1");
		await assertEquivalent(db, body, 'after p name update');
		// Both t rows with fk=1 (ids 1 and 2) must now read p.name = 'A!'.
		const rows = await readMultiset(db, "select id from mv where name = 'A!'");
		expect(rows.length, "rows referencing updated p name").to.equal(2);
	});
});

/* ─────────────────────────── full-rebuild floor ─────────────────────────── */

/** A freshly-built `'full-rebuild'` plan, as inspected by the swap helper. */
interface FullRebuildPlanLike {
	readonly kind: string;
	readonly sourceBases: string[];
}

/** White-box reach into the manager internals the swap helper drives. The map key is
 *  lowercase `schema.name` (see `mvKey` in database-materialized-views.ts). */
interface MvManagerInternals {
	buildFullRebuildPlan(mv: unknown, analyzed: unknown): FullRebuildPlanLike;
	releaseRowTime(key: string): void;
	readonly rowTime: Map<string, { kind: string }>;
	readonly rowTimeBySource: Map<string, Set<string>>;
}
interface ManagerHandle { readonly materializedViewManager: MvManagerInternals; }

/**
 * Swap a registered MV's maintenance plan for a freshly-built `'full-rebuild'` plan over
 * the SAME body, reusing the create-time backing. `buildMaintenancePlan` does not route
 * bodies to the floor yet (the eligibility flip is the next ticket), so this is how the
 * floor arm is exercised end-to-end in isolation: the body must ALSO be a bounded-delta
 * shape so `create` produced a backing table at the right shape. After the swap, a source
 * write dispatches into `applyFullRebuild` (re-run the whole body → `'replace-all'`).
 *
 * It re-derives the analyzed body exactly as `buildMaintenancePlan` does, calls the
 * manager's `buildFullRebuildPlan`, then re-installs the plan under every `sourceBases`
 * entry (mirroring `registerMaterializedView`'s indexing) so a write to any of them fires
 * maintenance.
 */
function forceFullRebuild(db: Database, schemaName: string, name: string): FullRebuildPlanLike {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager;
	const mv = db.schemaManager.getMaterializedView(schemaName, name);
	expect(mv, `${schemaName}.${name} MV registered`).to.exist;
	const analyzed = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.optimizer.optimizeForAnalysis(db._buildPlan([mv!.selectAst as AST.Statement]).plan, db),
	);
	const plan = mgr.buildFullRebuildPlan(mv, analyzed);
	const key = `${schemaName}.${name}`.toLowerCase();
	mgr.releaseRowTime(key);
	mgr.rowTime.set(key, plan as unknown as { kind: string });
	for (const base of plan.sourceBases) {
		let set = mgr.rowTimeBySource.get(base);
		if (!set) { set = new Set(); mgr.rowTimeBySource.set(base, set); }
		set.add(key);
	}
	return plan;
}

/** Build the analyzed plan for an arbitrary body (not necessarily a registered MV), the
 *  same pre-physical form `buildFullRebuildPlan` consumes. Used by the build-time reject
 *  tests to drive `buildFullRebuildPlan` directly over bag / non-deterministic bodies. */
function analyzeBody(db: Database, sql: string): unknown {
	const ast = new Parser().parseAll(sql)[0] as AST.Statement;
	return db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.optimizer.optimizeForAnalysis(db._buildPlan([ast]).plan, db),
	);
}

/**
 * Single-source full-rebuild floor shapes. Each body is BOTH a bounded-delta shape (so
 * `create` produces a backing) AND a valid full-rebuild shape (a deterministic, keyed
 * set), so {@link forceFullRebuild} can swap the plan and the SAME equivalence property
 * proves the floor's re-evaluate-and-`replace-all` maintenance stays equal to the live
 * body — across inserts/updates/deletes (the `replace-all` keyed diff exercises
 * insert/update/delete/skip) and rollback.
 */
const FULL_REBUILD_SHAPES: readonly BodyShape[] = [
	{ label: 'keyed projection (id, a)', body: 'select id, a from src' },
	{ label: 'keyed projection + partial WHERE (k > 5)', body: 'select id, a, b from src where k > 5' },
	{ label: 'single-source aggregate (group by k)', body: 'select k, count(*) as c, sum(a) as s from src group by k' },
];

defineEquivalenceSuite(
	'Materialized-view maintenance equivalence (full-rebuild floor, single source)',
	FULL_REBUILD_SHAPES,
	db => { forceFullRebuild(db, 'main', 'mv'); },
);

/**
 * Full-rebuild floor — the **body-goes-empty** edge, asserted deterministically (the
 * property suites only reach it incidentally). When the body re-evaluates to zero rows the
 * `'replace-all' []` must empty the backing (every prior row a `delete`), and a subsequent
 * write must repopulate it from empty — exercising the empty↔non-empty transitions in both
 * directions, end-to-end through the floor arm rather than at the layer level.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, body goes empty)', () => {
	let db: Database;
	const body = 'select id, a from src';
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		await db.exec(`create materialized view mv as ${body}`);
		forceFullRebuild(db, 'main', 'mv');
	});
	afterEach(async () => { await db.close(); });

	it('emptying every source row empties the backing, and a later insert repopulates it', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('delete from src');
		expect((await readMultiset(db, 'select * from mv')).length, 'backing empty after all-delete').to.equal(0);
		await assertEquivalent(db, body, 'after all-delete');
		// Repopulate from empty: the next rebuild diffs against an empty before-image (all inserts).
		await db.exec('insert into src (id, a, b, k) values (7, 9, 0, 0)');
		expect((await readMultiset(db, 'select * from mv')).length, 'backing repopulated from empty').to.equal(1);
		await assertEquivalent(db, body, 'after repopulate');
	});
});

/**
 * Full-rebuild floor over a **multi-source** body (a 1:1 inner join). The body reads two
 * sources, so the plan must be indexed under BOTH — a write to either `t` or `p` must
 * trigger the wholesale rebuild. (The 1:1 join is create-able via the join-residual arm, so
 * a backing exists for {@link forceFullRebuild} to reuse.) This is the end-to-end exercise
 * of `FullRebuildPlan.sourceBases` / `planSourceBases` that the single-source suite cannot
 * reach.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, multi-source join)', () => {
	let db: Database;
	let plan: FullRebuildPlanLike;
	const body = 'select t.id, t.fk, p.name from t join p on t.fk = p.id';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, name text)');
		await db.exec('create table t (id integer primary key, fk integer not null references p(id))');
		await db.exec("insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		await db.exec('insert into t (id, fk) values (1, 1), (2, 1), (3, 2), (4, 3)');
		await db.exec(`create materialized view mv as ${body}`);
		plan = forceFullRebuild(db, 'main', 'mv');
	});

	afterEach(async () => { await db.close(); });

	it('indexes the full-rebuild plan under every source the body reads', () => {
		expect(plan.kind).to.equal('full-rebuild');
		expect([...plan.sourceBases].sort()).to.deep.equal(['main.p', 'main.t']);
	});

	it('a lookup-side (p) write triggers a full rebuild that stays equal to the live body', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec("update p set name = 'A!' where id = 1");
		await assertEquivalent(db, body, 'after p name update');
		// Both t rows with fk=1 (ids 1, 2) re-read p.name = 'A!' — proving the p write fired maintenance.
		const rows = await readMultiset(db, "select id from mv where name = 'A!'");
		expect(rows.length, 'rows referencing updated p name').to.equal(2);
	});

	it('a driving-side (t) write triggers a full rebuild that stays equal to the live body', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('delete from t where id = 2');
		await assertEquivalent(db, body, 'after t delete');
		expect((await readMultiset(db, 'select * from mv')).length, 'after t-delete row count').to.equal(3);
	});

	it('read(MV) == evaluate(body) across random t/p mutations, in-txn and after rollback', async () => {
		type JoinMut =
			| { readonly kind: 't-insert'; readonly id: number; readonly fk: number }
			| { readonly kind: 't-updateFk'; readonly id: number; readonly fk: number }
			| { readonly kind: 't-delete'; readonly id: number }
			| { readonly kind: 'p-updateName'; readonly id: number; readonly name: string };
		const joinMutArb: fc.Arbitrary<JoinMut> = fc.oneof(
			fc.record({ kind: fc.constant('t-insert' as const), id: fc.integer({ min: 1, max: 6 }), fk: fc.integer({ min: 1, max: 5 }) }),
			fc.record({ kind: fc.constant('t-updateFk' as const), id: fc.integer({ min: 1, max: 6 }), fk: fc.integer({ min: 1, max: 5 }) }),
			fc.record({ kind: fc.constant('t-delete' as const), id: fc.integer({ min: 1, max: 6 }) }),
			fc.record({ kind: fc.constant('p-updateName' as const), id: fc.integer({ min: 1, max: 4 }), name: fc.constantFrom('a', 'b', 'z') }),
		);
		const joinSql = (m: JoinMut): string => {
			switch (m.kind) {
				case 't-insert': return `insert into t (id, fk) values (${m.id}, ${m.fk})`;
				case 't-updateFk': return `update t set fk = ${m.fk} where id = ${m.id}`;
				case 't-delete': return `delete from t where id = ${m.id}`;
				case 'p-updateName': return `update p set name = '${m.name}' where id = ${m.id}`;
			}
		};
		await fc.assert(fc.asyncProperty(
			fc.array(joinMutArb, { minLength: 1, maxLength: 10 }),
			async (mutations) => {
				await assertEquivalent(db, body, 'baseline');
				await db.exec('begin');
				try {
					for (const m of mutations) await execTolerant(db, joinSql(m));
					await assertEquivalent(db, body, 'in-transaction');
				} finally {
					await db.exec('rollback');
				}
				await assertEquivalent(db, body, 'post-rollback');
			},
		), { numRuns: 40 });
	});
});

/**
 * Full-rebuild floor as an **MV-over-MV producer**: a full-rebuild producer's wholesale
 * `'replace-all'` still emits the minimal effective `BackingRowChange[]`, so the existing
 * cascade drives a consumer MV reading the producer's backing — exactly as the bounded-delta
 * arms do. Here the producer `mv_base` is swapped to full-rebuild and `mv_over` reads it; a
 * source write to `g` rebuilds `mv_base` and the realized delta must propagate into `mv_over`.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, MV-over-MV cascade)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table g (id integer primary key, v integer)');
		await db.exec('insert into g values (1, 5)');
		await db.exec('create materialized view mv_base as select id, v from g');
		await db.exec('create materialized view mv_over as select id, v from mv_base');
		// Maintain the PRODUCER by full-rebuild; the consumer stays inverse-projection.
		forceFullRebuild(db, 'main', 'mv_base');
	});
	afterEach(async () => { await db.close(); });

	const readOver = async (): Promise<Array<Record<string, number>>> => {
		const rows: Array<Record<string, number>> = [];
		for await (const r of db.eval('select id, v from mv_over order by id')) rows.push({ id: Number(r.id), v: Number(r.v) });
		return rows;
	};

	it("a full-rebuild producer's replace-all delta cascades into a consumer MV", async () => {
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }]);
		// INSERT: producer rebuild emits an insert delta → consumer inserts.
		await db.exec('insert into g values (2, 7)');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }]);
		// UPDATE: producer rebuild emits an update delta → consumer updates.
		await db.exec('update g set v = 50 where id = 1');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 2, v: 7 }]);
		// DELETE: producer rebuild emits a delete delta → consumer deletes.
		await db.exec('delete from g where id = 2');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }]);
	});
});

/**
 * Build-time rejects of the full-rebuild floor (`buildFullRebuildPlan`), driven directly
 * (the builder is not yet reached from `create`). The floor accepts general bodies — its
 * only rejects are relational/determinism, NOT shape:
 *  - a **bag** body with no provable unique key (`keysOf` empty) — including the all-columns
 *    pseudo-key case, which `keysOf` already gates on `isSet`;
 *  - a **non-deterministic** body, unless `pragma nondeterministic_schema` lifts the gate.
 */
describe('Materialized-view full-rebuild floor — build-time rejects', () => {
	let db: Database;
	let mgr: MvManagerInternals;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		// A real keyed-set MV so a backing (`_mv_okmv`, PK id) exists for the cases that pass
		// the relational/determinism gates and reach the backing lookup.
		await db.exec('create materialized view okmv as select id, a from src');
		mgr = (db as unknown as ManagerHandle).materializedViewManager;
	});
	afterEach(async () => { await db.close(); });

	const okMv = (): unknown => db.schemaManager.getMaterializedView('main', 'okmv');

	it('rejects a bag body (no provable unique key — a key-dropping projection) as not-a-set', () => {
		const fakeMv = { name: 'bag', schemaName: 'main', backingTableName: '_mv_bag' };
		let caught: unknown;
		try { mgr.buildFullRebuildPlan(fakeMv, analyzeBody(db, 'select a from src')); }
		catch (e) { caught = e; }
		expect(caught, 'a bag body must reject').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		expect((caught as QuereusError).message).to.contain('no provable unique key');
		expect((caught as QuereusError).message).to.contain('must be a set');
		expect((caught as QuereusError).message).to.contain('bag');
	});

	it('a key-dropping projection that is a *set* via DISTINCT is accepted (all-columns key)', () => {
		// `select distinct a, k` drops the PK but DISTINCT makes it a provable set, so `keysOf`
		// returns the all-columns key (a, k) — NOT a bag. It reaches the backing lookup; the
		// okmv backing (PK id) does not match its shape, so it fails at the backing-PK derivation
		// rather than the bag gate. The point pinned here: it is NOT rejected as a bag.
		let caught: unknown;
		try { mgr.buildFullRebuildPlan(okMv(), analyzeBody(db, 'select distinct a, k from src')); }
		catch (e) { caught = e; }
		// Either it builds (no throw) or it fails past the bag gate — never the bag diagnostic.
		if (caught !== undefined) {
			expect((caught as QuereusError).message, 'a DISTINCT set must not be rejected as a bag')
				.to.not.contain('no provable unique key');
		}
	});

	it('rejects a non-deterministic body unless pragma nondeterministic_schema is set', () => {
		// Keyed (id is the source PK) so the determinism gate — not the bag gate — fires.
		let caught: unknown;
		try { mgr.buildFullRebuildPlan(okMv(), analyzeBody(db, 'select id, random() as r from src')); }
		catch (e) { caught = e; }
		expect(caught, 'a non-deterministic body must reject').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		expect((caught as QuereusError).message).to.contain('non-deterministic');
	});

	it('accepts a non-deterministic body when pragma nondeterministic_schema is set', async () => {
		await db.exec('pragma nondeterministic_schema = true');
		// keysOf(id) is a key; determinism gate lifted; the okmv backing (PK id) matches the
		// (id, r) body's leading key column — so a plan is built (no throw).
		const plan = mgr.buildFullRebuildPlan(okMv(), analyzeBody(db, 'select id, random() as r from src'));
		expect(plan.kind).to.equal('full-rebuild');
		expect(plan.sourceBases).to.deep.equal(['main.src']);
	});
});

/* ─────────────────── full-rebuild floor — per-statement flush deferral ─────────────────── */

/**
 * Count how many times the floor arm actually re-evaluates a body. Patches the manager's
 * `applyFullRebuild` instance method (shadowing the prototype), so every rebuild — the only
 * caller is the end-of-statement {@link MaterializedViewManager.flushDeferredRebuilds} drain,
 * since the DML boundary always defers — increments the counter. Install AFTER
 * {@link forceFullRebuild}. The deferral guarantee under test: N source rows touching one
 * full-rebuild MV in ONE statement ⇒ exactly ONE rebuild, not N.
 */
function instrumentRebuilds(db: Database): { count: () => number } {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager as unknown as {
		applyFullRebuild: (...args: unknown[]) => Promise<unknown>;
	};
	let n = 0;
	const orig = mgr.applyFullRebuild;
	mgr.applyFullRebuild = function (this: unknown, ...args: unknown[]) {
		n++;
		return orig.apply(this, args);
	};
	return { count: () => n };
}

/**
 * The deferral the ticket adds: a full-rebuild MV is marked dirty per source row during the
 * DML row loop and rebuilt EXACTLY ONCE at the end-of-statement flush (inside the statement-
 * atomicity savepoint). These assert the observable consequences — one rebuild per bulk
 * statement, atomic rollback of a failed statement that dirtied an MV, autocommit flush+commit,
 * and a mixed (bounded-delta + full-rebuild) source staying consistent — that the per-row floor
 * could not give affordably.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, per-statement flush)', () => {
	let db: Database;
	const body = 'select id, a from src';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 0, 0, 6), (2, 3, 4, 2)');
		await db.exec(`create materialized view mv as ${body}`);
		forceFullRebuild(db, 'main', 'mv');
	});
	afterEach(async () => { await db.close(); });

	it('a bulk INSERT touching one full-rebuild MV rebuilds it EXACTLY ONCE (not per row)', async () => {
		const rebuilds = instrumentRebuilds(db);
		await db.exec('insert into src (id, a, b, k) values (10,1,1,1),(11,2,2,2),(12,3,3,3),(13,4,4,4),(14,5,5,5)');
		expect(rebuilds.count(), 'one rebuild for a 5-row bulk insert (deferred to the flush)').to.equal(1);
		// …and the single rebuild reflects every row of the bulk statement.
		await assertEquivalent(db, body, 'after bulk insert');
		expect((await readMultiset(db, 'select * from mv')).length, 'all rows present').to.equal(7);
	});

	it('a bulk UPDATE / DELETE each rebuild the MV exactly once', async () => {
		await db.exec('insert into src (id, a, b, k) values (10,1,1,1),(11,2,2,2),(12,3,3,3)');
		const rebuilds = instrumentRebuilds(db);
		await db.exec('update src set a = a + 100');
		expect(rebuilds.count(), 'one rebuild for the bulk update').to.equal(1);
		await assertEquivalent(db, body, 'after bulk update');
		await db.exec('delete from src where id >= 10');
		expect(rebuilds.count(), 'one more rebuild for the bulk delete').to.equal(2);
		await assertEquivalent(db, body, 'after bulk delete');
	});

	it('a multi-row statement that FAILS after dirtying the MV leaves the backing unchanged', async () => {
		const before = await readMultiset(db, 'select * from mv');
		const rebuilds = instrumentRebuilds(db);
		// Row 1 (id=10) writes the source and dirties the MV; row 2 (id=1) collides on the
		// source PK and aborts the whole statement. The flush never runs (the loop throws
		// first), and the statement savepoint reverts row 1's source write — so neither the
		// source nor the MV backing retains anything.
		await execTolerant(db, 'insert into src (id, a, b, k) values (10, 9, 9, 9), (1, 9, 9, 9), (11, 9, 9, 9)');
		expect(rebuilds.count(), 'a flush never ran for the aborted statement').to.equal(0);
		expect(await readMultiset(db, 'select * from mv'), 'MV backing unchanged after the abort').to.deep.equal(before);
		expect((await readMultiset(db, 'select id from src')).sort(), 'source unchanged after the abort')
			.to.deep.equal([canonRow([1]), canonRow([2])].sort());
		// And maintenance still works afterwards (the aborted statement left no orphaned dirty state).
		await db.exec('insert into src (id, a, b, k) values (12, 7, 7, 7)');
		await assertEquivalent(db, body, 'after a clean write following the abort');
	});

	it('an explicit-transaction ROLLBACK reverts a deferred rebuild in lockstep', async () => {
		await assertEquivalent(db, body, 'baseline');
		await db.exec('begin');
		await db.exec('insert into src (id, a, b, k) values (20, 1, 1, 1), (21, 2, 2, 2)');
		// The rebuild ran at the (in-transaction) statement flush — visible mid-transaction.
		await assertEquivalent(db, body, 'in-transaction');
		expect((await readMultiset(db, 'select * from mv')).length, 'rebuilt rows visible pre-commit').to.equal(4);
		await db.exec('rollback');
		// The rebuild rode the source write's transaction layer, so rollback discards it.
		await assertEquivalent(db, body, 'post-rollback');
		expect((await readMultiset(db, 'select * from mv')).length, 'reverted to baseline').to.equal(2);
	});

	it('a bare autocommit INSERT flushes and commits the rebuild together with the source write', async () => {
		// No BEGIN: the statement savepoint wraps the row loop + flush, then autocommit commits
		// both the source write and the rebuilt backing. Two consecutive autocommit writes must
		// both land — proving the first committed cleanly with no orphaned pending backing layer.
		await db.exec('insert into src (id, a, b, k) values (30, 1, 1, 1)');
		await assertEquivalent(db, body, 'after autocommit insert 1');
		await db.exec('insert into src (id, a, b, k) values (31, 2, 2, 2)');
		await assertEquivalent(db, body, 'after autocommit insert 2');
		expect((await readMultiset(db, 'select * from mv')).length, 'both autocommit writes persisted').to.equal(4);
	});
});

/**
 * A single source feeding BOTH a bounded-delta (inverse-projection) MV and a full-rebuild MV.
 * One write must maintain the incremental MV per-row during the loop AND the full-rebuild MV
 * once at the flush; both end consistent with their live bodies. Proves the deferral does not
 * disturb the per-row arms sharing the source.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, mixed-arm same source)', () => {
	let db: Database;
	const incBody = 'select id, a from src';
	const fullBody = 'select id, b from src';

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table src (id integer primary key, a integer, b integer, k integer)');
		await db.exec('insert into src (id, a, b, k) values (1, 10, 100, 6), (2, 20, 200, 2)');
		await db.exec(`create materialized view mv_inc as ${incBody}`);
		await db.exec(`create materialized view mv_full as ${fullBody}`);
		// Only mv_full is the floor; mv_inc stays inverse-projection (per-row immediate).
		forceFullRebuild(db, 'main', 'mv_full');
	});
	afterEach(async () => { await db.close(); });

	const assertBoth = async (phase: string): Promise<void> => {
		const incFrom = await readMultiset(db, 'select * from mv_inc');
		const fullFrom = await readMultiset(db, 'select * from mv_full');
		const prev = db.optimizer.tuning;
		db.optimizer.updateTuning({ ...prev, disabledRules: new Set([...(prev.disabledRules ?? []), 'materialized-view-rewrite']) });
		let incBodyRows: string[]; let fullBodyRows: string[];
		try {
			incBodyRows = await readMultiset(db, incBody);
			fullBodyRows = await readMultiset(db, fullBody);
		} finally {
			db.optimizer.updateTuning(prev);
		}
		expect(incFrom, `${phase}: incremental MV diverged`).to.deep.equal(incBodyRows);
		expect(fullFrom, `${phase}: full-rebuild MV diverged`).to.deep.equal(fullBodyRows);
	};

	it('a single write keeps both the incremental and full-rebuild MV consistent (one rebuild)', async () => {
		const rebuilds = instrumentRebuilds(db);
		await db.exec('insert into src (id, a, b, k) values (3, 30, 300, 9), (4, 40, 400, 1)');
		expect(rebuilds.count(), 'the full-rebuild MV rebuilt once for the bulk insert').to.equal(1);
		await assertBoth('after mixed-arm bulk insert');
		await db.exec('update src set a = a + 1, b = b + 1 where id <= 2');
		expect(rebuilds.count(), 'one more rebuild for the bulk update').to.equal(2);
		await assertBoth('after mixed-arm bulk update');
		await db.exec('delete from src where id = 1');
		await assertBoth('after mixed-arm delete');
	});
});

/**
 * MV-over-MV with a **full-rebuild consumer over an incremental producer** — the converse of
 * the "full-rebuild producer → incremental consumer" suite above. A source write maintains the
 * incremental producer's backing inline during the loop; the consumer reads that backing, so it
 * is dirtied via the cascade and rebuilt at the flush, AFTER the producer's inline write has
 * landed (reads-own-writes at flush). The full rebuild must see the producer's just-updated
 * backing and stay equal to the live 2-level body.
 */
describe('Materialized-view maintenance equivalence (full-rebuild floor, full-rebuild consumer over incremental producer)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table g (id integer primary key, v integer)');
		await db.exec('insert into g values (1, 5)');
		await db.exec('create materialized view mv_base as select id, v from g');
		await db.exec('create materialized view mv_over as select id, v from mv_base');
		// Maintain the CONSUMER by full-rebuild; the producer stays inverse-projection.
		forceFullRebuild(db, 'main', 'mv_over');
	});
	afterEach(async () => { await db.close(); });

	const readOver = async (): Promise<Array<Record<string, number>>> => {
		const rows: Array<Record<string, number>> = [];
		for await (const r of db.eval('select id, v from mv_over order by id')) rows.push({ id: Number(r.id), v: Number(r.v) });
		return rows;
	};

	it("an incremental producer's inline write drives the consumer's deferred full rebuild", async () => {
		const rebuilds = instrumentRebuilds(db);
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }]);
		// INSERT: producer applies inline → cascade dirties the consumer → one rebuild at flush.
		await db.exec('insert into g values (2, 7), (3, 9)');
		expect(rebuilds.count(), 'one consumer rebuild for the bulk insert').to.equal(1);
		expect(await readOver()).to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 7 }, { id: 3, v: 9 }]);
		// UPDATE of a projected column: producer re-keys inline → consumer rebuild sees it.
		await db.exec('update g set v = 50 where id = 1');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 2, v: 7 }, { id: 3, v: 9 }]);
		// DELETE: producer removes inline → consumer rebuild drops the row.
		await db.exec('delete from g where id = 2');
		expect(await readOver()).to.deep.equal([{ id: 1, v: 50 }, { id: 3, v: 9 }]);
	});
});
