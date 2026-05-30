/**
 * Materialized-view maintenance: schema-change staleness tracking plus row-time
 * write-through maintenance.
 *
 * Two responsibilities:
 *
 *  1. **Staleness** — a *schema* change to a source table (drop / alter) can break
 *     an MV's body. This manager subscribes to schema-change events and marks any
 *     MV whose body reads a modified/removed source `stale`. The next reference
 *     re-validates the body (erroring with the staleness diagnostic on an
 *     incompatible change); the next successful refresh clears the flag.
 *
 *  2. **Row-time write-through** (`maintainRowTime`) — the backing table is kept
 *     consistent *synchronously* with each source row-write, driven from the
 *     runtime DML boundary (not at COMMIT). Each MV is gated at create to the
 *     covering-index shape (a single row-preserving source whose body projects every
 *     source PK column as a passthrough column, with non-key columns optionally a
 *     deterministic scalar expression over the row), so each source row maps to exactly
 *     one backing row and maintenance is a pure projection of the changed row — delete
 *     the old image's backing key, upsert the new image's backing row; no body
 *     re-execution, no scan. The write targets the backing
 *     table's *pending* transaction layer through the same connection a `select`
 *     from the MV uses, so the change is visible mid-transaction (reads-own-writes)
 *     and is committed/rolled-back in lockstep with the source write by the
 *     coordinated commit. A body that is not row-time maintainable is rejected at
 *     create (see {@link MaterializedViewManager.buildMaintenancePlan}).
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type ScalarPlanNode, type RowDescriptor, isRelationalNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Scheduler } from '../runtime/scheduler.js';
import { RowContextMap } from '../runtime/context-helpers.js';
import type { RuntimeContext } from '../runtime/types.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import {
	selectMaintenanceStrategy,
	seqScanCost,
	filterCost,
	projectCost,
	type MaintenanceSourceStats,
	type MaintenanceStrategy,
} from '../planner/cost/index.js';
import { getBackingManager } from '../runtime/emit/materialized-view-helpers.js';
import { buildPrimaryKeyFromValues } from '../vtab/memory/utils/primary-key.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import type { BackingRowChange, MaintenanceOp, MemoryTableManager } from '../vtab/memory/layer/manager.js';
import { MemoryVirtualTableConnection } from '../vtab/memory/connection.js';
import type { MemoryTableConnection } from '../vtab/memory/layer/connection.js';
import type { ScanPlan } from '../vtab/memory/layer/scan-plan.js';
import { compilePredicate, type CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import { compareSqlValues } from '../util/comparison.js';
import type { MaterializedViewSchema } from '../schema/view.js';
import type { TableSchema, UniqueConstraintSchema } from '../schema/table.js';
import type { Database } from './database.js';
import type * as AST from '../parser/ast.js';

const log = createLogger('core:materialized-views');

/** Fallback source row estimate when the StatsProvider has no count (mirrors the
 *  optimizer's naive default). Only feeds the create-time maintenance cost gate. */
const DEFAULT_SOURCE_ROWS = 1000;

/**
 * Database internals the materialized-view manager needs. Mirrors
 * `AssertionEvaluatorContext` / `WatcherManagerContext` — keeps the manager
 * decoupled from the full `Database`.
 */
export interface MaterializedViewManagerContext {
	readonly schemaManager: SchemaManager;
	readonly optimizer: Database['optimizer'];

	_buildPlan(statements: AST.Statement[]): import('./database.js').BuildPlanResult;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
}

/**
 * A compiled per-MV maintenance plan — how {@link MaterializedViewManager.applyMaintenancePlan}
 * keeps an MV's backing table consistent with a source row-write. A tagged union over
 * the maintenance strategies the incremental substrate names (the spike's
 * `incremental-maintenance-substrate-spike` design). Today the builder
 * ({@link MaterializedViewManager.buildMaintenancePlan}) only ever produces the
 * `'inverse-projection'` arm — the shipped covering-index semantics, lifted here
 * byte-for-byte from the former private `RowTimeMaintenancePlan`. The other two arms
 * are reserved convergence points, **unreachable** until the cost gate
 * (`incremental-maintenance-cost-gate`) and general-bodies
 * (`materialized-view-rowtime-general-bodies`) tickets wire selection logic; routing
 * one through `applyMaintenancePlan` today trips a loud `INTERNAL` guard.
 */
export type MaintenancePlan =
	| InverseProjectionPlan
	| FullRebuildPlan
	| ResidualRecomputePlan;

/**
 * The shipped covering-index maintenance arm (the former `RowTimeMaintenancePlan`,
 * verbatim). Per source row-write the backing delta is a pure projection of the
 * changed row: project the source row to a backing row (a per-column projector —
 * passthrough columns *and* deterministic scalar expressions over the source row),
 * key it by the backing physical PK, and (if the partial predicate admits it) delete
 * the old image / upsert the new image. No body re-execution, no scan — see
 * `docs/materialized-views.md` § Row-time refresh.
 */
/**
 * How a single backing output column is derived from the changed source row — a pure
 * per-row (per-statement) function. `'passthrough'` copies a source column (the column
 * permutation that *every* PK / UNIQUE-covered column must use, so the backing key and
 * the inverse-projection conflict map are recoverable); `'expr'` evaluates a
 * deterministic scalar expression over the source row (a non-key derived column —
 * `materialized-view-rowtime-expression-projections`). `eval` is the runtime-compiled
 * evaluator (see {@link compileSourceRowEvaluator}), so a computed backing value is
 * exactly what `select <body>` would produce.
 */
export type BackingProjector =
	| { readonly kind: 'passthrough'; readonly sourceCol: number }
	| { readonly kind: 'expr'; readonly eval: (sourceRow: Row) => SqlValue };

/**
 * Common identity + cost-gate fields shared by every {@link MaintenancePlan} arm.
 * `chosenStrategy` / `sourceStats` are set once by the create-time cost gate
 * ({@link MaterializedViewManager.buildMaintenancePlan}, via `selectMaintenanceStrategy`)
 * and are not re-evaluated per write, except for the residual → rebuild demotion
 * (`shouldDegradeToRebuild`; dormant until the residual arm is reachable).
 */
interface MaintenancePlanCommon {
	/** The MV this plan maintains. */
	mv: MaterializedViewSchema;
	/** Lowercased `schema.table` of the single source `T`. */
	sourceBase: string;
	backingSchema: string;
	backingTableName: string;
	/** Strategy the cost gate chose: argmin `maintenanceCost` over the body's sound strategies. */
	chosenStrategy: MaintenanceStrategy;
	/** Create-time cost inputs (StatsProvider + forward optimizer), retained so the DML
	 *  boundary can re-cost residual vs. rebuild against the actual changeCardinality. */
	sourceStats: MaintenanceSourceStats;
}

export interface InverseProjectionPlan extends MaintenancePlanCommon {
	readonly kind: 'inverse-projection';
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	/** `projectors[j]` derives backing output column `j` from the changed source row —
	 *  either a passthrough copy of a source column or a deterministic scalar expression
	 *  over the source row. Every PK / backing-key column is `'passthrough'` (eligibility
	 *  rejects a computed column that lands in the backing key); non-key columns may be
	 *  `'expr'`. {@link MaterializedViewManager.lookupCoveringConflicts} reads only the
	 *  passthrough projectors for its inverse (source↔backing) map. */
	projectors: BackingProjector[];
	/** Partial-WHERE predicate evaluated on a single source row; absent ⇒ every row
	 *  is in scope. A source row contributes a backing row only when this is
	 *  unambiguously TRUE (mirrors partial-UNIQUE / partial-index semantics). */
	predicate?: CompiledPredicate;
}

/**
 * The always-correct escape hatch: re-run the body to completion and swap the backing
 * base layer (the `rebuildBacking` strategy). Stub here — **unreachable** until
 * `incremental-maintenance-cost-gate` (1.6) wires the selector that routes to it when
 * inverse projection would cost more than a wholesale rebuild. Carries only the
 * common identity fields; the rebuild re-derives everything else from the MV body.
 */
export interface FullRebuildPlan extends MaintenancePlanCommon {
	readonly kind: 'full-rebuild';
}

/**
 * The general-body residual-recompute arm: re-evaluate a per-binding residual of the
 * body for each changed binding tuple. Stub here — **unreachable** until
 * `materialized-view-rowtime-general-bodies` (3) builds its body on this abstraction.
 * It carries the {@link BindingMode} the spike names as the convergence point — the
 * incremental engine and the delta executor sharing one binding analysis — plus a
 * `degradeToRebuild` escape flag (fall back to full rebuild when the residual cannot
 * be parameterized).
 */
export interface ResidualRecomputePlan extends MaintenancePlanCommon {
	readonly kind: 'residual-recompute';
	binding: BindingMode;
	degradeToRebuild: boolean;
}

export class MaterializedViewManager {
	private unsubscribeSchemaChanges: (() => void) | null = null;

	/** Compiled maintenance plans keyed by MV `schema.name` (lowercase). */
	private readonly rowTime = new Map<string, MaintenancePlan>();

	/** Source base (lowercased `schema.table`) → set of MV keys with a row-time plan
	 *  reading it. The per-row DML maintenance hook looks plans up by source base. */
	private readonly rowTimeBySource = new Map<string, Set<string>>();

	constructor(private readonly ctx: MaterializedViewManagerContext) {
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type === 'table_removed' || event.type === 'table_modified') {
				const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
				for (const mv of this.ctx.schemaManager.getAllMaterializedViews()) {
					if (mv.sourceTables.includes(changed)) {
						if (!mv.stale) {
							mv.stale = true;
							log('Marked materialized view %s.%s stale due to %s on %s', mv.schemaName, mv.name, event.type, changed);
						}
						// A source schema change invalidates the compiled row-time plan;
						// detach it. The MV reads "stale" until refreshed or recreated,
						// which re-registers it.
						this.releaseRowTime(mvKey(mv.schemaName, mv.name));
					}
				}
			} else if (event.type === 'materialized_view_removed') {
				this.releaseRowTime(mvKey(event.schemaName, event.objectName));
			}
		});
	}

	/**
	 * Compile + register an MV for row-time write-through maintenance. Always
	 * builds the maintenance plan via {@link buildMaintenancePlan}, which throws on a
	 * body that is not row-time maintainable — the create emitter rolls the MV back on
	 * throw, so an ineligible body errors cleanly at create time.
	 */
	registerMaterializedView(mv: MaterializedViewSchema): void {
		const key = mvKey(mv.schemaName, mv.name);
		// Cache the source-union change-scope so a `select` from this MV projects to
		// its sources in `analyzeChangeScope`: the backing table is maintained off the
		// user change log (synchronously at the DML boundary), so a `Database.watch`
		// on this MV must project to its sources rather than the never-change-logged
		// backing table. v1 is the conservative union of a `full` watch per source.
		mv.sourceScope = buildSourceUnionScope(mv.sourceTables);
		this.releaseRowTime(key);
		const plan = this.buildMaintenancePlan(mv); // throws on ineligible shape
		this.rowTime.set(key, plan);
		let set = this.rowTimeBySource.get(plan.sourceBase);
		if (!set) { set = new Set(); this.rowTimeBySource.set(plan.sourceBase, set); }
		set.add(key);
		log('Registered row-time materialized view %s.%s', mv.schemaName, mv.name);
	}

	/** Detach an MV's row-time plan + its source-base index entry (DROP path). */
	unregisterMaterializedView(schemaName: string, name: string): void {
		this.releaseRowTime(mvKey(schemaName, name));
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const key of [...this.rowTime.keys()]) {
			this.releaseRowTime(key);
		}
	}

	/** Drop a row-time plan and its source-base index entry (DROP / schema-change / re-register). */
	private releaseRowTime(key: string): void {
		const plan = this.rowTime.get(key);
		if (!plan) return;
		this.rowTime.delete(key);
		const set = this.rowTimeBySource.get(plan.sourceBase);
		if (set) {
			set.delete(key);
			if (set.size === 0) this.rowTimeBySource.delete(plan.sourceBase);
		}
	}

	/* ──────────────────── row-time write-through ──────────────────── */

	/**
	 * True iff a row-time covering structure reads `sourceBase` (lowercased
	 * `schema.table`). The DML write boundary consults this synchronously so the
	 * per-row maintenance hook is a zero-allocation no-op when nothing depends on
	 * the written table.
	 */
	hasRowTimePlanFor(sourceBase: string): boolean {
		const set = this.rowTimeBySource.get(sourceBase.toLowerCase());
		return set !== undefined && set.size > 0;
	}

	/**
	 * Synchronously maintain every row-time covering structure on `sourceBase` for
	 * one source row-write. Each plan computes the per-row backing delta (a pure
	 * projection of the changed row) and applies it to the backing table's pending
	 * transaction layer through the connection a `select` from the MV would use —
	 * so the write is visible mid-transaction and rides the coordinated commit.
	 *
	 * **MV-over-MV cascade.** A backing write is itself a row-write that every MV
	 * reading *that backing table* must see. When a plan's backing base has its own
	 * dependents (`rowTimeBySource[backingBase]` non-empty), each effective
	 * {@link BackingRowChange} the write produced is routed back through this method,
	 * recursively. The dependency graph is acyclic (a consumer MV requires its
	 * producer MV to already exist at create time), so this synchronous depth-first
	 * recursion is DAG-ordered — a producer's backing is fully written before its
	 * consumers run — and the whole chain commits/rolls-back atomically on the live
	 * transaction. The leaf fast path (`!rowTimeBySource.has(backingBase)`) keeps a
	 * non-chained MV at exactly today's cost (one map lookup, no recursion). `depth`
	 * feeds the structural-cycle backstop in {@link assertCascadeDepth}.
	 */
	async maintainRowTime(
		sourceBase: string,
		change: BackingRowChange,
		depth = 0,
	): Promise<void> {
		const keys = this.rowTimeBySource.get(sourceBase.toLowerCase());
		if (!keys || keys.size === 0) return;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			const backingChanges = await this.applyMaintenancePlan(plan, change);
			if (backingChanges.length === 0) continue;
			const backingBase = `${plan.backingSchema}.${plan.backingTableName}`.toLowerCase();
			if (!this.rowTimeBySource.has(backingBase)) continue; // leaf — no dependents
			this.assertCascadeDepth(depth + 1, backingBase);
			for (const bc of backingChanges) {
				await this.maintainRowTime(backingBase, bc, depth + 1);
			}
		}
	}

	/**
	 * Defense-in-depth backstop for the cascade. Cycles are structurally impossible
	 * (a consumer MV can only be created once its producer exists, and an MV's source
	 * set is fixed at create), so a valid chain descends at most once per registered
	 * row-time MV. A depth beyond that count signals a structural impossibility (a
	 * cycle) — fail loud with `INTERNAL` naming the backing base rather than overflow
	 * the stack. This should never fire.
	 */
	private assertCascadeDepth(depth: number, backingBase: string): void {
		if (depth > this.rowTime.size) {
			throw new QuereusError(
				`materialized-view cascade exceeded maximum depth (${this.rowTime.size}) at backing `
					+ `'${backingBase}' — a row-time dependency cycle should be structurally impossible`,
				StatusCode.INTERNAL,
			);
		}
	}

	/**
	 * Dispatch a maintenance plan on its `kind`, compute the per-row backing delta,
	 * apply it, and return the **effective** {@link BackingRowChange}(s) the backing
	 * layer realized (so the cascade can drive this plan's own dependents). Today the
	 * builder only ever yields `'inverse-projection'`; the `'full-rebuild'` and
	 * `'residual-recompute'` arms are loud `INTERNAL` guards (unreachable until the
	 * cost-gate / general-bodies tickets wire their selection — see {@link MaintenancePlan}).
	 */
	private async applyMaintenancePlan(
		plan: MaintenancePlan,
		change: BackingRowChange,
	): Promise<BackingRowChange[]> {
		switch (plan.kind) {
			case 'inverse-projection':
				return this.applyInverseProjection(plan, change);
			case 'full-rebuild':
			case 'residual-recompute':
				throw new QuereusError(
					`materialized view '${plan.mv.name}': '${plan.kind}' maintenance is not yet wired `
						+ `(reachable only once the cost-gate / general-bodies tickets land)`,
					StatusCode.INTERNAL,
				);
			default: {
				// A new arm added to MaintenancePlan must extend this dispatch; the
				// never-assignment makes that a compile error rather than a silent
				// fall-through (noImplicitReturns is off in this package).
				const exhaustiveCheck: never = plan;
				throw new QuereusError(
					`unknown maintenance plan kind: ${(exhaustiveCheck as MaintenancePlan).kind}`,
					StatusCode.INTERNAL,
				);
			}
		}
	}

	/**
	 * Compute an `'inverse-projection'` plan's per-row backing delta, apply it, and
	 * return the **effective** {@link BackingRowChange}(s) the backing layer realized.
	 * An out-of-scope row (or a delete of an absent backing key) yields no change. This
	 * body is the shipped covering-index maintenance, lifted verbatim from the former
	 * `applyRowTimeChange`.
	 */
	private async applyInverseProjection(
		plan: InverseProjectionPlan,
		change: BackingRowChange,
	): Promise<BackingRowChange[]> {
		const inScope = (row: Row): boolean => plan.predicate === undefined || plan.predicate.evaluate(row) === true;
		const project = (row: Row): Row =>
			plan.projectors.map(p => p.kind === 'passthrough' ? row[p.sourceCol] : p.eval(row)) as Row;
		const keyOf = (backingRow: Row): BTreeKeyForPrimary =>
			buildPrimaryKeyFromValues(plan.backingPkDefinition.map(d => backingRow[d.index]), plan.backingPkDefinition);

		const ops: MaintenanceOp[] = [];
		if (change.op === 'insert') {
			const r = change.newRow!;
			if (inScope(r)) ops.push({ kind: 'upsert', row: project(r) });
		} else if (change.op === 'delete') {
			const r = change.oldRow!;
			if (inScope(r)) ops.push({ kind: 'delete-key', key: keyOf(project(r)) });
		} else {
			// UPDATE: delete the old image if it was in scope, upsert the new image if
			// it is — covers predicate-scope transitions and key-changing updates.
			const oldR = change.oldRow!;
			const newR = change.newRow!;
			if (inScope(oldR)) ops.push({ kind: 'delete-key', key: keyOf(project(oldR)) });
			if (inScope(newR)) ops.push({ kind: 'upsert', row: project(newR) });
		}
		if (ops.length === 0) return [];

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const manager = getBackingManager(backing);
		const connection = await this.getBackingConnection(manager, `${plan.backingSchema}.${plan.backingTableName}`);
		return manager.applyMaintenanceToLayer(connection, ops);
	}

	/**
	 * Obtain (lazily create + register) the backing table's
	 * {@link MemoryTableConnection} for the current transaction. Reuses the same
	 * connection a `select` from the MV resolves to (so reads-own-writes holds);
	 * a freshly created connection is registered with the Database so the
	 * coordinated commit/rollback covers its pending layer in lockstep with the
	 * source write.
	 */
	private async getBackingConnection(manager: MemoryTableManager, qualifiedName: string): Promise<MemoryTableConnection> {
		const db = this.ctx as unknown as Database;
		for (const c of db.getConnectionsForTable(qualifiedName)) {
			if (c instanceof MemoryVirtualTableConnection) {
				const mc = c.getMemoryConnection();
				if (mc.tableManager === manager) return mc;
			}
		}
		const memConn = manager.connect();
		const vtabConn = new MemoryVirtualTableConnection(qualifiedName, memConn);
		await db.registerConnection(vtabConn);
		return memConn;
	}

	/**
	 * Build the row-time maintenance plan for an eligible MV, or throw with a
	 * shape-naming diagnostic. Eligibility is the covering-index shape: a single
	 * row-preserving source `T` with a primary key, a linear
	 * `TableReference → optional Filter → Project → optional Sort` body
	 * (no aggregate / join / DISTINCT / set op / recursive CTE / TVF / LIMIT/OFFSET),
	 * a projection that resolves every source PK column (and every backing-key column) to
	 * a **passthrough** source column — non-key columns may instead be a **deterministic
	 * scalar expression** over the source row (`materialized-view-rowtime-expression-
	 * projections`) — and a partial WHERE evaluable on a single source row.
	 *
	 * The single source may itself be another MV's backing table (an MV-over-MV body):
	 * `building/select.ts` rewrites a reference to `mv1` into a `TableReference` against
	 * `mv1`'s backing table, so the source base is `mv1`'s backing base and the same
	 * eligibility checks evaluate against the (keyed `memory`) backing schema unchanged.
	 * A write to `mv1` then drives `mv2` via the cascade in {@link maintainRowTime} — no
	 * separate dependency structure: the existing `rowTimeBySource[backingBase]` index
	 * already records the producer→consumer edge the moment `mv2` registers.
	 *
	 * Eligibility is a *cost choice* among the body's structurally-sound strategies
	 * ({@link selectMaintenanceStrategy}). For the covering-index shape the sound set is
	 * `['inverse-projection']` *only* — `'full-rebuild'` is the always-correct floor for
	 * shapes where inverse projection is NOT sound (which the general-bodies (3) ticket
	 * adds), so it is deliberately not a competitor here: were it in the sound set, a
	 * small/empty source's body cost would undercut inverse projection's per-row cost and
	 * argmin would pick the unwired `'full-rebuild'` arm. So this still only ever returns
	 * the `'inverse-projection'` arm today, now annotated with the chosen strategy and its
	 * cost inputs ({@link MaintenanceSourceStats}).
	 *
	 * The synchronous degrade-vs-reject machinery (`isFullRebuildPathological` reject-at-create,
	 * `shouldDegradeToRebuild` per-write demotion, both in `planner/cost/index.ts`) is
	 * implemented but **dormant**: it is unreachable while `'inverse-projection'` is the only
	 * wired/sound arm. The general-bodies (3) ticket widens the sound set so the other arms —
	 * and that machinery — become reachable.
	 */
	private buildMaintenancePlan(mv: MaterializedViewSchema): MaintenancePlan {
		const db = this.ctx as unknown as Database;
		const { plan } = this.ctx._buildPlan([mv.selectAst as AST.Statement]);
		const analyzed = this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;

		const reject = (detail: string): never => {
			throw new QuereusError(
				`materialized view '${mv.name}' cannot be materialized: ${detail}. `
					+ `A materialized view must be row-time maintainable — a passthrough or `
					+ `deterministic-expression projection of a single keyed source. For this body, use a `
					+ `plain 'create view' (live re-evaluation) or 'create table ... as <body>' (a one-off `
					+ `snapshot)`,
				StatusCode.UNSUPPORTED,
			);
		};

		// Single source `T`. (A join, self-join, or TVF fan-out surfaces ≥2 table
		// references or a TVF node — caught here and by the node-type checks below.)
		const tableRefs = [...collectTableRefs(analyzed).values()];
		if (tableRefs.length === 0) reject('its body reads no source table');
		if (tableRefs.length > 1) reject('its body reads more than one source table (joins are not supported)');
		const tableRef = tableRefs[0];
		const sourceSchema = tableRef.tableSchema;
		const sourceBase = `${sourceSchema.schemaName}.${sourceSchema.name}`.toLowerCase();

		// NOTE: an MV-over-MV body (a source that is itself another MV's backing table)
		// is no longer rejected here. The cascade in `maintainRowTime` drives dependents
		// of a backing write recursively (DAG-ordered, atomic within the statement); the
		// eligibility checks below evaluate against the keyed backing schema unchanged.

		// Row-collapsing / fan-out / unbounded shapes break one-source-row →
		// one-backing-row, so write-through could not be a pure projection.
		if (findAggregate(analyzed)) reject('its body uses an aggregate');
		if (containsAnyJoin(analyzed)) reject('its body contains a join');
		if (containsNodeType(analyzed, PlanNodeType.Distinct)) reject('its body uses DISTINCT');
		if (containsNodeType(analyzed, PlanNodeType.SetOperation)) reject('its body uses a set operation (union/intersect/except)');
		if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) reject('its body uses a recursive CTE');
		if (containsNodeType(analyzed, PlanNodeType.TableFunctionCall)) reject('its body calls a table-valued function');
		if (mv.selectAst.type === 'select' && (mv.selectAst.limit !== undefined || mv.selectAst.offset !== undefined)) {
			reject('its body uses LIMIT/OFFSET');
		}

		const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
		if (sourcePkCols.length === 0) reject(`its source '${sourceBase}' has no primary key`);

		const backing = this.ctx._findTable(mv.backingTableName, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}

		// Projection classification: each backing output column is either a passthrough
		// source column (a pure permutation entry) or a deterministic scalar expression
		// over the single source row. A passthrough makes maintenance a column copy; an
		// expression column evaluates `project(sourceRow)` via the runtime (still a pure
		// per-row function — O(log n), no body re-execution). PK / backing-key columns
		// must stay passthrough (the backing key and the inverse-projection conflict map
		// depend on it); non-key columns may be computed.
		const sourceAttrToCol = new Map<number, number>();
		const sourceDescriptor: RowDescriptor = [];
		tableRef.getAttributes().forEach((a, i) => {
			sourceAttrToCol.set(a.id, i);
			sourceDescriptor[a.id] = i;
		});
		const producingByAttrId = collectProducingExprs(analyzed);
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) reject('its body produced no relational output');

		const projectors: BackingProjector[] = [];
		for (let outCol = 0; outCol < rootAttrs!.length; outCol++) {
			const attr = rootAttrs![outCol];
			const sourceCol = attr ? resolveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
			if (sourceCol !== undefined) {
				projectors.push({ kind: 'passthrough', sourceCol });
				continue;
			}
			// Computed column: a deterministic scalar over the source row. Reject a
			// non-deterministic producer (determinism diagnostic) before checking shape,
			// so `random()` fails on *determinism* and a deterministic-but-unsupported
			// form fails on *shape* — distinct diagnostics.
			const colName = attr?.name ?? `#${outCol}`;
			const producing = attr ? producingByAttrId.get(attr.id) : undefined;
			if (!producing) {
				reject(`it projects output column '${colName}' with no resolvable source expression`);
			}
			const det = checkDeterministic(producing!);
			if (!det.valid) {
				reject(`it projects a non-deterministic expression column '${colName}' (${det.expression}); `
					+ `a row-time backing value must be reproducible from the source row`);
			}
			assertSingleRowEvaluable(producing!, sourceDescriptor, colName, reject);
			let evalFn: (row: Row) => SqlValue;
			try {
				evalFn = compileSourceRowEvaluator(db, producing!, sourceDescriptor);
			} catch (e) {
				reject(`it projects expression column '${colName}' in a form that is not row-time `
					+ `maintainable (${e instanceof Error ? e.message : String(e)})`);
			}
			projectors.push({ kind: 'expr', eval: evalFn! });
		}

		// Every source PK column must be projected as a passthrough column so the backing
		// key is a deterministic identity of the source row that `lookupCoveringConflicts`
		// can invert. A PK column produced only via an expression (or not at all) breaks
		// that recovery.
		const passthroughSourceCols = new Set(
			projectors.flatMap(p => p.kind === 'passthrough' ? [p.sourceCol] : []),
		);
		for (const pk of sourcePkCols) {
			if (!passthroughSourceCols.has(pk)) {
				reject(`it does not project source primary-key column '${sourceSchema.columns[pk]?.name ?? pk}' `
					+ `as a passthrough column`);
			}
		}

		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// A computed column may never land in the backing primary key: the btree keys on
		// it and `lookupCoveringConflicts` recovers the source PK from it, both of which
		// require a passthrough source-column identity.
		for (const d of backingPkDefinition) {
			if (projectors[d.index]?.kind !== 'passthrough') {
				reject(`its backing primary key includes computed column '${backing.columns[d.index]?.name ?? d.index}' `
					+ `(backing-key columns must be passthrough source columns)`);
			}
		}

		// Partial WHERE must be evaluable on a single source row (no subqueries /
		// cross-row references). `compilePredicate` throws on unsupported forms.
		let predicate: CompiledPredicate | undefined;
		const bodyWhere = mv.selectAst.type === 'select' ? mv.selectAst.where : undefined;
		if (bodyWhere) {
			try {
				predicate = compilePredicate(bodyWhere, sourceSchema.columns);
			} catch (e) {
				reject(`its WHERE is not evaluable on a single source row (${e instanceof Error ? e.message : String(e)})`);
			}
		}

		// ── Cost gate (incremental-maintenance-cost-gate) ──
		// The checks above establish soundness for the covering-index shape, whose only
		// structurally-sound maintenance strategy is 'inverse-projection' (O(1) per changed
		// row). Per the cost model inverse projection is never demoted to 'full-rebuild' for
		// an eligible shape — 'full-rebuild' is the always-correct floor for bodies where
		// inverse projection is NOT sound (which materialized-view-rowtime-general-bodies
		// adds), so it is not a competitor here. Eligibility is thus a cost choice among the
		// sound strategies (argmin maintenanceCost); for this shape it resolves to
		// inverse-projection while recording the choice + the cost inputs the runtime reuses.
		// The general-bodies ticket widens `soundStrategies` and activates the reject-at-create
		// / degrade-to-rebuild machinery in planner/cost/index.ts once the other arms are wired.
		const soundStrategies: MaintenanceStrategy[] = ['inverse-projection'];
		const sourceStats = this.estimateMaintenanceStats(sourceSchema, projectors.length, predicate !== undefined);
		// Create-time change-cardinality estimate: ~1% of the source per statement (typical OLTP).
		const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
		const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);

		// Defensive: only 'inverse-projection' is wired today. A different choice would mean
		// `soundStrategies` grew without the corresponding apply-arm — fail loud rather than
		// register an unexecutable plan. Unreachable until the general-bodies ticket lands.
		if (chosenStrategy !== 'inverse-projection') {
			throw new QuereusError(
				`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
				StatusCode.INTERNAL,
			);
		}

		return {
			kind: 'inverse-projection',
			mv,
			sourceBase,
			backingSchema: mv.schemaName,
			backingTableName: mv.backingTableName,
			chosenStrategy,
			sourceStats,
			backingPkDefinition,
			projectors,
			predicate,
		};
	}

	/**
	 * Assemble {@link MaintenanceSourceStats} for the cost gate from the optimizer's
	 * StatsProvider and tuning. `tableRows` / `distinctGroupsEstimate` come from the
	 * provider (heuristic defaults when absent); `forwardBodyCost` is estimated from the
	 * forward cost helpers (a scan + optional filter + projection of the source — the
	 * covering-index body shape); `fallbackRatio` carries the detection kernel's
	 * `deltaPerRowFallbackRatio` for the no-stats residual path.
	 */
	private estimateMaintenanceStats(
		sourceSchema: TableSchema,
		projectionCount: number,
		hasPredicate: boolean,
	): MaintenanceSourceStats {
		const optimizer = this.ctx.optimizer;
		const statsProvider = optimizer.getStats();
		const tableRows = statsProvider.tableRows(sourceSchema) ?? DEFAULT_SOURCE_ROWS;
		const forwardBodyCost =
			seqScanCost(tableRows)
			+ (hasPredicate ? filterCost(tableRows) : 0)
			+ projectCost(tableRows, projectionCount);
		const stats: MaintenanceSourceStats = {
			tableRows,
			forwardBodyCost,
			fallbackRatio: optimizer.tuning.deltaPerRowFallbackRatio,
		};
		// `distinctValues` is an optional, per-column StatsProvider method. For the
		// covering-index shape the source PK is the grouping key; a single-column PK
		// yields a usable distinct-groups estimate (which only feeds the never-chosen-here
		// residual cost). Multi-column PKs leave it unset → residual takes the no-stats path.
		const pkDef = sourceSchema.primaryKeyDefinition;
		if (pkDef.length === 1 && statsProvider.distinctValues) {
			const pkColName = sourceSchema.columns[pkDef[0].index]?.name;
			if (pkColName !== undefined) {
				const distinct = statsProvider.distinctValues(sourceSchema, pkColName);
				if (distinct !== undefined) stats.distinctGroupsEstimate = distinct;
			}
		}
		return stats;
	}

	/* ──────────────── row-time covering enforcement ──────────────── */

	/**
	 * Resolve the linked, enforcement-ready covering MV for a UNIQUE constraint on
	 * `schema.table`, or `undefined`. The constraint's `coveringStructureName`
	 * forward pointer (set by the eager prove-and-link) is the source of truth;
	 * this confirms a live row-time plan exists for the source and the MV is not
	 * `stale` (structural breakage) — only then is its backing table row-time
	 * consistent enough to answer conflict resolution. O(1) negative fast path off
	 * {@link rowTimeBySource} so a source table with no row-time covering MV pays a
	 * single map lookup and stays on the synchronous index/scan path.
	 */
	findRowTimeCoveringStructure(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): MaterializedViewSchema | undefined {
		const sourceBase = `${schemaName}.${tableName}`.toLowerCase();
		const keys = this.rowTimeBySource.get(sourceBase);
		if (!keys || keys.size === 0) return undefined; // O(1) negative fast path
		const mvName = this.resolveCoveringStructureName(schemaName, tableName, uc);
		if (!mvName) return undefined;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			const mv = plan.mv;
			if (mv.name !== mvName) continue; // must be THE linked covering MV
			if (mv.stale) return undefined; // not row-time consistent
			return mv;
		}
		return undefined;
	}

	/**
	 * Resolve a constraint's `coveringStructureName` forward pointer. Prefers the
	 * pointer already on the passed `uc` (the memory source shares the
	 * schema-manager's frozen constraint, so the eager link's mutation is visible).
	 * A store source holds a *copied* schema whose constraint never received the
	 * mutation, so fall back to the authoritative schema-manager constraint matched
	 * by column set — keeping the covering-structure lookup module-agnostic.
	 */
	private resolveCoveringStructureName(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): string | undefined {
		if (uc.coveringStructureName) return uc.coveringStructureName;
		const table = this.ctx._findTable(tableName, schemaName);
		const live = table?.uniqueConstraints?.find(c =>
			c.columns.length === uc.columns.length
			&& c.columns.every((col, i) => col === uc.columns[i]));
		return live?.coveringStructureName;
	}

	/**
	 * Point-look up the covering MV's backing table for rows whose backing columns
	 * equal `newRow`'s UNIQUE-constraint values, recover each conflicting **source**
	 * PK from the projected PK columns, and exclude the row being written
	 * (`newSourcePk`). Returns the conflicting source PK(s) — the caller resolves
	 * IGNORE/ABORT/REPLACE against its own source storage (recovering the live
	 * source row and validating the candidate against it, since the backing entry
	 * for an internally-deleted/updated source row can lag within a statement).
	 *
	 * Reads-own-writes: the scan resolves to the backing table's coordinated
	 * connection (the same one {@link maintainRowTime} writes), so the backing
	 * reflects all prior rows of the statement. v1 is a full layer scan of the
	 * backing (always the `memory` module regardless of the source module); a
	 * backing-PK prefix scan is a sound later optimization (see
	 * `docs/materialized-views.md` § Covering structures).
	 */
	async lookupCoveringConflicts(
		mv: MaterializedViewSchema,
		uc: UniqueConstraintSchema,
		newRow: Row,
		newSourcePk: readonly SqlValue[],
	): Promise<Array<{ pk: SqlValue[]; row?: Row }>> {
		const plan = this.rowTime.get(mvKey(mv.schemaName, mv.name));
		if (!plan) return [];
		// Covering-conflict resolution reads the inverse projection (source↔backing
		// column map). Only the `'inverse-projection'` arm carries it; the other arms
		// are unreachable today (see {@link MaintenancePlan}) — defensively skip.
		if (plan.kind !== 'inverse-projection') return [];

		const [srcSchemaName, srcTableName] = plan.sourceBase.split('.');
		const sourceSchema = this.ctx._findTable(srcTableName, srcSchemaName);
		if (!sourceSchema) return [];

		// Inverse projection: source column index → backing column index (first
		// occurrence). Only the passthrough projectors carry a source-column identity
		// (a computed `'expr'` column has no inverse), and the eligibility gate forces
		// every PK / UNIQUE-covered column to be passthrough, so conflict resolution is
		// unaffected by any extra computed columns the body also projects.
		const sourceColToBacking = new Map<number, number>();
		plan.projectors.forEach((p, backingCol) => {
			if (p.kind === 'passthrough' && !sourceColToBacking.has(p.sourceCol)) {
				sourceColToBacking.set(p.sourceCol, backingCol);
			}
		});

		const ucBackingCols: number[] = [];
		for (const c of uc.columns) {
			const b = sourceColToBacking.get(c);
			if (b === undefined) return []; // the prover guarantees this; defensive
			ucBackingCols.push(b);
		}
		const pkDef = sourceSchema.primaryKeyDefinition;
		const pkBackingCols: number[] = [];
		for (const d of pkDef) {
			const b = sourceColToBacking.get(d.index);
			if (b === undefined) return [];
			pkBackingCols.push(b);
		}

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) return [];
		const manager = getBackingManager(backing);
		const connection = await this.getBackingConnection(manager, `${plan.backingSchema}.${plan.backingTableName}`);
		const startLayer = connection.pendingTransactionLayer ?? connection.readLayer;

		const conflicts: Array<{ pk: SqlValue[]; row?: Row }> = [];
		const scanPlan: ScanPlan = { indexName: 'primary', descending: false };
		for await (const backingRow of manager.scanLayer(startLayer, scanPlan)) {
			let match = true;
			for (let k = 0; k < uc.columns.length; k++) {
				const coll = sourceSchema.columns[uc.columns[k]]?.collation;
				if (compareSqlValues(newRow[uc.columns[k]], backingRow[ucBackingCols[k]], coll) !== 0) {
					match = false;
					break;
				}
			}
			if (!match) continue;

			const sourcePk = pkBackingCols.map(b => backingRow[b]);
			// Exclude the row currently being written (its own source PK).
			let isSelf = sourcePk.length === newSourcePk.length;
			for (let i = 0; isSelf && i < sourcePk.length; i++) {
				if (compareSqlValues(sourcePk[i], newSourcePk[i], pkDef[i]?.collation) !== 0) isSelf = false;
			}
			if (isSelf) continue;

			conflicts.push({ pk: sourcePk });
		}
		return conflicts;
	}
}

/* ─────────────────────────── helpers ─────────────────────────── */

function mvKey(schemaName: string, name: string): string {
	return `${schemaName}.${name}`.toLowerCase();
}

/** Aggregate node types (logical + physical) — the analyzed plan may carry any. */
const AGGREGATE_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Aggregate,
	PlanNodeType.StreamAggregate,
	PlanNodeType.HashAggregate,
]);

/** Structural view of an aggregate node shared by the logical/physical variants. */
interface AggregateLike {
	readonly groupBy: readonly ScalarPlanNode[];
	readonly aggregates: readonly { readonly expression: ScalarPlanNode }[];
}

/** Find the first aggregate node anywhere in the plan. */
function findAggregate(node: PlanNode): AggregateLike | undefined {
	if (AGGREGATE_NODE_TYPES.has(node.nodeType)) return node as unknown as AggregateLike;
	for (const child of node.getChildren()) {
		const found = findAggregate(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/**
 * Join-bearing PlanNodeTypes (logical + physical). `optimizeForAnalysis` stops
 * before physical join selection, so the analyzed plan carries the logical
 * {@link PlanNodeType.Join}; the physical variants are included so the
 * eligibility gate stays correct if analysis ever surfaces them.
 */
const JOIN_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Join,
	PlanNodeType.NestedLoopJoin,
	PlanNodeType.HashJoin,
	PlanNodeType.MergeJoin,
	PlanNodeType.FanOutLookupJoin,
	PlanNodeType.AsofScan,
]);

/** True if any node in the plan has the given type (recursive `getChildren` walk). */
function containsNodeType(node: PlanNode, type: PlanNodeType): boolean {
	if (node.nodeType === type) return true;
	for (const child of node.getChildren()) {
		if (containsNodeType(child as unknown as PlanNode, type)) return true;
	}
	return false;
}

/** True if the plan carries any join node (logical or physical). Used by the
 *  row-time gate, which is single-source — any join is ineligible. */
function containsAnyJoin(node: PlanNode): boolean {
	for (const t of JOIN_NODE_TYPES) {
		if (containsNodeType(node, t)) return true;
	}
	return false;
}

/** Collect `relationKey → TableReferenceNode` over a plan. */
function collectTableRefs(node: PlanNode, out = new Map<string, TableReferenceNode>()): Map<string, TableReferenceNode> {
	if (node instanceof TableReferenceNode) {
		const base = `${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase();
		out.set(`${base}#${node.id ?? 'unknown'}`, node);
	}
	for (const child of node.getChildren()) collectTableRefs(child as unknown as PlanNode, out);
	return out;
}

/** Minimal duck-type for nodes (aggregates) that expose attribute provenance. */
interface HasProducingExprs { getProducingExprs(): Map<number, ScalarPlanNode>; }

/**
 * Merge attribute provenance (output attr id → producing scalar expr) from every
 * node that exposes it. Physical aggregates expose `getProducingExprs()`; the
 * logical {@link AggregateNode} present in the pre-physical analyzed plan does
 * not, so its group-by → output-attr mapping is reconstructed directly here.
 */
function collectProducingExprs(node: PlanNode, out = new Map<number, ScalarPlanNode>()): Map<number, ScalarPlanNode> {
	const fn = (node as Partial<HasProducingExprs>).getProducingExprs;
	if (typeof fn === 'function') {
		for (const [attrId, expr] of fn.call(node)) {
			if (!out.has(attrId)) out.set(attrId, expr);
		}
	} else if (node instanceof AggregateNode) {
		const attrs = node.getAttributes();
		node.groupBy.forEach((expr, i) => {
			const attr = attrs[i];
			if (attr && !out.has(attr.id)) out.set(attr.id, expr);
		});
		node.aggregates.forEach((agg, i) => {
			const attr = attrs[node.groupBy.length + i];
			if (attr && !out.has(attr.id)) out.set(attr.id, agg.expression);
		});
	}
	for (const child of node.getChildren()) collectProducingExprs(child as unknown as PlanNode, out);
	return out;
}

/** Resolve an output attribute id back to a source column index, via provenance. */
function resolveSourceCol(
	outAttrId: number,
	sourceAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): number | undefined {
	const direct = sourceAttrToCol.get(outAttrId);
	if (direct !== undefined) return direct;
	const expr = producingByAttrId.get(outAttrId);
	if (expr instanceof ColumnReferenceNode) {
		return sourceAttrToCol.get(expr.attributeId);
	}
	return undefined;
}

/** Read the output attributes of a block's final relational statement. */
function relationalAttributes(block: BlockNode): ReturnType<TableReferenceNode['getAttributes']> | undefined {
	const children = block.getChildren();
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i] as unknown as { getAttributes?: () => ReturnType<TableReferenceNode['getAttributes']> };
		if (typeof child.getAttributes === 'function') return child.getAttributes();
	}
	return undefined;
}

/**
 * Reject a computed projection expression that cannot be evaluated as a pure function
 * of the changed source row: a subquery / relational subtree (cross-row), or a column
 * reference that does not resolve to a source column (a correlated / outer reference).
 * This is the "shape" gate distinct from the determinism gate — a determinism failure
 * is caught earlier by `checkDeterministic`.
 */
function assertSingleRowEvaluable(
	expr: ScalarPlanNode,
	sourceDescriptor: RowDescriptor,
	colName: string,
	reject: (detail: string) => never,
): void {
	const visit = (node: PlanNode): void => {
		if (node !== expr && isRelationalNode(node)) {
			reject(`it projects expression column '${colName}' containing a subquery `
				+ `(only single-row scalar expressions over the source are row-time maintainable)`);
		}
		if (node instanceof ColumnReferenceNode && sourceDescriptor[node.attributeId] === undefined) {
			reject(`it projects expression column '${colName}' referencing a value outside the source row`);
		}
		for (const child of node.getChildren()) visit(child as unknown as PlanNode);
	};
	visit(expr);
}

/**
 * Compile a deterministic scalar plan node into a per-source-row evaluator by reusing
 * the runtime: emit the node once, then run it against a row context that maps each
 * source attribute id to its column index in the changed row. Reusing the runtime
 * (rather than a hand-rolled scalar interpreter) guarantees a computed backing value is
 * byte-for-byte what `select <body>` would produce — the materialized-view ≡ view
 * contract. The gated forms (deterministic scalars over a single row, no subqueries —
 * see {@link assertSingleRowEvaluable}) resolve synchronously; a Promise result would
 * signal an unsupported async form and is surfaced loudly rather than silently awaited.
 */
function compileSourceRowEvaluator(
	db: Database,
	expr: ScalarPlanNode,
	sourceDescriptor: RowDescriptor,
): (row: Row) => SqlValue {
	const instruction = emitPlanNode(expr, new EmissionContext(db));
	const scheduler = new Scheduler(instruction);
	const context = new RowContextMap();
	let currentRow: Row = [];
	// Installed once; the getter reads the closed-over `currentRow`, refreshed per call.
	context.set(sourceDescriptor, () => currentRow);
	const rctx: RuntimeContext = {
		db,
		stmt: undefined,
		params: {},
		context,
		tableContexts: new Map(),
		enableMetrics: false,
	};
	return (row: Row): SqlValue => {
		currentRow = row;
		const result = scheduler.run(rctx);
		if (result instanceof Promise) {
			throw new QuereusError(
				'a row-time projection expression evaluated asynchronously (unexpected for a gated single-row scalar)',
				StatusCode.INTERNAL,
			);
		}
		return result as SqlValue;
	};
}
