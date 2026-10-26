import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MisuseError } from '../../src/common/errors.js';
import type { SqlParameters, SqlValue } from '../../src/common/types.js';
import type { ParamScopeValue, TableWatch } from '../../src/planner/analysis/change-scope.js';
import {
	bindWriteParameters,
	deserializeWriteScope,
	serializeWriteScope,
	type TableWrite,
	type TargetSelection,
	type WriteConstraint,
	type WriteDisposition,
	type WriteScope,
} from '../../src/planner/analysis/write-scope.js';

const SCHEMA = `
	create table t (id integer primary key, v text, n integer, name text) using memory;
	create table s (id integer primary key, v text) using memory;
	create table p (id integer primary key) using memory;
	create table c (id integer primary key, pid integer references p(id)) using memory;
	create table lim (id integer primary key, n integer) using memory;
	create table chk (id integer primary key, n integer check (n > 0), m integer check (m < (select max(n) from lim))) using memory;
	create table u (id integer primary key, email text unique, hits integer) using memory;
	create assertion t_nonneg check (not exists (select 1 from t where n < 0));
`;

function scopeFor(db: Database, sql: string, params?: SqlParameters | SqlValue[]): WriteScope {
	const stmt = db.prepare(sql);
	try {
		return stmt.getWriteScope(params);
	} finally {
		void stmt.finalize();
	}
}

function onlyWrite(scope: WriteScope): TableWrite {
	expect(scope.writes.length, 'one write site').to.equal(1);
	return scope.writes[0];
}

function rows(selection: TargetSelection): Extract<TargetSelection, { kind: 'rows' }> {
	expect(selection.kind).to.equal('rows');
	return selection as Extract<TargetSelection, { kind: 'rows' }>;
}

function upsert(disposition: WriteDisposition): Extract<WriteDisposition, { kind: 'upsert' }> {
	expect(disposition.kind).to.equal('upsert');
	return disposition as Extract<WriteDisposition, { kind: 'upsert' }>;
}

function readOf(write: TableWrite, table: string): TableWatch | undefined {
	return write.reads.find(w => w.table.schema === 'main' && w.table.table === table);
}

function constraintsOf(write: TableWrite, kind: WriteConstraint['kind']): WriteConstraint[] {
	return write.constraints.filter(c => c.kind === kind);
}

/** The engine names an unnamed FK itself; the spec is about the rest of the entry. */
function withoutName(constraint: WriteConstraint): Omit<WriteConstraint, 'name'> {
	const { name: _name, ...rest } = constraint;
	return rest;
}

function provenanceOf(write: TableWrite, column: string) {
	const found = write.columns.find(c => c.column === column);
	if (!found) throw new Error(`column ${column} not written; have ${write.columns.map(c => c.column).join(',')}`);
	return found.provenance;
}

describe('Statement.getWriteScope', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(SCHEMA);
	});
	afterEach(async () => { await db.close(); });

	describe('insert', () => {
		it('literals and parameters: no selection, provenance per column, PK is cross-row', () => {
			const write = onlyWrite(scopeFor(db, 'insert into t (id, v) values (1, :p)'));
			expect(write.operation).to.equal('insert');
			expect(write.disposition).to.deep.equal({ kind: 'abort' });
			expect(write.selection).to.deep.equal({ kind: 'none' });
			expect(write.columns.map(c => c.column)).to.deep.equal(['id', 'v', 'n', 'name']);
			expect(provenanceOf(write, 'id')).to.deep.equal({ kind: 'literal', value: 1 });
			expect(provenanceOf(write, 'v')).to.deep.equal({ kind: 'input', parameters: ['p'], contexts: [] });
			expect(constraintsOf(write, 'primary-key')).to.deep.equal([
				{ kind: 'primary-key', columns: ['id'], locality: 'cross-row', timing: 'immediate' },
			]);
			expect(write.selfIndependent).to.equal(true);
		});

		it('insert … select reads the source table and writes other-sourced values', () => {
			const write = onlyWrite(scopeFor(db, 'insert into t (id, v) select id, v from s'));
			expect(write.selection).to.deep.equal({ kind: 'none' });
			expect(provenanceOf(write, 'id')).to.deep.equal({ kind: 'other' });
			const source = readOf(write, 's');
			expect(source, 'source table read').to.not.equal(undefined);
			expect(source!.scope).to.deep.equal({ kind: 'full' });
			expect(write.selfIndependent).to.equal(false);
		});

		it('or ignore / or replace surface as the disposition', () => {
			expect(onlyWrite(scopeFor(db, 'insert or ignore into t (id) values (1)')).disposition).to.deep.equal({ kind: 'ignore' });
			expect(onlyWrite(scopeFor(db, 'insert or replace into t (id) values (1)')).disposition).to.deep.equal({ kind: 'replace' });
		});

		it('upsert: clause target and action, a self-dependent DO UPDATE breaks self-independence', () => {
			const write = onlyWrite(scopeFor(db,
				`insert into u (id, email, hits) values (1, 'a', 0) on conflict (email) do update set hits = hits + 1`));
			const clauses = upsert(write.disposition).clauses;
			expect(clauses.length).to.equal(1);
			expect(clauses[0].target).to.deep.equal(['email']);
			expect(clauses[0].action).to.equal('update');
			expect(clauses[0].conditional).to.equal(false);
			expect(clauses[0].columns.map(c => c.column)).to.deep.equal(['hits']);
			expect(clauses[0].columns[0].provenance).to.deep.equal({ kind: 'self', columns: ['hits'] });
			expect(write.selfIndependent).to.equal(false);
			expect(constraintsOf(write, 'unique')).to.deep.equal([
				{ kind: 'unique', columns: ['email'], locality: 'cross-row', timing: 'immediate', partial: false },
			]);
		});

		it('upsert do nothing keeps the insert row independent', () => {
			const write = onlyWrite(scopeFor(db, `insert into u (id, email, hits) values (1, 'a', 0) on conflict do nothing`));
			const clauses = upsert(write.disposition).clauses;
			expect(clauses[0].target).to.equal('primary-key');
			expect(clauses[0].action).to.equal('nothing');
			expect(clauses[0].columns).to.deep.equal([]);
			expect(write.selfIndependent).to.equal(true);
		});
	});

	describe('update', () => {
		it('by key with a parameter: rows selection, no target read, self-independent', () => {
			const scope = scopeFor(db, 'update t set v = :p where id = :k');
			const write = onlyWrite(scope);
			expect(write.operation).to.equal('update');
			const selection = rows(write.selection);
			expect(selection.key).to.deep.equal(['id']);
			expect(selection.values.length).to.equal(1);
			const placeholder = selection.values[0][0] as ParamScopeValue;
			expect(placeholder.kind).to.equal('param');
			expect(placeholder.index).to.equal('k');
			expect(readOf(write, 't'), 'only the key was read').to.equal(undefined);
			expect(write.columns.map(c => c.column)).to.deep.equal(['v']);
			expect(provenanceOf(write, 'v')).to.deep.equal({ kind: 'input', parameters: ['p'], contexts: [] });
			expect(write.selfIndependent).to.equal(true);
			expect(scope.unboundParameters).to.deep.equal(['k', 'p']);
			// Only the assigned column's constraints apply: the PK is not assigned.
			expect(constraintsOf(write, 'primary-key')).to.deep.equal([]);
		});

		it('set n = n + 1 reads the target column and is not self-independent', () => {
			const write = onlyWrite(scopeFor(db, 'update t set n = n + 1 where id = 1'));
			expect(rows(write.selection).values).to.deep.equal([[1]]);
			const target = readOf(write, 't');
			expect(target, 'target read').to.not.equal(undefined);
			expect(target!.columns).to.deep.equal(new Set(['n']));
			expect(provenanceOf(write, 'n')).to.deep.equal({ kind: 'self', columns: ['n'] });
			expect(write.selfIndependent).to.equal(false);
		});

		it('by a non-key predicate: global selection, the predicate column is a read', () => {
			const write = onlyWrite(scopeFor(db, `update t set v = 'x' where name = 'a'`));
			expect(write.selection).to.deep.equal({ kind: 'global' });
			const target = readOf(write, 't');
			expect(target, 'target read').to.not.equal(undefined);
			expect(target!.columns).to.deep.equal(new Set(['name']));
			expect(target!.scope).to.deep.equal({ kind: 'full' });
		});
	});

	describe('delete', () => {
		it('by key: rows selection, no columns, only the assertion applies', () => {
			const write = onlyWrite(scopeFor(db, 'delete from t where id = 1'));
			expect(write.operation).to.equal('delete');
			expect(rows(write.selection)).to.deep.equal({ kind: 'rows', key: ['id'], values: [[1]] });
			expect(write.columns).to.deep.equal([]);
			expect(write.reads).to.deep.equal([]);
			expect(write.selfIndependent).to.equal(true);
			expect(write.constraints.map(c => c.kind)).to.deep.equal(['assertion']);
		});
	});

	describe('constraints', () => {
		it('a write under a foreign key names the parent as a cross-row constraint and a read', () => {
			const write = onlyWrite(scopeFor(db, 'insert into c (id, pid) values (1, 7)'));
			expect(constraintsOf(write, 'foreign-key-child').map(withoutName)).to.deep.equal([
				{ kind: 'foreign-key-child', columns: ['pid'], locality: 'cross-row', timing: 'deferred', references: { schema: 'main', table: 'p' } },
			]);
			expect(readOf(write, 'p'), 'parent read by the existence probe').to.not.equal(undefined);
		});

		it('a delete of a referenced row carries the inbound foreign key', () => {
			const write = onlyWrite(scopeFor(db, 'delete from p where id = 7'));
			expect(constraintsOf(write, 'foreign-key-parent').map(withoutName)).to.deep.equal([
				{ kind: 'foreign-key-parent', columns: ['id'], locality: 'cross-row', timing: 'immediate', references: { schema: 'main', table: 'c' } },
			]);
		});

		it('a plain CHECK is row/immediate; one with a subquery is cross-row/deferred and reads its table', () => {
			const write = onlyWrite(scopeFor(db, 'insert into chk (id, n, m) values (1, 2, 3)'));
			const checks = constraintsOf(write, 'check').map(c => ({ locality: c.locality, timing: c.timing }));
			expect(checks).to.deep.equal([
				{ locality: 'row', timing: 'immediate' },
				{ locality: 'cross-row', timing: 'deferred' },
			]);
			expect(readOf(write, 'lim'), 'subquery table read').to.not.equal(undefined);
		});

		it('an assertion over the target appears as cross-row and deferred', () => {
			const write = onlyWrite(scopeFor(db, 'insert into t (id, n) values (1, 2)'));
			expect(constraintsOf(write, 'assertion')).to.deep.equal([
				{ name: 't_nonneg', kind: 'assertion', columns: [], locality: 'cross-row', timing: 'deferred' },
			]);
		});

		it('NOT NULL is row-local and, for an update, listed only for assigned columns', async () => {
			await db.exec('create table nn (id integer primary key, a text not null, b text not null) using memory');
			const insert = onlyWrite(scopeFor(db, `insert into nn (id, a, b) values (1, 'x', 'y')`));
			// Columns default to NOT NULL in this engine, so the key column is listed too.
			expect(constraintsOf(insert, 'not-null').map(c => c.columns[0])).to.deep.equal(['id', 'a', 'b']);
			const update = onlyWrite(scopeFor(db, `update nn set a = 'z' where id = 1`));
			expect(constraintsOf(update, 'not-null')).to.deep.equal([
				{ kind: 'not-null', columns: ['a'], locality: 'row', timing: 'immediate' },
			]);
		});
	});

	describe('statement level', () => {
		it('a non-DML statement has no writes', () => {
			expect(scopeFor(db, 'select * from t')).to.deep.equal({ writes: [], nonDeterministicSources: [], unboundParameters: [] });
		});

		it('binding parameters resolves the selection and clears unboundParameters', () => {
			const bound = onlyWrite(scopeFor(db, 'update t set v = :p where id = :k', { k: 5, p: 'x' }));
			expect(rows(bound.selection).values).to.deep.equal([[5]]);
			const scope = scopeFor(db, 'update t set v = :p where id = :k');
			const rebound = bindWriteParameters(scope, { ':k': 5 });
			expect(rows(onlyWrite(rebound).selection).values).to.deep.equal([[5]]);
			expect(rebound.unboundParameters).to.deep.equal(['p']);
			expect(() => bindWriteParameters(scope, { k: 1, ':k': 2 })).to.throw(MisuseError);
		});

		it('serialize + JSON + deserialize round-trips the richest shape', () => {
			const scope = scopeFor(db, `insert into c (id, pid) values (1, :p) on conflict (id) do update set pid = new.pid`);
			const roundTripped = deserializeWriteScope(JSON.parse(JSON.stringify(serializeWriteScope(scope))));
			expect(roundTripped).to.deep.equal(scope);
		});
	});
});

