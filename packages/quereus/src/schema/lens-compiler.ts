import type { Database } from '../core/database.js';
import type { Schema } from './schema.js';
import type { SchemaManager } from './manager.js';
import type { TableSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type * as AST from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { astToString } from '../emit/ast-stringify.js';
import { buildLogicalConstraints, type LensSlot, type LensColumnProvenance } from './lens.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:lens-compiler');

/**
 * Lens compiler — the `apply schema X` step for a **logical** schema.
 *
 * For each declared logical table it: builds the logical spec, aligns it against
 * the basis schema (the default name-based aligner), produces the inlined
 * effective view body, populates the lens slot, and registers the body as an
 * ordinary `ViewSchema`. The query processor then sees a view; reads ride the
 * standard view-resolution path and writes ride view-updateability.
 *
 * v1 is **single-source, name-based** (see `docs/lens.md` § The Default Mapper):
 * a logical table maps to a name-matching basis table, and each logical column
 * to a name-matching basis column. Type/nullability conformance and the n-way
 * decomposition shape are deferred to the prover / decomposition tickets.
 */

/**
 * Deploys (or re-deploys) a logical schema's lens slots + compiled view bodies.
 *
 * Re-deploy semantics are **clear-and-rebuild**: every existing lens view + slot
 * in the logical schema is dropped, then rebuilt from the current declaration.
 * This is how asymmetric removal falls out for free — a logical table dropped
 * from the declaration is simply not rebuilt (its view + slot vanish), and the
 * basis is never touched (logical removals never cascade to basis storage; see
 * `docs/lens.md` § Deployment).
 */
export function deployLogicalSchema(
	db: Database,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	validateLogicalDeclaration(declaredSchema, logicalSchemaName);

	const schemaManager = db.schemaManager;
	const logicalSchema = schemaManager.getSchemaOrFail(logicalSchemaName);

	// The lens block (explicit `over Y` basis + sparse overrides), if declared.
	// Re-read from source on every deploy — that is what lets a rename and a
	// later column-add compose without attribute-ID plumbing (docs/lens.md § D2).
	const lensDecl = db.declaredSchemaManager.getLensDeclaration(logicalSchemaName);
	const overridesByTable = indexOverrides(lensDecl, declaredSchema, logicalSchemaName);

	// Infer the basis lazily, only when there is ≥1 logical table to align. An
	// empty logical declaration (e.g. re-applying X after all its tables are
	// removed) is a pure detach-everything operation and must NOT fail on basis
	// resolution — removal never depends on the basis (asymmetric removal).
	let basis: { schema: Schema; schemaName: string } | undefined;
	const resolveBasis = (): { schema: Schema; schemaName: string } => {
		if (lensDecl) {
			// Explicit `over Y` binding resolves the foundation's default-basis
			// ambiguity (docs/lens.md § D4); `inferDefaultBasis` is NOT consulted.
			const basisSchema = schemaManager.getSchema(lensDecl.basisSchema);
			if (!basisSchema) {
				throw new QuereusError(
					`lens: basis schema '${lensDecl.basisSchema}' for logical schema '${logicalSchemaName}' does not exist (declared via 'declare lens for ${logicalSchemaName} over ${lensDecl.basisSchema}')`,
					StatusCode.ERROR,
				);
			}
			return { schema: basisSchema, schemaName: basisSchema.name };
		}
		return inferDefaultBasis(schemaManager, logicalSchemaName);
	};

	// Compile everything FIRST (basis alignment can throw — name mismatch, etc.).
	// Only after every table aligns successfully do we mutate the catalog, so a
	// failed re-apply leaves the existing lens state untouched (atomic deploy).
	const compiled: Array<{ slot: LensSlot; view: ViewSchema }> = [];
	for (const item of declaredSchema.items) {
		if (item.type !== 'declaredTable') continue;

		basis ??= resolveBasis();
		const logicalTable = schemaManager.buildLogicalTableSchema(item.tableStmt, logicalSchema.name);
		const override = overridesByTable.get(logicalTable.name.toLowerCase());

		let compiledBody: AST.SelectStmt;
		let provenance: LensColumnProvenance[];
		let hiding: ReadonlySet<string> | undefined;
		let effectiveColumns: string[];
		if (override) {
			const merged = compileOverrideBody(logicalTable, logicalSchemaName, basis.schemaName, schemaManager, override);
			compiledBody = merged.body;
			provenance = merged.provenance;
			hiding = merged.hiding.size > 0 ? merged.hiding : undefined;
			effectiveColumns = merged.effectiveColumns;
		} else {
			compiledBody = compileDefaultBody(logicalTable, logicalSchemaName, basis.schema, basis.schemaName);
			provenance = logicalTable.columns.map(c => ({ logicalColumn: c.name, source: 'default' as const }));
			effectiveColumns = logicalTable.columns.map(c => c.name);
		}

		const slot: LensSlot = {
			logicalTable,
			defaultBasis: { schemaName: basis.schemaName },
			override: override?.select,
			hiding,
			compiledBody,
			columnProvenance: provenance,
			attachedConstraints: buildLogicalConstraints(logicalTable),
		};
		const view: ViewSchema = {
			name: logicalTable.name,
			schemaName: logicalSchema.name,
			sql: astToString(compiledBody),
			selectAst: compiledBody,
			// Pin the consumer-facing column names to the *logical* declaration
			// (the contract, minus hidden columns), independent of the basis
			// column casing. Equivalent to `create view T(<logical cols>) as
			// <body>`: `select * from X.T` then surfaces the logical names, not
			// whatever the basis happens to spell them. Write-through is
			// unaffected (positional passthrough).
			columns: effectiveColumns,
			tags: logicalTable.tags,
		};
		compiled.push({ slot, view });
	}

	// Clear-and-rebuild: drop all current lens views + slots, then register the
	// freshly compiled set. A logical schema's views are exclusively lens bodies,
	// so dropping every view is safe and implements detach for tables removed
	// from the declaration (logical removals never touch basis storage).
	for (const view of Array.from(logicalSchema.getAllViews())) {
		logicalSchema.removeView(view.name);
	}
	logicalSchema.clearLensSlots();

	for (const { slot, view } of compiled) {
		logicalSchema.addLensSlot(slot);
		logicalSchema.addView(view);
		log('Deployed lens for %s.%s over %s', logicalSchemaName, slot.logicalTable.name, slot.defaultBasis.schemaName);
	}
}

/**
 * Rejects every physical construct under a logical declared schema, naming the
 * offending construct and the logical-schema context. Tags are allowed (they
 * are engine-facing and survive into the compiled view).
 */
export function validateLogicalDeclaration(
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	const ctx = `logical schema '${logicalSchemaName}'`;
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				if (item.tableStmt.moduleName) {
					throw new QuereusError(
						`lens: module association 'using ${item.tableStmt.moduleName}(...)' on table '${item.tableStmt.table.name}' is not allowed in ${ctx}; logical tables declare columns and constraints only`,
						StatusCode.ERROR,
					);
				}
				break;
			}
			case 'declaredIndex': {
				const kind = item.indexStmt.isUnique ? 'unique index' : 'index';
				throw new QuereusError(
					`lens: ${kind} '${item.indexStmt.index.name}' is not allowed in ${ctx}; indexes are a basis-layer construct (a materialized view over the basis)`,
					StatusCode.ERROR,
				);
			}
			case 'declaredMaterializedView': {
				throw new QuereusError(
					`lens: materialized view '${item.viewStmt.view.name}' is not allowed in ${ctx}; materialized views are a basis-layer construct`,
					StatusCode.ERROR,
				);
			}
			// declaredView / declaredSeed / declaredAssertion / declareIgnored:
			// not part of the logical-table surface in v1 — neither rejected nor
			// processed by the lens compiler (only declaredTable becomes a slot).
		}
	}
}

/**
 * Infers the default basis for a logical schema (MVP binding — there is no
 * `declare lens for X over Y` yet). The basis is the single registered
 * **physical** schema that contains ≥1 table, excluding the logical schema
 * itself and `temp`. See `docs/lens.md` § Default-basis inference.
 */
export function inferDefaultBasis(
	schemaManager: SchemaManager,
	logicalSchemaName: string,
): { schema: Schema; schemaName: string } {
	const lowerLogical = logicalSchemaName.toLowerCase();
	const candidates: Array<{ schema: Schema; schemaName: string }> = [];

	for (const schema of schemaManager._getAllSchemas()) {
		const lowerName = schema.name.toLowerCase();
		if (lowerName === lowerLogical) continue;
		if (lowerName === 'temp') continue;
		if (schema.kind !== 'physical') continue;

		let hasTable = false;
		for (const _t of schema.getAllTables()) { hasTable = true; break; }
		if (!hasTable) continue;

		candidates.push({ schema, schemaName: schema.name });
	}

	if (candidates.length === 1) {
		return candidates[0];
	}

	throw new QuereusError(
		`lens: cannot infer a default basis for logical schema '${logicalSchemaName}' (found ${candidates.length} candidates); supply 'declare lens for ${logicalSchemaName} over <basis>'`,
		StatusCode.ERROR,
	);
}

/**
 * The default name-based aligner: produces `select <logical columns> from B.T'`
 * for one logical table `L.T` over basis schema `B`.
 *
 * - The basis table is matched by name (case-insensitive).
 * - Each logical column is matched to a basis column by name (case-insensitive).
 * - The projection lists exactly the logical columns, in declaration order, so
 *   a basis table with extra columns is correctly projected down.
 *
 * The empty-key (singleton) case needs no special path: a `primary key ()`
 * logical table over a `primary key ()` basis table is an ordinary single-source
 * projection.
 */
export function compileDefaultBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchema: Schema,
	basisSchemaName: string,
): AST.SelectStmt {
	const logicalName = logicalTable.name;
	const basisTable = basisSchema.getTable(logicalName);
	if (!basisTable) {
		throw new QuereusError(
			`lens: logical table '${logicalSchemaName}.${logicalName}' has no basis backing`,
			StatusCode.ERROR,
		);
	}

	const columns: AST.ResultColumn[] = [];
	for (const col of logicalTable.columns) {
		const basisColIdx = basisTable.columnIndexMap.get(col.name.toLowerCase());
		if (basisColIdx === undefined) {
			throw new QuereusError(
				`lens: logical column '${logicalSchemaName}.${logicalName}.${col.name}' has no basis backing`,
				StatusCode.ERROR,
			);
		}
		// Single source → an unqualified column reference is unambiguous. Reference
		// the basis column by its actual name; the consumer-facing column *names*
		// (and casing) are pinned to the logical declaration via the registered
		// view's explicit column list (see `deployLogicalSchema`), so the basis
		// spelling never leaks through `select * from Logical.T`.
		const basisColName = basisTable.columns[basisColIdx].name;
		columns.push({
			type: 'column',
			expr: { type: 'column', name: basisColName } as AST.ColumnExpr,
		});
	}

	return {
		type: 'select',
		columns,
		from: [{
			type: 'table',
			table: { type: 'identifier', name: basisTable.name, schema: basisSchemaName },
		}],
	};
}

/**
 * Indexes a lens block's overrides by lowercased logical-table name, validating
 * that each names a logical table the declaration actually carries. The check
 * is skipped for an empty declaration (a pure detach-everything re-apply, which
 * never aligns a basis).
 */
function indexOverrides(
	lensDecl: AST.DeclareLensStmt | undefined,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): Map<string, AST.LensOverride> {
	const byTable = new Map<string, AST.LensOverride>();
	if (!lensDecl) return byTable;

	const declaredTableNames = new Set<string>();
	for (const item of declaredSchema.items) {
		if (item.type === 'declaredTable') declaredTableNames.add(item.tableStmt.table.name.toLowerCase());
	}
	for (const ov of lensDecl.overrides) {
		const key = ov.table.toLowerCase();
		if (declaredTableNames.size > 0 && !declaredTableNames.has(key)) {
			throw new QuereusError(
				`lens: override 'view ${ov.table} as ...' references logical table '${logicalSchemaName}.${ov.table}', which is not declared in logical schema '${logicalSchemaName}'`,
				StatusCode.ERROR,
			);
		}
		byTable.set(key, ov);
	}
	return byTable;
}

/** A basis table referenced by an override's FROM clause, with its ref name. */
interface OverrideSource {
	/** The resolved basis table schema. */
	table: TableSchema;
	/** Alias if the FROM gave one, else the table name — used to qualify refs. */
	refName: string;
}

/**
 * Composes one effective **read** body for a logical table that has a
 * `declare lens` override, per docs/lens.md § D2:
 *
 *   covered columns (override projection) ⊕ default-mapper gap-fill ⊖ hidden.
 *
 * Coverage is read **by name** from the override's output column names (alias or
 * bare name, and `*`-expansion of FROM-source columns). Each uncovered,
 * non-hidden logical column is gap-filled from a same-named basis column of the
 * override's FROM. When a gap is not reachable from the FROM (the hide-via-
 * gap-fill trap, or a partial cross-basis join), the compile errors rather than
 * emit an unsound body. The composition is recomputed on every deploy.
 */
function compileOverrideBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	override: AST.LensOverride,
): { body: AST.SelectStmt; provenance: LensColumnProvenance[]; hiding: ReadonlySet<string>; effectiveColumns: string[] } {
	const select = override.select;
	const logicalName = logicalTable.name;
	const hidden = new Set((override.hiding ?? []).map(h => h.toLowerCase()));

	// Resolve FROM-source basis tables once — used for both `*` expansion and
	// gap-fill. Opaque sources (subquery / function / unresolvable table) are
	// tracked so a gap that actually needs them errors precisely.
	const { sources, hasOpaqueSource } = collectOverrideSources(select.from, basisSchemaName, schemaManager);
	const qualify = sources.length > 1;

	// Coverage map: lowercased output-column name -> the expression producing it.
	const coverage = new Map<string, AST.Expression>();
	let hasStar = false;
	let starTable: string | undefined;
	for (const col of select.columns) {
		if (col.type === 'all') {
			hasStar = true;
			if (col.table) starTable = col.table.toLowerCase();
			continue;
		}
		const outName = deriveColumnOutputName(col);
		if (outName) coverage.set(outName.toLowerCase(), col.expr);
	}

	// `*` covers every FROM-source column not already explicitly covered.
	if (hasStar) {
		for (const src of sources) {
			if (starTable && src.refName.toLowerCase() !== starTable) continue;
			for (const c of src.table.columns) {
				const key = c.name.toLowerCase();
				if (!coverage.has(key)) coverage.set(key, columnRef(c.name, qualify ? src.refName : undefined));
			}
		}
	}

	const composed: AST.ResultColumn[] = [];
	const provenance: LensColumnProvenance[] = [];
	const effectiveColumns: string[] = [];
	for (const col of logicalTable.columns) {
		const key = col.name.toLowerCase();
		if (hidden.has(key)) {
			provenance.push({ logicalColumn: col.name, source: 'hidden' });
			continue;
		}
		const coveredExpr = coverage.get(key);
		if (coveredExpr !== undefined) {
			composed.push({ type: 'column', expr: coveredExpr, alias: col.name });
			provenance.push({ logicalColumn: col.name, source: 'override' });
		} else {
			const ref = gapFillRef(col.name, sources, qualify);
			if (!ref) {
				throw new QuereusError(
					gapFillError(logicalSchemaName, logicalName, col.name, sources, hasOpaqueSource),
					StatusCode.ERROR,
				);
			}
			composed.push({ type: 'column', expr: ref, alias: col.name });
			provenance.push({ logicalColumn: col.name, source: 'default' });
		}
		effectiveColumns.push(col.name);
	}

	// Preserve every non-projection clause of the override (where/group/having/
	// order/limit/distinct/with — the filter shape, etc.); replace only the
	// projection with the composed logical-column list.
	const body: AST.SelectStmt = { ...select, columns: composed };
	return { body, provenance, hiding: hidden, effectiveColumns };
}

/** Walks an override's FROM tree, collecting introspectable basis-table sources. */
function collectOverrideSources(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	schemaManager: SchemaManager,
): { sources: OverrideSource[]; hasOpaqueSource: boolean } {
	const sources: OverrideSource[] = [];
	let hasOpaqueSource = false;

	const walk = (node: AST.FromClause): void => {
		switch (node.type) {
			case 'table': {
				const schemaName = node.table.schema ?? basisSchemaName;
				const tbl = schemaManager.getSchema(schemaName)?.getTable(node.table.name);
				if (!tbl) { hasOpaqueSource = true; return; }
				sources.push({ table: tbl, refName: node.alias ?? tbl.name });
				break;
			}
			case 'join': {
				walk(node.left);
				walk(node.right);
				break;
			}
			default:
				// subquerySource / functionSource — not introspectable in v1.
				hasOpaqueSource = true;
				break;
		}
	};

	if (from) for (const f of from) walk(f);
	return { sources, hasOpaqueSource };
}

/** Output name a result column contributes: its alias, or the bare column name. */
function deriveColumnOutputName(col: AST.ResultColumnExpr): string | undefined {
	if (col.alias) return col.alias;
	return col.expr.type === 'column' ? col.expr.name : undefined;
}

/** Builds a column reference, optionally qualified by a source ref name. */
function columnRef(name: string, refName: string | undefined): AST.ColumnExpr {
	return refName ? { type: 'column', name, table: refName } : { type: 'column', name };
}

/** Finds a same-named basis column across the override's FROM sources. */
function gapFillRef(colName: string, sources: ReadonlyArray<OverrideSource>, qualify: boolean): AST.ColumnExpr | undefined {
	const lower = colName.toLowerCase();
	for (const src of sources) {
		const idx = src.table.columnIndexMap.get(lower);
		if (idx !== undefined) {
			// Reference the basis column by its actual name (casing); the logical
			// alias is applied by the caller.
			return columnRef(src.table.columns[idx].name, qualify ? src.refName : undefined);
		}
	}
	return undefined;
}

/** Diagnostic for an uncovered, non-hidden logical column the FROM can't gap-fill. */
function gapFillError(
	logicalSchemaName: string,
	logicalName: string,
	colName: string,
	sources: ReadonlyArray<OverrideSource>,
	hasOpaqueSource: boolean,
): string {
	const sourceDesc = sources.length === 0
		? 'the override FROM exposes no introspectable basis table'
		: `basis source(s) ${sources.map(s => s.table.name).join(', ')} have no column '${colName}'`;
	if (sources.length > 1 || hasOpaqueSource) {
		// Cross-basis / partial-coverage fidelity boundary (docs/lens.md § D2).
		return `lens: override for logical table '${logicalSchemaName}.${logicalName}' covers only some columns; uncovered column '${colName}' is not reachable from the override's FROM (${sourceDesc}) — it would need a basis source the v1 single-source mapper cannot join in. Cover it explicitly or list it in hiding(...)`;
	}
	// Single-source hide-via-gap-fill trap (docs/lens.md § D3).
	return `lens: override for logical table '${logicalSchemaName}.${logicalName}' leaves column '${colName}' uncovered and ${sourceDesc} to gap-fill from (the hide-via-gap-fill trap) — add it to the override projection or list it in hiding(...)`;
}
