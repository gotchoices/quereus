import type {
	CreateMaterializedViewNode,
	RefreshMaterializedViewNode,
	DropMaterializedViewNode,
} from '../../planner/nodes/materialized-view-nodes.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { astToString } from '../../emit/ast-stringify.js';
import {
	materializeView,
	deriveBackingShape,
	rebuildBacking,
	rebuildBackingTable,
	backingShapeMatches,
	revalidateBody,
	unlinkCoveredUniqueConstraints,
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

		// The materialize core (derive backing shape → create + fill the backing
		// in the declared host module → register record + row-time maintenance,
		// rolling back on any throw) is shared with the catalog-import path — see
		// materializeView.
		const mv = await materializeView(db, {
			schemaName: plan.schemaName,
			viewName: plan.viewName,
			sql: plan.sql,
			selectAst: plan.selectStmt,
			bodySql: plan.bodySql,
			columns: plan.columns,
			insertDefaults: plan.insertDefaults,
			tags: plan.tags,
			backingModuleName: plan.backingModuleName,
			backingModuleArgs: plan.backingModuleArgs,
		});

		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_added',
			// Stored names of the registered MV — see
			// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: mv.schemaName,
			objectName: mv.name,
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

		const bodySql = astToString(mv.selectAst);

		// A stale MV re-validates its body against current source schemas first.
		if (mv.stale) {
			revalidateBody(db, mv.name, bodySql);
		}

		// Re-derive the canonical backing shape from the (re-planned) body. A source
		// `alter` can shift the body's output shape (columns/types/PK/ordering) — most
		// visibly for a `select *` body, whose new source column interleaves into the
		// output while the create-time backing does not. Only `replaceContents`-ing the
		// new rows into the stale backing schema would surface body values under the wrong
		// column labels (a latent direct-read corruption) and break the positional
		// backing↔body alignment the join read-rewrite relies on. So compare the derived
		// shape to the live backing and rebuild the backing table when it shifted.
		const shape = deriveBackingShape(db, bodySql, mv.columns);

		// An explicit column list is a declared interface. A body whose output count
		// shifted under it (a source column add behind `mv(a, b, c)`) would silently
		// widen/narrow that list — error instead of reshaping it. The MV stays stale, so
		// the next read re-validates/errors rather than serving a reshaped interface.
		if (mv.columns && mv.columns.length !== shape.columns.length) {
			throw new QuereusError(
				`materialized view '${mv.schemaName}.${mv.name}' was declared with ${mv.columns.length} columns `
					+ `but its body now produces ${shape.columns.length} after a source change — drop and recreate`,
				StatusCode.ERROR,
			);
		}

		const currentBacking = sm.getTable(mv.schemaName, mv.backingTableName);
		if (currentBacking && backingShapeMatches(currentBacking, shape)) {
			// FAST PATH: shape unchanged — data-only swap, backing identity + caches preserved.
			await rebuildBacking(db, mv);
		} else {
			// REBUILD: the backing shape shifted — drop+recreate the backing to match the
			// re-planned body, then keep the MV record consistent with the new shape.
			await rebuildBackingTable(db, mv, shape);
			mv.primaryKey = shape.primaryKey;
			mv.ordering = shape.ordering;
			mv.sourceTables = shape.sourceTables;
		}

		// Re-register row-time write-through maintenance. A source schema change that
		// marked this MV stale also detached its row-time plan; the rebuild above only
		// fixes the snapshot, so without re-registering, subsequent source writes would
		// silently not propagate. Registration runs AFTER the (re)build so the maintenance
		// plan binds to the new backing's shape (`backingPkDefinition`/projectors).
		// Registration is idempotent (it releases any existing plan first), so a refresh of
		// a never-stale MV is a harmless no-op re-attach. Re-register BEFORE clearing
		// `stale`: if registration ever threw (the eligibility gate re-runs here), leaving
		// the MV stale makes the next read re-validate/error rather than silently serve an
		// unmaintained snapshot.
		db.registerMaterializedView(mv);
		mv.stale = false;
		sm.getChangeNotifier().notifyChange({
			type: 'materialized_view_refreshed',
			// Stored names of the refreshed MV, not the raw statement spelling — see
			// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: mv.schemaName,
			objectName: mv.name,
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
			// Stored names of the dropped MV, not the raw statement spelling — see
			// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
			schemaName: mv.schemaName,
			objectName: mv.name,
			oldObject: mv,
		});
		return null;
	}

	return { params: [], run, note: `dropMaterializedView(${plan.schemaName}.${plan.viewName})` };
}
