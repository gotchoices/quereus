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
import type { Database } from '../../core/database.js';
import type { MaintainedTableSchema } from '../../schema/derivation.js';
import type { BackingRowChange } from '../../vtab/backing-host.js';
import { requireVtabModule } from '../../schema/table.js';
import { normalizeBackingModuleName } from '../../schema/view.js';
import { assertDdlTransactionPolicy, isDdlPolicyStrict } from './ddl-transaction-policy.js';
import { withStatementScopedSchemaEvents } from './ddl-event-scope.js';
import { assertNoAssertionDependsOn } from './assertion-drop-guard.js';
import { assertNoExpressionDependsOn } from './expression-drop-guard.js';
import {
	materializeView,
	deriveBackingShape,
	rebuildBacking,
	reshapeBacking,
	backingShapeMatches,
	revalidateBody,
	unlinkCoveredUniqueConstraints,
	adoptShapeSources,
} from './materialized-view-helpers.js';

/**
 * Strict-policy gate (see ddl-transaction-policy.ts) for a verb that operates on an
 * EXISTING maintained table — REFRESH and DROP. Both drive the backing module table
 * in ways that escape rollback, so both are refused inside an explicit transaction on
 * a non-`transactional` module.
 *
 * Resolving the owning module needs the MV lookup, so it is guarded behind the cheap
 * policy check (the `emitDropIndex` pattern): the default permissive path pays nothing
 * and keeps its statement ordering byte-for-byte. An unresolvable name skips the gate
 * and falls through to the caller's IF EXISTS / not-found diagnostics.
 */
function assertMaintainedTableDdlPolicy(db: Database, schemaName: string, viewName: string, statementLabel: string): void {
	if (!isDdlPolicyStrict(db)) return;
	const target = db.schemaManager.getMaintainedTable(schemaName, viewName);
	if (!target) return;
	assertDdlTransactionPolicy(db, requireVtabModule(target), target.vtabModuleName, statementLabel);
}

export function emitCreateMaterializedView(plan: CreateMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). The MV's backing is a real
		// module (memory/store) table, so creating one escapes rollback exactly like
		// CREATE TABLE. The owning module is the `using <module>(...)` backing host, else
		// the memory default — the one normalizeBackingModuleName decision
		// buildBackingTableSchema also resolves through (NOT the session default module,
		// which MV backing deliberately ignores). The plan builder already rejects an
		// unregistered module; if one was unregistered after the plan was built, skip the
		// gate and let materializeView raise the natural "no virtual table module named
		// ..." error.
		const backingModuleName = normalizeBackingModuleName(plan.backingModuleName);
		const backingModule = rctx.db.schemaManager.getModule(backingModuleName);
		if (backingModule?.module) {
			assertDdlTransactionPolicy(
				rctx.db, backingModule.module, backingModuleName,
				`CREATE MATERIALIZED VIEW ${plan.viewName}`,
			);
		}

		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope (see ddl-event-scope.ts): `materializeView`
		// creates the backing table — announced — and fills it afterwards, so a fill that
		// fails drops the table again. Without the scope the statement announces a create
		// and a drop for a table the application never got.
		return withStatementScopedSchemaEvents(rctx, async () => {
			const db = rctx.db;
			const sm = db.schemaManager;

			const existing = sm.getMaintainedTable(plan.schemaName, plan.viewName);
			if (existing) {
				if (plan.ifNotExists) return null;
				throw new QuereusError(
					`Materialized view '${plan.schemaName}.${plan.viewName}' already exists`,
					StatusCode.ERROR,
				);
			}
			// One namespace now: a plain table occupies the same name a maintained
			// table would. Keep the dedicated diagnostic for both directions.
			if (sm.getTable(plan.schemaName, plan.viewName) || sm.getView(plan.schemaName, plan.viewName)) {
				throw new QuereusError(
					`Cannot create materialized view '${plan.schemaName}.${plan.viewName}': a table or view with the same name already exists`,
					StatusCode.CONSTRAINT,
				);
			}

			// The materialize core (derive backing shape → create + fill the
			// maintained table under the MV's own name in the declared host module →
			// attach derivation + register row-time maintenance, rolling back on any
			// throw) is shared with the catalog-import path — see materializeView.
			const mv = await materializeView(db, {
				schemaName: plan.schemaName,
				viewName: plan.viewName,
				// Any `with defaults (…)` rides inside plan.selectStmt (→ selectAst).
				selectAst: plan.selectStmt,
				bodySql: plan.bodySql,
				columns: plan.columns,
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
		});
	}

	return { params: [], run, note: `createMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

export function emitRefreshMaterializedView(plan: RefreshMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// REFRESH is gated even though it mostly rewrites rows rather than the catalog
		// shape: its reshape arm reconciles a shifted body shape onto the live table with
		// module `alterTable` ops and commits the rebuilt rows early — a genuine escaping
		// schema change. Whether a refresh takes that arm depends on how the sources have
		// changed, so gating only that arm would make strict unpredictable. (The data-only
		// arm is transactional: `begin; refresh; rollback` undoes it.)
		assertMaintainedTableDdlPolicy(
			rctx.db, plan.schemaName, plan.viewName,
			`REFRESH MATERIALIZED VIEW ${plan.viewName}`,
		);

		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope (see ddl-event-scope.ts). No demonstrated leak
		// on either path today: the reshape arm does drive module `alterTable` ops before the
		// recomputed rows can reject the refresh, but `reshapeOpToChange` never sets `ddl`, so
		// an emitter-backed module stays silent for them. The scope is the invariant every DDL
		// emitter holds, and the guard if a reshape ever announces.
		return withStatementScopedSchemaEvents(rctx, async () => {
			const db = rctx.db;
			const sm = db.schemaManager;

			const mv = sm.getMaintainedTable(plan.schemaName, plan.viewName);
			if (!mv) {
				if (sm.getTable(plan.schemaName, plan.viewName)) {
					throw new QuereusError(
						`'${plan.viewName}' is a table, not a materialized view`,
						StatusCode.ERROR,
					);
				}
				throw new QuereusError(`no such materialized view: ${plan.viewName}`, StatusCode.ERROR);
			}

			await refreshMaintainedTable(db, mv);
			return null;
		});
	}

	return { params: [], run, note: `refreshMaterializedView(${plan.schemaName}.${plan.viewName})` };
}

let refreshSavepointCounter = 0;

/**
 * The per-MV refresh core — the always-correct full-rebuild convergence point a
 * `refresh materialized view` runs through, factored out of
 * {@link emitRefreshMaterializedView} so the engine-level convergence sweep
 * ({@link Database.refreshAllMaterializedViews}) drives the IDENTICAL path
 * without a second copy of the rebuild logic. The caller has already looked the
 * MV up and ensured a transaction; this runs everything after that:
 * stale revalidation → shape re-derivation → reshape/rebuild → row-time
 * re-registration → propagation of the realized diff → `stale` clear →
 * `materialized_view_refreshed` notify. Returns the live (possibly reshaped)
 * maintained-table record.
 *
 * The rebuilt rows and everything propagated from them (change-log entries, writes
 * to maintained tables built on this one, referential actions) are pending in the
 * transaction, so they commit or roll back with it — except on the reshape arm,
 * whose rows commit early (see `reshapeBackingInPlace`). A savepoint makes the
 * refresh atomic inside an explicit transaction: a failure unwinds its writes and
 * leaves the MV as it was.
 *
 * `stale` is catalog state, which a rollback does not touch. So a refresh that
 * cleared it — or that committed early — registers a transaction undo action that
 * marks the MV stale again if its work is undone; otherwise a rolled-back refresh
 * would leave the MV marked fresh over its restored, drifted rows.
 */
export async function refreshMaintainedTable(db: Database, mv: MaintainedTableSchema): Promise<MaintainedTableSchema> {
	const wasStale = mv.derivation.stale === true;
	const savepoint = `__refresh_${refreshSavepointCounter++}`;
	await db._createSavepointBroadcast(savepoint);
	let refreshed: RefreshedRecord;
	try {
		refreshed = await rebuildAndPropagate(db, mv);
		await db._releaseSavepointBroadcast(savepoint);
	} catch (e) {
		await db._rollbackAndReleaseSavepointBroadcast(savepoint);
		// Registration may have run before the failure. A stale MV keeps no row-time
		// plan, and this one is back over its pre-refresh rows.
		if (mv.derivation.stale) db.unregisterMaterializedView(mv.schemaName, mv.name);
		throw e;
	}

	const { live, reshaped } = refreshed;
	live.derivation.stale = false;
	if (wasStale || reshaped) {
		db._onTransactionUndo(() => markStaleIfPresent(db, live.schemaName, live.name));
	}
	db.schemaManager.getChangeNotifier().notifyChange({
		type: 'materialized_view_refreshed',
		// Stored names of the refreshed MV, not the raw statement spelling — see
		// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
		schemaName: live.schemaName,
		objectName: live.name,
		object: live,
	});
	return live;
}

interface RefreshedRecord {
	/** The live (possibly reshaped) maintained-table record. */
	live: MaintainedTableSchema;
	/** True when the refresh took the reshape arm, whose rows committed early. */
	reshaped: boolean;
}

/** Re-stale a refreshed MV whose refresh was undone, if it still exists. */
function markStaleIfPresent(db: Database, schemaName: string, name: string): void {
	const current = db.schemaManager.getMaintainedTable(schemaName, name);
	if (current) db.markMaterializedViewStale(current);
}

/** The refresh's transactional body: rebuild or reshape, re-register, propagate. */
async function rebuildAndPropagate(db: Database, mv: MaintainedTableSchema): Promise<RefreshedRecord> {
	const d = mv.derivation;

	const bodySql = astToString(d.selectAst);

	// A stale MV re-validates its body against current source schemas first.
	if (d.stale) {
		revalidateBody(db, mv.schemaName, mv.name, bodySql);
	}

	// Re-derive the canonical backing shape from the (re-planned) body. A source
	// `alter` can shift the body's output shape (columns/types/PK/ordering) — most
	// visibly for a `select *` body, whose new source column interleaves into the
	// output while the create-time backing does not. Only swapping the
	// new rows into the stale backing schema would surface body values under the wrong
	// column labels (a latent direct-read corruption) and break the positional
	// backing↔body alignment the join read-rewrite relies on. So compare the derived
	// shape to the live table and rebuild it when the shape shifted.
	const shape = deriveBackingShape(db, mv.schemaName, bodySql, d.columns,
		{ moduleName: mv.vtabModuleName, moduleArgs: mv.vtabArgs, against: mv });

	// An explicit column list is a declared interface. A body whose output count
	// shifted under it (a source column add behind `mv(a, b, c)`) would silently
	// widen/narrow that list — error instead of reshaping it. The MV stays stale, so
	// the next read re-validates/errors rather than serving a reshaped interface.
	if (d.columns && d.columns.length !== shape.columns.length) {
		throw new QuereusError(
			`materialized view '${mv.schemaName}.${mv.name}' was declared with ${d.columns.length} columns `
				+ `but its body now produces ${shape.columns.length} after a source change — drop and recreate`,
			StatusCode.ERROR,
		);
	}

	let live: MaintainedTableSchema = mv;
	let changes: BackingRowChange[];
	const reshaped = !backingShapeMatches(mv, shape);
	if (!reshaped) {
		// FAST PATH: shape unchanged — data-only swap, table identity + caches preserved.
		// The sources may still have moved (a view the body reads was dropped and
		// recreated over other tables), and registration below keys off the record.
		adoptShapeSources(d, shape);
		changes = await rebuildBacking(db, mv, { commitEarly: false });
	} else {
		// RESHAPE: the shape shifted — reconcile the live table to the re-planned
		// body IN PLACE (module alterTable ops + data reconcile), preserving the
		// table incarnation. An interleaving reorder or a physical-PK change is
		// inexpressible in place and raises a sited error (table left untouched,
		// MV stays stale). The helper returns the reshaped (shape-updated) record.
		({ live, changes } = await reshapeBacking(db, mv, shape));
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
	// `backingRecomputed`: the rebuild/reshape above re-derived every backing row from the
	// body against the CURRENT function registry, so a body function that now resolves to a
	// different registration than at the last registration is exactly what this refresh just
	// resolved — not drift to mark stale over. (Every other re-registration path leaves the
	// stored rows alone and so keeps the check.)
	db.registerMaterializedView(live, { backingRecomputed: true });

	// The rebuild wrote the table through the privileged surface, which the DML boundary
	// never sees: send its diff downstream (change log, referential actions, the cascade to
	// maintained tables reading this one). After registration, so it binds the live record;
	// before the `stale` clear, so a failure here leaves the MV stale.
	await db._propagateRefreshChanges(live, changes);
	return { live, reshaped };
}

/**
 * Shared maintained-table teardown: detach the row-time maintenance plan,
 * clear any constraint↔structure link, drop the table (fires `table_removed`),
 * and fire `materialized_view_removed` so store catalog persistence forgets
 * the `create materialized view` entry. Used by DROP MATERIALIZED VIEW and by
 * DROP TABLE on a maintained table — in the unified model both drop the one
 * record (table + derivation).
 */
export async function dropMaintainedTable(db: Database, mv: MaintainedTableSchema): Promise<void> {
	const sm = db.schemaManager;

	// Detach the row-time maintenance plan. The manager also reacts to the
	// `materialized_view_removed` event below, but detaching first keeps the
	// stale plan from firing on the table drop.
	db.unregisterMaterializedView(mv.schemaName, mv.name);

	// Clear any constraint↔structure link this MV established. No enforcement
	// demotion: physical schemas still enforce via the implicit auto-index.
	unlinkCoveredUniqueConstraints(db, mv);

	// Drop the table (fires table_removed), then notify the MV channel.
	await sm.dropTable(mv.schemaName, mv.name, /*ifExists*/ true);
	sm.getChangeNotifier().notifyChange({
		type: 'materialized_view_removed',
		// Stored names of the dropped MV, not the raw statement spelling — see
		// SchemaManager.canonicalSchemaName for the emitter/stored-name invariant.
		schemaName: mv.schemaName,
		objectName: mv.name,
		oldObject: mv,
	});
}

export function emitDropMaterializedView(plan: DropMaterializedViewNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Dropping an MV drops its backing module table, escaping rollback exactly like
		// DROP TABLE.
		assertMaintainedTableDdlPolicy(
			rctx.db, plan.schemaName, plan.viewName,
			`DROP MATERIALIZED VIEW ${plan.viewName}`,
		);

		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope (see ddl-event-scope.ts): `dropMaintainedTable`
		// drops the backing table — announced — and then does more work (the
		// `materialized_view_removed` notify and its listeners), so a failure past the drop
		// must not leave the drop announced.
		return withStatementScopedSchemaEvents(rctx, async () => {
			const db = rctx.db;
			const sm = db.schemaManager;

			const mv = sm.getMaintainedTable(plan.schemaName, plan.viewName);
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

			// Same guard DROP TABLE applies — a maintained table is a table to an
			// assertion body. `dropMaintainedTable` itself stays unguarded: internal
			// rollback / catalog-cleanup paths call it and must not be vetoed.
			assertNoAssertionDependsOn(db, plan.schemaName, plan.viewName, 'materialized view');
			// …and a table to another table's CHECK / DEFAULT / generated subquery too.
			assertNoExpressionDependsOn(db, plan.schemaName, plan.viewName, 'materialized view');

			await dropMaintainedTable(db, mv);
			return null;
		});
	}

	return { params: [], run, note: `dropMaterializedView(${plan.schemaName}.${plan.viewName})` };
}
