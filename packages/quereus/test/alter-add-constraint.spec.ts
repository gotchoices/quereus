/**
 * Tests for `ALTER TABLE ADD CONSTRAINT` routing.
 *
 * CHECK constraints stay in Quereus's emitter (`runtime/emit/add-constraint.ts`)
 * and mutate the schema's `checkConstraints` array directly. Non-CHECK
 * constraints (UNIQUE / FOREIGN KEY) route through the vtab module's
 * `alterTable({ type: 'addConstraint', constraint })`. Modules that don't
 * implement `addConstraint` — including the built-in `MemoryTableModule` —
 * surface `StatusCode.UNSUPPORTED`. The wording change ("does not support
 * ADD CONSTRAINT …") is intentional: the gate moved from the emitter to the
 * module.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

describe('ALTER TABLE ADD CONSTRAINT', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('CHECK constraint succeeds (in-emitter metadata mutation)', async () => {
		await db.exec('create table t (id integer primary key, v integer)');
		await db.exec('alter table t add constraint pos_v check (v > 0)');
		// Forward enforcement still works.
		let rejected = false;
		try {
			await db.exec('insert into t (id, v) values (1, -1)');
		} catch {
			rejected = true;
		}
		expect(rejected).to.equal(true);
	});

	it('UNIQUE constraint against MemoryTable rejects with UNSUPPORTED', async () => {
		await db.exec('create table t (id integer primary key, email text)');
		let caught: unknown;
		try {
			await db.exec('alter table t add constraint u_email unique (email)');
		} catch (e) {
			caught = e;
		}
		expect(caught).to.be.instanceOf(QuereusError);
		const err = caught as QuereusError;
		expect(err.code).to.equal(StatusCode.UNSUPPORTED);
		expect(err.message).to.match(/does not support ADD CONSTRAINT/i);
	});

	it('FOREIGN KEY constraint against MemoryTable rejects with UNSUPPORTED', async () => {
		await db.exec('create table parent (pid integer primary key)');
		await db.exec('create table child (id integer primary key, pa integer)');
		let caught: unknown;
		try {
			await db.exec('alter table child add constraint fk_pa foreign key (pa) references parent(pid)');
		} catch (e) {
			caught = e;
		}
		expect(caught).to.be.instanceOf(QuereusError);
		const err = caught as QuereusError;
		expect(err.code).to.equal(StatusCode.UNSUPPORTED);
		expect(err.message).to.match(/does not support ADD CONSTRAINT/i);
	});
});
