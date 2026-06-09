import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	extractCheckConstraints,
} from '../../src/planner/analysis/check-extraction.js';
import type { ConstantBinding, DomainConstraint } from '../../src/planner/nodes/plan-node.js';
import type { RowConstraintSchema } from '../../src/schema/table.js';
import { DEFAULT_ROWOP_MASK } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';

// ---------------------------------------------------------------------------
// AST builders for unit tests
// ---------------------------------------------------------------------------

function lit(value: AST.LiteralExpr['value']): AST.LiteralExpr {
	return { type: 'literal', value };
}

function col(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

function bin(operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return { type: 'binary', operator, left, right };
}

function and(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('AND', left, right);
}

function or(left: AST.Expression, right: AST.Expression): AST.BinaryExpr {
	return bin('OR', left, right);
}

function between(expr: AST.Expression, lower: AST.Expression, upper: AST.Expression, not = false): AST.BetweenExpr {
	return { type: 'between', expr, lower, upper, not };
}

function inExpr(expr: AST.Expression, values: AST.Expression[]): AST.InExpr {
	return { type: 'in', expr, values };
}

function fn(name: string, ...args: AST.Expression[]): AST.FunctionExpr {
	return { type: 'function', name, args };
}

function check(expr: AST.Expression): RowConstraintSchema {
	return { expr, operations: DEFAULT_ROWOP_MASK };
}

const colMap = new Map<string, number>([
	['a', 0],
	['b', 1],
	['c', 2],
	['x', 3],
	['y', 4],
	['status', 5],
	['qty', 6],
	['alt_status', 7],
]);

const allDeterministic = () => true;

// ---------------------------------------------------------------------------
// Unit tests for extractCheckConstraints
// ---------------------------------------------------------------------------

describe('extractCheckConstraints (unit)', () => {
	it('check (a = b) emits bi-directional FDs and an EC pair', () => {
		const result = extractCheckConstraints([check(bin('=', col('a'), col('b')))], colMap, allDeterministic);
		expect(result.fds).to.have.length(2);
		expect(result.fds.some(fd => fd.determinants.includes(0) && fd.dependents.includes(1))).to.equal(true);
		expect(result.fds.some(fd => fd.determinants.includes(1) && fd.dependents.includes(0))).to.equal(true);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it("check (status = 'a') emits ∅ → status FD plus a literal binding", () => {
		const result = extractCheckConstraints([check(bin('=', col('status'), lit('a')))], colMap, allDeterministic);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([]);
		expect(result.fds[0].dependents).to.deep.equal([5]);
		expect(result.constantBindings).to.have.length(1);
		expect(result.constantBindings[0].attrs).to.deep.equal([5]);
		expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 'a' });
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (qty >= 0) emits a range domain with inclusive lower bound', () => {
		const result = extractCheckConstraints([check(bin('>=', col('qty'), lit(0)))], colMap, allDeterministic);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		expect(d.min).to.equal(0);
		expect(d.minInclusive).to.equal(true);
		expect(d.max).to.equal(undefined);
		expect(result.fds).to.have.length(0);
	});

	it('check (qty between 0 and 100) emits a range with both inclusive bounds', () => {
		const result = extractCheckConstraints(
			[check(between(col('qty'), lit(0), lit(100)))],
			colMap,
			allDeterministic,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		expect(d.min).to.equal(0);
		expect(d.max).to.equal(100);
		expect(d.minInclusive).to.equal(true);
		expect(d.maxInclusive).to.equal(true);
	});

	it('check (qty > 0 and qty < 100) emits two range domains (intersection deferred)', () => {
		const result = extractCheckConstraints(
			[check(and(bin('>', col('qty'), lit(0)), bin('<', col('qty'), lit(100))))],
			colMap,
			allDeterministic,
		);
		expect(result.domainConstraints).to.have.length(2);
		const lower = result.domainConstraints.find(d => d.kind === 'range' && d.min !== undefined) as DomainConstraint & { kind: 'range' } | undefined;
		const upper = result.domainConstraints.find(d => d.kind === 'range' && d.max !== undefined) as DomainConstraint & { kind: 'range' } | undefined;
		expect(lower?.min).to.equal(0);
		expect(lower?.minInclusive).to.equal(false);
		expect(upper?.max).to.equal(100);
		expect(upper?.maxInclusive).to.equal(false);
	});

	it("check (status in ('a','i','d')) emits an enum domain", () => {
		const result = extractCheckConstraints(
			[check(inExpr(col('status'), [lit('a'), lit('i'), lit('d')]))],
			colMap,
			allDeterministic,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('enum');
		if (d.kind !== 'enum') return;
		expect(d.column).to.equal(5);
		expect(d.values).to.deep.equal(['a', 'i', 'd']);
	});

	it("check (a = b and status = 'a') decomposes into FDs, EC, and a binding", () => {
		const result = extractCheckConstraints(
			[check(and(bin('=', col('a'), col('b')), bin('=', col('status'), lit('a'))))],
			colMap,
			allDeterministic,
		);
		expect(result.fds.length).to.be.greaterThanOrEqual(3);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
		expect(result.constantBindings).to.have.length(1);
		expect(result.constantBindings[0].value).to.deep.equal({ kind: 'literal', value: 'a' });
	});

	it('check (a = b or x = y) — disjunction contributes nothing', () => {
		const result = extractCheckConstraints(
			[check(or(bin('=', col('a'), col('b')), bin('=', col('x'), col('y'))))],
			colMap,
			allDeterministic,
		);
		expect(result.fds).to.have.length(0);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (a > b) — non-equality column-column emits no FD or domain', () => {
		const result = extractCheckConstraints(
			[check(bin('>', col('a'), col('b')))],
			colMap,
			allDeterministic,
		);
		expect(result.fds).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (b = a + 1) — single-column RHS yields one-way FD a → b, no EC, no binding, no domain', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), bin('+', col('a'), lit(1))))],
			colMap,
			allDeterministic,
		);
		expect(result.fds).to.have.length(1);
		expect(result.fds[0].determinants).to.deep.equal([0]);
		expect(result.fds[0].dependents).to.deep.equal([1]);
		expect(result.equivPairs).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});

	it('check (b = a + c) — two columns on RHS contributes nothing', () => {
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), bin('+', col('a'), col('c'))))],
			colMap,
			allDeterministic,
		);
		expect(result.fds).to.have.length(0);
	});

	it('check (0 < qty) — column on RHS of inequality is normalized via flipComparison', () => {
		const result = extractCheckConstraints(
			[check(bin('<', lit(0), col('qty')))],
			colMap,
			allDeterministic,
		);
		expect(result.domainConstraints).to.have.length(1);
		const d = result.domainConstraints[0];
		expect(d.kind).to.equal('range');
		if (d.kind !== 'range') return;
		expect(d.column).to.equal(6);
		// `0 < qty` flips to `qty > 0` → strict lower bound at 0, no upper.
		expect(d.min).to.equal(0);
		expect(d.minInclusive).to.equal(false);
		expect(d.max).to.equal(undefined);
	});

	it('check (a == b) — the `==` operator alias is recognized as equality', () => {
		const result = extractCheckConstraints([check(bin('==', col('a'), col('b')))], colMap, allDeterministic);
		expect(result.fds).to.have.length(2);
		expect(result.equivPairs).to.deep.equal([[0, 1]]);
	});

	it('check (b = some_nondeterministic_fn(a)) — non-deterministic call drops the whole check', () => {
		const isDeterministic = (fnName: string) => fnName !== 'random_fn';
		const result = extractCheckConstraints(
			[check(bin('=', col('b'), fn('random_fn', col('a'))))],
			colMap,
			isDeterministic,
		);
		expect(result.fds).to.have.length(0);
		expect(result.constantBindings).to.have.length(0);
		expect(result.domainConstraints).to.have.length(0);
	});
});

// ---------------------------------------------------------------------------
// End-to-end propagation through query_plan(...)
// ---------------------------------------------------------------------------

interface PhysicalProps {
	fds?: { determinants: number[]; dependents: number[] }[];
	equivClasses?: number[][];
	constantBindings?: ConstantBinding[];
	domainConstraints?: DomainConstraint[];
}

interface PlanRow { node_type: string; op: string; detail: string; physical: string | null }

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval('SELECT node_type, op, detail, physical FROM query_plan(?)', [sql])) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function physicalOf(rows: readonly PlanRow[], pred: (r: PlanRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(pred);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

describe('CHECK-derived FDs/domains: end-to-end propagation', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	// The one-way determination FD `{a}→{b}` from `check (b = a + 1)` is still
	// *emitted* by check-extraction, but it folds onto the TableReference's
	// physical FDs only when an endpoint is a real declared key — otherwise it is
	// gated away (a narrow `select distinct a, b` over a non-keyed table would
	// otherwise re-derive `{a}` as a phantom key and drop a REQUIRED DISTINCT,
	// wrong results). Ticket `fd-oneway-determination-key-bag-overclaim`. Both
	// arms pin the gate: absent when `a` is not a key, present when it is.
	it('table with check (b = a + 1): the one-way FD a → b is GATED AWAY when a is not a key', async () => {
		// `id` is the PK, so neither `a` (col 1) nor `b` (col 2) is a key.
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, CHECK (b = a + 1)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'TABLEREF' || r.op === 'TABLEREFERENCE' || r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN' || r.op === 'INDEXSCAN');
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		// `a` is column index 1, `b` is column index 2 — the one-way FD must be gated.
		const fd = props!.fds?.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 1 && fd.dependents.includes(2));
		expect(fd, 'one-way FD a → b must be gated away (a is not a real key)').to.equal(undefined);
	});

	it('table with check (b = a + 1): the one-way FD a → b is PRESENT when a is the PK', async () => {
		// `a` (col 0) is the PK, so `{a}→{b}` is a sound key — the gate keeps it.
		await db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, CHECK (b = a + 1)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'TABLEREF' || r.op === 'TABLEREFERENCE' || r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN' || r.op === 'INDEXSCAN');
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		// `a` is column index 0, `b` is column index 1.
		const fd = props!.fds?.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 0 && fd.dependents.includes(1));
		expect(fd, 'expected FD a → b (a is the real key)').to.not.equal(undefined);
	});

	it("table with check (status in ('a','i')): TableReference carries the enum domain", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t');
		const props = physicalOf(rows, r => r.op === 'SEQSCAN' || r.op === 'SEQ SCAN')
			?? physicalOf(rows, r => r.node_type === 'TableReference')
			?? physicalOf(rows, r => r.op.includes('SCAN'));
		expect(props, 'expected physical props on a leaf').to.not.equal(undefined);
		const enumDomain = props!.domainConstraints?.find(d => d.kind === 'enum' && d.column === 1);
		expect(enumDomain, 'expected enum domain on status (col 1)').to.not.equal(undefined);
	});

	it("check (status = 'a') exposes ∅ → status FD at the table reference", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status = 'a')) USING memory");
		const rows = await planRows(db, 'SELECT status FROM t');
		// Look at any leaf or filter where the FD might surface.
		const candidate = rows
			.map(r => r.physical ? JSON.parse(r.physical) as PhysicalProps : undefined)
			.find(p => p?.fds?.some(fd => fd.determinants.length === 0 && fd.dependents.includes(1)));
		expect(candidate, 'expected ∅ → status FD somewhere in plan').to.not.equal(undefined);
	});

	it('Filter pass-through: domains on the source survive at the Filter', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER, qty INTEGER, CHECK (qty >= 0)) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t WHERE x > 0');
		const filterProps = physicalOf(rows, r => r.op === 'FILTER');
		expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
		const range = filterProps!.domainConstraints?.find(d => d.kind === 'range' && d.column === 2);
		expect(range, 'expected range domain on qty (col 2) to survive').to.not.equal(undefined);
	});

	it('Inner join: domain on inner side survives at the join output', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, payload TEXT) USING memory");
		const rows = await planRows(db, 'SELECT * FROM t JOIN u ON t.id = u.id');
		const props = physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(props, 'expected join physical props').to.not.equal(undefined);
		// t has cols {id=0, status=1}; join output has u columns starting at col 2.
		const enumDomain = props!.domainConstraints?.find(d => d.kind === 'enum' && d.column === 1);
		expect(enumDomain, 'expected enum domain on status (col 1) to survive').to.not.equal(undefined);
	});

	it('Left outer join: domains on the nullable (right) side are dropped', async () => {
		await db.exec("CREATE TABLE l (id INTEGER PRIMARY KEY, payload TEXT) USING memory");
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT * FROM l LEFT JOIN r ON l.id = r.id');
		const props = physicalOf(rows, r => /JOIN/i.test(r.op));
		expect(props, 'expected join physical props').to.not.equal(undefined);
		// Left's two columns at indices 0 and 1; right's status at index 3.
		const survived = props!.domainConstraints?.find(d => d.column === 3);
		expect(survived, 'right-side domain must not survive a left outer').to.equal(undefined);
	});

	it("EC closure: check (status = 'a') AND (status = alt_status) pins both columns to 'a'", async () => {
		await db.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, alt_status TEXT, " +
			"CHECK (status = 'a'), CHECK (status = alt_status)) USING memory"
		);
		const rows = await planRows(db, 'SELECT id, status, alt_status FROM t');
		// Find the leaf where bindings should surface (table ref or scan).
		const candidate = rows
			.map(r => r.physical ? JSON.parse(r.physical) as PhysicalProps : undefined)
			.find(p => p?.constantBindings && p.constantBindings.length > 0);
		expect(candidate, 'expected at least one constant binding').to.not.equal(undefined);
		// status=col1, alt_status=col2 — both should appear in some binding's attrs.
		const allAttrs = new Set<number>();
		for (const cb of candidate!.constantBindings ?? []) {
			for (const a of cb.attrs) allAttrs.add(a);
		}
		expect(allAttrs.has(1), "binding should cover 'status' (col 1)").to.equal(true);
		expect(allAttrs.has(2), "binding should cover 'alt_status' (col 2) via EC closure").to.equal(true);
	});

	it('Project drops domains on columns it does not project', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, CHECK (status in ('a','i'))) USING memory");
		const rows = await planRows(db, 'SELECT id FROM t');
		const projProps = physicalOf(rows, r => r.op === 'PROJECT');
		if (!projProps) return; // Some plans skip Project for SELECT id of a single column.
		// Whatever domains survive must not reference the dropped status column index.
		const surviving = projProps.domainConstraints ?? [];
		// Status was source col 1; after projection only id (col 0) remains, so the
		// status domain shouldn't surface at the projection output.
		expect(surviving.every(d => d.column === 0), 'no domain should reference dropped status').to.equal(true);
	});
});
