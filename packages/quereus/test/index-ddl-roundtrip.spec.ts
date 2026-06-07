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
import { createIndexToString } from '../src/emit/ast-stringify.js';
import { computeSchemaDiff, type SchemaDiff, type RenamePolicy } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import type { CreateIndexStmt, DeclaredIndex, IndexedColumn, DeclareSchemaStmt } from '../src/parser/ast.js';

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

// ============================================================================
// Declarative differ: index BODY drift detection.
//
// The differ resolves indexes by name, then compares a CANONICAL BODY (UNIQUE-
// ness, column set/order/direction, partial WHERE, per-column collation — tags
// excluded) rendered by the same `createIndexBodyToCanonicalString` on both the
// declared-AST side and the actual-catalog side (lifted via `indexToCanonicalDDL`).
// Per-column collation is resolved identically on both sides (explicit index
// COLLATE, else the table column's collation, else BINARY; normalized) so an
// inherited/default-BINARY collation that is unchanged never churns, while a real
// collation change drops+recreates. A name-matched index whose body drifted drops +
// recreates (the recreate carries the declared tags); an unchanged body with drifted
// tags takes in-place SET TAGS.
// ============================================================================

describe('CREATE INDEX DDL round-trip: declarative differ stability', () => {
	/** Parse a `declare schema main { … }` body into its DeclareSchemaStmt AST. */
	function declaredSchemaOf(body: string): DeclareSchemaStmt {
		const stmt = parse(`declare schema main {\n${body}\n}`);
		if (stmt.type !== 'declareSchema') throw new Error(`not a declare schema: ${stmt.type}`);
		return stmt;
	}

	/**
	 * Apply `baseline` as schema `main`, then diff a fresh `modified` declaration
	 * against the resulting actual catalog. The baseline is applied so the actual
	 * table round-trips with zero churn — only the index edit between `baseline` and
	 * `modified` drives the returned diff. `policy` defaults to 'allow'.
	 */
	async function diffIndexEdit(baseline: string, modified: string, policy?: RenamePolicy): Promise<SchemaDiff> {
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${baseline}\n}`);
			await db.exec('apply schema main');
			const actual = collectSchemaCatalog(db, 'main');
			return computeSchemaDiff(declaredSchemaOf(modified), actual, policy);
		} finally {
			await db.close();
		}
	}

	/** Table shared by every index-edit case (identical in baseline + modified, so no table churn). */
	const TABLE = `table t { id INTEGER PRIMARY KEY, name TEXT, email TEXT, active INTEGER }`;

	it('an unchanged re-declared index produces no migration, and the actual DDL carries UNIQUE', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nunique index uq_email on t (email)\n}`);
			await db.exec('apply schema main');
			const actual = collectSchemaCatalog(db, 'main');
			// The actual-side index DDL now carries the UNIQUE keyword (generateIndexDDL).
			expect(actual.indexes.find(i => i.name.toLowerCase() === 'uq_email')!.ddl)
				.to.match(/^CREATE UNIQUE INDEX/);
			// Re-diffing the same declaration is a no-op: the differ compares canonical
			// bodies, and the declared UNIQUE matches the actual UNIQUE body (collation,
			// excluded from the body, cannot churn either).
			const diff = computeSchemaDiff(declaredSchemaOf(`${TABLE}\nunique index uq_email on t (email)`), actual);
			expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
			expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an inherited-NOCASE unique index re-declares with no churn (both sides resolve the same collation)', async () => {
		// The index has no explicit COLLATE; both sides resolve NOCASE from the table
		// column, so the canonical bodies match and no recreate churns.
		const tbl = `table t { id INTEGER PRIMARY KEY, email TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nunique index uq_email on t (email)`, `${tbl}\nunique index uq_email on t (email)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('plain → UNIQUE drops + recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_email on t (email)`, `${TABLE}\nunique index ix_email on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create unique index/i);
		expect(diff.indexTagsChanges, 'no separate SET TAGS').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table churn').to.deep.equal([]);
	});

	it('UNIQUE → plain drops + recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nunique index ix_email on t (email)`, `${TABLE}\nindex ix_email on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create index/i);
		expect(diff.indexesToCreate[0], 'recreate drops the UNIQUE keyword').to.not.match(/unique/i);
	});

	it('adding a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active)`, `${TABLE}\nindex ix_active on t (active) where active = 1`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/where active = 1/i);
	});

	it('removing a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate drops the WHERE').to.not.match(/where/i);
	});

	it('changing a partial WHERE predicate recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active) where active = 0`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_active']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/where active = 0/i);
	});

	it('a semantically-identical partial predicate does not churn', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (active) where active = 1`, `${TABLE}\nindex ix_active on t (active) where active = 1`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a partial WHERE whose column-ref case changes across re-declares does not churn', async () => {
		// The stored predicate keeps the as-written ref case; baseline WHERE references the
		// column as `Active`, the modified re-declare as `active` (the column is `active`).
		// Equal only after folding the column ref in the canonical index body — and the
		// literal `1` is preserved byte-exact (the genuine-edit case above proves it differs).
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_active on t (name) where Active = 1`, `${TABLE}\nindex ix_active on t (name) where active = 1`);
		expect(diff.indexesToDrop, 'no drop from a WHERE column-ref case change').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from a WHERE column-ref case change').to.deep.equal([]);
	});

	it('reordering index columns recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active)`, `${TABLE}\nindex ix_comp on t (active, name)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
	});

	it('flipping a column direction (asc → desc) recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active)`, `${TABLE}\nindex ix_comp on t (name, active desc)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/active desc/i);
	});

	it('a desc index re-declared unchanged does not churn (actual-side desc lift is symmetric)', async () => {
		// Guards the `indexToCanonicalDDL` lift: the stored `IndexColumnSchema.desc`
		// must round-trip to a `desc` direction so a baseline desc index re-declared
		// verbatim renders the SAME canonical body — no spurious drop+recreate. Every
		// other desc test starts from an asc baseline, so only this one exercises the
		// actual side already carrying desc.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, active desc)`, `${TABLE}\nindex ix_comp on t (name, active desc)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
	});

	it('changing the indexed column (different column) recreates the index', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_one on t (name)`, `${TABLE}\nindex ix_one on t (email)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_one']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/\(\s*"?email"?\s*\)/i);
	});

	// An index reference whose case diverges from the column DEFINITION case must not
	// churn: the actual side lifts the definition case (tableSchema.columns[i].name)
	// while the declared side carries the as-written reference case, and the canonical
	// body folds both (matching case-insensitive column resolution). Without the fold
	// these render byte-unequal and drop+recreate on every diff.
	it('an index column whose case differs from the column definition does not churn', async () => {
		// Column declared `Email`, index references `email` — same on both apply→declare
		// sides, so only the definition≠reference case divergence is under test.
		const tbl = `table t { id INTEGER PRIMARY KEY, Email TEXT, Active INTEGER, Name TEXT }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (email)`, `${tbl}\nindex ix on t (email)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a composite index with mixed-case column references does not churn', async () => {
		// Columns `name` / `active` (lowercase definitions) referenced as `Name` / `Active`.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (Name, Active)`, `${TABLE}\nindex ix_comp on t (Name, Active)`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a reserved-word index column in mixed case re-quotes identically on both sides', async () => {
		// Probe: a reserved-word column name must lowercase BEFORE quoteIdentifier so it
		// re-quotes to `"order"` on both the definition (`Order`) and reference (`ORDER`)
		// sides — neither over- nor under-quoted, and no case-only churn.
		const tbl = `table t { id INTEGER PRIMARY KEY, "Order" INTEGER }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t ("ORDER")`, `${tbl}\nindex ix on t ("ORDER")`);
		expect(diff.indexesToCreate, 'no index creates').to.deep.equal([]);
		expect(diff.indexesToDrop, 'no index drops').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('a tags-only change takes SET TAGS, not a recreate', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_name on t (name) with tags (purpose = 'a')`, `${TABLE}\nindex ix_name on t (name) with tags (purpose = 'b')`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges).to.deep.equal([{ name: 'ix_name', tags: { purpose: 'b' } }]);
	});

	it('a body change with a concurrent tags change is a single recreate, no SET TAGS', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_name on t (name) with tags (purpose = 'a')`, `${TABLE}\nunique index ix_name on t (name) with tags (purpose = 'b')`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_name']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/^create unique index/i);
		expect(diff.indexesToCreate[0], 'recreate carries the declared tags').to.match(/purpose = 'b'/i);
		expect(diff.indexTagsChanges, 'no separate SET TAGS').to.deep.equal([]);
	});

	it('a body-change recreate does not trip require-hint policy', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_email on t (email)`, `${TABLE}\nunique index ix_email on t (email)`, 'require-hint');
		expect(diff.indexesToDrop).to.deep.equal(['ix_email']);
		expect(diff.indexesToCreate).to.have.length(1);
	});

	it('a genuine unhinted create + drop still trips require-hint policy', async () => {
		let threw = false;
		try {
			await diffIndexEdit(`${TABLE}\nindex ix_old on t (email)`, `${TABLE}\nindex ix_new on t (email)`, 'require-hint');
		} catch (e) {
			threw = true;
			expect((e as Error).message).to.match(/require-hint/i);
		}
		expect(threw, 'distinct-name create + drop must trip require-hint').to.equal(true);
	});

	it('applying an index body change converges (the drop + recreate executes, re-diff is empty)', async () => {
		// End-to-end: exercise the real apply path (generateMigrationDDL → exec the
		// DROP INDEX + CREATE UNIQUE INDEX pair), not just the diff decision.
		const db = new Database();
		try {
			await db.exec(`declare schema main {\n${TABLE}\nindex ix_email on t (email)\n}`);
			await db.exec('apply schema main');

			// Re-declare the same index as UNIQUE and re-apply — the migration drops
			// and recreates it.
			await db.exec(`declare schema main {\n${TABLE}\nunique index ix_email on t (email)\n}`);
			await db.exec('apply schema main');

			// The applied index is now UNIQUE…
			const actual = collectSchemaCatalog(db, 'main');
			expect(actual.indexes.find(i => i.name.toLowerCase() === 'ix_email')!.ddl).to.match(/^CREATE UNIQUE INDEX/);

			// …and the declaration now matches the catalog (the migration converged —
			// a third diff is empty).
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, actual);
			expect(diff.indexesToCreate, 'converged: no creates').to.deep.equal([]);
			expect(diff.indexesToDrop, 'converged: no drops').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Per-column collation in the canonical index body ---
	// Both sides pre-resolve each column's effective collation (explicit index
	// COLLATE, else the table column's collation, else BINARY; normalized), so an
	// inherited/default-BINARY collation that is unchanged renders identically (no
	// churn) while a genuine collation change diverges (drop+recreate).

	it('an index inheriting BINARY, re-declared verbatim, does not churn', async () => {
		// The common case the original exclusion protected: no COLLATE anywhere, both
		// sides resolve BINARY and elide it.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (name)`, `${TABLE}\nindex ix on t (name)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
		expect(diff.indexTagsChanges, 'no tag changes').to.deep.equal([]);
	});

	it('adding an explicit index COLLATE recreates the index', async () => {
		// Declared resolves NOCASE, actual still BINARY → diverge → drop+recreate.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate nocase)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0], 'recreate carries the declared collation').to.match(/collate nocase/i);
	});

	it('an index inheriting a non-BINARY column collation, re-declared verbatim, does not churn', async () => {
		// `email text collate nocase`, index has no explicit COLLATE: both sides resolve
		// NOCASE from the TABLE column. Guards that the declared side reads the
		// table-column collation, not just the index column's explicit COLLATE.
		const tbl = `table t { id INTEGER PRIMARY KEY, email TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (email)`, `${tbl}\nindex ix on t (email)`);
		expect(diff.indexesToDrop, 'no drop from inherited NOCASE').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from inherited NOCASE').to.deep.equal([]);
		expect(diff.tablesToAlter, 'no table alters').to.deep.equal([]);
	});

	it('changing the column collation under a stable-named index recreates it AND alters the column', async () => {
		// `name text` → `name text collate nocase` with a same-named index inheriting it.
		// The index follows the declared column: declared body resolves NOCASE, actual
		// body (old) is BINARY → drop+recreate. The column itself also emits a SET COLLATE.
		const baseTbl = `table t { id INTEGER PRIMARY KEY, name TEXT }`;
		const modTbl = `table t { id INTEGER PRIMARY KEY, name TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${baseTbl}\nindex ix on t (name)`, `${modTbl}\nindex ix on t (name)`);
		expect(diff.indexesToDrop, 'index drops').to.deep.equal(['ix']);
		expect(diff.indexesToCreate, 'index recreates').to.have.length(1);
		// The column collation change rides the table-alter channel.
		expect(diff.tablesToAlter, 'one table alter').to.have.length(1);
		const colChange = diff.tablesToAlter[0].columnsToAlter.find(c => c.columnName.toLowerCase() === 'name');
		expect(colChange?.collation, 'column SET COLLATE to NOCASE').to.equal('NOCASE');
	});

	it('an explicit COLLATE BINARY on a BINARY column does not churn', async () => {
		// Normalization makes `binary` / `BINARY` / absent equivalent — both elide.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate binary)`);
		expect(diff.indexesToDrop, 'no drop from a no-op explicit BINARY').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate from a no-op explicit BINARY').to.deep.equal([]);
	});

	it('a composite index with all collations unchanged does not churn', async () => {
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, email)`, `${TABLE}\nindex ix_comp on t (name, email)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a composite index gaining one column COLLATE recreates', async () => {
		// Only the second column's render differs → recreate.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix_comp on t (name, email)`, `${TABLE}\nindex ix_comp on t (name, email collate nocase)`);
		expect(diff.indexesToDrop).to.deep.equal(['ix_comp']);
		expect(diff.indexesToCreate).to.have.length(1);
		expect(diff.indexesToCreate[0]).to.match(/collate nocase/i);
	});

	it('a desc index inheriting a non-BINARY collation, re-declared verbatim, does not churn', async () => {
		// Guards the name->collate->desc render order on both sides with an inherited
		// NOCASE collation plus a descending column.
		const tbl = `table t { id INTEGER PRIMARY KEY, name TEXT collate nocase }`;
		const diff = await diffIndexEdit(`${tbl}\nindex ix on t (name desc)`, `${tbl}\nindex ix on t (name desc)`);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	// PENDING — blocked on `index-explicit-column-collate-apply-path`. The canonical
	// BODY logic this ticket added already handles the collate-folded form correctly
	// (`declaredIndexCanonicalBody` resolves the collation off `col.expr` and preserves
	// `col.direction`). What this test cannot yet do is APPLY the baseline: the live
	// `CREATE INDEX … (email collate nocase desc)` path (`buildIndexSchema`) rejects any
	// collate-folded column as an "expression index", and `createIndexToString` also
	// drops the trailing `desc` for that form. Un-skip once that apply/emit path supports
	// explicit per-column index COLLATE; the expectation below should then hold (no churn).
	it.skip('an explicit COLLATE on a descending column (collate-folded form), re-declared verbatim, does not churn', async () => {
		const diff = await diffIndexEdit(
			`${TABLE}\nindex ix on t (email collate nocase desc)`,
			`${TABLE}\nindex ix on t (email collate nocase desc)`,
		);
		expect(diff.indexesToDrop, 'no drop').to.deep.equal([]);
		expect(diff.indexesToCreate, 'no recreate').to.deep.equal([]);
	});

	it('a pure collation body-change recreate does not trip require-hint policy', async () => {
		// A collation-driven recreate is a body change (counts in indexBodyRecreates),
		// so it is excluded from the unhinted-rename guard, exactly as other body changes.
		const diff = await diffIndexEdit(`${TABLE}\nindex ix on t (email)`, `${TABLE}\nindex ix on t (email collate nocase)`, 'require-hint');
		expect(diff.indexesToDrop).to.deep.equal(['ix']);
		expect(diff.indexesToCreate).to.have.length(1);
	});
});

// ============================================================================
// `declare schema { ... }` index WHERE-clause grammar (partial declared index).
//
// `declareIndexItem` must accept an optional WHERE <predicate> between the column
// list and WITH TAGS, mirroring the standalone `create index` form, so a partial
// index can be expressed inside a declarative schema. These are parse-level tests:
// they inspect the `CreateIndexStmt.where` the parser populates on each declared
// index item.
// ============================================================================

/** Extract every declared index's `CreateIndexStmt` from a declare-schema body. */
function declaredIndexes(body: string): CreateIndexStmt[] {
	const stmt = parse(`declare schema main {\n${body}\n}`);
	if (stmt.type !== 'declareSchema') throw new Error(`not a declare schema: ${stmt.type}`);
	return stmt.items
		.filter((it): it is DeclaredIndex => it.type === 'declaredIndex')
		.map(it => it.indexStmt);
}

describe('declare schema: index WHERE-clause grammar', () => {
	it('a plain partial index populates indexStmt.where', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 index ix_active on t (active) where active = 1`,
		);
		expect(ix.index.name).to.equal('ix_active');
		expect(ix.where, 'partial declared index carries a WHERE predicate').to.exist;
		expect(ix.isUnique ?? false, 'plain index is not unique').to.equal(false);
		expect(ix.tags, 'no tags on a bare partial index').to.be.undefined;
	});

	it('a unique partial index sets both isUnique and where', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 unique index uq_active on t (active) where active = 1`,
		);
		expect(ix.isUnique, 'unique keyword threads through').to.equal(true);
		expect(ix.where, 'unique partial index carries a WHERE predicate').to.exist;
	});

	it('a partial index with WITH TAGS populates both where and tags', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 unique index uq_a on t (active) where active = 1 with tags (k = 'v')`,
		);
		expect(ix.where, 'WHERE before WITH TAGS').to.exist;
		expect(ix.tags, 'WITH TAGS still parses after WHERE').to.deep.equal({ k: 'v' });
		expect(ix.isUnique).to.equal(true);
	});

	it('a non-partial declared index leaves where undefined (no regression)', () => {
		// Plain, tag-only, and a tag-only index followed by another item all keep
		// `where` undefined and must not mis-step the WITH/TAGS backtrack.
		const ixs = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }
			 index ix_plain on t (name)
			 index ix_tagged on t (active) with tags (purpose = 'search')
			 index ix_after on t (id)`,
		);
		expect(ixs.map(i => i.index.name)).to.deep.equal(['ix_plain', 'ix_tagged', 'ix_after']);
		expect(ixs[0].where, 'plain index has no predicate').to.be.undefined;
		expect(ixs[1].where, 'tag-only index has no predicate').to.be.undefined;
		expect(ixs[1].tags).to.deep.equal({ purpose: 'search' });
		// The item after a tag-only index parses cleanly — the WITH backtrack did
		// not strand the cursor.
		expect(ixs[2].where).to.be.undefined;
		expect(indexColumnName(ixs[2].columns[0])).to.equal('id');
	});

	it('a non-trivial predicate round-trips through createIndexToString re-parseably', () => {
		const [ix] = declaredIndexes(
			`table t { id INTEGER PRIMARY KEY, active INTEGER }
			 index ix_active on t (active) where active = 1 and id > 0`,
		);
		const emitted = createIndexToString(ix);
		expect(emitted, 'emitted DDL carries the full predicate').to.match(/where active = 1 and id > 0/i);

		// Re-parse the emitted standalone DDL and re-emit: createIndexToString is a
		// fixed point over the declared partial index, so the predicate survives.
		const reparsed = parse(emitted);
		expect(reparsed.type).to.equal('createIndex');
		if (reparsed.type === 'createIndex') {
			expect(reparsed.where, 're-parsed DDL still carries a WHERE').to.exist;
			expect(createIndexToString(reparsed)).to.equal(emitted);
		}
	});
});
