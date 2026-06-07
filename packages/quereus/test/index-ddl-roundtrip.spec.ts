/**
 * Lossless CREATE INDEX DDL round-trip through the engine.
 *
 * Pins the three engine-level facts that let a secondary index survive being
 * persisted as canonical DDL and rehydrated by re-parsing (the store catalog
 * path, exercised here without the store):
 *
 *   1. `generateIndexDDL` emits UNIQUE + partial WHERE (+ collation / desc / tags),
 *      ordered to match the parser grammar so the result re-parses to the same shape.
 *   2. `SchemaManager.importIndex` reconstructs the full IndexSchema from the
 *      re-parsed AST — unique, predicate, per-column collation (including the
 *      collate-wrapped column form the parser folds `COLLATE` into) — and
 *      synthesizes the `derivedFromIndex` UNIQUE constraint for a unique index.
 *   3. `importCatalog` accepts a multi-statement entry (a table bundled with its
 *      indexes), importing each in document order.
 *
 * `index_info()` / `unique_constraint_info()` are the assertion surface — they
 * report the reconstructed unique / partial / collation / desc / tags / derived
 * constraint straight off the schema.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateTableDDL, generateIndexDDL } from '../src/schema/ddl-generator.js';
import { parse } from '../src/parser/index.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import type { IndexedColumn } from '../src/parser/ast.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/**
 * The bare column name an indexed-column AST node refers to. The parser folds
 * `col COLLATE x` into a `collate` expression over a column reference, so the
 * name lives on `col.expr.expr.name` for that form.
 */
function indexColumnName(col: IndexedColumn): string | undefined {
	if (col.name) return col.name;
	if (col.expr?.type === 'collate' && col.expr.expr.type === 'column') return col.expr.expr.name;
	return undefined;
}

/** The collation an indexed column carries, from either fold (see positions spec). */
function indexCollationOf(col: IndexedColumn): string | undefined {
	if (col.collation) return col.collation;
	if (col.expr?.type === 'collate') return col.expr.collation;
	return undefined;
}

/** The index name a CREATE INDEX DDL string declares (via the real parser). */
function parseIndexName(ddl: string): string {
	const stmt = parse(ddl);
	if (stmt.type !== 'createIndex') throw new Error(`not a CREATE INDEX: ${ddl}`);
	return stmt.index.name;
}

/**
 * Builds a source DB with a table and a representative spread of secondary
 * indexes (unique, partial, composite/desc, tagged, unique-partial). Returns the
 * DB plus the canonical table + index DDL generated from its live schema.
 */
async function buildSource(): Promise<{ db: Database; tableDDL: string; indexDDLs: string[] }> {
	const db = new Database();
	await db.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
	await db.exec('create unique index uq_email on t (email)');           // unique + inherited NOCASE collation
	await db.exec('create index ix_active on t (active) where active = 1'); // partial (WHERE)
	await db.exec('create index ix_comp on t (name, active desc)');        // composite + desc
	await db.exec("create index ix_tagged on t (name) with tags (purpose = 'search')"); // tags
	await db.exec('create unique index uq_name_active on t (name) where active = 1');    // unique + partial

	const t = db.schemaManager.getTable('main', 't')!;
	return {
		db,
		tableDDL: generateTableDDL(t),
		indexDDLs: t.indexes!.map(ix => generateIndexDDL(ix, t)),
	};
}

describe('CREATE INDEX DDL round-trip: generateIndexDDL emission', () => {
	let src: Database;
	let indexDDLs: string[];

	before(async () => {
		const s = await buildSource();
		src = s.db;
		indexDDLs = s.indexDDLs;
	});

	after(async () => { await src.close(); });

	it('emits UNIQUE + inherited collation for a unique index', () => {
		const ddl = indexDDLs[0];
		expect(ddl).to.match(/^CREATE UNIQUE INDEX /);
		expect(ddl).to.include('COLLATE NOCASE');
	});

	it('emits a WHERE predicate for a partial index', () => {
		const ddl = indexDDLs[1];
		expect(ddl).to.not.match(/^CREATE UNIQUE/);
		expect(ddl).to.match(/\bWHERE active = 1\b/);
	});

	it('emits DESC for a descending composite column, columns before WHERE before WITH TAGS', () => {
		expect(indexDDLs[2]).to.match(/\("name" COLLATE BINARY, "active" COLLATE BINARY DESC\)/);
		// Clause ordering: WHERE comes after the column list (partial unique index).
		const uniquePartial = indexDDLs[4];
		expect(uniquePartial.indexOf('(')).to.be.lessThan(uniquePartial.indexOf('WHERE'));
	});

	it('emits WITH TAGS after the column list', () => {
		expect(indexDDLs[3]).to.match(/\("name" COLLATE BINARY\) WITH TAGS \(purpose = 'search'\)/);
	});

	it('every generated index DDL re-parses to an equivalent createIndex AST', () => {
		for (const ddl of indexDDLs) {
			const stmt = parse(ddl);
			expect(stmt.type, ddl).to.equal('createIndex');
		}
		// Spot-check reconstructed AST fidelity per case.
		const uq = parse(indexDDLs[0]);
		const partial = parse(indexDDLs[1]);
		const comp = parse(indexDDLs[2]);
		const tagged = parse(indexDDLs[3]);
		if (uq.type === 'createIndex') {
			expect(uq.isUnique).to.equal(true);
			expect(indexColumnName(uq.columns[0])).to.equal('email');
			expect(indexCollationOf(uq.columns[0])?.toLowerCase()).to.equal('nocase');
		}
		if (partial.type === 'createIndex') {
			expect(partial.isUnique ?? false).to.equal(false);
			expect(partial.where, 'partial index carries a WHERE predicate').to.exist;
		}
		if (comp.type === 'createIndex') {
			expect(comp.columns).to.have.length(2);
			expect(comp.columns[1].direction).to.equal('desc');
		}
		if (tagged.type === 'createIndex') {
			expect(tagged.tags?.purpose).to.equal('search');
		}
	});
});

describe('CREATE INDEX DDL round-trip: importCatalog reconstruction', () => {
	it('rehydrates unique / partial / collation / desc / tags + derived constraint losslessly', async () => {
		const { db: src, indexDDLs } = await buildSource();
		try {
			const srcIndexInfo = await rows(src, "select * from index_info('t')");
			const srcUniqueInfo = await rows(src, "select * from unique_constraint_info('t')");

			// Fresh DB: table established first (so the memory module can connect),
			// then the index bundle imported as a single multi-statement entry.
			const dst = new Database();
			try {
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				const result = await dst.schemaManager.importCatalog([indexDDLs.join(';\n')]);
				expect(result.indexes).to.have.length(indexDDLs.length);

				const dstIndexInfo = await rows(dst, "select * from index_info('t')");
				const dstUniqueInfo = await rows(dst, "select * from unique_constraint_info('t')");

				// Full-fidelity: the rehydrated catalog matches the source byte-for-byte.
				expect(dstIndexInfo, 'index_info round-trips').to.deep.equal(srcIndexInfo);
				expect(dstUniqueInfo, 'unique_constraint_info round-trips').to.deep.equal(srcUniqueInfo);

				// Explicit spot-checks (guard against both sides being wrong together).
				const uqEmail = dstIndexInfo.find(r => r.index_name === 'uq_email')!;
				expect(uqEmail.unique).to.equal(1);
				expect(uqEmail.collation).to.equal('NOCASE');
				const ixActive = dstIndexInfo.find(r => r.index_name === 'ix_active')!;
				expect(ixActive.partial).to.equal(1);
				const ixCompDesc = dstIndexInfo.find(r => r.index_name === 'ix_comp' && r.seq === 1)!;
				expect(ixCompDesc.desc).to.equal(1);
				const ixTagged = dstIndexInfo.find(r => r.index_name === 'ix_tagged')!;
				expect(ixTagged.tags).to.equal('{"purpose":"search"}');

				// Both unique indexes synthesized their derived UNIQUE constraint; the
				// partial one carries the partial flag.
				const derivedNames = dstUniqueInfo.map(r => r.name);
				expect(derivedNames).to.include.members(['uq_email', 'uq_name_active']);
				const derivedPartial = dstUniqueInfo.find(r => r.name === 'uq_name_active')!;
				expect(derivedPartial.partial).to.equal(1);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('a collate-wrapped index column imports without the expression-index rejection', async () => {
		// Every generated index DDL emits an explicit COLLATE, which re-parses as a
		// `collate` expression over the column — the exact shape the old importIndex
		// rejected as an expression index.
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, email text)');
			await dst.schemaManager.importCatalog(['CREATE INDEX i ON t (email COLLATE NOCASE)']);
			const info = await rows(dst, "select column_name, collation from index_info('t')");
			expect(info).to.deep.equal([{ column_name: 'email', collation: 'NOCASE' }]);
		} finally {
			await dst.close();
		}
	});

	it('a genuine expression index is still rejected on import', async () => {
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, email text)');
			let threw = false;
			try {
				await dst.schemaManager.importCatalog(['CREATE INDEX i ON t (lower(email))']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/Expression-based index columns are not supported/);
			}
			expect(threw, 'expression index import should throw').to.equal(true);
		} finally {
			await dst.close();
		}
	});

	it('re-generating DDL from the imported schema is a fixed point (predicate / collation / desc survive textually)', async () => {
		// index_info() exposes the partial flag but NOT the predicate text, so the
		// deep-equal above cannot catch predicate drift (WHERE active = 1 degrading
		// to a different/empty body). Re-emitting the imported index as DDL and
		// comparing it to the original generated DDL closes that gap: it asserts the
		// whole clause shape — UNIQUE, column collation, DESC, WHERE body, tags —
		// round-trips, making generateIndexDDL a fixed point over import.
		const { db: src, indexDDLs } = await buildSource();
		try {
			const dst = new Database();
			try {
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				await dst.schemaManager.importCatalog([indexDDLs.join(';\n')]);

				const dstTable = dst.schemaManager.getTable('main', 't')!;
				const byName = new Map(indexDDLs.map(ddl => [parseIndexName(ddl), ddl]));
				for (const ix of dstTable.indexes!) {
					const regenerated = generateIndexDDL(ix, dstTable);
					expect(regenerated, `index ${ix.name} re-emits identically`).to.equal(byName.get(ix.name));
				}
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('a composite UNIQUE index synthesizes a derived constraint over all its columns', async () => {
		const dst = new Database();
		try {
			await dst.exec('create table t (id integer primary key, a integer, b integer)');
			await dst.schemaManager.importCatalog(['CREATE UNIQUE INDEX uq_ab ON t (a, b DESC)']);
			const uc = await rows(dst, "select name, column_name, seq from unique_constraint_info('t') where name = 'uq_ab' order by seq");
			expect(uc.map(r => r.column_name)).to.deep.equal(['a', 'b']);
		} finally {
			await dst.close();
		}
	});
});

describe('CREATE INDEX DDL round-trip: importCatalog multi-statement entries', () => {
	it('imports a CREATE TABLE + CREATE INDEX bundle in document order', async () => {
		const { db: src, tableDDL, indexDDLs } = await buildSource();
		try {
			const dst = new Database();
			try {
				// Establish the memory table so module.connect() succeeds (the store
				// module connects to fresh storage; memory requires a prior create).
				await dst.exec('create table t (id integer primary key, email text collate nocase, active integer, name text)');
				const result = await dst.schemaManager.importCatalog([`${tableDDL};\n${indexDDLs[0]}`]);
				expect(result.tables, 'table imported from the bundle').to.have.length(1);
				expect(result.indexes, 'index imported from the same bundle').to.have.length(1);
				const info = await rows(dst, "select index_name, unique from index_info('t')");
				expect(info).to.deep.equal([{ index_name: 'uq_email', unique: 1 }]);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('an empty DDL string is a no-op', async () => {
		const dst = new Database();
		try {
			const result = await dst.schemaManager.importCatalog(['']);
			expect(result).to.deep.equal({ tables: [], indexes: [] });
		} finally {
			await dst.close();
		}
	});

	it('an unsupported statement type in a bundle throws (fail-loud)', async () => {
		const dst = new Database();
		try {
			let threw = false;
			try {
				await dst.schemaManager.importCatalog(['select 1']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/does not support statement type/);
			}
			expect(threw).to.equal(true);
		} finally {
			await dst.close();
		}
	});
});

describe('CREATE INDEX DDL round-trip: declarative differ stability', () => {
	it('a declared UNIQUE index diffed against the applied catalog produces no migration', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, email TEXT NOT NULL }
				unique index uq_email on t (email)
			}`);
			await db.exec('apply schema main');

			// The actual-side index DDL now carries the UNIQUE keyword (generateIndexDDL).
			const actual = collectSchemaCatalog(db, 'main');
			expect(actual.indexes.find(i => i.name.toLowerCase() === 'uq_email')!.ddl)
				.to.match(/^CREATE UNIQUE INDEX/);

			// Diffing the same declaration against that catalog is a no-op: index
			// matching is name-based, so the added UNIQUE keyword introduces no churn.
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});
