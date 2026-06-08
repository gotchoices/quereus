/**
 * Verifies the `permitsGrandfatheredCheckViolators` capability gate on the
 * planner's lift of declared CHECK constraints into `TableReferenceNode`'s
 * physical properties (see `planner/nodes/reference.ts` and
 * `vtab/capabilities.ts`).
 *
 * Default vtab modules leave the cap off: a `CHECK (v > 0)` on column `v`
 * flows into `domainConstraints` as `{ kind: 'range', column: <v>, min: 0,
 * minInclusive: false }`, so the filter-contradiction rule can fold a WHERE
 * like `v <= 0` to `EmptyRelationNode`. Modules that opt in (e.g. Lamina,
 * whose `ALTER TABLE … ADD CHECK` is structurally total and grandfathers
 * violators) suppress the lift — the planner can no longer prove the
 * predicate empty, so the scan stays.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { TableReferenceNode } from '../../src/planner/nodes/reference.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import type { ModuleCapabilities } from '../../src/vtab/capabilities.js';

describe('CHECK contribution gated by permitsGrandfatheredCheckViolators', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	function buildReference(vtabModule: MemoryTableModule, schemaName = 'main', tableName = 't'): TableReferenceNode {
		const table = db.schemaManager.findTable(tableName, schemaName);
		if (!table) throw new Error(`table ${schemaName}.${tableName} not found`);
		return new TableReferenceNode(
			new GlobalScope(db.schemaManager),
			table,
			vtabModule,
		);
	}

	it('default (cap absent): CHECK (v > 0) lifts into domainConstraints', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER CHECK (v > 0)) USING memory');
		const ref = buildReference(new MemoryTableModule());
		const phys = ref.computePhysical([]);
		expect(phys.domainConstraints, 'CHECK should lift to domainConstraints').to.exist;
		const domain = phys.domainConstraints!;
		// Column 1 is `v`. Expect a min: 0 range with minInclusive: false.
		const vDomain = domain.find(d => d.column === 1 && d.kind === 'range');
		expect(vDomain, 'range domain on v').to.exist;
		expect(vDomain).to.include({ kind: 'range', column: 1, min: 0, minInclusive: false });
	});

	it('cap on: CHECK (v > 0) is NOT lifted', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER CHECK (v > 0)) USING memory');
		class WrappedModule extends MemoryTableModule {
			override getCapabilities(): ModuleCapabilities {
				return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
			}
		}
		const ref = buildReference(new WrappedModule());
		const phys = ref.computePhysical([]);
		// `out.domainConstraints` is only set when non-empty (see reference.ts);
		// absence is the contract.
		expect(phys.domainConstraints, 'no CHECK lift under cap').to.be.undefined;
	});

	it('cap on: equality CHECK (a = b) does NOT lift to equivClasses / FDs / constantBindings', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, CHECK (a = b)) USING memory');
		class WrappedModule extends MemoryTableModule {
			override getCapabilities(): ModuleCapabilities {
				return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
			}
		}
		const ref = buildReference(new WrappedModule());
		const phys = ref.computePhysical([]);
		expect(phys.equivClasses, 'no EC lift under cap').to.be.undefined;
		expect(phys.constantBindings, 'no binding lift under cap').to.be.undefined;
		expect(phys.domainConstraints, 'no domain lift under cap').to.be.undefined;
		// `fds` still gets seeded from the PK; assert no a↔b FDs leaked in from
		// the CHECK extraction.
		const fds = phys.fds ?? [];
		const aIdx = 1; // columns: id(0), a(1), b(2)
		const bIdx = 2;
		const hasAtoB = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === aIdx
			&& fd.dependents.length === 1 && fd.dependents[0] === bIdx,
		);
		const hasBtoA = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === bIdx
			&& fd.dependents.length === 1 && fd.dependents[0] === aIdx,
		);
		expect(hasAtoB, 'no a→b FD under cap').to.be.false;
		expect(hasBtoA, 'no b→a FD under cap').to.be.false;
	});

	it('default (cap absent): equality CHECK (a = b) DOES lift to FDs', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, CHECK (a = b)) USING memory');
		const ref = buildReference(new MemoryTableModule());
		const phys = ref.computePhysical([]);
		const fds = phys.fds ?? [];
		const aIdx = 1;
		const bIdx = 2;
		const hasAtoB = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === aIdx
			&& fd.dependents.includes(bIdx),
		);
		const hasBtoA = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === bIdx
			&& fd.dependents.includes(aIdx),
		);
		expect(hasAtoB, 'a→b FD without cap').to.be.true;
		expect(hasBtoA, 'b→a FD without cap').to.be.true;
	});
});
