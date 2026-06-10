import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { astToString } from '../../emit/ast-stringify.js';
import type { PlanNode, RelationalPlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../planner/nodes/reference.js';
import { keysOf } from '../../planner/util/fd-utils.js';
import { proveCoverage } from '../../planner/analysis/coverage-prover.js';
import type { ColumnSchema } from '../../schema/column.js';
import { type TableSchema, type PrimaryKeyColumnDefinition, buildColumnIndexMap, requireVtabModule } from '../../schema/table.js';
import type { MaterializedViewSchema } from '../../schema/view.js';
import { backingTableNameFor, computeBodyHash } from '../../schema/view.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import type { MemoryTableManager } from '../../vtab/memory/layer/manager.js';

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

	// First usable key from the unified surface; all-columns fallback when none.
	const keys = keysOf(root);
	const pkIndices = keys.length > 0 ? [...keys[0]] : columns.map((_c, i) => i);
	const primaryKey = pkIndices.map(idx => ({ index: idx, desc: false }));

	const ordering = root.physical?.ordering?.map(o => ({ index: o.column, desc: o.desc }));

	return {
		columns,
		primaryKey,
		ordering: ordering && ordering.length > 0 ? ordering : undefined,
		sourceTables: collectSourceTables(plan),
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
 * derived {@link BackingShape}. Module is always `memory` in v1.
 */
export function buildBackingTableSchema(
	db: Database,
	schemaName: string,
	backingTableName: string,
	shape: BackingShape,
): TableSchema {
	const moduleInfo = db.schemaManager.getModule('memory');
	if (!moduleInfo || !moduleInfo.module) {
		throw new QuereusError(`No virtual table module named 'memory'`, StatusCode.INTERNAL);
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
		vtabModuleName: 'memory',
		vtabArgs: {},
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
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * The materialize core shared by `emitCreateMaterializedView` and the
 * catalog-import path (`SchemaManager.importMaterializedView`): derive the
 * backing shape from the planned body → create the (memory) backing table →
 * fill it from the body → register the `MaterializedViewSchema` → compile +
 * register row-time write-through maintenance. Returns the registered schema.
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
	const backingTableName = backingTableNameFor(def.viewName);
	const backingSchema = buildBackingTableSchema(db, def.schemaName, backingTableName, shape);
	const completeBacking = await sm.createBackingTable(backingSchema);

	try {
		const rows: Row[] = await collectBodyRows(db, def.bodySql);
		const manager = getBackingManager(completeBacking);
		await manager.replaceBaseLayer(rows, () => materializedViewNotASetError(def.schemaName, def.viewName));
	} catch (e) {
		// Roll back: drop the backing table, do not register the MV.
		try {
			await sm.dropTable(def.schemaName, backingTableName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}

	const mv: MaterializedViewSchema = {
		name: def.viewName,
		schemaName: def.schemaName,
		sql: def.sql,
		selectAst: def.selectAst,
		columns: def.columns,
		tags: def.tags,
		backingTableName,
		primaryKey: shape.primaryKey,
		bodyHash: computeBodyHash(def.bodySql),
		ordering: shape.ordering,
		sourceTables: shape.sourceTables,
		stale: false,
		origin: 'explicit',
	};
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
	const manager = getBackingManager(backing);
	await manager.replaceBaseLayer(rows, () => materializedViewNotASetError(mv.schemaName, mv.name));
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
	if (current.columns.length !== shape.columns.length) return false;
	for (let i = 0; i < shape.columns.length; i++) {
		const a = current.columns[i];
		const b = shape.columns[i];
		if (a.name.toLowerCase() !== b.name.toLowerCase()) return false;
		if (a.logicalType !== b.logicalType) return false;
		if ((a.notNull === true) !== (b.notNull === true)) return false;
		if ((a.collation ?? 'BINARY') !== (b.collation ?? 'BINARY')) return false;
	}
	const shapePk = computeBackingPrimaryKey(shape);
	const currentPk = current.primaryKeyDefinition;
	if (currentPk.length !== shapePk.length) return false;
	for (let i = 0; i < shapePk.length; i++) {
		if (currentPk[i].index !== shapePk[i].index) return false;
		if ((currentPk[i].desc === true) !== (shapePk[i].desc === true)) return false;
		const shapeColl = shape.columns[shapePk[i].index]?.collation ?? 'BINARY';
		if ((currentPk[i].collation ?? 'BINARY') !== shapeColl) return false;
	}
	return true;
}

/**
 * Drop-and-recreate rebuild of a materialized view's backing table when a source
 * schema change has shifted the body's output shape (columns/types/PK/ordering),
 * so the backing no longer corresponds column-for-column to the re-planned body.
 * Mirrors the create path (`emitCreateMaterializedView`) exactly —
 * `buildBackingTableSchema` → `createBackingTable` → fill via `replaceBaseLayer` —
 * so there is one code path for "make the backing match the body".
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
	const backingSchema = buildBackingTableSchema(db, mv.schemaName, mv.backingTableName, shape);
	const completeBacking = await sm.createBackingTable(backingSchema);
	try {
		const manager = getBackingManager(completeBacking);
		await manager.replaceBaseLayer(rows, () => materializedViewNotASetError(mv.schemaName, mv.name));
	} catch (e) {
		try {
			await sm.dropTable(mv.schemaName, mv.backingTableName, /*ifExists*/ true);
		} catch { /* best-effort cleanup */ }
		throw e;
	}
}

/** Resolves the {@link MemoryTableManager} backing a materialized view's table. */
export function getBackingManager(backingSchema: TableSchema): MemoryTableManager {
	const module = requireVtabModule(backingSchema);
	if (!(module instanceof MemoryTableModule)) {
		throw new QuereusError(
			`materialized view backing table '${backingSchema.name}' is not a memory table`,
			StatusCode.INTERNAL,
		);
	}
	const key = `${backingSchema.schemaName}.${backingSchema.name}`.toLowerCase();
	const manager = module.tables.get(key);
	if (!manager) {
		throw new QuereusError(`backing table manager not found for '${key}'`, StatusCode.INTERNAL);
	}
	return manager;
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
