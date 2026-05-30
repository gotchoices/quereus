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
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { isAsyncIterable } from '../runtime/utils.js';
import type { RuntimeContext } from '../runtime/types.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
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
import type { VirtualTableConnection } from '../vtab/connection.js';
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
	/** Backing-connection resolution for row-time write-through (see {@link MaterializedViewManager.getBackingConnection}). */
	getConnectionsForTable(tableName: string): VirtualTableConnection[];
	registerConnection(connection: VirtualTableConnection): Promise<void>;
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
 * The general-body residual-recompute arm: per source change, derive the affected
 * binding key(s) from the changed row, run a key-filtered residual of the body against
 * **live mid-transaction source state**, delete the old backing slice for that key, and
 * upsert the recomputed slice. Wired for the **single-source aggregate** shape
 * (`select g1,… , agg(…) from T [where P] group by g1,…` over bare group columns) by
 * `materialized-view-rowtime-residual-recompute`; the 1:1 row-preserving join shape
 * (`'row'` binding) reuses the same kernel in a follow-on ticket.
 *
 * The residual is the body with a key-equality filter injected on `T`'s
 * `TableReferenceNode` via {@link injectKeyFilter} (parameterized `gk0…` for a group
 * binding, `pk0…` for a row binding), compiled + cached once at registration and run
 * synchronously through the live transaction so the source read is reads-own-writes —
 * the synchronous analogue of `database-assertions.ts`'s residual path.
 *
 * It carries the {@link BindingMode} the spike names as the convergence point (built
 * directly from the body's shape — for an aggregate, the bare GROUP BY columns; NOT
 * via `extractBindings`, whose `'group'` classification additionally requires the group
 * key to cover a source unique key and so reports `'global'` for the common
 * `group by <non-key>` body). `degradeToRebuild` is the cost gate's full-rebuild escape
 * flag — dormant in v1 (the per-row recompute is correct without batching, and the
 * full-rebuild arm is unwired).
 */
export interface ResidualRecomputePlan extends MaintenancePlanCommon {
	readonly kind: 'residual-recompute';
	binding: BindingMode;
	degradeToRebuild: boolean;
	/** Cached scheduler for the key-filtered residual (the body with `injectKeyFilter`
	 *  applied on `T`). Re-run per affected key tuple, bound through the live transaction. */
	residualScheduler: Scheduler;
	/** Bind-parameter prefix the residual was compiled with: `'gk'` (group) / `'pk'` (row). */
	bindParamPrefix: 'gk' | 'pk';
	/** Source-column indices of the binding key (group columns / row key columns). The
	 *  affected key tuple is `bindColumns.map(c => changedRow[c])`, bound to `${prefix}{i}`. */
	bindColumns: number[];
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	/** Source column projected (passthrough) into each backing-PK column, in
	 *  `backingPkDefinition` order. The old backing slice's delete key for a changed row
	 *  `R` is `buildPrimaryKeyFromValues(backingPkSourceCols.map(sc => R[sc]), backingPkDefinition)`. */
	backingPkSourceCols: number[];
}

/**
 * Per-statement cache of resolved backing {@link MemoryTableConnection}s, keyed by the
 * lowercased backing `schema.table`. Created **once per DML generator run** (one
 * statement) and threaded through the maintenance path so the backing-connection
 * resolution — a scan over *all* the Database's active connections in
 * {@link MaterializedViewManager.getBackingConnection} — is paid once per
 * (statement, backing) instead of once per source row. This amortizes the dominant
 * per-row overhead of a bulk `insert`/`update`/`delete` over a covered table.
 *
 * It is purely a resolution cache: each row's ops are still applied **immediately** to
 * the cached connection's pending transaction layer (per-row apply), so a later
 * same-statement row's enforcement scan (`lookupCoveringConflicts`) still observes every
 * earlier row's backing write. There is no deferred/end-of-statement op flush — see
 * `docs/materialized-views.md` § Synchronous, transactional, per-statement. Because the
 * cache is scoped to one generator run, the connection it holds cannot be torn down
 * mid-statement; the cold enforcement/eviction paths that omit the cache re-resolve the
 * *same* connection deterministically, so reads-own-writes is unaffected.
 */
export type BackingConnectionCache = Map<string, MemoryTableConnection>;

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
	 *
	 * `cache` is the optional per-statement {@link BackingConnectionCache}: when the
	 * DML boundary supplies one, every backing (this plan's and each cascade level's)
	 * resolves its connection at most once for the whole statement. The cascade threads
	 * the same cache through, so a multi-level chain amortizes each level's resolution
	 * too. Omitted by the cold enforcement/eviction callers, which re-resolve the same
	 * connection deterministically.
	 */
	async maintainRowTime(
		sourceBase: string,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
		depth = 0,
	): Promise<void> {
		const keys = this.rowTimeBySource.get(sourceBase.toLowerCase());
		if (!keys || keys.size === 0) return;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			const backingChanges = await this.applyMaintenancePlan(plan, change, cache);
			if (backingChanges.length === 0) continue;
			const backingBase = `${plan.backingSchema}.${plan.backingTableName}`.toLowerCase();
			if (!this.rowTimeBySource.has(backingBase)) continue; // leaf — no dependents
			this.assertCascadeDepth(depth + 1, backingBase);
			for (const bc of backingChanges) {
				await this.maintainRowTime(backingBase, bc, cache, depth + 1);
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
	 * layer realized (so the cascade can drive this plan's own dependents). The builder
	 * yields `'inverse-projection'` (covering-index shape) and `'residual-recompute'`
	 * (single-source aggregate); the `'full-rebuild'` arm is still a loud `INTERNAL`
	 * guard (unreachable until its selection is wired — see {@link MaintenancePlan}).
	 */
	private async applyMaintenancePlan(
		plan: MaintenancePlan,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		switch (plan.kind) {
			case 'inverse-projection':
				return this.applyInverseProjection(plan, change, cache);
			case 'residual-recompute':
				return this.applyResidualRecompute(plan, change, cache);
			case 'full-rebuild':
				throw new QuereusError(
					`materialized view '${plan.mv.name}': '${plan.kind}' maintenance is not yet wired `
						+ `(reachable only once the cost-gate full-rebuild selection lands)`,
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
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		const inScope = (row: Row): boolean => plan.predicate === undefined || plan.predicate.evaluate(row) === true;
		const project = (row: Row): Row =>
			plan.projectors.map(p => p.kind === 'passthrough' ? row[p.sourceCol] : p.eval(row));
		const keyOf = (backingRow: Row): BTreeKeyForPrimary =>
			buildPrimaryKeyFromValues(plan.backingPkDefinition.map(d => backingRow[d.index]), plan.backingPkDefinition);

		const ops: MaintenanceOp[] = [];
		if (change.op === 'insert') {
			if (inScope(change.newRow)) ops.push({ kind: 'upsert', row: project(change.newRow) });
		} else if (change.op === 'delete') {
			if (inScope(change.oldRow)) ops.push({ kind: 'delete-key', key: keyOf(project(change.oldRow)) });
		} else {
			// UPDATE: delete the old image if it was in scope, upsert the new image if
			// it is — covers predicate-scope transitions and key-changing updates.
			if (inScope(change.oldRow)) ops.push({ kind: 'delete-key', key: keyOf(project(change.oldRow)) });
			if (inScope(change.newRow)) ops.push({ kind: 'upsert', row: project(change.newRow) });
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
		const connection = await this.getBackingConnection(manager, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return manager.applyMaintenanceToLayer(connection, ops);
	}

	/**
	 * Obtain (lazily create + register) the backing table's
	 * {@link MemoryTableConnection} for the current transaction. Reuses the same
	 * connection a `select` from the MV resolves to (so reads-own-writes holds);
	 * a freshly created connection is registered with the Database so the
	 * coordinated commit/rollback covers its pending layer in lockstep with the
	 * source write.
	 *
	 * When an optional per-statement {@link BackingConnectionCache} is supplied, the
	 * scan over the Database's active connections (the dominant per-row cost on a bulk
	 * write) is paid once per (statement, backing): a hit returns the cached connection
	 * directly, and a miss caches whichever connection the scan resolves — or the one it
	 * lazily creates + registers. Caching the resolved/created connection is sound
	 * because the scan is deterministic within a statement (nothing interleaves between
	 * a statement's rows to change which connection a `select` from the MV picks), so the
	 * cache holds exactly what an uncached re-resolution would return.
	 */
	private async getBackingConnection(
		manager: MemoryTableManager,
		qualifiedName: string,
		cache?: BackingConnectionCache,
	): Promise<MemoryTableConnection> {
		const cacheKey = qualifiedName.toLowerCase();
		const cached = cache?.get(cacheKey);
		if (cached) return cached;
		for (const c of this.ctx.getConnectionsForTable(qualifiedName)) {
			if (c instanceof MemoryVirtualTableConnection) {
				const mc = c.getMemoryConnection();
				if (mc.tableManager === manager) {
					cache?.set(cacheKey, mc);
					return mc;
				}
			}
		}
		const memConn = manager.connect();
		const vtabConn = new MemoryVirtualTableConnection(qualifiedName, memConn);
		await this.ctx.registerConnection(vtabConn);
		cache?.set(cacheKey, memConn);
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

		// Structural rejections that hold for *every* maintenance shape. A window
		// function reads across the partition, set ops / recursive CTEs / TVFs / row caps
		// are out of the row-time model entirely. Joins are single-source-incompatible
		// for the covering-index and aggregate arms; the 1:1 join arm (a follow-on ticket)
		// lifts this one. Keep these exactly as they were.
		if (containsNodeType(analyzed, PlanNodeType.Window)) reject('its body uses a window function');
		if (containsAnyJoin(analyzed)) reject('its body contains a join');
		if (containsNodeType(analyzed, PlanNodeType.Distinct)) reject('its body uses DISTINCT');
		if (containsNodeType(analyzed, PlanNodeType.SetOperation)) reject('its body uses a set operation (union/intersect/except)');
		if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) reject('its body uses a recursive CTE');
		if (containsNodeType(analyzed, PlanNodeType.TableFunctionCall)) reject('its body calls a table-valued function');
		if (mv.selectAst.type === 'select' && (mv.selectAst.limit !== undefined || mv.selectAst.offset !== undefined)) {
			reject('its body uses LIMIT/OFFSET');
		}

		// Single-source aggregate (`group by` over bare columns) → residual-recompute arm.
		// Each changed source row belongs to exactly one group; maintaining the MV means
		// recomputing that group's backing row from live state (delete old slice → run the
		// group-keyed residual → upsert). A scalar aggregate (no GROUP BY) is rejected in
		// v1 by `buildAggregateResidualPlan`. This replaces the former blanket aggregate
		// rejection.
		const aggregate = findAggregate(analyzed);
		if (aggregate) {
			return this.buildAggregateResidualPlan(mv, analyzed, tableRef, sourceBase, aggregate, reject);
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
	 * Build a `'residual-recompute'` plan for a single-source aggregate body
	 * (`select g1,…, agg(…) from T [where P] group by g1,…` over **bare** group columns),
	 * or throw via `reject` with a shape diagnostic. Each changed source row belongs to
	 * exactly one group `(g1,…)`; maintaining the MV means recomputing that group's
	 * backing row from live state — delete the old slice, run the group-keyed residual,
	 * upsert the recomputed slice (zero rows when the group emptied). See
	 * {@link ResidualRecomputePlan} and `docs/incremental-maintenance.md` § residual-recompute.
	 *
	 * NOTE: the group binding is derived **directly** from the aggregate node's bare GROUP
	 * BY columns, not via `extractBindings`. `analyzeRowSpecific`'s `'group'` classification
	 * additionally requires the group key to cover a *source* unique key (so it reports
	 * `'global'` for the common `group by <non-key>` body), which is the wrong test here —
	 * the backing is keyed by the group key regardless of whether it is a source key.
	 */
	private buildAggregateResidualPlan(
		mv: MaterializedViewSchema,
		analyzed: BlockNode,
		tableRef: TableReferenceNode,
		sourceBase: string,
		aggregate: AggregateLike,
		reject: (detail: string) => never,
	): MaintenancePlan {
		// Require an explicit GROUP BY. A scalar aggregate (no GROUP BY) is one global
		// row keyed by the empty key — deferred in v1 (the residual + harness do not yet
		// cover the empty-key shape cleanly).
		if (aggregate.groupBy.length === 0) {
			reject('its body is a scalar aggregate with no GROUP BY (a single global row is not row-time maintainable in v1)');
		}

		// Map T's output attributes to source column indices. T is a bare
		// `TableReferenceNode`, so output-column index == source-column index.
		const sourceAttrToCol = new Map<number, number>();
		tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
		const producingByAttrId = collectProducingExprs(analyzed);

		// Transitive provenance: chase output-attr → producing ColumnReference chains
		// (Project-over-Aggregate adds a hop the single-hop `resolveSourceCol` cannot
		// follow) until landing on a T source column, or `undefined`.
		const resolveToSourceCol = (attrId: number): number | undefined => {
			const seen = new Set<number>();
			let cur: number | undefined = attrId;
			while (cur !== undefined && !seen.has(cur)) {
				seen.add(cur);
				const direct = sourceAttrToCol.get(cur);
				if (direct !== undefined) return direct;
				const expr = producingByAttrId.get(cur);
				if (expr instanceof ColumnReferenceNode) { cur = expr.attributeId; continue; }
				return undefined;
			}
			return undefined;
		};

		// Each GROUP BY expression must be a bare source column (a computed group key has
		// no source-column index to bind / key the backing on).
		const groupColumns: number[] = [];
		for (const expr of aggregate.groupBy) {
			if (!(expr instanceof ColumnReferenceNode)) {
				reject('its GROUP BY includes a computed expression (only bare source columns are row-time maintainable in v1)');
			}
			const sourceCol = sourceAttrToCol.get((expr as ColumnReferenceNode).attributeId);
			if (sourceCol === undefined) {
				reject('its GROUP BY references a value that is not a column of the single source');
			}
			groupColumns.push(sourceCol!);
		}

		// Determinism: a residual must reproduce exactly what `select <body>` returns, so a
		// volatile group/aggregate expression (random()/now()/volatile UDF) is rejected.
		for (const expr of aggregate.groupBy) {
			const det = checkDeterministic(expr);
			if (!det.valid) reject(`it groups by a non-deterministic expression (${det.expression})`);
		}
		for (const agg of aggregate.aggregates) {
			const det = checkDeterministic(agg.expression);
			if (!det.valid) reject(`it aggregates a non-deterministic expression (${det.expression})`);
		}

		// Backing table + its physical PK. The aggregate's group-key FD
		// (`propagateAggregateFds`) makes the group key the backing key (via `keysOf`).
		const backing = this.ctx._findTable(mv.backingTableName, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// Map each backing-PK column back to the source group column it projects, so a
		// changed row's old backing-slice delete key can be built. Every backing-PK column
		// MUST resolve to a GROUP BY source column — else the backing key is not the group
		// key and point-keyed delete+upsert would be unsound.
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) reject('its body produced no relational output');
		const groupColumnSet = new Set(groupColumns);
		const backingPkSourceCols: number[] = [];
		for (const d of backingPkDefinition) {
			const attr = rootAttrs![d.index];
			const sourceCol = attr ? resolveToSourceCol(attr.id) : undefined;
			if (sourceCol === undefined || !groupColumnSet.has(sourceCol)) {
				reject(`its backing primary key includes column '${backing.columns[d.index]?.name ?? d.index}', `
					+ `which is not a GROUP BY source column (the backing key must be the group key)`);
			}
			backingPkSourceCols.push(sourceCol!);
		}

		// Compile + cache the group-keyed residual once (the body with `g1 = :gk0 AND …`
		// injected on T). Re-run per affected group key against the live transaction.
		const relKey = `${sourceBase}#${tableRef.id ?? 'unknown'}`;
		const residualScheduler = this.compileResidual(analyzed, relKey, groupColumns, 'gk', reject);

		// ── Cost gate ──
		// The residual is the structurally-sound incremental arm for an aggregate body;
		// 'full-rebuild' is the always-correct floor for shapes where the residual is NOT
		// sound, so (as with inverse-projection) it is not a competitor here. We still
		// record the chosen strategy + cost inputs for parity with the substrate.
		const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
		const hasPredicate = mv.selectAst.type === 'select' && mv.selectAst.where !== undefined;
		const sourceStats = this.estimateMaintenanceStats(tableRef.tableSchema, backing.columns.length, hasPredicate);
		const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
		const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
		if (chosenStrategy !== 'residual-recompute') {
			throw new QuereusError(
				`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
				StatusCode.INTERNAL,
			);
		}

		return {
			kind: 'residual-recompute',
			mv,
			sourceBase,
			backingSchema: mv.schemaName,
			backingTableName: mv.backingTableName,
			chosenStrategy,
			sourceStats,
			binding: { kind: 'group', groupColumns: [...groupColumns] },
			degradeToRebuild: false,
			residualScheduler,
			bindParamPrefix: 'gk',
			bindColumns: groupColumns,
			backingPkDefinition,
			backingPkSourceCols,
		};
	}

	/**
	 * Compile the key-filtered residual for a binding into a reusable {@link Scheduler}:
	 * the analyzed body with a key-equality filter injected on `T`'s `TableReferenceNode`
	 * (parameterized `${paramPrefix}0…`), then optimized + emitted. Mirrors the assertion
	 * evaluator's residual compilation (`database-assertions.ts`) so the two cannot drift.
	 * Throws via `reject` if `injectKeyFilter` could not target `T`.
	 */
	private compileResidual(
		analyzed: BlockNode,
		relKey: string,
		bindColumns: readonly number[],
		paramPrefix: 'gk' | 'pk',
		reject: (detail: string) => never,
	): Scheduler {
		const db = this.ctx as unknown as Database;
		const rewritten = injectKeyFilter(analyzed, relKey, bindColumns, paramPrefix);
		if (rewritten === analyzed) {
			reject('its body could not be parameterized for residual maintenance (the source reference was not found)');
		}
		const optimized = this.ctx.optimizer.optimize(rewritten, db) as BlockNode;
		const instruction = emitPlanNode(optimized, new EmissionContext(db));
		return new Scheduler(instruction);
	}

	/**
	 * Execute the cached key-filtered residual for one affected key tuple, returning its
	 * result rows (0 or 1 for the aggregate shape). Bound through a fresh
	 * {@link RuntimeContext} on the live `db` so the residual's source scan reuses `T`'s
	 * transaction connection and reads this statement's pending writes (reads-own-writes)
	 * — the synchronous analogue of `database-assertions.ts:executeResidualPerTuple`.
	 */
	private async runResidual(plan: ResidualRecomputePlan, keyTuple: readonly SqlValue[]): Promise<Row[]> {
		const params: Record<string, SqlValue> = {};
		for (let i = 0; i < keyTuple.length; i++) {
			params[`${plan.bindParamPrefix}${i}`] = keyTuple[i];
		}
		const rctx: RuntimeContext = {
			db: this.ctx as unknown as Database,
			stmt: undefined,
			params,
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			enableMetrics: false,
		};
		const result = await plan.residualScheduler.run(rctx);
		const rows: Row[] = [];
		if (isAsyncIterable(result)) {
			for await (const r of result as AsyncIterable<Row>) rows.push(r);
		}
		return rows;
	}

	/**
	 * Compute a `'residual-recompute'` plan's per-row backing delta and apply it: derive
	 * the affected binding key(s) from the changed row (OLD ∪ NEW, deduped), and for each —
	 * delete the old backing slice for that key, re-run the key-filtered residual against
	 * live source state, and upsert the recomputed slice (0 or 1 rows). An emptied group
	 * (residual returns nothing) leaves only the delete, removing the stale backing row.
	 * Returns the effective {@link BackingRowChange}(s) the backing layer realized, for the
	 * MV-over-MV cascade.
	 *
	 * Per-row recompute is correct without per-statement batching: every change to a group
	 * triggers a full recompute of that group from live (reads-own-writes) state, so the
	 * last change to touch a group writes the authoritative backing row. Batching/dedup
	 * across a whole statement is an affordability optimization deferred with the
	 * statement-flush boundary (see the ticket handoff).
	 */
	private async applyResidualRecompute(
		plan: ResidualRecomputePlan,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		// Distinct affected keys (OLD ∪ NEW), deduped on the backing-key values: a
		// non-key-changing update recomputes the group once; a key-changing update
		// recomputes both the old and the new group.
		const affected = new Map<string, { keyTuple: SqlValue[]; keyVals: SqlValue[]; deleteKey: BTreeKeyForPrimary }>();
		const addFrom = (row: Row): void => {
			const keyVals = plan.backingPkSourceCols.map(sc => row[sc]);
			const dedupKey = canonKeyValues(keyVals);
			if (affected.has(dedupKey)) return;
			affected.set(dedupKey, {
				keyTuple: plan.bindColumns.map(c => row[c]),
				keyVals,
				deleteKey: buildPrimaryKeyFromValues(keyVals, plan.backingPkDefinition),
			});
		};
		if (change.op === 'insert') addFrom(change.newRow);
		else if (change.op === 'delete') addFrom(change.oldRow);
		else { addFrom(change.oldRow); addFrom(change.newRow); }

		const ops: MaintenanceOp[] = [];
		for (const { keyTuple, keyVals, deleteKey } of affected.values()) {
			ops.push({ kind: 'delete-key', key: deleteKey });
			const recomputed = await this.runResidual(plan, keyTuple);
			// Upsert only the recomputed rows whose backing key equals the affected key.
			// The residual for key K must only contribute K's slice; any other row is
			// spurious and is dropped. This is the soundness net for an emptied group: when
			// no source row matches the key, a *correct* grouped residual returns zero rows,
			// but a constant-pinned multi-column grouped aggregate is mis-collapsed by the
			// optimizer into a *scalar* aggregate that emits one all-NULL `count=0` row over
			// the empty input (a pre-existing optimizer bug, filed separately as
			// `fix/optimizer-constant-group-aggregate-empty-input-spurious-row`). That row's
			// key ≠ K, so it is filtered here and the delete-without-upsert correctly removes
			// the emptied group's backing row.
			for (const row of recomputed) {
				if (this.residualRowMatchesKey(plan, row, keyVals)) ops.push({ kind: 'upsert', row });
			}
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
		const connection = await this.getBackingConnection(manager, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return manager.applyMaintenanceToLayer(connection, ops);
	}

	/**
	 * True iff `row`'s backing primary-key columns equal `keyVals` (the affected binding
	 * key, in `backingPkDefinition` order), under each column's collation. Used to keep
	 * only the residual row(s) belonging to the recomputed key — see
	 * {@link applyResidualRecompute}.
	 */
	private residualRowMatchesKey(plan: ResidualRecomputePlan, row: Row, keyVals: readonly SqlValue[]): boolean {
		for (let i = 0; i < plan.backingPkDefinition.length; i++) {
			const d = plan.backingPkDefinition[i];
			if (compareSqlValues(row[d.index], keyVals[i], d.collation) !== 0) return false;
		}
		return true;
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
	 * reflects all prior rows of the statement. The backing is always the `memory`
	 * module regardless of the source module.
	 *
	 * The conflict check is a **backing-PK prefix scan** keyed on `newRow`'s UC
	 * values — O(log n + matches) rather than the former O(n) full backing scan.
	 * Soundness rests on the covering-index shape: the body's `order by` columns are
	 * a permutation of the UC columns ({@link buildMaintenancePlan} eligibility +
	 * the coverage prover), and they seed the leading backing-PK columns
	 * (`computeBackingPrimaryKey`), so the leading `k = uc.columns.length` backing-PK
	 * columns are exactly the UC columns. {@link tryBuildCoveringPrefix} builds the
	 * equality prefix in backing-PK column order; the scan seeks to it and
	 * early-terminates when the leading columns stop matching. It falls back to a
	 * full scan whenever the fast-path gate fails (non-BINARY collation, or a
	 * leading-prefix shape that does not lead with exactly the UC columns) — the
	 * full scan re-compares with the source collation, so the fallback is
	 * collation-correct. Either way the result is only a *candidate* set: the caller
	 * validates each against the live source row.
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
		// Fast path: a backing-PK prefix scan keyed on `newRow`'s UC values. The
		// covering-index shape guarantees the leading backing-PK columns are the UC
		// columns, so this seeks to the matching block and early-terminates instead of
		// scanning the whole backing. `undefined` ⇒ the gate failed (non-binary
		// collation / unexpected shape) and we fall back to the full layer scan, which
		// re-compares with the source collation and is therefore collation-correct.
		const equalityPrefix = this.tryBuildCoveringPrefix(plan, uc, sourceSchema, newRow);
		const scanPlan: ScanPlan = equalityPrefix
			? { indexName: 'primary', descending: false, equalityPrefix }
			: { indexName: 'primary', descending: false };
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

	/**
	 * Build the backing-PK equality prefix for a covering-conflict scan, or
	 * `undefined` to fall back to the full backing scan.
	 *
	 * The covering-index shape guarantees the body's `order by` columns are a
	 * permutation of the UC columns and that they seed the leading backing-PK columns
	 * (`computeBackingPrimaryKey`). So the leading `k = uc.columns.length` backing-PK
	 * columns are exactly the UC columns (as a set, possibly reordered by `order by`).
	 * The returned prefix is keyed in **backing-PK column order** (not `uc.columns`
	 * order), so a permuting `order by` still seeks to the right block:
	 * `prefix[i] = newRow[ sourceCol(backingPkDefinition[i]) ]`.
	 *
	 * Returns `undefined` (full-scan fallback) when any holds:
	 *  - fewer than `k` backing-PK columns, or a leading column is not a passthrough
	 *    of a source column (defensive — the covering shape guarantees passthrough);
	 *  - the leading `k` backing-PK columns do not map to **exactly** the UC
	 *    source-column set (defensive guard against a non-UC-leading structure);
	 *  - any leading backing-PK column, or its source UC column, has a **non-BINARY**
	 *    collation. This is a *soundness* gate, not a perf choice: the prefix seek's
	 *    early-termination compares with plain `compareSqlValues` (binary), while the
	 *    backing btree orders the PK by its declared collation and the UNIQUE
	 *    constraint conflicts by the source collation. Under a non-binary collation
	 *    the binary early-termination could `break` before a collated-equal /
	 *    binary-different conflict, missing it. The full-scan fallback re-compares
	 *    with the source collation, so it stays collation-correct.
	 *
	 * DESC-leading prefixes are admitted: equality on a column makes its order
	 * direction irrelevant to *grouping* (the binary-equal rows stay contiguous), and
	 * `scanLayer`'s `equalityPrefix` seek + ascending walk lands at the group start
	 * for either direction (verified by the `order by … desc` enforcement test).
	 */
	private tryBuildCoveringPrefix(
		plan: InverseProjectionPlan,
		uc: UniqueConstraintSchema,
		sourceSchema: TableSchema,
		newRow: Row,
	): SqlValue[] | undefined {
		const k = uc.columns.length;
		const backingPk = plan.backingPkDefinition;
		if (backingPk.length < k) return undefined;

		const ucSourceCols = new Set(uc.columns);
		const leadingSourceCols = new Set<number>();
		const prefix: SqlValue[] = [];
		for (let i = 0; i < k; i++) {
			const d = backingPk[i];
			const projector = plan.projectors[d.index];
			if (!projector || projector.kind !== 'passthrough') return undefined;
			// Soundness: both the backing-PK column (btree ordering / early-termination)
			// and its source UC column (UNIQUE semantics) must be BINARY for the binary
			// prefix-equality scan to neither over- nor under-match.
			if (!isBinaryCollation(d.collation)) return undefined;
			const sourceCol = projector.sourceCol;
			if (!isBinaryCollation(sourceSchema.columns[sourceCol]?.collation)) return undefined;
			leadingSourceCols.add(sourceCol);
			prefix.push(newRow[sourceCol]);
		}

		// The leading `k` backing-PK columns must be exactly the UC source columns.
		if (leadingSourceCols.size !== ucSourceCols.size) return undefined;
		for (const c of ucSourceCols) {
			if (!leadingSourceCols.has(c)) return undefined;
		}
		return prefix;
	}
}

/* ─────────────────────────── helpers ─────────────────────────── */

/** True for the default (binary) collation: an absent name or a case-insensitive
 *  `BINARY`. Non-binary collations gate off the prefix-scan fast path (see
 *  {@link MaterializedViewManager.tryBuildCoveringPrefix}). */
function isBinaryCollation(collation: string | undefined): boolean {
	return collation === undefined || collation.toUpperCase() === 'BINARY';
}

function mvKey(schemaName: string, name: string): string {
	return `${schemaName}.${name}`.toLowerCase();
}

/** Canonical, order-stable, bigint-safe string for a key tuple — used to dedup the
 *  distinct affected backing keys of a single change in the residual-recompute arm. */
function canonKeyValues(values: readonly SqlValue[]): string {
	return JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
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
