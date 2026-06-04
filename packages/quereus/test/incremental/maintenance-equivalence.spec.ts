import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../../src/core/database.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode, type SqlValue } from '../../src/common/types.js';

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
 * multiset. Shared by the covering-index (`'inverse-projection'`) and single-source
 * aggregate (`'residual-recompute'`) shape sets.
 */
function defineEquivalenceSuite(suiteTitle: string, shapes: readonly BodyShape[]): void {
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

/** Minimal reach into the manager's private plan map so a stubbed-arm plan can be
 *  routed through the real DML maintenance path. The map key is lowercase
 *  `schema.name` (see `mvKey` in database-materialized-views.ts). */
interface PlanMapHandle { readonly materializedViewManager: { readonly rowTime: Map<string, { kind: string }> }; }

/**
 * The `MaintenancePlan` union still has one stubbed arm (`'full-rebuild'`) that the
 * builder never emits today — a named convergence point for the cost-gate full-rebuild
 * selection, guarded by a loud `INTERNAL` throw in `applyMaintenancePlan` so a future
 * mis-wire fails fast rather than silently no-op'ing maintenance. The builder can't
 * produce it, so this white-box test mutates a registered plan's `kind` in place and
 * drives a real source write through the maintenance path to assert the guard fires
 * (and locks its wording + status code) until that selection is wired.
 *
 * The `'residual-recompute'` arm is **no longer** a stub — it is wired for single-source
 * aggregate bodies (covered by the aggregate equivalence suite above), so mutating an
 * inverse-projection plan's kind to it would dispatch into the (unprepared) residual
 * path rather than the guard. It is therefore excluded here.
 */
describe('Materialized-view maintenance plan — stubbed-arm guard', () => {
	for (const kind of ['full-rebuild'] as const) {
		it(`throws INTERNAL when a '${kind}' plan reaches applyMaintenancePlan`, async () => {
			const db = new Database();
			try {
				await db.exec('create table src (id integer primary key, a integer)');
				await db.exec('create materialized view mv as select id, a from src');

				// Force the registered plan onto a stub arm the builder never yields.
				const plan = (db as unknown as PlanMapHandle).materializedViewManager.rowTime.get('main.mv');
				expect(plan, 'expected a registered inverse-projection plan').to.exist;
				plan!.kind = kind;

				let caught: unknown;
				try {
					await db.exec('insert into src (id, a) values (1, 1)');
				} catch (e) { caught = e; }

				expect(caught, 'a stub-arm plan must trip the guard, not no-op').to.be.instanceOf(QuereusError);
				expect((caught as QuereusError).code).to.equal(StatusCode.INTERNAL);
				expect((caught as QuereusError).message).to.contain(kind).and.to.contain('not yet wired');
			} finally {
				await db.close();
			}
		});
	}
});
