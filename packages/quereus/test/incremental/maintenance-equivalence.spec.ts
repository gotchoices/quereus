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
async function applyMutation(db: Database, m: Mutation): Promise<void> {
	try {
		await db.exec(sqlFor(m));
	} catch (e) {
		if (e instanceof QuereusError && e.code === StatusCode.CONSTRAINT) return;
		throw e;
	}
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
	const fromBody = await readMultiset(db, body);
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
