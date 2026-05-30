import type {
	CreateMaterializedViewNode,
	RefreshMaterializedViewNode,
	DropMaterializedViewNode,
} from '../../planner/nodes/materialized-view-nodes.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { MaterializedViewSchema } from '../../schema/view.js';
import { backingTableNameFor } from '../../schema/view.js';
import { astToString } from '../../emit/ast-stringify.js';
import {
	deriveBackingShape,
	buildBackingTableSchema,
	computeBodyHash,
	collectBodyRows,
	getBackingManager,
	rebuildBacking,
	revalidateBody,
	linkCoveredUniqueConstraints,
	unlinkCoveredUniqueConstraints,
	materializedViewNotASetError,
} from './materialized-view-helpers.js';

export function emitCreateMaterializedView(plan: CreateMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const existing = sm.getMaterializedView(plan.schemaName, plan.viewName);
		if (existing) {
			if (plan.ifNotExists) return null;
			throw new QuereusError(
				`Materialized view '${plan.schemaName}.${plan.viewName}' already exists`,
				StatusCode.ERROR,
			);
		}
		if (sm.getTable(plan.schemaName, plan.viewName) || sm.getView(plan.schemaName, plan.viewName)) {
			throw new QuereusError(
				`Cannot create materialized view '${plan.schemaName}.${plan.viewName}': a table or view with the same name already exists`,
				StatusCode.CONSTRAINT,
			);
		}

		// Derive backing shape from the optimized body, then create the backing
		// table and fill it. A failure during fill rolls back the backing table so
		// the MV is never half-registered.
		const shape = deriveBackingShape(db, plan.bodySql, plan.columns);
		const backingTableName = backingTableNameFor(plan.viewName);
		const backingSchema = buildBackingTableSchema(db, plan.schemaName, backingTableName, shape);
		const completeBacking = await sm.createBackingTable(backingSchema);

		try {
			const rows: Row[] = await collectBodyRows(db, plan.bodySql);
			const manager = getBackingManager(completeBacking);
			await manager.replaceBaseLayer(rows, () => materializedViewNotASetError(plan.schemaName, plan.viewName));
		} catch (e) {
			// Roll back: drop the backing table, do not register the MV.
			try {
				await sm.dropTable(plan.schemaName, backingTableName, /*ifExists*/ true);
			} catch { /* best-effort cleanup */ }
			throw e;
		}

		const mv: MaterializedViewSchema = {
			name: plan.viewName,
			schemaName: plan.schemaName,
			sql: plan.sql,
			selectAst: plan.selectStmt,
			columns: plan.columns,
			tags: plan.tags,
			backingTableName,
			primaryKey: shape.primaryKey,
			bodyHash: computeBodyHash(plan.bodySql),
			ordering: shape.ordering,
			sourceTables: shape.sourceTables,
			stale: false,
			origin: 'explicit',
		};
		// Eagerly record the constraint↔structure link if this MV covers a UNIQUE
		// constraint (informational — enforcement still routes through the
		// synchronously-maintained auto-index).
		linkCoveredUniqueConstraints(db, mv, plan.bodySql);
		sm.addMaterializedView(mv);

		// Compile + register row-time write-through maintenance. The mandatory
		// eligibility gate runs here (it needs the analyzed body) and throws on a
		// body that is not row-time maintainable — roll the whole MV back so an
		// ineligible body errors cleanly at create time.
		try {
			db.registerMaterializedView(mv);
		} catch (e) {
			unlinkCoveredUniqueConstraints(db, mv);
			sm.removeMaterializedView(plan.schemaName, plan.viewName);
			try {
				await sm.dropTable(plan.schemaName, backingTableName, /*ifExists*/ true);
			} catch { /* best-effort cleanup */ }
			throw e;
		}

		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_added',
			schemaName: plan.schemaName,
			objectName: plan.viewName,
			newObject: mv,
		});
		return null;
	}

	return { params: [], run, note: `createMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

export function emitRefreshMaterializedView(plan: RefreshMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const mv = sm.getMaterializedView(plan.schemaName, plan.viewName);
		if (!mv) {
			throw new QuereusError(`no such materialized view: ${plan.viewName}`, StatusCode.ERROR);
		}

		// A stale MV re-validates its body against current source schemas first.
		if (mv.stale) {
			revalidateBody(db, mv.name, astToString(mv.selectAst));
		}

		await rebuildBacking(db, mv);

		// Re-register row-time write-through maintenance. A source schema change that
		// marked this MV stale also detached its row-time plan; the rebuild above only
		// fixes the snapshot, so without re-registering, subsequent source writes would
		// silently not propagate. Registration is idempotent (it releases any existing
		// plan first), so a refresh of a never-stale MV is a harmless no-op re-attach.
		// Re-register BEFORE clearing `stale`: if registration ever threw (the eligibility
		// gate re-runs here), leaving the MV stale makes the next read re-validate/error
		// rather than silently serve an unmaintained snapshot.
		db.registerMaterializedView(mv);
		mv.stale = false;
		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_refreshed',
			schemaName: plan.schemaName,
			objectName: plan.viewName,
			object: mv,
		});
		return null;
	}

	return { params: [], run, note: `refreshMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

export function emitDropMaterializedView(plan: DropMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		await rctx.db._ensureTransaction();
		const db = rctx.db;
		const sm = db.schemaManager;

		const mv = sm.getMaterializedView(plan.schemaName, plan.viewName);
		if (!mv) {
			if (plan.ifExists) return null;
			if (sm.getTable(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`'${plan.viewName}' is a table, not a materialized view — use DROP TABLE`,
					StatusCode.ERROR,
				);
			}
			if (sm.getView(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`'${plan.viewName}' is a view, not a materialized view — use DROP VIEW`,
					StatusCode.ERROR,
				);
			}
			throw new QuereusError(`no such materialized view: ${plan.viewName}`, StatusCode.ERROR);
		}

		// Detach the row-time maintenance plan. The manager also reacts to the
		// `materialized_view_removed` event below, but detaching first keeps the
		// stale plan from firing on the backing-table drop.
		db.unregisterMaterializedView(plan.schemaName, plan.viewName);

		// Clear any constraint↔structure link this MV established. No enforcement
		// demotion: physical schemas still enforce via the implicit auto-index.
		unlinkCoveredUniqueConstraints(db, mv);

		// Drop the backing table (fires table_removed) then unregister the MV.
		await sm.dropTable(plan.schemaName, mv.backingTableName, /*ifExists*/ true);
		sm.removeMaterializedView(plan.schemaName, plan.viewName);
		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_removed',
			schemaName: plan.schemaName,
			objectName: plan.viewName,
			oldObject: mv,
		});
		return null;
	}

	return { params: [], run, note: `dropMaterializedView(${plan.schemaName}.${plan.viewName})` };
}
