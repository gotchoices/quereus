import { expect } from 'chai';
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fc from 'fast-check';
import { Database } from '../../src/core/database.js';
import {
	addInd,
	mergeInds,
	projectInds,
	shiftInds,
	MAX_INDS_PER_NODE,
} from '../../src/planner/util/fd-utils.js';
import { fkChildNullable, seedTableForeignKeyInds } from '../../src/planner/util/ind-utils.js';
import { propagateJoinInds } from '../../src/planner/nodes/join-utils.js';
import type { JoinType } from '../../src/planner/nodes/join-node.js';
import {
	isRelationalNode,
	type InclusionDependency,
	type PhysicalProperties,
	type PlanNode,
	type RelationalPlanNode,
} from '../../src/planner/nodes/plan-node.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { ForeignKeyConstraintSchema, PrimaryKeyColumnDefinition, TableSchema } from '../../src/schema/table.js';
import { buildColumnIndexMap } from '../../src/schema/table.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import type { Row, SqlValue } from '../../src/common/types.js';
import { EmissionContext } from '../../src/runtime/emission-context.js';
import { emitPlanNode } from '../../src/runtime/emitters.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import { isAsyncIterable } from '../../src/runtime/utils.js';
import type { RuntimeContext } from '../../src/runtime/types.js';

// ---------------------------------------------------------------------------
// IND constructors shared by the unit tests
// ---------------------------------------------------------------------------

function tableTarget(table: string, targetCols: number[]): InclusionDependency['target'] {
	return { kind: 'table', schema: 'main', table, targetCols };
}

function ind(cols: number[], target: InclusionDependency['target'], nullRejecting = false): InclusionDependency {
	return { cols, target, nullRejecting };
}

// ---------------------------------------------------------------------------
// projectInds / shiftInds — unit
// ---------------------------------------------------------------------------

describe('fd-utils: IND helpers', () => {
	describe('projectInds', () => {
		it('drops an IND when any of its cols loses its mapping (all-or-nothing)', () => {
			const i = ind([1, 2], tableTarget('p', [0, 1]));
			// Mapping omits source col 2.
			const mapping = new Map<number, number>([[1, 10]]);
			expect(projectInds([i], mapping)).to.have.length(0);
		});

		it('remaps survivors and does NOT remap target.targetCols', () => {
			const i = ind([1, 2], tableTarget('p', [0, 1]), true);
			const mapping = new Map<number, number>([[1, 5], [2, 9]]);
			const out = projectInds([i], mapping);
			expect(out).to.have.length(1);
			expect(out[0].cols).to.deep.equal([5, 9]);
			// targetCols index the *target* relation — untouched by the source mapping.
			expect(out[0].target).to.deep.equal(tableTarget('p', [0, 1]));
			// nullRejecting is preserved through projection.
			expect(out[0].nullRejecting).to.equal(true);
		});

		it('keeps a single-column IND when its sole col survives', () => {
			const i = ind([3], tableTarget('p', [0]));
			const mapping = new Map<number, number>([[3, 0]]);
			const out = projectInds([i], mapping);
			expect(out).to.have.length(1);
			expect(out[0].cols).to.deep.equal([0]);
		});
	});

	describe('shiftInds', () => {
		it('shifts cols by offset and leaves targetCols untouched', () => {
			const i = ind([0, 1], tableTarget('p', [0, 1]), true);
			const out = shiftInds([i], 10);
			expect(out[0].cols).to.deep.equal([10, 11]);
			expect(out[0].target).to.deep.equal(tableTarget('p', [0, 1]));
			expect(out[0].nullRejecting).to.equal(true);
		});

		it('offset 0 returns a copy with identical contents', () => {
			const i = ind([2], tableTarget('p', [0]));
			const out = shiftInds([i], 0);
			expect(out).to.deep.equal([i]);
		});
	});

	describe('mergeInds / addInd dedup + cap', () => {
		it('dedups structurally-equal INDs', () => {
			const a = ind([1], tableTarget('p', [0]));
			const b = ind([1], tableTarget('p', [0]));
			expect(mergeInds([a], [b])).to.have.length(1);
			expect(addInd([a], b)).to.have.length(1);
		});

		it('keeps INDs that differ in cols, target, or nullRejecting', () => {
			const base = ind([1], tableTarget('p', [0]));
			expect(addInd([base], ind([2], tableTarget('p', [0])))).to.have.length(2); // diff cols
			expect(addInd([base], ind([1], tableTarget('q', [0])))).to.have.length(2); // diff table
			expect(addInd([base], ind([1], tableTarget('p', [1])))).to.have.length(2); // diff targetCols
			expect(addInd([base], ind([1], tableTarget('p', [0]), true))).to.have.length(2); // diff nullRejecting
		});

		it('treats a reordered cols/targetCols pairing as a distinct fact (ordered compare)', () => {
			const a = ind([1, 2], tableTarget('p', [0, 1]));
			const b = ind([2, 1], tableTarget('p', [1, 0]));
			// Same logical fact written swapped — ordered compare keeps both (safe redundancy).
			expect(addInd([a], b)).to.have.length(2);
		});

		it('honors the per-node cap', () => {
			const many: InclusionDependency[] = [];
			for (let n = 0; n < MAX_INDS_PER_NODE + 10; n++) {
				many.push(ind([n], tableTarget('p', [0])));
			}
			expect(mergeInds([], many)).to.have.length(MAX_INDS_PER_NODE);
		});
	});
});

// ---------------------------------------------------------------------------
// seedTableForeignKeyInds — unit (hand-built schemas)
// ---------------------------------------------------------------------------

function col(name: string, notNull: boolean): ColumnSchema {
	return {
		name,
		logicalType: INTEGER_TYPE,
		notNull,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	};
}

function makeTable(opts: {
	name: string;
	columns: ColumnSchema[];
	pk?: number[];
	foreignKeys?: ForeignKeyConstraintSchema[];
}): TableSchema {
	const pkDef: PrimaryKeyColumnDefinition[] = (opts.pk ?? []).map(index => ({ index }));
	return {
		name: opts.name,
		schemaName: 'main',
		columns: opts.columns,
		columnIndexMap: buildColumnIndexMap(opts.columns),
		primaryKeyDefinition: pkDef,
		checkConstraints: [],
		vtabModuleName: 'memory',
		isView: false,
		foreignKeys: opts.foreignKeys,
	} as TableSchema;
}

function makeFk(columns: number[], referencedTable: string, referencedColumnNames: string[]): ForeignKeyConstraintSchema {
	return {
		columns,
		referencedTable,
		referencedColumns: [],
		referencedColumnNames,
		onDelete: 'restrict',
		onUpdate: 'restrict',
		deferred: false,
	};
}

describe('seedTableForeignKeyInds', () => {
	it('composite NOT-NULL FK seeds one total IND (nullRejecting: false)', () => {
		const parent = makeTable({
			name: 'p',
			columns: [col('a', true), col('b', true)],
			pk: [0, 1],
		});
		const child = makeTable({
			name: 'c',
			columns: [col('id', true), col('x', true), col('y', true)],
			pk: [0],
			foreignKeys: [makeFk([1, 2], 'p', ['a', 'b'])],
		});
		const inds = seedTableForeignKeyInds(child, () => parent);
		expect(inds).to.have.length(1);
		expect(inds[0].cols).to.deep.equal([1, 2]);
		expect(inds[0].target).to.deep.equal(tableTarget('p', [0, 1]));
		expect(inds[0].nullRejecting).to.equal(false);
	});

	it('nullable FK seeds a nullRejecting IND', () => {
		const parent = makeTable({ name: 'p', columns: [col('id', true)], pk: [0] });
		const child = makeTable({
			name: 'c',
			columns: [col('id', true), col('pid', false)],
			pk: [0],
			foreignKeys: [makeFk([1], 'p', ['id'])],
		});
		const inds = seedTableForeignKeyInds(child, () => parent);
		expect(inds).to.have.length(1);
		expect(inds[0].cols).to.deep.equal([1]);
		expect(inds[0].nullRejecting).to.equal(true);
		// fkChildNullable is the shared bit underpinning the seed.
		expect(fkChildNullable(child, child.foreignKeys![0])).to.equal(true);
	});

	it('FK referencing non-PK columns seeds none', () => {
		// Parent PK is column 0 (id); the FK references column 1 (u), a non-PK column.
		const parent = makeTable({
			name: 'p',
			columns: [col('id', true), col('u', true)],
			pk: [0],
		});
		const child = makeTable({
			name: 'c',
			columns: [col('id', true), col('v', true)],
			pk: [0],
			foreignKeys: [makeFk([1], 'p', ['u'])],
		});
		expect(seedTableForeignKeyInds(child, () => parent)).to.have.length(0);
	});

	it('FK to a parent with no PK seeds none', () => {
		const parent = makeTable({ name: 'p', columns: [col('a', true)], pk: [] });
		const child = makeTable({
			name: 'c',
			columns: [col('id', true), col('pid', true)],
			pk: [0],
			foreignKeys: [makeFk([1], 'p', ['a'])],
		});
		expect(seedTableForeignKeyInds(child, () => parent)).to.have.length(0);
	});

	it('FK whose parent cannot be resolved seeds none', () => {
		const child = makeTable({
			name: 'c',
			columns: [col('id', true), col('pid', true)],
			pk: [0],
			foreignKeys: [makeFk([1], 'missing', ['id'])],
		});
		expect(seedTableForeignKeyInds(child, () => undefined)).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// propagateJoinInds — branch table
// ---------------------------------------------------------------------------

describe('propagateJoinInds', () => {
	// left side: 2 columns, IND on col 0 → parent p. right side: IND on col 0 → parent q.
	const leftPhys = { inds: [ind([0], tableTarget('p', [0]))] } as PhysicalProperties;
	const rightPhys = { inds: [ind([0], tableTarget('q', [0]))] } as PhysicalProperties;
	const leftColumnCount = 2;

	function run(joinType: JoinType): readonly InclusionDependency[] {
		return propagateJoinInds(joinType, leftPhys, rightPhys, leftColumnCount) ?? [];
	}

	it('inner = union of left and shifted-right', () => {
		const out = run('inner');
		expect(out).to.have.length(2);
		expect(out).to.deep.include(ind([0], tableTarget('p', [0])));
		// right's col 0 shifted by leftColumnCount → col 2; targetCols unchanged.
		expect(out).to.deep.include(ind([2], tableTarget('q', [0])));
	});

	it('cross = union (same as inner)', () => {
		expect(run('cross')).to.have.length(2);
	});

	it('left keeps preserved-side IND and drops the null-padded right side', () => {
		const out = run('left');
		expect(out).to.deep.equal([ind([0], tableTarget('p', [0]))]);
	});

	it('right keeps the shifted preserved-side IND and drops left', () => {
		const out = run('right');
		expect(out).to.deep.equal([ind([2], tableTarget('q', [0]))]);
	});

	it('full drops both sides', () => {
		expect(propagateJoinInds('full', leftPhys, rightPhys, leftColumnCount)).to.equal(undefined);
	});

	it('semi keeps left only', () => {
		expect(run('semi')).to.deep.equal([ind([0], tableTarget('p', [0]))]);
	});

	it('anti keeps left only', () => {
		expect(run('anti')).to.deep.equal([ind([0], tableTarget('p', [0]))]);
	});

	it('returns undefined when there is nothing to propagate', () => {
		expect(propagateJoinInds('inner', undefined, undefined, 2)).to.equal(undefined);
	});
});

// ---------------------------------------------------------------------------
// End-to-end seeding + propagation through optimized plans
// ---------------------------------------------------------------------------

describe('IND seeding + propagation (end-to-end)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table parent (id integer primary key, name text null) using memory');
		// `pid` declared nullable (quereus columns default to NOT NULL) so the
		// seeded IND is nullRejecting.
		await db.exec('create table child (cid integer primary key, pid integer null references parent(id)) using memory');
	});

	afterEach(async () => {
		await db.close();
	});

	/** INDs on the *root* relational node (the query output) of an optimized plan. */
	function rootInds(sql: string): InclusionDependency[] {
		const block = db.getPlan(sql) as any;
		const root = block.getRelations?.()[0] as RelationalPlanNode | undefined;
		return root ? (root.physical.inds ?? []).slice() : [];
	}

	function hasParentInd(inds: InclusionDependency[]): boolean {
		return inds.some(i => i.target.kind === 'table' && i.target.table === 'parent');
	}

	it('a base scan over child carries the FK-seeded IND', () => {
		const inds = rootInds('select * from child');
		const match = inds.find(i =>
			i.target.kind === 'table' && i.target.table === 'parent'
			&& i.cols.length === 1 && i.target.targetCols.length === 1,
		);
		expect(match, 'expected a child→parent IND').to.not.equal(undefined);
		// pid is nullable ⇒ nullRejecting.
		expect(match!.nullRejecting).to.equal(true);
	});

	it('projection keeping the FK column preserves the IND', () => {
		expect(hasParentInd(rootInds('select cid, pid from child'))).to.equal(true);
	});

	it('projection dropping the FK column drops the IND (on the output node)', () => {
		expect(hasParentInd(rootInds('select cid from child'))).to.equal(false);
	});

	it('inner join preserves the child IND (shifted into the combined row)', () => {
		expect(hasParentInd(rootInds('select * from child c join parent p on c.pid = p.id'))).to.equal(true);
	});

	it('the IND survives row-preserving pass-throughs (sort + limit)', () => {
		expect(hasParentInd(rootInds('select * from child order by cid limit 5'))).to.equal(true);
	});
});

// ---------------------------------------------------------------------------
// Property / law harness: propagated INDs never over-claim
// ---------------------------------------------------------------------------
//
// The load-bearing soundness check (the IND analogue of the key-soundness
// harness in property.spec.ts). For a spread of query shapes over randomly
// seeded — but FK-valid — data, walk every relational node in the *optimized*
// plan tree, materialize it in isolation, and assert each propagated IND holds:
// every materialized row's `cols` projection (excluding NULL-rejected rows) is
// actually present in the target table's `targetCols` projection. An over-claim
// reds the test. Soundness, not completeness: a missing IND is fine.
describe('IND soundness (no over-claim)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Single-column nullable FK, composite NOT-NULL FK, and a grandchild chain.
		await db.exec('create table p (id integer primary key, label text null) using memory');
		await db.exec('create table c (cid integer primary key, pid integer null references p(id)) using memory');
		await db.exec('create table pk2 (a integer, b integer, primary key (a, b)) using memory');
		await db.exec('create table c2 (id integer primary key, x integer not null, y integer not null, foreign key (x, y) references pk2(a, b)) using memory');
	});

	afterEach(async () => {
		await db.close();
	});

	const queries = [
		'select * from c',
		'select cid, pid from c',
		'select * from c where pid > 1',
		'select * from c order by cid',
		'select * from c order by cid limit 5',
		'select distinct pid from c',
		'select * from c join p on c.pid = p.id',
		'select * from c left join p on c.pid = p.id',
		'select * from c2',
		'select x, y from c2',
		'select * from c2 join pk2 on c2.x = pk2.a and c2.y = pk2.b',
	];

	function tupleSig(values: SqlValue[]): string {
		return values.map(v => {
			if (v === null || v === undefined) return 'N';
			if (v instanceof Uint8Array) return 'B:' + Array.from(v).join('.');
			return typeof v + ':' + String(v);
		}).join('|');
	}

	function collectRelationalNodes(rootNode: PlanNode): RelationalPlanNode[] {
		const out: RelationalPlanNode[] = [];
		const seen = new Set<string>();
		const stack: PlanNode[] = [rootNode];
		while (stack.length > 0) {
			const n = stack.pop()!;
			if (seen.has(n.id)) continue;
			seen.add(n.id);
			if (isRelationalNode(n)) out.push(n);
			for (const child of n.getChildren()) stack.push(child);
		}
		return out;
	}

	async function materializeNode(node: RelationalPlanNode): Promise<SqlValue[][]> {
		const emissionContext = new EmissionContext(db);
		const rootInstruction = emitPlanNode(node, emissionContext);
		const scheduler = new Scheduler(rootInstruction);
		const runtimeCtx: RuntimeContext = {
			db,
			stmt: undefined,
			params: {},
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			tracer: undefined,
			enableMetrics: false,
		};
		const output = scheduler.run(runtimeCtx);
		const resolved = output instanceof Promise ? await output : output;
		if (!isAsyncIterable(resolved)) throw new Error('node did not produce a row stream');
		const rows: SqlValue[][] = [];
		for await (const row of resolved as AsyncIterable<Row>) rows.push(row as SqlValue[]);
		return rows;
	}

	/** Materialize a base table's rows as positional tuples (table column order). */
	async function materializeTable(schema: string, table: string): Promise<SqlValue[][]> {
		const block = db.getPlan(`select * from "${schema}"."${table}"`) as any;
		const root = block.getRelations?.()[0] as RelationalPlanNode | undefined;
		if (!root) throw new Error(`no root for ${schema}.${table}`);
		return materializeNode(root);
	}

	function assertIndHolds(label: string, i: InclusionDependency, rows: SqlValue[][], targetRows: SqlValue[][]): void {
		// Build the target tuple set (projected by targetCols).
		const targetSet = new Set<string>();
		for (const t of targetRows) targetSet.add(tupleSig(i.target.targetCols.map(c => t[c])));

		for (const row of rows) {
			const projected = i.cols.map(c => row[c]);
			if (i.nullRejecting && projected.some(v => v === null || v === undefined)) continue;
			const sig = tupleSig(projected);
			if (!targetSet.has(sig)) {
				throw new Error(`over-claim: IND ${JSON.stringify(i.cols)}→${i.target.kind === 'table' ? i.target.table : '?'} not satisfied on ${label} (missing tuple ${sig})`);
			}
		}
	}

	it('the over-claim detector fails loudly on a synthetic violation', () => {
		const bad = ind([0], tableTarget('p', [0]));
		// Node has value 99 in col 0 but the target table has only {1}.
		expect(() => assertIndHolds('synthetic', bad, [[99]], [[1]])).to.throw(/over-claim/);
		expect(() => assertIndHolds('synthetic', bad, [[1]], [[1]])).to.not.throw();
	});

	it('propagated INDs never over-claim on materialized optimized plans', async () => {
		const pidArb = fc.oneof(fc.constant(null as number | null), fc.integer({ min: 1, max: 6 }));
		await fc.assert(fc.asyncProperty(
			fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 0, maxLength: 8 }), // parent ids
			fc.array(fc.record({ cid: fc.integer({ min: 1, max: 30 }), pid: pidArb }), { minLength: 0, maxLength: 12 }),
			fc.array(fc.record({ a: fc.integer({ min: 1, max: 4 }), b: fc.integer({ min: 1, max: 4 }) }), { minLength: 0, maxLength: 8 }),
			fc.array(fc.record({ id: fc.integer({ min: 1, max: 30 }), ab: fc.integer({ min: 0, max: 100 }) }), { minLength: 0, maxLength: 12 }),
			fc.constantFrom(...queries),
			async (parentIds, childRows, pkRows, c2Seeds, q) => {
				// Reseed all tables (children first to satisfy FK on delete order isn't
				// enforced here; we simply clear then repopulate in parent→child order).
				await db.exec('delete from c');
				await db.exec('delete from c2');
				await db.exec('delete from p');
				await db.exec('delete from pk2');

				const parentSet = new Set<number>();
				for (const id of parentIds) {
					if (parentSet.has(id)) continue;
					parentSet.add(id);
					await db.exec(`insert into p values (${id}, 'l${id}')`);
				}
				// pk2 composite parent rows (deduped by (a,b)).
				const pkSet = new Set<string>();
				const pkPairs: Array<[number, number]> = [];
				for (const r of pkRows) {
					const k = `${r.a},${r.b}`;
					if (pkSet.has(k)) continue;
					pkSet.add(k);
					pkPairs.push([r.a, r.b]);
					await db.exec(`insert into pk2 values (${r.a}, ${r.b})`);
				}

				// Child rows: pid must be NULL or an existing parent id (FK-valid).
				const childSeen = new Set<number>();
				for (const r of childRows) {
					if (childSeen.has(r.cid)) continue;
					childSeen.add(r.cid);
					const pidValid = r.pid !== null && parentSet.has(r.pid);
					const pidSql = pidValid ? String(r.pid) : 'null';
					await db.exec(`insert into c values (${r.cid}, ${pidSql})`);
				}
				// c2 rows: (x,y) must be an existing pk2 pair (NOT NULL composite FK).
				if (pkPairs.length > 0) {
					const c2Seen = new Set<number>();
					for (const r of c2Seeds) {
						if (c2Seen.has(r.id)) continue;
						c2Seen.add(r.id);
						const [x, y] = pkPairs[r.ab % pkPairs.length];
						await db.exec(`insert into c2 values (${r.id}, ${x}, ${y})`);
					}
				}

				const block = db.getPlan(q) as unknown as PlanNode;
				const nodes = collectRelationalNodes(block);

				// Cache target-table materializations per (schema.table) within this run.
				const targetCache = new Map<string, SqlValue[][]>();
				const targetRowsFor = async (schema: string, table: string): Promise<SqlValue[][]> => {
					const key = `${schema}.${table}`;
					const cached = targetCache.get(key);
					if (cached) return cached;
					const rows = await materializeTable(schema, table);
					targetCache.set(key, rows);
					return rows;
				};

				for (const node of nodes) {
					const inds = node.physical.inds;
					if (!inds || inds.length === 0) continue;

					let rows: SqlValue[][];
					try {
						rows = await materializeNode(node);
					} catch {
						// Correlated / non-isolatable nodes — skip (best-effort tier).
						continue;
					}

					for (const i of inds) {
						if (i.target.kind !== 'table') continue; // only 'table' is produced this wave
						const targetRows = await targetRowsFor(i.target.schema, i.target.table);
						assertIndHolds(`${node.nodeType}[${node.id}] of \`${q}\``, i, rows, targetRows);
					}
				}
			},
		), { numRuns: 40 });
	});
});
