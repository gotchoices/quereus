import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { astToString, viewDefinitionToCanonicalString } from '../../emit/ast-stringify.js';
import type { PlanNode, RelationalPlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../planner/nodes/reference.js';
import { keysOf } from '../../planner/util/fd-utils.js';
import { proveCoverage } from '../../planner/analysis/coverage-prover.js';
import { deriveCoarsenedBackingKey, type CoarsenedBackingKey } from '../../planner/analysis/coarsened-key.js';
import type { ColumnSchema } from '../../schema/column.js';
import { type TableSchema, type PrimaryKeyColumnDefinition, buildColumnIndexMap, requireVtabModule } from '../../schema/table.js';
import type { MaterializedViewSchema, CoarsenedKeyInfo } from '../../schema/view.js';
import { backingTableNameFor, computeBodyHash } from '../../schema/view.js';
import type { Schema } from '../../schema/schema.js';
import { generateMaterializedViewDDL } from '../../schema/ddl-generator.js';
import { renameTableInAst, renameColumnInAst, renameTableInInsertDefaults, renameColumnInInsertDefaults, collectFromTableNames, type ResolveColumnInSource } from '../../schema/rename-rewriter.js';
import { createLogger } from '../../common/logger.js';
import type { BackingHost } from '../../vtab/backing-host.js';

const log = createLogger('runtime:emit:materialized-view');
const warnLog = log.extend('warn');

// Canonical body-hash lives next to the MV schema definition so the declarative
// differ can share it without depending on the runtime layer. Re-exported here
// for the create/refresh emitters that already import from this module.
export { computeBodyHash };

/**
 * Purpose-built diagnostic for a bag (duplicate-producing) materialized-view
 * body. A v1 materialized view is a *keyed* derived relation: its body must
 * produce a **set** (no duplicate rows under the backing-table key). This
 * replaces the raw `UNIQUE constraint failed: <backing table> PK` message —
 * which named a hidden implementation detail — with one that names the MV and
 * explains the contract. Raised at create (loud, immediate) or at the next
 * refresh if a duplicate-free body later becomes duplicate-producing.
 */
export function materializedViewNotASetError(schemaName: string, viewName: string): QuereusError {
	return new QuereusError(
		`materialized view '${schemaName}.${viewName}' body produces duplicate rows, `
			+ `but a materialized view must be a set: its body needs a unique key. `
			+ `Project the source's primary-key column(s) so every row is unique; for a `
			+ `non-keyed result use a plain \`create view\` (live re-evaluation) or `
			+ `\`create table ... as <body>\` (a one-off snapshot).`,
		StatusCode.CONSTRAINT,
	);
}

/** Backing-table column/PK/ordering shape derived from the optimized body relation. */
export interface BackingShape {
	columns: ColumnSchema[];
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;
	/** Qualified (lowercased `schema.table`) source tables the body reads. */
	sourceTables: string[];
	/** Present when `primaryKey` is a **collation-coarsened lineage key** — the body
	 *  has no provable key and the backing identity was derived from source-key
	 *  lineage with at least one collation-weakened column (the parallel-migration
	 *  shape — `deriveCoarsenedBackingKey`). Drives the create-time key-coarsening
	 *  warning and the MV-record stamp. Absent when `keysOf` proved a key, when the
	 *  lineage key does not coarsen, or when no key was derivable at all (the
	 *  all-columns fallback; such a body is rejected at registration). */
	coarsenedKey?: CoarsenedKeyInfo;
}

/**
 * Builds + optimizes the materialized-view body and derives the backing table's
 * column list, primary key, body ordering, and source-table dependencies.
 *
 * Columns and types come straight from the optimized relation's
 * {@link RelationalPlanNode.getType}; the PK is the first usable key from
 * `keysOf` (all-columns fallback when none — such an MV is incremental-ineligible
 * until Phase 2). Re-planning here is cheap relative to materialization and keeps
 * the create/refresh emitters free of optimizer plumbing.
 */
export function deriveBackingShape(
	db: Database,
	bodySql: string,
	explicitColumns: ReadonlyArray<string> | undefined,
): BackingShape {
	// Suppress the read-side rewrite: we are computing the MV body to derive/populate
	// its OWN backing, so it must not be rewritten to read that backing.
	return db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => deriveBackingShapeUnguarded(db, bodySql, explicitColumns),
	);
}

function deriveBackingShapeUnguarded(
	db: Database,
	bodySql: string,
	explicitColumns: ReadonlyArray<string> | undefined,
): BackingShape {
	const plan = db.getPlan(bodySql);
	const root = plan.getRelations()[0];
	if (!root) {
		throw new QuereusError('materialized view body produced no relation', StatusCode.INTERNAL);
	}

	const relType = root.getType();
	const bodyColumns = relType.columns;
	const names = explicitColumns && explicitColumns.length > 0
		? explicitColumns
		: bodyColumns.map((c, i) => c.name || `col${i}`);

	const columns: ColumnSchema[] = bodyColumns.map((c, i) => ({
		name: names[i] ?? `col${i}`,
		logicalType: c.type.logicalType,
		notNull: c.type.nullable === false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: c.type.collationName ?? 'BINARY',
		generated: false,
	}));

	// First usable key from the unified surface. A keyless body is then offered the
	// coarsened lineage key (the parallel-migration shape — see coarsened-key.ts):
	// the projected source key, keyed under the OUTPUT collations, so create-fill
	// rejects collisions loudly and steady-state maintenance merges them LWW. The
	// all-columns fallback remains for bodies with neither (rejected at
	// registration as a bag, exactly as before).
	const keys = keysOf(root);
	let pkIndices: number[];
	let coarsenedKey: CoarsenedKeyInfo | undefined;
	if (keys.length > 0) {
		pkIndices = [...keys[0]];
	} else {
		const lineageKey = deriveCoarsenedBackingKey(root);
		if (lineageKey) {
			pkIndices = [...lineageKey.keyIndices];
			// Only a genuinely COARSENING key carries the warning payload; an
			// equal/refining lineage key is a true unique key accepted silently.
			if (lineageKey.coarsens) coarsenedKey = buildCoarsenedKeyInfo(lineageKey, columns);
		} else {
			pkIndices = columns.map((_c, i) => i);
		}
	}
	const primaryKey = pkIndices.map(idx => ({ index: idx, desc: false }));

	// A COARSENING key must be the backing's physical key EXACTLY: the loud
	// create-fill and the LWW merge both rest on the backing btree equating
	// colliding source keys, and the ordering-seeded physical PK
	// (computeBackingPrimaryKey leads with the body's `order by` columns) would
	// widen uniqueness past K' — colliding siblings would then coexist silently,
	// defeating both. So drop the ordering seed for a coarsened key; the only
	// cost is the clustering optimization (`mv.ordering` is informational). A
	// non-coarsening lineage key is a true key, so the seed stays uniqueness-
	// preserving there, exactly as for a `keysOf`-proved key.
	const ordering = coarsenedKey
		? undefined
		: root.physical?.ordering?.map(o => ({ index: o.column, desc: o.desc }));

	return {
		columns,
		primaryKey,
		ordering: ordering && ordering.length > 0 ? ordering : undefined,
		sourceTables: collectSourceTables(plan),
		coarsenedKey,
	};
}

/** Lift the structural {@link CoarsenedBackingKey} into the named, record-facing
 *  {@link CoarsenedKeyInfo} (backing column names instead of indices). */
function buildCoarsenedKeyInfo(key: CoarsenedBackingKey, columns: readonly ColumnSchema[]): CoarsenedKeyInfo {
	const nameOf = (idx: number): string => columns[idx]?.name ?? `col${idx}`;
	return {
		columns: key.keyIndices.map(nameOf),
		weakened: key.columns
			.filter(c => c.coarsens)
			.map(c => ({
				column: nameOf(c.outputIndex),
				sourceCollation: c.sourceCollation,
				outputCollation: c.outputCollation,
			})),
	};
}

/** Walks the plan collecting qualified (lowercased) names of every base table referenced. */
function collectSourceTables(plan: PlanNode): string[] {
	const out = new Set<string>();
	const visited = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof TableReferenceNode) {
			out.add(`${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase());
		}
		for (const c of node.getChildren()) walk(c as unknown as PlanNode);
		for (const r of node.getRelations()) walk(r as unknown as PlanNode);
	};
	walk(plan);
	return [...out];
}

/**
 * Computes the backing table's *physical* primary key. When the body carries an
 * `order by`, the ordering columns lead the key so the btree clusters (and scans)
 * in the body's order — "seeding the backing-table ordering" — with the logical
 * key (from `keysOf`) appended as a uniqueness-preserving tiebreaker. Without an
 * `order by`, the physical key is just the logical key.
 *
 * NOTE: this diverges from {@link MaterializedViewSchema.primaryKey}, which keeps
 * the logical `keysOf` identity. The covering ticket replaces this seeding with a
 * proper materialized index.
 */
export function computeBackingPrimaryKey(shape: BackingShape): ReadonlyArray<{ index: number; desc: boolean }> {
	if (!shape.ordering || shape.ordering.length === 0) {
		return shape.primaryKey;
	}
	const seeded: { index: number; desc: boolean }[] = [];
	const seen = new Set<number>();
	for (const o of shape.ordering) {
		if (!seen.has(o.index)) { seeded.push({ index: o.index, desc: o.desc }); seen.add(o.index); }
	}
	for (const k of shape.primaryKey) {
		if (!seen.has(k.index)) { seeded.push({ index: k.index, desc: k.desc }); seen.add(k.index); }
	}
	return seeded.length > 0 ? seeded : shape.primaryKey;
}

/**
 * Constructs the backing-table {@link TableSchema} for a materialized view from a
 * derived {@link BackingShape}, hosted in `moduleName` (default `'memory'`).
 * The capability check here is defense-in-depth — the create builder already
 * gates, but the catalog-import path reaches this without it.
 */
export function buildBackingTableSchema(
	db: Database,
	schemaName: string,
	backingTableName: string,
	shape: BackingShape,
	moduleName?: string,
	moduleArgs?: Readonly<Record<string, SqlValue>>,
): TableSchema {
	const resolvedModuleName = moduleName ?? 'memory';
	const moduleInfo = db.schemaManager.getModule(resolvedModuleName);
	if (!moduleInfo || !moduleInfo.module) {
		throw new QuereusError(`no virtual table module named '${resolvedModuleName}'`, StatusCode.ERROR);
	}
	if (!moduleInfo.module.getBackingHost) {
		throw new QuereusError(
			`module '${resolvedModuleName}' cannot host a materialized-view backing table (it does not implement the backing-host capability)`,
			StatusCode.UNSUPPORTED,
		);
	}

	const backingPk = computeBackingPrimaryKey(shape);
	const pkDefinition: PrimaryKeyColumnDefinition[] = backingPk.map(pk => ({
		index: pk.index,
		desc: pk.desc,
		collation: shape.columns[pk.index]?.collation,
	}));
	// Reflect the physical PK in the column flags (cosmetic; the memory table reads
	// `primaryKeyDefinition`, but catalog/introspection consults column flags).
	backingPk.forEach((pk, order) => {
		const col = shape.columns[pk.index];
		if (col) { col.primaryKey = true; col.pkOrder = order + 1; }
	});

	return {
		name: backingTableName,
		schemaName,
		columns: Object.freeze(shape.columns),
		columnIndexMap: buildColumnIndexMap(shape.columns),
		primaryKeyDefinition: Object.freeze(pkDefinition),
		checkConstraints: Object.freeze([]),
		vtabModule: moduleInfo.module,
		vtabModuleName: resolvedModuleName,
		vtabArgs: moduleArgs ? { ...moduleArgs } : {},
		vtabAuxData: moduleInfo.auxData,
		isView: false,
		estimatedRows: 0,
	};
}

/** Runs the body to completion and returns its rows (raw `Row` arrays). Uses the
 *  no-transaction-management primitive — the caller is already inside DDL execution. */
export async function collectBodyRows(db: Database, bodySql: string): Promise<Row[]> {
	// Suppress the read-side rewrite for the whole prepare+iterate: this body is run
	// to (re)compute the MV's OWN backing (create fill / refresh rebuild), so it must
	// recompute from the source, never read the backing it is populating.
	return db.schemaManager.withSuppressedMaterializedViewRewriteAsync(async () => {
		const stmt = db.prepare(bodySql);
		try {
			const rows: Row[] = [];
			for await (const row of stmt._iterateRowsRaw()) {
				rows.push(row as Row);
			}
			return rows;
		} finally {
			await stmt.finalize();
		}
	});
}

/**
 * Everything needed to materialize an MV — identity, canonical DDL, and the body
 * in both AST and canonical-SQL form. Satisfied by the create plan node
 * (`CreateMaterializedViewNode`) and by a re-parsed catalog entry
 * (`SchemaManager.importMaterializedView`).
 */
export interface MaterializeViewDefinition {
	schemaName: string;
	viewName: string;
	/** Canonical full `create materialized view` DDL text (round-trippable). */
	sql: string;
	/** Body AST — retained on the MV schema for refresh, declarative emission, and body-hash. */
	selectAst: AST.QueryExpr;
	/** Canonical SQL of the body alone (re-planned here to derive and fill the backing). */
	bodySql: string;
	/** Explicit column list from `create materialized view mv(a, b) ...`, when present. */
	columns?: ReadonlyArray<string>;
	/** Per-column omitted-insert defaults from `insert defaults (col = expr, …)`. */
	insertDefaults?: ReadonlyArray<AST.ViewInsertDefault>;
	tags?: Readonly<Record<string, SqlValue>>;
	/** Normalized backing-host module (absent ⇒ memory default — see
	 *  `normalizeBackingModule` in schema/view.ts). */
	backingModuleName?: string;
	/** Backing-module args; recorded only when non-empty. */
	backingModuleArgs?: Readonly<Record<string, SqlValue>>;
}

/**
 * Throws the sited declared-column-arity diagnostic when `def`'s explicit column
 * list disagrees with the body's output arity. Build-time creation already
 * validated this (with a build-located diagnostic); this guards the import path —
 * both the refill arm ({@link materializeView}) and the adopt gate check
 * (`SchemaManager.tryAdoptPreExistingBacking`, which must raise it BEFORE the
 * caller drops a durable backing: the entry can never materialize, so dropping
 * would destroy rows for nothing). The refresh path deliberately does NOT share
 * this — it reaches a legitimate mismatch after a source ALTER and has its own
 * "drop and recreate" diagnostic.
 */
export function assertDeclaredColumnArity(def: MaterializeViewDefinition, shape: BackingShape): void {
	if (def.columns && def.columns.length > 0 && def.columns.length !== shape.columns.length) {
		throw new QuereusError(
			`materialized view '${def.schemaName}.${def.viewName}' has ${def.columns.length} declared columns but body produces ${shape.columns.length}`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Builds the {@link MaterializedViewSchema} record for `def` over the derived
 * `shape` — the single record formula shared by {@link materializeView} (refill)
 * and {@link adoptMaterializedView} (adopt), so the two paths cannot drift: an
 * adopted and a refilled MV record are indistinguishable (fixed point: export
 * DDL after adopt == after refill).
 *
 * `bodyHash` hashes the canonical DEFINITION (explicit columns + body +
 * insert-defaults clause), NOT the executable bodySql — the declarative differ
 * recomputes the same form from a declared MV, so a clause-only or
 * explicit-columns-only change is detected as drift. `def.bodySql` stays
 * select-only: it feeds execution (collectBodyRows / deriveBackingShape /
 * linkCoveredUniqueConstraints).
 */
function buildMaterializedViewRecord(def: MaterializeViewDefinition, shape: BackingShape): MaterializedViewSchema {
	return {
		name: def.viewName,
		schemaName: def.schemaName,
		sql: def.sql,
		selectAst: def.selectAst,
		columns: def.columns,
		insertDefaults: def.insertDefaults,
		tags: def.tags,
		backingTableName: backingTableNameFor(def.viewName),
		backingModuleName: def.backingModuleName,
		backingModuleArgs: def.backingModuleArgs,
		primaryKey: shape.primaryKey,
		coarsenedKey: shape.coarsenedKey,
		bodyHash: computeBodyHash(viewDefinitionToCanonicalString(def.columns, def.selectAst, def.insertDefaults)),
		ordering: shape.ordering,
		sourceTables: shape.sourceTables,
		stale: false,
		origin: 'explicit',
	};
}

/**
 * The key-coarsening warning `docs/migration.md` § Convergence hazards
 * specifies — emitted (structured logger, `warn` channel) when an MV
 * materializes over a coarsened backing key, with {@link MaterializedViewSchema.coarsenedKey}
 * as the record-side complement. Warn, don't reject: the merge-on-coarsen
 * behavior is often exactly what the migration intends.
 */
function warnKeyCoarsening(schemaName: string, viewName: string, info: CoarsenedKeyInfo): void {
	const detail = info.weakened
		.map(w => `${w.column}: collation ${w.sourceCollation} → ${w.outputCollation}`)
		.join(', ');
	warnLog(
		`materialized view '%s.%s': backing key (%s) is coarser than the source primary key (%s); `
			+ `colliding source rows will last-write-win until they are merged`,
		schemaName, viewName, info.columns.join(', '), detail,
	);
}

/**
 * The materialize core shared by `emitCreateMaterializedView` and the
 * catalog-import path (`SchemaManager.importMaterializedView`): derive the
 * backing shape from the planned body → create the backing table in the
 * declared backing-host module (memory default) → fill it from the body →
 * register the `MaterializedViewSchema` → compile + register row-time
 * write-through maintenance. Returns the registered schema.
 *
 * Fires `table_added` for the backing table (it is created like any table) but
 * deliberately does NOT fire `materialized_view_added` — the create emitter
 * notifies after this returns, while import stays silent (a store rehydrating
 * its own catalog must not re-emit persistence events).
 *
 * Rollback-on-throw: a fill failure (including the "must be a set"
 * duplicate-key gate) drops the half-built backing; a registration failure (the
 * mandatory row-time eligibility gate runs there) also unlinks and deregisters
 * the MV record — either way the schema is left exactly as before the call.
 * Existence/collision checks are the caller's job (the create emitter checks
 * before calling; on import a duplicate surfaces as a backing-table conflict).
 */
export async function materializeView(db: Database, def: MaterializeViewDefinition): Promise<MaterializedViewSchema> {
	const sm = db.schemaManager;

	const shape = deriveBackingShape(db, def.bodySql, def.columns);
	// Lives here — not in deriveBackingShape — because the refresh path reaches a
	// legitimate mismatch after a source ALTER (see the assert's docstring).
	assertDeclaredColumnArity(def, shape);
	const backingTableName = backingTableNameFor(def.viewName);
	const backingSchema = buildBackingTableSchema(db, def.schemaName, backingTableName, shape, def.backingModuleName, def.backingModuleArgs);
	const completeBacking = await sm.createBackingTable(backingSchema);

	try {
		const rows: Row[] = await collectBodyRows(db, def.bodySql);
		const host = resolveBackingHost(db, completeBacking);
		await host.replaceContents(rows, () => materializedViewNotASetError(def.schemaName, def.viewName));
	} catch (e) {
		// Roll back: drop the backing table, do not register the MV.
		try {
			await sm.dropTable(def.schemaName, backingTableName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}

	const mv = buildMaterializedViewRecord(def, shape);
	// Eagerly record the constraint↔structure link if this MV covers a UNIQUE
	// constraint (informational — enforcement still routes through the
	// synchronously-maintained auto-index).
	linkCoveredUniqueConstraints(db, mv, def.bodySql);
	sm.addMaterializedView(mv);

	// Compile + register row-time write-through maintenance. The mandatory
	// eligibility gate runs here (it needs the analyzed body) and throws on a
	// body that is not row-time maintainable — roll the whole MV back so an
	// ineligible body errors cleanly.
	try {
		db.registerMaterializedView(mv);
	} catch (e) {
		unlinkCoveredUniqueConstraints(db, mv);
		sm.removeMaterializedView(def.schemaName, def.viewName);
		try {
			await sm.dropTable(def.schemaName, backingTableName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}

	// After the MV fully materialized (a fill/registration failure must error, not
	// warn): surface the key-coarsening hazard the coarsened backing key carries.
	if (mv.coarsenedKey) {
		warnKeyCoarsening(def.schemaName, def.viewName, mv.coarsenedKey);
	}

	return mv;
}

/**
 * The adopt-without-refill counterpart of {@link materializeView}: the
 * registration tail without create+fill, for the catalog-import path
 * (`SchemaManager.importMaterializedView`) when a pre-existing durable backing
 * passed every adopt gate (same module, shape match, all sources same-module
 * with upstream `_mv_` backings themselves adopted, caller-attested
 * `trustBackings`). The backing's rows are trusted as-is — no body execution.
 *
 * **Backing schema re-stamp.** `preExisting` is a phase-1 DDL round-trip and
 * loses ScalarType fidelity the refill path would carry (the registry-interned
 * logical types survive only by name in DDL). Re-registering the body-derived
 * {@link buildBackingTableSchema} result — shape-verified identical by the
 * caller's `backingShapeMatches` gate — makes post-adopt state equivalent to
 * post-refill state for the row-time plan `registerMaterializedView` binds.
 * Module identity/args come from `def` exactly as the refill path's
 * `buildBackingTableSchema` call does (gate 1 verified the registered module
 * matches); `estimatedRows` carries over from the registered schema (the rows
 * are preserved, so the prior estimate stays truthful). The module-side LIVE
 * table instance still caches the phase-1 schema — the importing host
 * reconciles it after import (the store module's `rehydrateCatalog` runs
 * `StoreTable.updateSchema` over every connected table); reads are unaffected
 * either way since the shapes are identical.
 *
 * Rollback on a registration failure (the mandatory row-time eligibility gate
 * runs there): unlink + `removeMaterializedView` + rethrow, but — unlike
 * {@link materializeView} — the backing table stays REGISTERED, reverting to
 * its plain-table state. Dropping a durable backing on a registration error
 * would destroy the very rows a later retry could adopt; the caller records
 * the throw as a per-entry rehydration error.
 */
export async function adoptMaterializedView(
	db: Database,
	def: MaterializeViewDefinition,
	preExisting: TableSchema,
	shape: BackingShape,
): Promise<MaterializedViewSchema> {
	const sm = db.schemaManager;
	const backingTableName = backingTableNameFor(def.viewName);

	const stamped = buildBackingTableSchema(db, def.schemaName, backingTableName, shape, def.backingModuleName, def.backingModuleArgs);
	sm.getSchemaOrFail(def.schemaName).addTable({ ...stamped, estimatedRows: preExisting.estimatedRows ?? 0 });

	const mv = buildMaterializedViewRecord(def, shape);
	linkCoveredUniqueConstraints(db, mv, def.bodySql);
	sm.addMaterializedView(mv);

	try {
		db.registerMaterializedView(mv);
	} catch (e) {
		unlinkCoveredUniqueConstraints(db, mv);
		sm.removeMaterializedView(def.schemaName, def.viewName);
		// Deliberately NOT dropping the backing: it reverts to a plain table
		// (re-stamped schema is shape-identical to its phase-1 state).
		throw e;
	}

	return mv;
}

/**
 * Full-rebuild of a materialized view's backing table: re-run the body to
 * completion and atomically swap the backing table's base layer. This is the
 * always-correct path shared by manual `refresh materialized view` and the
 * incremental manager's global / cost-fallback branch (`globalRelations`).
 *
 * The caller is responsible for staleness re-validation when relevant; this
 * helper assumes `mv.selectAst` plans. Throws if the backing table is missing.
 */
export async function rebuildBacking(db: Database, mv: MaterializedViewSchema): Promise<void> {
	const bodySql = astToString(mv.selectAst);
	const rows: Row[] = await collectBodyRows(db, bodySql);

	const backing = db.schemaManager.getTable(mv.schemaName, mv.backingTableName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const host = resolveBackingHost(db, backing);
	await host.replaceContents(rows, () => materializedViewNotASetError(mv.schemaName, mv.name));
}

/**
 * True iff the live backing `TableSchema` is structurally identical to what the
 * derived `shape` would build — so a `refresh` can take the data-only fast path
 * (`rebuildBacking`, preserving the backing identity and warm caches) instead of
 * rebuilding the backing table. Compares, in order:
 *  - column **count**;
 *  - per column: **name** (case-insensitive — matching the matcher's name compare),
 *    **logical type**, **not-null**, **collation**;
 *  - the **physical** PK ({@link computeBackingPrimaryKey} vs the backing's
 *    `primaryKeyDefinition`, by index + desc + collation, in order).
 *
 * Returns false when a source schema change has shifted the body's output shape
 * (most visibly a `select *` body whose new source column interleaves into the
 * output) — the caller then rebuilds the backing to match the re-planned body.
 */
export function backingShapeMatches(current: TableSchema, shape: BackingShape): boolean {
	if (!backingShapeMatchesStructurally(current, shape)) return false;
	for (let i = 0; i < shape.columns.length; i++) {
		if (current.columns[i].name.toLowerCase() !== shape.columns[i].name.toLowerCase()) return false;
	}
	return true;
}

/**
 * The structural (name-blind) half of {@link backingShapeMatches}: column count,
 * per-column logical type / not-null / collation, and the physical PK. The rename
 * propagation ({@link propagateColumnRenameToMaterializedViews}) uses it to assert
 * a source column rename produced a *pure name shift* in the body's output before
 * carrying the new names onto the live backing — anything structural is not a
 * rename outcome and fails the propagation instead of rebuilding data.
 */
function backingShapeMatchesStructurally(current: TableSchema, shape: BackingShape): boolean {
	return describeBackingShapeMismatch(current, shape) === null;
}

/** Names the first structural difference between the live backing and the derived
 *  shape (null when structurally identical) — the diagnostic half of
 *  {@link backingShapeMatchesStructurally}. */
function describeBackingShapeMismatch(current: TableSchema, shape: BackingShape): string | null {
	if (current.columns.length !== shape.columns.length) {
		return `column count ${current.columns.length} → ${shape.columns.length}`;
	}
	for (let i = 0; i < shape.columns.length; i++) {
		const a = current.columns[i];
		const b = shape.columns[i];
		// By NAME, not identity: logical types resolve through the (name-interned)
		// registry, but a module may rebuild its TableSchema with fresh instances
		// after an ALTER (the store module does), so identity is spuriously false.
		if (a.logicalType.name.toUpperCase() !== b.logicalType.name.toUpperCase()) {
			return `column ${i} type ${a.logicalType.name} → ${b.logicalType.name}`;
		}
		if ((a.notNull === true) !== (b.notNull === true)) {
			return `column ${i} not-null ${a.notNull === true} → ${b.notNull === true}`;
		}
		if ((a.collation ?? 'BINARY') !== (b.collation ?? 'BINARY')) {
			return `column ${i} collation ${a.collation ?? 'BINARY'} → ${b.collation ?? 'BINARY'}`;
		}
	}
	const shapePk = computeBackingPrimaryKey(shape);
	const currentPk = current.primaryKeyDefinition;
	if (currentPk.length !== shapePk.length) {
		return `primary-key length ${currentPk.length} → ${shapePk.length}`;
	}
	for (let i = 0; i < shapePk.length; i++) {
		if (currentPk[i].index !== shapePk[i].index) {
			return `primary-key column ${i} index ${currentPk[i].index} → ${shapePk[i].index}`;
		}
		if ((currentPk[i].desc === true) !== (shapePk[i].desc === true)) {
			return `primary-key column ${i} direction`;
		}
		const shapeColl = shape.columns[shapePk[i].index]?.collation ?? 'BINARY';
		if ((currentPk[i].collation ?? 'BINARY') !== shapeColl) {
			return `primary-key column ${i} collation ${currentPk[i].collation ?? 'BINARY'} → ${shapeColl}`;
		}
	}
	return null;
}

/**
 * Drop-and-recreate rebuild of a materialized view's backing table when a source
 * schema change has shifted the body's output shape (columns/types/PK/ordering),
 * so the backing no longer corresponds column-for-column to the re-planned body.
 * Mirrors the create path (`emitCreateMaterializedView`) exactly —
 * `buildBackingTableSchema` → `createBackingTable` → fill via the backing host's
 * `replaceContents` — so there is one code path for "make the backing match the body".
 *
 * The body rows are collected BEFORE the old backing is dropped (the body reads
 * the sources with the rewrite suppressed, never the backing it populates), so
 * the window in which no backing exists is minimal. The drop fires `table_removed`
 * and the create fires `table_added` on `_mv_<name>`, which (a) invalidate any
 * cached prepared plan scanning the backing directly and (b) cascade staleness to
 * any consumer MV whose source is this backing. On a fill failure (e.g. the
 * reshaped body is duplicate-producing under the new PK) the half-built backing is
 * dropped so the next read errors rather than serving an empty relation; the caller
 * leaves the MV `stale` (it clears the flag only on success).
 */
export async function rebuildBackingTable(
	db: Database,
	mv: MaterializedViewSchema,
	shape: BackingShape,
): Promise<void> {
	const sm = db.schemaManager;
	const rows: Row[] = await collectBodyRows(db, astToString(mv.selectAst));

	await sm.dropTable(mv.schemaName, mv.backingTableName, /*ifExists*/ true);
	// Rebuild into the MV's OWN backing module — falling back to memory here
	// would silently migrate a non-default backing on the first shape rebuild.
	const backingSchema = buildBackingTableSchema(db, mv.schemaName, mv.backingTableName, shape, mv.backingModuleName, mv.backingModuleArgs);
	const completeBacking = await sm.createBackingTable(backingSchema);
	try {
		const host = resolveBackingHost(db, completeBacking);
		await host.replaceContents(rows, () => materializedViewNotASetError(mv.schemaName, mv.name));
	} catch (e) {
		try {
			await sm.dropTable(mv.schemaName, mv.backingTableName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}
}

/**
 * Resolves the {@link BackingHost} for a materialized view's backing table via
 * the owning module's backing-host capability (`vtab/backing-host.ts`). INTERNAL
 * when the module lacks the capability or does not know the table — a backing
 * table is engine-created on a capability-checked module, so either is a bug.
 */
export function resolveBackingHost(db: Database, backingSchema: TableSchema): BackingHost {
	const module = requireVtabModule(backingSchema);
	if (!module.getBackingHost) {
		throw new QuereusError(
			`materialized view backing table '${backingSchema.name}' is owned by module `
				+ `'${backingSchema.vtabModuleName}', which does not implement the backing-host capability`,
			StatusCode.INTERNAL,
		);
	}
	const host = module.getBackingHost(db, backingSchema.schemaName, backingSchema.name);
	if (!host) {
		throw new QuereusError(
			`backing host not found for '${backingSchema.schemaName}.${backingSchema.name}'`,
			StatusCode.INTERNAL,
		);
	}
	return host;
}

/**
 * Eagerly records the constraint↔structure link when this MV covers a UNIQUE
 * constraint on one of its single source tables. Runs the coverage prover
 * (`coverage-prover.ts`) over the optimized body and, on the first match, stamps
 * the MV's `origin`/`covers` reverse link and the constraint's
 * `coveringStructureName` forward pointer (the source of truth). Informational
 * in this ticket — nothing enforces through the MV's backing table yet.
 *
 * Best-effort and side-effect-bounded: the body has already planned (during
 * shape derivation), so re-planning here is cheap and safe; a non-covering MV
 * simply records nothing.
 */
export function linkCoveredUniqueConstraints(db: Database, mv: MaterializedViewSchema, bodySql: string): void {
	// The coverage prover reasons over the body's SOURCE table; suppress the
	// read-side rewrite so the body is not re-pointed at this MV's own backing.
	const root = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.getPlan(bodySql).getRelations()[0],
	);
	if (!root) return;
	const sm = db.schemaManager;
	for (const qualified of mv.sourceTables) {
		const dot = qualified.indexOf('.');
		const schemaName = dot >= 0 ? qualified.slice(0, dot) : 'main';
		const tableName = dot >= 0 ? qualified.slice(dot + 1) : qualified;
		const table = sm.getTable(schemaName, tableName);
		if (!table || !table.uniqueConstraints) continue;
		for (const uc of table.uniqueConstraints) {
			const result = proveCoverage(root, mv, uc, table);
			if (result.covers) {
				mv.origin = 'explicit';
				mv.covers = { schemaName: table.schemaName, tableName: table.name, constraintName: uc.name };
				// Forward pointer is the source of truth (see docs/schema.md).
				uc.coveringStructureName = mv.name;
				return; // singular back-pointer: link the first covered constraint.
			}
		}
	}
}

/**
 * Clears the constraint↔structure link a covering MV established (drop path).
 * Matches on the forward pointer (`coveringStructureName === mv.name`) so it
 * works for unnamed constraints too; no enforcement demotion — physical schemas
 * still enforce via the implicit auto-index.
 */
export function unlinkCoveredUniqueConstraints(db: Database, mv: MaterializedViewSchema): void {
	if (!mv.covers) return;
	const table = db.schemaManager.getTable(mv.covers.schemaName, mv.covers.tableName);
	if (!table?.uniqueConstraints) return;
	for (const uc of table.uniqueConstraints) {
		if (uc.coveringStructureName === mv.name) uc.coveringStructureName = undefined;
	}
}

/** Re-validates a stale MV's body against the current source schemas. Throws the
 *  staleness diagnostic when the body no longer plans. Returns the optimized
 *  relational root on success. */
export function revalidateBody(db: Database, mvName: string, bodySql: string): RelationalPlanNode {
	let root: RelationalPlanNode | undefined;
	try {
		// Re-validate the body against the SOURCE schemas; suppress the read-side
		// rewrite so it is not re-pointed at this MV's own backing.
		root = db.schemaManager.withSuppressedMaterializedViewRewrite(
			() => db.getPlan(bodySql).getRelations()[0],
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate (${message})`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined,
		);
	}
	if (!root) {
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate`,
			StatusCode.ERROR,
		);
	}
	return root;
}

/* ──────────────── ALTER … RENAME propagation into MV bodies ──────────────── */

/**
 * Lowercased `schema.name` keys of every MV that is stale *right now*. The rename
 * emitters snapshot this BEFORE the statement's first schema-change notify, so the
 * propagation pass can distinguish "stale from this very rename statement" (safe to
 * clear after a successful in-place rewrite — no DML can interleave within the
 * statement) from "stale from an earlier un-refreshed change" (the backing may
 * already be behind — writes during staleness are not maintained — so only a
 * successful REFRESH may clear it).
 */
export function snapshotStaleMaterializedViews(db: Database): ReadonlySet<string> {
	const out = new Set<string>();
	for (const mv of db.schemaManager.getAllMaterializedViews()) {
		if (mv.stale) out.add(mvStaleKey(mv));
	}
	return out;
}

function mvStaleKey(mv: Pick<MaterializedViewSchema, 'schemaName' | 'name'>): string {
	return `${mv.schemaName}.${mv.name}`.toLowerCase();
}

/**
 * Rewrites every dependent materialized view in `schema` after a source TABLE
 * RENAME — the MV mirror of the plain-view loop in `propagateTableRenameInSchema`
 * ("MV ≡ faster view"): the caller applies the same same-schema gate, and the body
 * `selectAst` is mutated in place by the same `renameTableInAst` walker. An MV is
 * processed when its body AST changed, its `insert defaults` clause changed (an
 * expr subquery can name the renamed table even when the body doesn't), OR its
 * `sourceTables` carries the old base — the latter catches a body that reads the
 * renamed table *through a plain view* (the view's AST was rewritten by the view
 * loop, but this MV's own AST never names the table while its row-time plan is
 * still keyed under the old base).
 *
 * Per processed MV the derived fields are recomputed on a shallow clone
 * (`sourceTables` re-keyed old→new, `bodyHash`, regenerated `sql`, the `covers`
 * reverse link), then {@link applyMaterializedViewRewrite} re-registers row-time
 * maintenance / preserves pre-existing staleness and fires
 * `materialized_view_modified`. Failures mark the MV stale and propagation
 * continues — best-effort, like the rest of the rename propagation.
 */
export async function propagateTableRenameToMaterializedViews(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
	preStale: ReadonlySet<string>,
): Promise<void> {
	const schemaLower = renamedSchemaName.toLowerCase();
	const oldBase = `${schemaLower}.${oldName.toLowerCase()}`;
	const newBase = `${schemaLower}.${newName.toLowerCase()}`;
	for (const mv of Array.from(schema.getAllMaterializedViews())) {
		try {
			const bodyChanged = renameTableInAst(mv.selectAst, oldName, newName, renamedSchemaName);
			const clause = renameTableInInsertDefaults(mv.insertDefaults, oldName, newName, renamedSchemaName);
			if (!bodyChanged && !clause?.changed && !mv.sourceTables.includes(oldBase)) continue;
			const covers = mv.covers
				&& mv.covers.schemaName.toLowerCase() === schemaLower
				&& mv.covers.tableName.toLowerCase() === oldName.toLowerCase()
				? { ...mv.covers, tableName: newName }
				: mv.covers;
			await applyMaterializedViewRewrite(db, schema, mv, {
				sourceTables: mv.sourceTables.map(s => (s === oldBase ? newBase : s)),
				covers,
			}, preStale, /*renamedColumns*/ false);
		} catch (e) {
			failMaterializedViewRenamePropagation(db, schema, mv, e);
		}
	}
}

/**
 * Rewrites every dependent materialized view in `schema` after a source COLUMN
 * RENAME — the MV mirror of the plain-view loop in `propagateColumnRenameInSchema`
 * (same same-schema gate at the caller, same in-place `renameColumnInAst` walk,
 * same `renameColumnInInsertDefaults` clause rewrite). An MV is processed when
 * its body AST OR its `insert defaults` clause changed — the clause's target is
 * typically a projected-away NOT NULL column the body never mentions, so a
 * clause-only change must still re-hash, regenerate DDL, and fire the event. An
 * MV neither rewrite touches that the schema-change listener marked stale (an
 * unreferenced-column rename, a `select *` body) is restored by the
 * {@link restoreUnaffectedMaterializedViews} pass the ALTER emitter runs after
 * all per-schema loops. A changed BODY
 * can shift the MV's *exposed output names* (a bare passthrough projection of
 * the renamed column — plain-view parity), which
 * {@link applyMaterializedViewRewrite} carries onto the live backing table; a
 * clause-only change cannot, so the backing-rename pass is gated on the body
 * flag.
 */
export async function propagateColumnRenameToMaterializedViews(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	preStale: ReadonlySet<string>,
	resolveColumnInSource: ResolveColumnInSource,
): Promise<void> {
	for (const mv of Array.from(schema.getAllMaterializedViews())) {
		try {
			const bodyChanged = renameColumnInAst(mv.selectAst, tableName, oldCol, newCol, renamedSchemaName);
			const clause = mv.insertDefaults?.length
				? renameColumnInInsertDefaults(mv.insertDefaults, collectFromTableNames(mv.selectAst, renamedSchemaName), tableName, oldCol, newCol, renamedSchemaName, resolveColumnInSource)
				: null;
			if (!bodyChanged && !clause?.changed) continue;
			await applyMaterializedViewRewrite(
				db, schema, mv,
				clause?.changed ? { insertDefaults: clause.defaults } : {},
				preStale, /*renamedColumns*/ bodyChanged,
			);
		} catch (e) {
			failMaterializedViewRenamePropagation(db, schema, mv, e);
		}
	}
}

/**
 * The per-MV core both rename propagations share. `mv.selectAst` (and any
 * `insert defaults` exprs) have already been rewritten in place; `overrides`
 * carries the recomputed catalog fields — `sourceTables` / `covers` (table
 * rename) and `insertDefaults` (column rename, where a clause entry's `column`
 * string swap needs a fresh array). The remaining derived fields are recomputed
 * on a shallow clone (mirroring the tag setters — `oldObject` in the event
 * shares the rewritten AST, only the derived fields differ) and swapped into
 * the catalog. The `bodyHash` and regenerated `sql` both read the POST-override
 * clause, so they agree with each other and with what the differ recomputes
 * from the post-rename declared form; the `materialized_view_modified` → store
 * re-persist path round-trips the new name.
 *
 * Staleness discipline: `stale` means the row-time plan was released and the
 * backing may already be BEHIND, so a flag that predates this statement is never
 * cleared — the body/sql/hash/sources are still rewritten (a later REFRESH then
 * resolves the new name; today it cannot), but maintenance is NOT re-registered
 * and the backing columns are NOT renamed (refresh's shape-mismatch rebuild owns
 * that). An MV that was live before the statement is fully restored: backing
 * column names follow the body's output names (column rename only), row-time
 * maintenance re-plans against the already-renamed catalog (re-keying the
 * source-base index, recomputing `sourceScope`), and the staleness this very
 * statement's events set is cleared — no DML can interleave within the statement,
 * so the backing cannot be behind.
 */
async function applyMaterializedViewRewrite(
	db: Database,
	schema: Schema,
	mv: MaterializedViewSchema,
	overrides: Partial<Pick<MaterializedViewSchema, 'sourceTables' | 'covers' | 'insertDefaults'>>,
	preStale: ReadonlySet<string>,
	renamedColumns: boolean,
): Promise<void> {
	const wasPreStale = preStale.has(mvStaleKey(mv));
	const bodySql = astToString(mv.selectAst);
	const insertDefaults = overrides.insertDefaults ?? mv.insertDefaults;
	const updated: MaterializedViewSchema = {
		...mv,
		...overrides,
		// Canonical-definition hash (columns + body + POST-override insert-defaults
		// clause) — must match the formula stamped at create / recomputed by the
		// differ, or every post-rename diff would churn a spurious rebuild. `bodySql`
		// (select-only) still feeds renameShiftedBackingColumns below.
		bodyHash: computeBodyHash(viewDefinitionToCanonicalString(mv.columns, mv.selectAst, insertDefaults)),
	};
	updated.sql = generateMaterializedViewDDL(updated);
	schema.addMaterializedView(updated);

	if (!wasPreStale) {
		// Only a changed BODY can shift output names; a table rename / clause-only
		// change skips the backing-name pass (no re-plan needed).
		await restoreMaterializedViewLive(db, schema, updated, renamedColumns ? { bodySql } : undefined);
	}
	// Fired for still-stale MVs too: the rewritten body must re-persist so a
	// post-reopen REFRESH resolves the new name.
	db.schemaManager.getChangeNotifier().notifyChange({
		type: 'materialized_view_modified',
		schemaName: updated.schemaName,
		objectName: updated.name,
		oldObject: mv,
		newObject: updated,
	});
}

/**
 * The shared restore tail both per-MV restore paths run — the changed-AST rewrite
 * ({@link applyMaterializedViewRewrite}) and the provably-unaffected restoration
 * pass ({@link restoreUnaffectedMaterializedViews}) — so the restore discipline
 * cannot drift between them: carry any body output-name shift onto the live
 * backing (`backingNames` present), re-register row-time maintenance, and only
 * then clear `stale`.
 *
 * `backingNames` is absent when the body's output names provably did not move (a
 * table rename / clause-only change), skipping the backing-name pass and its body
 * re-plan; when present, `shape` short-circuits the re-derivation for a caller
 * that already planned the body.
 */
async function restoreMaterializedViewLive(
	db: Database,
	schema: Schema,
	mv: MaterializedViewSchema,
	backingNames?: { bodySql: string; shape?: BackingShape },
): Promise<void> {
	if (backingNames) {
		await renameShiftedBackingColumns(db, schema, mv, backingNames.bodySql, backingNames.shape);
	}
	// Re-register BEFORE clearing `stale`: if registration throws, the caller's
	// failure path leaves the MV stale rather than serving an unmaintained backing.
	db.registerMaterializedView(mv);
	mv.stale = false;
}

/**
 * Restores every dependent MV that THIS rename statement marked stale but the
 * rename provably did not affect. Runs once at the end of the table-/column-rename
 * propagation, after all per-schema loops — so every body rewrite, backing-column
 * rename, and cascade event has already fired and the catalog is fully renamed.
 *
 * The schema-change listener marks **every** MV whose `sourceTables` includes a
 * `table_modified` table stale (and detaches its row-time plan), but the rename
 * propagation only restores MVs it processes (changed AST / clause, or — table
 * rename — `sourceTables` carrying the old base). An MV the rename does not touch
 * fell through stale-but-valid: reads silently served the now-unmaintained backing
 * and writes never propagated until a manual REFRESH. Three concrete shapes: a
 * column rename the body never references; a rename whose only effect on another
 * source is a constraint rewrite (e.g. an FK `references` target) firing that
 * source's `table_modified`; and a `select *` body whose output is a pure name
 * shift (the AST is unchanged, so the body rewrite never sees it).
 *
 * Per candidate (`stale` now, not stale at the pre-statement snapshot — a
 * pre-existing flag means the backing may be BEHIND and only REFRESH may clear it):
 * re-derive the backing shape from the body against the renamed catalog; a
 * **structural** mismatch is not a rename no-op → leave stale (REFRESH's
 * shape-mismatch rebuild owns it); otherwise run the shared restore tail —
 * {@link renameShiftedBackingColumns} carries a pure name shift onto the live
 * backing (no-op when names already match; its backing `table_modified`
 * deliberately cascades staleness to chained MVs referencing the old output name),
 * then re-register row-time maintenance and clear `stale`.
 *
 * Deliberately fires NO `materialized_view_modified`: the MV record (AST, hash,
 * sql, sourceTables) is unchanged here — `stale` is runtime state, not persisted.
 * Walks all schemas (the listener marks cross-schema dependents too), in creation
 * order — topological for same-schema MV chains, so a producer restores before its
 * consumer is examined. A chained MV whose body references a renamed-away producer
 * output name fails shape derivation and stays stale (staleness-diagnostic parity
 * with a broken plain-view chain). Best-effort like the rest of the propagation:
 * a per-MV failure logs, leaves that MV stale, and continues.
 */
export async function restoreUnaffectedMaterializedViews(
	db: Database,
	preStale: ReadonlySet<string>,
): Promise<void> {
	for (const mv of db.schemaManager.getAllMaterializedViews()) {
		if (!mv.stale || preStale.has(mvStaleKey(mv))) continue;
		try {
			const schema = db.schemaManager.getSchemaOrFail(mv.schemaName);
			const bodySql = astToString(mv.selectAst);
			// Throws when the body no longer plans against the renamed catalog
			// (e.g. a chained MV referencing a renamed-away output name) → catch
			// below leaves it stale.
			const shape = deriveBackingShape(db, bodySql, mv.columns);
			// The retry of a failure-marked MV must not revive an inconsistent record: a
			// rewrite that threw between the in-place AST mutation and the catalog swap
			// leaves the OLD record (un-re-keyed `sourceTables`, old `sql`) holding the
			// rewritten body. Registering that would compute `sourceScope` (and key the
			// read-side rewrite) off the wrong bases — leave it stale instead.
			if (!sameSourceTables(mv.sourceTables, shape.sourceTables)) {
				log('Leaving materialized view %s.%s stale after rename: recorded sourceTables disagree with the re-planned body — REFRESH recovers',
					mv.schemaName, mv.name);
				continue;
			}
			const backing = schema.getTable(mv.backingTableName);
			if (!backing) {
				throw new QuereusError(
					`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
					StatusCode.INTERNAL,
				);
			}
			const mismatch = describeBackingShapeMismatch(backing, shape);
			if (mismatch) {
				log('Leaving materialized view %s.%s stale after rename: backing shape mismatch (%s) — REFRESH rebuilds it',
					mv.schemaName, mv.name, mismatch);
				continue;
			}
			await restoreMaterializedViewLive(db, schema, mv, { bodySql, shape });
		} catch (e) {
			log('Could not restore materialized view %s.%s after rename; leaving it stale: %s',
				mv.schemaName, mv.name, e instanceof Error ? e.message : String(e));
		}
	}
}

/** Set-equality over qualified (already-lowercased) source-table lists. Order is
 *  irrelevant — both sides come from `collectSourceTables`' Set walk. */
function sameSourceTables(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every(s => set.has(s));
}

/**
 * Carries a column-rename-induced output-name shift onto the MV's live backing
 * table. The backing's column names were derived from the body's output names at
 * create ({@link deriveBackingShape}); after the body rewrite a bare passthrough
 * projection of the renamed column exposes the NEW name, so the backing follows —
 * positionally, data-preserving, via the host module's own `alterTable` (a host
 * without `alterTable` throws UNSUPPORTED and the caller's failure path leaves
 * the MV stale). Explicit-column MVs (`mv(a, b)`) and
 * expression-aliased outputs produce no mismatch and no-op. Any structural
 * difference (count / types / PK) is NOT a rename outcome — throw so the caller's
 * failure path leaves the MV stale rather than rebuilding data here.
 *
 * The backing `table_modified` fired on a real rename deliberately cascades: a
 * chained MV whose body references the OLD output name is marked stale by the
 * manager's listener and surfaces the staleness diagnostic on its next read
 * (parity with a broken plain-view chain — strictly better than silently freezing),
 * and cached plans scanning the backing directly recompile against the new names.
 */
async function renameShiftedBackingColumns(
	db: Database,
	schema: Schema,
	mv: MaterializedViewSchema,
	bodySql: string,
	preDerivedShape?: BackingShape,
): Promise<void> {
	const shape = preDerivedShape ?? deriveBackingShape(db, bodySql, mv.columns);
	const backing = schema.getTable(mv.backingTableName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const mismatch = describeBackingShapeMismatch(backing, shape);
	if (mismatch) {
		throw new QuereusError(
			`materialized view '${mv.schemaName}.${mv.name}': source column rename shifted the body's backing shape structurally (beyond a pure name shift): ${mismatch}`,
			StatusCode.INTERNAL,
		);
	}
	const module = requireVtabModule(backing);
	let current = backing;
	for (let i = 0; i < shape.columns.length; i++) {
		const liveCol = current.columns[i];
		const newName = shape.columns[i].name;
		if (liveCol.name.toLowerCase() === newName.toLowerCase()) continue;
		if (!module.alterTable) {
			throw new QuereusError(
				`module for backing table '${backing.name}' does not support ALTER TABLE`,
				StatusCode.UNSUPPORTED,
			);
		}
		current = await module.alterTable(db, mv.schemaName, backing.name, {
			type: 'renameColumn',
			oldName: liveCol.name,
			newName,
			newColumnDefAst: backingColumnDef(liveCol, newName),
		});
	}
	if (current !== backing) {
		schema.addTable(current);
		db.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName: mv.schemaName,
			objectName: backing.name,
			oldObject: backing,
			newObject: current,
		});
	}
}

/** Minimal ColumnDef AST for a backing-column rename. Backing columns carry only
 *  type / not-null / PK / collation — never defaults or generated expressions
 *  (see {@link buildBackingTableSchema}) — so the lift is total. */
function backingColumnDef(col: ColumnSchema, newName: string): AST.ColumnDef {
	const constraints: AST.ColumnDef['constraints'] = [col.notNull ? { type: 'notNull' } : { type: 'null' }];
	if (col.primaryKey) constraints.push({ type: 'primaryKey', direction: col.pkDirection });
	if (col.collation && col.collation !== 'BINARY') constraints.push({ type: 'collate', collation: col.collation });
	return { name: newName, dataType: col.logicalType.name, constraints };
}

/**
 * Failure path for one MV's rename rewrite: whatever partial state the rewrite
 * reached (AST possibly mutated, catalog record possibly swapped), the MV must not
 * keep serving its backing as if live — force-mark it stale, release its row-time
 * plan, and invalidate cached backing reads so the next reference re-hits the
 * build-time stale guard. A pre-existing stale flag is unaffected (it is never
 * cleared here). The caller continues with the remaining MVs.
 */
function failMaterializedViewRenamePropagation(
	db: Database,
	schema: Schema,
	mv: MaterializedViewSchema,
	cause: unknown,
): void {
	log('Rename propagation failed for materialized view %s.%s; leaving it stale: %s',
		mv.schemaName, mv.name, cause instanceof Error ? cause.message : String(cause));
	// The shallow clone may or may not have been swapped in before the throw —
	// mark whichever object the catalog currently holds.
	const live = schema.getMaterializedView(mv.name) ?? mv;
	db.markMaterializedViewStale(live);
}
