import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema, IndexColumnSchema, UniqueConstraintSchema } from './table.js';
import type { ViewSchema } from './view.js';
import { normalizeBackingModule } from './view.js';
import { isMaintainedTable, type MaintainedTableSchema } from './derivation.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, quoteIdentifier, expressionToString, viewDefinitionToCanonicalString } from '../emit/ast-stringify.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { generateTableDDL, generateIndexDDL, generateMaintainedTableDDL, constraintToCanonicalDDL, indexToCanonicalDDL } from './ddl-generator.js';

/**
 * Represents a catalog snapshot of the current database schema state
 */
export interface SchemaCatalog {
	schemaName: string;
	tables: CatalogTable[];
	views: CatalogView[];
	indexes: CatalogIndex[];
	assertions: CatalogAssertion[];
}

export interface CatalogTable {
	name: string;
	ddl: string;
	columns: Array<{
		name: string;
		type: string;
		notNull: boolean;
		primaryKey: boolean;
		defaultValue: AST.Expression | null;
		/** Canonical collation (normalized, uppercase). Default `'BINARY'`. */
		collation: string;
		tags?: Readonly<Record<string, SqlValue>>;
	}>;
	primaryKey: Array<{ columnName: string; desc: boolean }>;
	/** Lowercased names of tables this table FK-references (within the same schema). */
	referencedTables: string[];
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * Named constraints (CHECK / UNIQUE / FOREIGN KEY) carrying their tags and a
	 * canonical body fragment. Constraints without a user-supplied name are excluded.
	 * `definition` is the order/format-stable body DDL (name + tags excluded) the
	 * differ compares against a declared constraint's body to detect a
	 * name-unchanged-but-body-changed constraint (→ drop+recreate). Tags are kept
	 * separate (and out of `definition`) so a tag-only change takes `ALTER
	 * CONSTRAINT … SET TAGS`, not a needless drop+recreate.
	 */
	namedConstraints: Array<{ name: string; tags?: Readonly<Record<string, SqlValue>>; definition: string }>;
	/**
	 * Present iff this is a **maintained table** (carries a `derivation` — what
	 * `create materialized view` / `create table … maintained as` produces). A
	 * maintained table round-trips in the table category like any other table; this
	 * descriptor carries the extra derivation dimension the differ compares to
	 * recognize attach / detach / re-attach transitions (table↔maintained) as
	 * non-destructive alter ops instead of a drop+recreate. `bodyHash` is the
	 * canonical DEFINITION hash (`computeBodyHash` over `viewDefinitionToCanonicalString`
	 * — explicit rename list + body + `insert defaults`; name / schema / tags
	 * excluded), matching the live `derivation.bodyHash`. Absent ⇒ a plain table.
	 */
	maintained?: {
		bodyHash: string;
		/** Normalized backing-host module when non-default (absent ⇒ memory). */
		backingModuleName?: string;
		/** Backing-module args; recorded only when non-empty. */
		backingModuleArgs?: Readonly<Record<string, SqlValue>>;
	};
}

export interface CatalogView {
	name: string;
	ddl: string;
	/**
	 * Canonical definition string (explicit column list, body, `insert defaults`
	 * clause; name / schema / tags excluded — see
	 * `viewDefinitionToCanonicalString`). The differ compares this against a
	 * declared view's definition — rendered by the same function — to detect a
	 * name-matched view whose definition changed (→ drop+recreate), mirroring
	 * `CatalogIndex.definition`. Tags are kept separate (and out of `definition`)
	 * so a tag-only change takes `ALTER VIEW … SET TAGS`, not a needless
	 * drop+recreate.
	 */
	definition: string;
	tags?: Readonly<Record<string, SqlValue>>;
}

export interface CatalogIndex {
	name: string;
	tableName: string;
	ddl: string;
	/**
	 * Canonical body string (UNIQUE-ness, column set/order/direction, per-column
	 * collation, partial predicate; name / `on <table>` / tags excluded). Per-column
	 * collation is rendered from the resolved effective value (the same value both
	 * diff sides pre-resolve — see `indexToCanonicalDDL` / the differ's
	 * `declaredIndexCanonicalBody`), so an inherited/default-BINARY collation that is
	 * unchanged never churns while a real collation change recreates. The differ
	 * compares this against a declared index's body — rendered by the same
	 * `createIndexBodyToCanonicalString` — to detect a name-matched index whose
	 * body changed (→ drop+recreate), mirroring `CatalogTable.namedConstraints[].
	 * definition` and `CatalogMaterializedView.bodyHash`. Tags are kept separate
	 * (and out of `definition`) so a tag-only change takes `ALTER INDEX … SET TAGS`,
	 * not a needless drop+recreate.
	 */
	definition: string;
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * True when this index is an *exposed implicit covering structure* — the
	 * secondary BTree backing a UNIQUE constraint tagged
	 * `quereus.expose_implicit_index`. Surfaced for introspection only; its
	 * lifecycle is the originating constraint's (the named-constraint diff path),
	 * so the schema differ MUST exclude it from the standalone-index
	 * create/drop/rename buckets (see `computeSchemaDiff`'s `actualIndexes`).
	 * Absent/false ⇒ an ordinary, differ-managed index.
	 */
	implicit?: boolean;
}

export interface CatalogAssertion {
	name: string;
	ddl: string;
}

/**
 * True when a constraint name is engine-synthesized rather than user-supplied.
 * The schema extractors auto-name unnamed column/table constraints with a
 * reserved `_`-leading prefix (`_check_<col>`, `_fk_<table>_<cols>`,
 * `_uc_<cols>`); such names are deterministic from structure but are NOT stable
 * identity a declarative schema can reference, so they are excluded from the
 * catalog's user-addressable `namedConstraints` (which drives differ
 * add/drop/rename lifecycle). A user who explicitly names a constraint `_x`
 * forfeits declarative lifecycle management of it — an acceptable corner.
 */
function isAutoConstraintName(name: string): boolean {
	return name.startsWith('_');
}

/**
 * Collects current schema state from the database into a catalog representation
 */
export function collectSchemaCatalog(db: Database, schemaName: string = 'main'): SchemaCatalog {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		return {
			schemaName,
			tables: [],
			views: [],
			indexes: [],
			assertions: []
		};
	}

	const tables: CatalogTable[] = [];
	const views: CatalogView[] = [];
	const indexes: CatalogIndex[] = [];
	const assertions: CatalogAssertion[] = [];

	// Collect tables. A maintained table (one carrying a `derivation` — what
	// `create materialized view` / `create table … maintained as` produces)
	// round-trips in the TABLE category like any other table, carrying a
	// `maintained` descriptor (body hash + backing module) so the declarative
	// differ compares it per name in one category and recognizes attach / detach /
	// re-attach transitions as non-destructive alter ops. Its internal covering
	// indexes stay OUT of the catalog `indexes` set — they are a maintenance
	// backing detail, not differ-managed objects. (Check maintained BEFORE isView:
	// a maintained table may legacy-carry isView.)
	for (const tableSchema of schema.getAllTables()) {
		if (isMaintainedTable(tableSchema)) {
			tables.push(tableSchemaToCatalog(tableSchema, db));
			continue;
		}
		if (tableSchema.isView) continue;
		tables.push(tableSchemaToCatalog(tableSchema, db));

		// Collect indexes for this table. Implicit covering structures (the
		// auto-built secondary BTree a declared UNIQUE constraint synthesizes for
		// enforcement) are a backing detail and are omitted by default, surfaced
		// only when the originating constraint opts in via
		// `quereus.expose_implicit_index` — preserving the user-visible shape.
		if (tableSchema.indexes && tableSchema.indexes.length > 0) {
			const implicit = implicitCoveringIndexExposure(tableSchema);
			for (const indexSchema of tableSchema.indexes) {
				const exposed = implicit.get(indexSchema.name);
				if (exposed === false) continue; // hidden implicit covering structure
				// Mark only the *exposed* implicit covering structure (exposed === true);
				// an ordinary index (absent from the exposure map ⇒ undefined) stays
				// unmarked so the differ manages it normally.
				indexes.push(indexSchemaToCatalog(indexSchema, tableSchema, db, exposed === true));
			}
		}

		// Surface exposed implicit covering indexes the backend did NOT
		// materialize as `IndexSchema` entries (store mode). In memory mode this
		// returns [] (the name is already in `tableSchema.indexes` above), so the
		// catalog shape matches across backends with no double-listing. Tags ride
		// on the descriptor (from `uc.exposedIndexTags`), kept out of the canonical
		// `definition` so a tag-only change stays `ALTER INDEX … SET TAGS`.
		for (const desc of exposedImplicitIndexes(tableSchema)) {
			// Every synthetic descriptor is exposed-implicit by construction → mark it.
			indexes.push(indexSchemaToCatalog(desc, tableSchema, db, true));
		}
	}

	// Collect views
	for (const viewSchema of schema.getAllViews()) {
		views.push(viewSchemaToCatalog(viewSchema));
	}

	// Collect assertions
	for (const assertionSchema of schema.getAllAssertions()) {
		assertions.push(assertionSchemaToCatalog(assertionSchema));
	}

	return {
		schemaName,
		tables,
		views,
		indexes,
		assertions
	};
}

function tableSchemaToCatalog(tableSchema: TableSchema, db: Database): CatalogTable {
	// Canonical DDL: a maintained table renders the `create table … maintained as`
	// form (carrying its derivation body), a plain table the ordinary form.
	const maintainedTable = isMaintainedTable(tableSchema) ? tableSchema : undefined;
	const ddl = maintainedTable ? generateMaintainedTableDDL(maintainedTable) : generateTableDDL(tableSchema, db);

	const columns = tableSchema.columns.map(col => ({
		name: col.name,
		type: col.logicalType.name,
		notNull: col.notNull,
		primaryKey: col.primaryKey,
		defaultValue: col.defaultValue ?? null,
		collation: col.collation || 'BINARY',
		tags: col.tags,
	}));

	const primaryKey = tableSchema.primaryKeyDefinition.map(pk => ({
		columnName: tableSchema.columns[pk.index].name,
		desc: pk.desc ?? false,
	}));

	// FK references within the same schema (cross-schema FKs are excluded — drop
	// ordering only matters for tables whose lifetimes are tied to this schema).
	const ownSchemaLower = tableSchema.schemaName.toLowerCase();
	const referencedTables: string[] = [];
	const seen = new Set<string>();
	for (const fk of tableSchema.foreignKeys ?? []) {
		const refSchema = (fk.referencedSchema ?? tableSchema.schemaName).toLowerCase();
		if (refSchema !== ownSchemaLower) continue;
		const refName = fk.referencedTable.toLowerCase();
		if (refName === tableSchema.name.toLowerCase()) continue; // self-FK
		if (seen.has(refName)) continue;
		seen.add(refName);
		referencedTables.push(refName);
	}

	// Surface *user-addressable* named constraints with their tags so the differ
	// can detect renames / drops / adds of named CHECK / UNIQUE / FOREIGN KEY
	// constraints. Excluded:
	//   - engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names
	//     the extractors assign to unnamed column/table constraints) — these are
	//     not stable identity a user can reference declaratively, and surfacing
	//     them would churn add/drop on every diff against a declaration that only
	//     carries explicit names (see `isAutoConstraintName`);
	//   - UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX`
	//     (`derivedFromIndex`) — those are managed as indexes (the differ's
	//     index buckets), not as table constraints.
	const namedConstraints: CatalogTable['namedConstraints'] = [];
	for (const c of tableSchema.checkConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('check', c, tableSchema) });
		}
	}
	for (const c of tableSchema.uniqueConstraints ?? []) {
		if (c.name && !isAutoConstraintName(c.name) && !c.derivedFromIndex) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('unique', c, tableSchema) });
		}
	}
	for (const c of tableSchema.foreignKeys ?? []) {
		if (c.name && !isAutoConstraintName(c.name)) {
			namedConstraints.push({ name: c.name, tags: c.tags, definition: constraintToCanonicalDDL('foreignKey', c, tableSchema) });
		}
	}

	return {
		name: tableSchema.name,
		ddl,
		columns,
		primaryKey,
		referencedTables,
		tags: tableSchema.tags,
		namedConstraints,
		...(maintainedTable ? { maintained: maintainedDescriptor(maintainedTable) } : {}),
	};
}

/**
 * The derivation dimension surfaced on a maintained table's catalog entry — the
 * canonical body hash plus the normalized backing module (compared separately
 * from the hash, the module is deliberately not folded into the hash formula).
 * The differ uses this to recognize a body change (re-attach) vs an unchanged
 * maintained table (no-op), and table↔maintained transitions (attach / detach).
 */
function maintainedDescriptor(table: MaintainedTableSchema): NonNullable<CatalogTable['maintained']> {
	const backing = normalizeBackingModule(table.vtabModuleName, table.vtabArgs);
	return {
		bodyHash: table.derivation.bodyHash,
		backingModuleName: backing.storedModuleName,
		backingModuleArgs: backing.storedModuleArgs,
	};
}

function viewSchemaToCatalog(viewSchema: ViewSchema): CatalogView {
	return {
		name: viewSchema.name,
		ddl: viewSchema.sql,
		definition: viewDefinitionToCanonicalString(viewSchema.columns, viewSchema.selectAst, viewSchema.insertDefaults),
		tags: viewSchema.tags,
	};
}

/**
 * Tag opting a UNIQUE constraint's implicit covering structure into catalog /
 * `export_schema` visibility. Off by default — the auto-built secondary BTree is
 * a backing detail of enforcement, not part of the user-visible schema shape.
 */
const EXPOSE_IMPLICIT_INDEX_TAG = 'quereus.expose_implicit_index';

/**
 * Maps each implicit-covering-structure index name to its exposure flag. An index
 * is an implicit covering structure when it is the secondary BTree auto-built to
 * back a declared (inline) UNIQUE constraint — identified by the deterministic
 * auto-index name `uc.name ?? '_uc_<cols>'` (see
 * `MemoryTableManager.ensureUniqueConstraintIndexes`). Constraints synthesized
 * from a real `CREATE UNIQUE INDEX` (`derivedFromIndex` set) are excluded — that
 * index is the user's, always shown. The flag is `true` when the constraint
 * carries {@link EXPOSE_IMPLICIT_INDEX_TAG} (surface it), `false` otherwise
 * (hide). Index names absent from the map are ordinary indexes (always shown).
 */
function implicitCoveringIndexExposure(tableSchema: TableSchema): Map<string, boolean> {
	const map = new Map<string, boolean>();
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		map.set(implicitIndexName(tableSchema, uc), uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] === true);
	}
	return map;
}

/**
 * Deterministic name of the implicit covering structure realizing `uc` —
 * `uc.name` when the constraint is named, else the auto-name `_uc_<cols>`. This is
 * the single source of the name shared by the catalog exposure map, the synthetic
 * descriptor, and `MemoryTableManager.ensureUniqueConstraintIndexes` (which
 * materializes the identical name).
 */
function implicitIndexName(tableSchema: TableSchema, uc: UniqueConstraintSchema): string {
	const colNames = uc.columns.map(i => tableSchema.columns[i]?.name ?? String(i));
	return uc.name ?? `_uc_${colNames.join('_')}`;
}

/**
 * A backend-agnostic description of an *exposed* implicit covering index that is
 * NOT materialized in `tableSchema.indexes` (the store-mode case). Shaped as a
 * subset of {@link IndexSchema} (no `unique` flag — see below) so the read-path
 * helpers (`indexSchemaToCatalog`, the `schema()` / `index_info()` TVFs) can
 * consume it identically to a real index.
 */
export interface SyntheticExposedIndex {
	name: string;
	/** Mirrors `ensureUniqueConstraintIndexes`: per-column index + declared collation. */
	columns: ReadonlyArray<IndexColumnSchema>;
	/** Partial-index predicate from `uc.predicate`, when any. */
	predicate?: AST.Expression;
	/** User tags from `uc.exposedIndexTags` (the exposure flag stays on `uc.tags`). */
	tags?: Readonly<Record<string, SqlValue>>;
	// NOTE: deliberately NO `unique` flag — mirrors the memory materialized entry
	// (ensureUniqueConstraintIndexes does not set `unique`; UNIQUE enforcement routes
	// through uniqueConstraints), so index_info()'s `unique` column matches across
	// backends.
}

/**
 * Exposed implicit covering indexes that are NOT already materialized in
 * `tableSchema.indexes` — i.e. the store-mode case. For each non-derived UNIQUE
 * constraint carrying `quereus.expose_implicit_index = true` whose implicit name
 * (`uc.name ?? '_uc_<cols>'`) is absent from `tableSchema.indexes`, returns a
 * descriptor the read paths can surface and `updateIndexTags` can target.
 *
 * Returns empty for memory-mode tables (the name is already materialized), so
 * callers can append unconditionally with no risk of double-listing.
 */
export function exposedImplicitIndexes(tableSchema: TableSchema): SyntheticExposedIndex[] {
	const result: SyntheticExposedIndex[] = [];
	const materialized = new Set((tableSchema.indexes ?? []).map(idx => idx.name.toLowerCase()));
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		if (uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] !== true) continue;
		const name = implicitIndexName(tableSchema, uc);
		if (materialized.has(name.toLowerCase())) continue; // memory mode — already surfaced
		result.push({
			name,
			columns: uc.columns.map(colIdx => ({ index: colIdx, collation: tableSchema.columns[colIdx]?.collation })),
			predicate: uc.predicate,
			tags: uc.exposedIndexTags,
		});
	}
	return result;
}

/**
 * Index of the exposed (non-materialized) implicit-covering UNIQUE constraint
 * whose implicit name matches `indexName`, or `-1` when none — the write-path
 * counterpart of {@link exposedImplicitIndexes}. `updateIndexTags` uses this to
 * route `ALTER INDEX … TAGS` onto the originating constraint's `exposedIndexTags`
 * when the index is not materialized as an `IndexSchema` (store mode). A *hidden*
 * implicit index (exposure flag absent/false) and a materialized one both return
 * `-1`, preserving their `NOTFOUND` behavior.
 */
export function findExposedImplicitConstraintIndex(tableSchema: TableSchema, indexName: string): number {
	const lower = indexName.toLowerCase();
	const ucs = tableSchema.uniqueConstraints ?? [];
	const materialized = new Set((tableSchema.indexes ?? []).map(idx => idx.name.toLowerCase()));
	for (let i = 0; i < ucs.length; i++) {
		const uc = ucs[i];
		if (uc.derivedFromIndex) continue;
		if (uc.tags?.[EXPOSE_IMPLICIT_INDEX_TAG] !== true) continue;
		const name = implicitIndexName(tableSchema, uc).toLowerCase();
		if (materialized.has(name)) continue;
		if (name === lower) return i;
	}
	return -1;
}

/**
 * True when `indexName` names an index that is a **hidden** implicit covering
 * structure on `tableSchema` — the auto-built secondary BTree backing a declared
 * UNIQUE constraint that has NOT opted into catalog visibility via
 * {@link EXPOSE_IMPLICIT_INDEX_TAG}. Such an index is a backing detail, not a
 * user-addressable object, so `ALTER INDEX … SET TAGS` treats it as NOTFOUND (its
 * tags live on the originating constraint — use `ALTER TABLE … ALTER CONSTRAINT
 * … SET TAGS`). An *exposed* implicit index (flag true) and any ordinary index
 * are not hidden. Match is by exact stored index name (as the catalog uses it).
 */
export function isHiddenImplicitIndex(tableSchema: TableSchema, indexName: string): boolean {
	return implicitCoveringIndexExposure(tableSchema).get(indexName) === false;
}

function indexSchemaToCatalog(
	indexSchema: IndexSchema,
	tableSchema: TableSchema,
	db: Database,
	/** Set true for an exposed implicit covering structure — see `CatalogIndex.implicit`. */
	implicit = false,
): CatalogIndex {
	const entry: CatalogIndex = {
		name: indexSchema.name,
		tableName: tableSchema.name,
		ddl: generateIndexDDL(indexSchema, tableSchema, db),
		definition: indexToCanonicalDDL(indexSchema, tableSchema),
		tags: indexSchema.tags,
	};
	// Only set the field when true so an ordinary index's catalog shape is unchanged.
	if (implicit) entry.implicit = true;
	return entry;
}

function assertionSchemaToCatalog(assertionSchema: IntegrityAssertionSchema): CatalogAssertion {
	// Emit a faithful, re-parseable `CREATE ASSERTION <name> CHECK (<expr>)` by
	// stringifying the original CHECK expression AST — the same `expressionToString`
	// call `emitCreateAssertion` already uses, so it is proven to produce a
	// parseable expression for this input. Using the stored `violationSql` here
	// instead would embed a full `select 1 where not (...)` query in the CHECK
	// slot, which is not a CHECK-expression and never round-trips through `parse()`.
	//
	// `checkExpression` is absent only for assertions reconstructed from persisted
	// `violationSql` alone — a path that does not exist today (`importDDL`
	// throws on assertion DDL), so the primary branch always fires. The fallback
	// keeps a descriptive (non-reparseable) string for that hypothetical case
	// rather than throwing. See assertion.ts:21-27.
	const checkSql = assertionSchema.checkExpression
		? expressionToString(assertionSchema.checkExpression)
		: assertionSchema.violationSql;
	return {
		name: assertionSchema.name,
		ddl: `CREATE ASSERTION ${quoteIdentifier(assertionSchema.name)} CHECK (${checkSql})`
	};
}

/**
 * Generates canonical DDL from a declared schema AST
 */
export function generateDeclaredDDL(declaredSchema: AST.DeclareSchemaStmt, targetSchema?: string): string[] {
	const ddlStatements: string[] = [];

	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				// Qualify table name with schema if specified
				const tableStmt = item.tableStmt;
				if (targetSchema && targetSchema !== 'main' && !tableStmt.table.schema) {
					const qualifiedStmt: AST.CreateTableStmt = {
						...tableStmt,
						table: {
							...tableStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createTableToString(qualifiedStmt));
				} else {
					ddlStatements.push(createTableToString(tableStmt));
				}
				break;
			}
			case 'declaredIndex': {
				// Generate index DDL using AST stringifier
				const indexStmt = item.indexStmt;
				if (targetSchema && targetSchema !== 'main' && !indexStmt.table.schema) {
					const qualifiedStmt: AST.CreateIndexStmt = {
						...indexStmt,
						table: {
							...indexStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createIndexToString(qualifiedStmt));
				} else {
					ddlStatements.push(createIndexToString(indexStmt));
				}
				break;
			}
			case 'declaredView': {
				// Qualify view name with schema if specified
				const viewStmt = item.viewStmt;
				if (targetSchema && targetSchema !== 'main' && !viewStmt.view.schema) {
					const qualifiedStmt: AST.CreateViewStmt = {
						...viewStmt,
						view: {
							...viewStmt.view,
							schema: targetSchema
						}
					};
					ddlStatements.push(createViewToString(qualifiedStmt));
				} else {
					ddlStatements.push(createViewToString(viewStmt));
				}
				break;
			}
			case 'declaredMaterializedView': {
				// Qualify MV name with schema if specified
				const mvStmt = item.viewStmt;
				if (targetSchema && targetSchema !== 'main' && !mvStmt.view.schema) {
					const qualifiedStmt: AST.CreateMaterializedViewStmt = {
						...mvStmt,
						view: {
							...mvStmt.view,
							schema: targetSchema
						}
					};
					ddlStatements.push(createMaterializedViewToString(qualifiedStmt));
				} else {
					ddlStatements.push(createMaterializedViewToString(mvStmt));
				}
				break;
			}
		}
	}

	return ddlStatements;
}


