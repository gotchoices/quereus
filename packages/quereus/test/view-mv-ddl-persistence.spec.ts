/**
 * Engine-side support for persisting (materialized) views in a store-backed catalog.
 *
 * Pins the three engine facts the store package consumes (sibling ticket
 * `store-view-mv-catalog-persistence`), exercised here without the store:
 *
 *   1. A plain `CREATE VIEW` / `DROP VIEW` fires `view_added` / `view_removed`
 *      from the runtime emitters (so a store catalog can persist incrementally),
 *      and the `IF [NOT] EXISTS` no-ops fire nothing. Internal `schema.addView`
 *      callers (lens bodies) are deliberately NOT covered — they never route
 *      through the emitter, so no event fires for them.
 *   2. `generateViewDDL` / `generateMaterializedViewDDL` emit fully-qualified,
 *      tag-carrying, re-parseable DDL (a parse→generate→parse fixed point) so a
 *      `view_modified` (SET TAGS, which leaves the stored `sql` stale) round-trips.
 *   3. `SchemaManager.importCatalog` silently registers a plain view from its DDL
 *      without planning the body (queryable, body validation deferred), names it
 *      in the `.views` result, and still fails loud on a materialized view.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateViewDDL, generateMaterializedViewDDL } from '../src/schema/ddl-generator.js';
import { parse } from '../src/parser/index.js';
import { backingTableNameFor, type ViewSchema, type MaterializedViewSchema } from '../src/schema/view.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** Collect every schema-change event a database fires while `fn` runs. */
async function captureEvents(db: Database, fn: () => Promise<void>): Promise<SchemaChangeEvent[]> {
	const events: SchemaChangeEvent[] = [];
	const off = db.schemaManager.getChangeNotifier().addListener(e => events.push(e));
	try {
		await fn();
	} finally {
		off();
	}
	return events;
}

describe('view persistence: view_added / view_removed lifecycle events', () => {
	it('CREATE VIEW fires a single view_added carrying the view schema', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, () =>
				db.exec("create view v as select 1 as a with tags (purpose = 'test')"));
			const added = events.filter(e => e.type === 'view_added');
			expect(added, 'one view_added').to.have.length(1);
			expect(added[0].objectName).to.equal('v');
			expect(added[0].schemaName).to.equal('main');
			// The event carries the live ViewSchema (incl. tags) the store persists.
			const ev = added[0];
			if (ev.type === 'view_added') {
				expect(ev.newObject.name).to.equal('v');
				expect(ev.newObject.tags).to.deep.equal({ purpose: 'test' });
			}
		} finally {
			await db.close();
		}
	});

	it('DROP VIEW fires a single view_removed carrying the old schema', async () => {
		const db = new Database();
		try {
			await db.exec('create view v as select 1 as a');
			const events = await captureEvents(db, () => db.exec('drop view v'));
			const removed = events.filter(e => e.type === 'view_removed');
			expect(removed, 'one view_removed').to.have.length(1);
			expect(removed[0].objectName).to.equal('v');
			const ev = removed[0];
			if (ev.type === 'view_removed') {
				expect(ev.oldObject.name).to.equal('v');
			}
		} finally {
			await db.close();
		}
	});

	it('CREATE VIEW IF NOT EXISTS on an existing view fires no view_added (no-op)', async () => {
		const db = new Database();
		try {
			await db.exec('create view v as select 1 as a');
			const events = await captureEvents(db, () =>
				db.exec('create view if not exists v as select 2 as a'));
			expect(events.filter(e => e.type === 'view_added'), 'no event on the no-op').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('DROP VIEW IF EXISTS on a missing view fires no view_removed (no-op)', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, () => db.exec('drop view if exists nope'));
			expect(events.filter(e => e.type === 'view_removed'), 'no event on the no-op').to.have.length(0);
		} finally {
			await db.close();
		}
	});
});

describe('view persistence: importCatalog silent view registration', () => {
	it('registers a queryable view with tags, names it in .views, fires no event', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, async () => {
				const result = await db.schemaManager.importCatalog([
					"create view v as select 1 as a, 2 as b with tags (purpose = 'test')",
				]);
				expect(result.views, 'view named in the result').to.deep.equal(['main.v']);
				expect(result.tables).to.deep.equal([]);
				expect(result.indexes).to.deep.equal([]);
			});
			// Silent — import must not re-emit a persistence event.
			expect(events.filter(e => e.type === 'view_added'), 'import is silent').to.have.length(0);

			// Registered with tags…
			const view = db.schemaManager.getView('main', 'v');
			expect(view?.tags).to.deep.equal({ purpose: 'test' });
			// …and queryable (the body planned lazily on first reference).
			expect(await rows(db, 'select a, b from v')).to.deep.equal([{ a: 1, b: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a view whose body references a not-yet-imported relation imports without throwing', async () => {
		const db = new Database();
		try {
			// `missing` does not exist — import must defer body validation to query time.
			const result = await db.schemaManager.importCatalog(['create view v as select * from missing']);
			expect(result.views).to.deep.equal(['main.v']);
			expect(db.schemaManager.getView('main', 'v'), 'view registered despite unresolved body').to.exist;
		} finally {
			await db.close();
		}
	});

	it('a view over another (later-imported) view imports order-independently', async () => {
		const db = new Database();
		try {
			// v_outer references v_inner, but v_outer is imported FIRST.
			const result = await db.schemaManager.importCatalog([
				'create view v_outer as select a from v_inner',
				'create view v_inner as select 7 as a',
			]);
			expect(result.views).to.deep.equal(['main.v_outer', 'main.v_inner']);
			expect(await rows(db, 'select a from v_outer')).to.deep.equal([{ a: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('a materialized view DDL still fails loud through importCatalog', async () => {
		const db = new Database();
		try {
			let threw = false;
			try {
				await db.schemaManager.importCatalog(['create materialized view mv as select 1 as a']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/does not support statement type/);
			}
			expect(threw, 'MV import must fail loud').to.equal(true);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// generateViewDDL / generateMaterializedViewDDL parse→generate→parse fixed point.
//
// The generators read the LIVE schema (tags included) and emit fully-qualified,
// re-parseable DDL. A `view_modified` / `materialized_view_modified` swaps the
// in-memory schema without rewriting the stored `sql`, so the generators — not the
// stale `sql` — are what a store regenerates and re-persists. The matrix covers the
// tag / column / body shapes that must survive that round-trip.
// ============================================================================

/** Lift a `create view` DDL string into the minimal ViewSchema the generator reads. */
function viewSchemaFromDDL(ddl: string): ViewSchema {
	const stmt = parse(ddl);
	if (stmt.type !== 'createView') throw new Error(`not a create view: ${stmt.type}`);
	return {
		name: stmt.view.name,
		schemaName: stmt.view.schema ?? 'main',
		sql: ddl,
		selectAst: stmt.select,
		columns: stmt.columns ? [...stmt.columns] : undefined,
		tags: stmt.tags,
	};
}

/** Lift a `create materialized view` DDL into a MaterializedViewSchema; the
 *  fields the generator never reads (backing / pk / hash / sources) are stubbed. */
function mvSchemaFromDDL(ddl: string): MaterializedViewSchema {
	const stmt = parse(ddl);
	if (stmt.type !== 'createMaterializedView') throw new Error(`not a create materialized view: ${stmt.type}`);
	return {
		name: stmt.view.name,
		schemaName: stmt.view.schema ?? 'main',
		sql: ddl,
		selectAst: stmt.select,
		columns: stmt.columns ? [...stmt.columns] : undefined,
		tags: stmt.tags,
		backingTableName: backingTableNameFor(stmt.view.name),
		primaryKey: [],
		bodyHash: '',
		sourceTables: [],
	};
}

/** The tag / column / body matrix, parameterized by the CREATE keyword. */
function matrix(kind: 'view' | 'materialized view'): { name: string; ddl: string }[] {
	const k = `create ${kind} v`;
	return [
		{ name: 'no tags', ddl: `${k} as select 1 as a` },
		{ name: 'single tag', ddl: `${k} as select 1 as a with tags (k = 'v')` },
		{ name: 'multiple tags', ddl: `${k} as select 1 as a with tags (k1 = 'v1', k2 = 2, k3 = true)` },
		{ name: 'reserved quereus.update.* tag key (quoted)', ddl: `${k} as select 1 as a with tags ("quereus.update.deny" = true)` },
		{ name: 'explicit column list', ddl: `${k} (x, y) as select 1, 2` },
		{ name: 'compound-SELECT body', ddl: `${k} as select 1 as a union all select 2 as a` },
		{ name: 'VALUES body', ddl: `${k} as values (1, 2), (3, 4)` },
	];
}

describe('view persistence: generateViewDDL fixed point', () => {
	const gen = (ddl: string) => generateViewDDL(viewSchemaFromDDL(ddl));

	it('always emits a fully-qualified (schema.name) view name', () => {
		// Qualification is unconditional; bare-valid names stay unquoted (main.v).
		expect(gen('create view v as select 1 as a')).to.match(/^create view main\.v /i);
	});

	for (const { name, ddl } of matrix('view')) {
		it(`re-parses and is a fixed point: ${name}`, () => {
			const once = gen(ddl);
			expect(parse(once).type, 'generated DDL re-parses to createView').to.equal('createView');
			expect(gen(once), 'generate is a fixed point over its own re-parse').to.equal(once);
		});
	}

	it('preserves tags, columns, and body shape through the round-trip', () => {
		const tagged = parse(gen("create view v as select 1 as a with tags (k1 = 'v1', \"quereus.update.deny\" = true)"));
		if (tagged.type === 'createView') {
			expect(tagged.tags).to.deep.equal({ k1: 'v1', 'quereus.update.deny': true });
		}
		const cols = parse(gen('create view v (x, y) as select 1, 2'));
		if (cols.type === 'createView') expect(cols.columns).to.deep.equal(['x', 'y']);
		const vals = parse(gen('create view v as values (1, 2)'));
		if (vals.type === 'createView') expect(vals.select.type).to.equal('values');
	});
});

describe('view persistence: generateMaterializedViewDDL fixed point', () => {
	const gen = (ddl: string) => generateMaterializedViewDDL(mvSchemaFromDDL(ddl));

	it('always emits a fully-qualified (schema.name) MV name and omits the USING clause', () => {
		const ddl = gen('create materialized view v using memory as select 1 as a');
		expect(ddl).to.match(/^create materialized view main\.v /i);
		expect(ddl, 'USING is informational only and is dropped (backing rebuilds as memory)').to.not.match(/using/i);
	});

	for (const { name, ddl } of matrix('materialized view')) {
		it(`re-parses and is a fixed point: ${name}`, () => {
			const once = gen(ddl);
			expect(parse(once).type, 'generated DDL re-parses to createMaterializedView').to.equal('createMaterializedView');
			expect(gen(once), 'generate is a fixed point over its own re-parse').to.equal(once);
		});
	}

	it('preserves tags, columns, and body shape through the round-trip', () => {
		const tagged = parse(gen("create materialized view v as select 1 as a with tags (k1 = 'v1')"));
		if (tagged.type === 'createMaterializedView') expect(tagged.tags).to.deep.equal({ k1: 'v1' });
		const cols = parse(gen('create materialized view v (x, y) as select 1, 2'));
		if (cols.type === 'createMaterializedView') expect(cols.columns).to.deep.equal(['x', 'y']);
	});
});
