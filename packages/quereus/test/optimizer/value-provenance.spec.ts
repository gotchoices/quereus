import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MisuseError } from '../../src/common/errors.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { InsertNode } from '../../src/planner/nodes/insert-node.js';
import { UpdateNode } from '../../src/planner/nodes/update-node.js';
import { DmlExecutorNode } from '../../src/planner/nodes/dml-executor-node.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import {
	classifyInsertColumns,
	classifyUpdateColumns,
	classifyUpsertUpdateColumns,
	type ValueProvenance,
	type WrittenColumn,
} from '../../src/planner/analysis/value-provenance.js';

function builtPlan(db: Database, sql: string): PlanNode {
	const ast = new Parser().parse(sql) as AST.Statement;
	const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
	const ctx: PlanningContext = {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: parameterScope,
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		cteDescriptors: new Map(),
		outputScopes: new Map(),
	};
	return buildBlock(ctx, [ast]);
}

function findNode<T extends PlanNode>(root: PlanNode, test: (node: PlanNode) => node is T): T {
	const seen = new Set<PlanNode>();
	const stack: PlanNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (test(node)) return node;
		stack.push(...node.getChildren(), ...node.getRelations());
	}
	throw new Error('node not found in plan');
}

const isInsert = (n: PlanNode): n is InsertNode => n instanceof InsertNode;
const isUpdate = (n: PlanNode): n is UpdateNode => n instanceof UpdateNode;
const isExecutor = (n: PlanNode): n is DmlExecutorNode => n instanceof DmlExecutorNode;

function writtenColumns(db: Database, sql: string): WrittenColumn[] {
	const plan = builtPlan(db, sql);
	if (/^\s*update\b/i.test(sql)) return classifyUpdateColumns(findNode(plan, isUpdate));
	const insert = findNode(plan, isInsert);
	const insertColumns = classifyInsertColumns(insert);
	const clauses = findNode(plan, isExecutor).upsertClauses;
	return clauses ? classifyUpsertUpdateColumns(clauses[0], insert.table.tableSchema, insertColumns) : insertColumns;
}

const input = (parameters: Array<number | string>, contexts: string[] = []): ValueProvenance =>
	({ kind: 'input', parameters, contexts });

interface ProvenanceCase {
	readonly name: string;
	readonly sql: string;
	/** Expected provenance for the columns this case is about (others unchecked). */
	readonly expected: Readonly<Record<string, ValueProvenance>>;
}

const CASES: ReadonlyArray<ProvenanceCase> = [
	{
		name: 'literal and parameter cells',
		sql: `insert into t (id, v) values (1, :p)`,
		expected: { id: { kind: 'literal', value: 1 }, v: input(['p']) },
	},
	{
		name: 'the write conversion: a literal reports its stored form, a fresh blob decoded into a text column is other',
		sql: `insert into t (id, v) values ('7', randomblob(16))`,
		expected: { id: { kind: 'literal', value: 7 }, v: { kind: 'other' } },
	},
	{
		name: 'a fresh blob into a text column is other even when no column needs a planned coercion; hex of it stays fresh',
		sql: `insert into tt (id, body) values (randomblob(16), hex(randomblob(16)))`,
		expected: { id: { kind: 'other' }, body: { kind: 'fresh', function: 'randomblob' } },
	},
	{
		name: 'multi-row VALUES joins per column: distinct literals drop the value, literal with input is input',
		sql: `insert into t (id, v) values (1, 'a'), (2, :p)`,
		expected: { id: { kind: 'literal' }, v: input(['p']) },
	},
	{
		name: 'omitted column with a randomblob(16) default is fresh',
		sql: `insert into ids (v) values ('x')`,
		expected: { id: { kind: 'fresh', function: 'randomblob' } },
	},
	{
		name: 'generated column over a parameter column is input',
		sql: `insert into g (id, qty, price) values (1, :q, 3)`,
		expected: { total: input(['q']) },
	},
	{
		name: 'a default reading a context variable reports the variable, not its definition',
		sql: `insert into c (id) with context now_ms = random() values (1)`,
		expected: { created: input([], ['now_ms']) },
	},
	{
		name: 'INSERT … SELECT: projected literal and parameter keep their class, source columns are other',
		sql: `insert into t3 (id, v, w) select x, 'k', :p from s`,
		expected: { id: { kind: 'other' }, v: { kind: 'literal', value: 'k' }, w: input(['p']) },
	},
	{
		name: 'hex over a fresh call stays fresh',
		sql: `insert into r (id, k) values (1, hex(randomblob(16)))`,
		expected: { k: { kind: 'fresh', function: 'randomblob' } },
	},
	{
		name: 'cast keeps a fresh blob fresh only when lossless: to blob yes, to text no',
		sql: `insert into r (id, k, j) values (1, cast(randomblob(16) as text), cast(randomblob(16) as blob))`,
		expected: { k: { kind: 'other' }, j: { kind: 'fresh', function: 'randomblob' } },
	},
	{
		name: 'a non-injective function of a fresh value is other',
		sql: `insert into r (id, k) values (1, substr(randomblob(16), 1, 4))`,
		expected: { k: { kind: 'other' } },
	},
	{
		name: 'concatenating a fresh value with a non-literal is other',
		sql: `insert into r (id, k) values (1, randomblob(16) || :p)`,
		expected: { k: { kind: 'other' } },
	},
	{
		name: 'randomblob below 16 bytes is volatile random',
		sql: `insert into r (id, k) values (1, randomblob(8))`,
		expected: { k: { kind: 'volatile', sources: [{ kind: 'random' }] } },
	},
	{
		name: 'a module-registered fresh function is fresh; an arbitrary function of it is other',
		sql: `insert into r (id, k, j) values (1, stamp_id(), abs(stamp_id()))`,
		expected: { k: { kind: 'fresh', function: 'stamp_id' }, j: { kind: 'other' } },
	},
	{
		name: 'set n = n + 1 reads the row\'s own previous value',
		sql: `update t set n = n + 1 where id = 1`,
		expected: { n: { kind: 'self', columns: ['n'] } },
	},
	{
		name: 'set x = :p is input',
		sql: `update t set v = :p where id = 1`,
		expected: { v: input(['p']) },
	},
	{
		name: 'UPDATE assignments go through the same write conversion as inserted cells',
		sql: `update t set id = '8', v = randomblob(16) where id = 1`,
		expected: { id: { kind: 'literal', value: 8 }, v: { kind: 'other' } },
	},
	{
		name: 'set from a subquery over other rows is other',
		sql: `update t set n = (select max(n) from t) where id = 1`,
		expected: { n: { kind: 'other' } },
	},
	{
		name: 'a generated recompute reads the assigned value of an assigned column and the previous value of the rest',
		sql: `update g set qty = :q where id = 1`,
		expected: { qty: input(['q']), total: { kind: 'self', columns: ['price'] } },
	},
	{
		name: 'upsert DO UPDATE: existing-row reads are self',
		sql: `insert into t (id, v, n) values (1, 'a', 5) on conflict (id) do update set n = n + 1`,
		expected: { n: { kind: 'self', columns: ['n'] } },
	},
	{
		name: 'upsert DO UPDATE: NEW reads resolve to the insert row',
		sql: `insert into t (id, v, n) values (1, 'a', :n) on conflict (id) do update set n = new.n`,
		expected: { n: input(['n']) },
	},
];

describe('written-value provenance', () => {
	let db: Database;

	before(async () => {
		db = new Database();
		await db.exec('pragma nondeterministic_schema = true');
		db.createScalarFunction('stamp_id', { numArgs: 0, fresh: true }, () => crypto.randomUUID());
		await db.exec(`
			create table t (id integer primary key, v text, n integer) using memory;
			create table tt (id text primary key, body text) using memory;
			create table t3 (id integer primary key, v text, w text) using memory;
			create table s (x integer primary key) using memory;
			create table ids (id blob primary key default (randomblob(16)), v text) using memory;
			create table g (id integer primary key, qty integer, price integer, total integer generated always as (qty * price) stored) using memory;
			create table c (id integer primary key, created integer default now_ms) using memory with context (now_ms integer);
			create table r (id integer primary key, k any, j any) using memory;
		`);
	});
	after(async () => { await db.close(); });

	for (const testCase of CASES) {
		it(testCase.name, () => {
			const byColumn = new Map(writtenColumns(db, testCase.sql).map(c => [c.column, c.provenance]));
			for (const [column, expected] of Object.entries(testCase.expected)) {
				expect(byColumn.get(column), column).to.deep.equal(expected);
			}
		});
	}

	it('rejects registering a function both fresh and deterministic', () => {
		expect(() => db.createScalarFunction('bad_fresh', { numArgs: 0, fresh: true, deterministic: true }, () => 1))
			.to.throw(MisuseError);
	});
});
