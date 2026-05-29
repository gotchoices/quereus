/**
 * Materialized-view maintenance: schema-change staleness tracking (phase 1),
 * incremental on-commit maintenance (phase 2), plus row-time write-through
 * maintenance (phase 3).
 *
 * Three responsibilities:
 *
 *  1. **Staleness** — a *schema* change to a source table (drop / alter) can break
 *     an MV's body. This manager subscribes to schema-change events and marks any
 *     MV whose body reads a modified/removed source `stale`. The next reference
 *     re-validates the body (erroring with the staleness diagnostic on an
 *     incompatible change); the next successful refresh clears the flag. Applies
 *     to every MV regardless of refresh policy.
 *
 *  2. **Incremental maintenance** (third consumer of `DeltaExecutor`, after
 *     assertions and watchers) — for an `on-commit-incremental` MV, a
 *     `DeltaSubscription` runs *after* commit (change log alive, connections
 *     committed) and **writes** the backing table: per affected binding it
 *     delete-then-upserts the recomputed slice; a `'global'` binding or the
 *     cost-fallback triggers a full rebuild. Failed maintenance logs-and-skips
 *     and never rolls the user's commit back (mirrors `database-watchers.ts`).
 *     This write path bypasses the user write-boundary via
 *     `MemoryTableManager.applyMaintenance` (delete/upsert) and `replaceBaseLayer`
 *     (rebuild) — both manager-level, off the user-transaction path.
 *
 *  3. **Row-time write-through** (`maintainRowTime`) — for a `row-time` MV (gated
 *     at create to the covering-index shape), the backing table is kept consistent
 *     *synchronously* with each source row-write, driven from the runtime DML
 *     boundary (not at COMMIT). Each source row maps to exactly one backing row,
 *     so maintenance is a pure projection of the changed row — delete the old
 *     image's backing key, upsert the new image's backing row; no body
 *     re-execution, no scan. Unlike (2) this writes the backing table's *pending*
 *     transaction layer through the same connection a `select` from the MV uses,
 *     so the change is visible mid-transaction (reads-own-writes) and is
 *     committed/rolled-back in lockstep with the source write by the coordinated
 *     commit — no `pendingDelta`-style overlay is needed.
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { Scheduler } from '../runtime/scheduler.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import type { RuntimeContext } from '../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { TableFunctionCallNode } from '../planner/nodes/table-function-call.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { isTableValuedFunctionSchema, resolveAdvertisement } from '../schema/function.js';
import type { BindingMode, PlanBindings } from '../planner/analysis/binding-extractor.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
import {
	DeltaExecutor,
	type DeltaApplyInput,
	type DeltaExecutorContext,
	type DeltaSubscription,
} from '../runtime/delta-executor.js';
import { rebuildBacking, getBackingManager } from '../runtime/emit/materialized-view-helpers.js';
import { buildPrimaryKeyFromValues } from '../vtab/memory/utils/primary-key.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import type { MaintenanceOp, MemoryTableManager } from '../vtab/memory/layer/manager.js';
import { MemoryVirtualTableConnection } from '../vtab/memory/connection.js';
import type { MemoryTableConnection } from '../vtab/memory/layer/connection.js';
import type { ScanPlan } from '../vtab/memory/layer/scan-plan.js';
import { compilePredicate, type CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import { compareSqlValues } from '../util/comparison.js';
import type { MaterializedViewSchema } from '../schema/view.js';
import type { UniqueConstraintSchema } from '../schema/table.js';
import type { Database } from './database.js';
import type * as AST from '../parser/ast.js';

const log = createLogger('core:materialized-views');
const warnLog = log.extend('warn');

/**
 * Database internals the materialized-view manager needs. Mirrors
 * `AssertionEvaluatorContext` / `WatcherManagerContext` — keeps the manager
 * decoupled from the full `Database`.
 */
export interface MaterializedViewManagerContext {
	readonly schemaManager: SchemaManager;
	readonly optimizer: Database['optimizer'];
	readonly options: Database['options'];

	_buildPlan(statements: AST.Statement[]): import('./database.js').BuildPlanResult;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	getInstructionTracer(): ReturnType<Database['getInstructionTracer']>;

	getChangedBaseTables(): Set<string>;
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void;
}

/** Pre-compiled residual artifacts for a single non-global binding of an MV body. */
interface ResidualArtifacts {
	scheduler: Scheduler;
	/** Source-table column indices, bound as `pk0..`/`gk0..` per the prefix. */
	bindColumns: number[];
	paramPrefix: 'pk' | 'gk';
	/**
	 * How to build the backing-table delete key from a binding tuple, or `null`
	 * when the binding does not map cleanly onto the (physical) MV-PK — such a
	 * relation's changes fall back to a full rebuild (always correct) unless a
	 * {@link prefixDelete} descriptor is present.
	 *
	 * `bindingTupleOrder[j]` = the binding-tuple index supplying physical-PK
	 * column `j`'s value.
	 */
	deleteKeyOrder: number[] | null;
	/**
	 * For a lateral-TVF fan-out body (a base row maps to MANY backing rows), how
	 * to bound the delete by the changed base row's PK *prefix* instead of one
	 * exact key. `null` when the shape is not a gated fan-out (the
	 * `deleteKeyOrder`/rebuild path applies). When set, `apply()` emits a
	 * `delete-by-prefix` op built from the binding tuple's base-PK values.
	 */
	prefixDelete: PrefixDeleteDescriptor | null;
}

/**
 * Bounded-delete descriptor for a lateral-TVF fan-out body. The backing physical
 * PK decomposes into a leading run of base-PK columns (the {@link prefixLength}
 * prefix) followed by TVF-supplied columns; deleting every backing row whose
 * leading prefix equals the changed base PK removes exactly that base row's
 * fan-out (base PK is unique, so no other base row shares the prefix).
 */
interface PrefixDeleteDescriptor {
	/** Binding-tuple index supplying each leading prefix column's value, in prefix order. */
	baseKeyOrder: number[];
	/** Number of leading backing-PK columns that form the base-PK prefix. */
	prefixLength: number;
}

/**
 * Maintenance phase a {@link MaterializedViewManager.maintenanceFaultInjector}
 * may simulate a failure at: while recomputing a binding's residual, just
 * before writing the maintenance ops, or during the full-rebuild recovery.
 */
export type MaintenanceFaultPhase = 'residual' | 'apply' | 'rebuild';

/** Cached per-MV incremental compilation. */
interface CompiledIncrementalMV {
	bindings: PlanBindings;
	baseTablesInPlan: Set<string>;
	pkIndicesByBase: Map<string, number[]>;
	residualsByRelation: Map<string, ResidualArtifacts>;
	/** Backing-table physical primary-key definition (column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	/** This MV's backing table as a lowercased `schema.table` base key. A dependent
	 *  MV's body references resolve to this name, so it is the join point for the
	 *  MV-dependency graph (producer backing base → consumer) and the overlay key. */
	backingBase: string;
	/** The `DeltaSubscription.id` this entry registers — used to map the cached
	 *  topological rank onto the live subscription snapshot. */
	subscriptionId: string;
	captureDisposers: Array<() => void>;
	subscriptionDisposer: () => void;
}

/**
 * One captured change to a materialized view's backing table, recorded by the
 * per-binding apply path so a dependent MV processed later in the same
 * post-commit pass observes it as a delta (see {@link MaterializedViewManager}'s
 * overlay change source). Full rows are stored so the overlay can project any
 * requested columns directly — no capture-demand bookkeeping for backing tables.
 */
interface OverlayChange {
	op: 'insert' | 'update' | 'delete';
	oldRow?: Row;
	newRow?: Row;
}

/**
 * Compiled per-MV row-time (write-through) maintenance plan, derived once at
 * registration from the covering-index shape. Per source row-write, the backing
 * delta is a pure projection of the changed row: project the source row to a
 * backing row (a column permutation — passthrough columns only), key it by the
 * backing physical PK, and (if the partial predicate admits it) delete the old
 * image / upsert the new image. No body re-execution, no scan, no compiled
 * residual — see `docs/materialized-views.md` § Row-time refresh.
 */
interface RowTimeMaintenancePlan {
	/** The MV this plan maintains. */
	mv: MaterializedViewSchema;
	/** Lowercased `schema.table` of the single source `T`. */
	sourceBase: string;
	backingSchema: string;
	backingTableName: string;
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	/** `projectionSourceCols[j]` = the source column index supplying backing output
	 *  column `j`. A pure passthrough permutation (every backing column resolves to a
	 *  source column via attribute provenance — eligibility rejects expression columns). */
	projectionSourceCols: number[];
	/** Partial-WHERE predicate evaluated on a single source row; absent ⇒ every row
	 *  is in scope. A source row contributes a backing row only when this is
	 *  unambiguously TRUE (mirrors partial-UNIQUE / partial-index semantics). */
	predicate?: CompiledPredicate;
}

export class MaterializedViewManager {
	private unsubscribeSchemaChanges: (() => void) | null = null;
	private readonly executor: DeltaExecutor;
	/** Compiled incremental entries keyed by `schema.name` (lowercase). */
	private readonly incremental = new Map<string, CompiledIncrementalMV>();

	/** Compiled row-time plans keyed by MV `schema.name` (lowercase). */
	private readonly rowTime = new Map<string, RowTimeMaintenancePlan>();

	/** Source base (lowercased `schema.table`) → set of MV keys with a row-time plan
	 *  reading it. The per-row DML maintenance hook looks plans up by source base. */
	private readonly rowTimeBySource = new Map<string, Set<string>>();

	/**
	 * Per-pass delta overlay layered on top of the {@link TransactionManager}
	 * change log: backing base (lowercased `schema.table`) → captured changes by
	 * serialized PK. Populated by a producer MV's per-binding apply so its
	 * dependents, processed later in the same topologically-ordered pass, read
	 * its backing-table writes as deltas. Reset at the top of every
	 * {@link runPostCommit}.
	 */
	private readonly pendingDelta = new Map<string, Map<string, OverlayChange>>();

	/**
	 * Per-pass set of backing bases whose entire contents were rebuilt wholesale
	 * (global binding, cost-fallback, `deleteKeyOrder === null`, or recovery
	 * rebuild) — no per-row deltas were captured, so any dependent must rebuild in
	 * full. Surfaced to the kernel via `isGloballyChanged`. Reset per pass.
	 */
	private readonly globallyChangedBacking = new Set<string>();

	/**
	 * Cached topological rank per `DeltaSubscription.id` over the incremental MVs
	 * (Kahn over backing-base dependency edges). `null` ⇒ recompute on next use;
	 * invalidated whenever an incremental entry is registered or released.
	 */
	private topoRanks: Map<string, number> | null = null;

	/**
	 * Cached set of backing bases that *another* incremental MV's body reads (the
	 * producer side of a cascade edge). Only these need per-pass delta capture —
	 * a leaf MV with no dependent skips the before/after backing reads entirely,
	 * so a non-cascading MV pays zero capture overhead. `null` ⇒ recompute on next
	 * use; shares fate (same data, same invalidation) with {@link topoRanks}.
	 */
	private consumedBacking: Set<string> | null = null;

	/**
	 * @internal Test-only fault-injection seam. When set, it is invoked with the
	 * maintenance phase about to run; throwing simulates that phase failing. Used
	 * to exercise the two-tier recovery (Tier-1 full-rebuild self-heal, Tier-2
	 * `diverged`). Production never sets this; see
	 * `Database._setMaterializedViewMaintenanceFault`.
	 */
	maintenanceFaultInjector?: (phase: MaintenanceFaultPhase) => void;

	constructor(private readonly ctx: MaterializedViewManagerContext) {
		// Overlay-aware change source: the underlying TransactionManager change log
		// unioned with this pass's backing-table deltas (`pendingDelta`) and
		// wholesale-rebuilt backing bases (`globallyChangedBacking`). A backing base
		// in `pendingDelta` reads from the overlay; everything else (genuine user
		// tables) delegates to the change log. Backing-table names use the reserved
		// `_mv_` prefix and never collide with user-table names, so per-base
		// routing is unambiguous.
		const executorCtx: DeltaExecutorContext = {
			getChangedBaseTables: () => {
				const out = ctx.getChangedBaseTables();
				for (const base of this.pendingDelta.keys()) out.add(base);
				for (const base of this.globallyChangedBacking) out.add(base);
				return out;
			},
			getChangedTuples: (base, cols, pk) => this.overlayChangedTuples(base, cols, pk),
			isGloballyChanged: (base) => this.globallyChangedBacking.has(base),
			getRowCount: (base) => {
				const [schemaName, tableName] = base.split('.');
				const table = ctx._findTable(tableName, schemaName);
				return table?.estimatedRows;
			},
			deltaPerRowFallbackRatio: ctx.optimizer.tuning.deltaPerRowFallbackRatio,
		};
		this.executor = new DeltaExecutor(executorCtx);
		this.subscribeToSchemaChanges();
	}

	/**
	 * Change-tuple source for the overlay executor. A backing base present in the
	 * overlay projects the requested columns out of the captured old/new rows
	 * (mirroring the TransactionManager's insert→new, delete→old, update→old&new
	 * emission with the same de-duplication); any other base delegates to the
	 * genuine change log.
	 */
	private overlayChangedTuples(base: string, cols: readonly number[], pk: readonly number[]): SqlValue[][] {
		const overlay = this.pendingDelta.get(base);
		if (!overlay) return this.ctx.getChangedTuples(base, cols, pk);

		const out: SqlValue[][] = [];
		const seen = new Set<string>();
		const emit = (row: Row | undefined): void => {
			if (!row) return;
			const tuple = cols.map(c => row[c]);
			const key = serializeTuple(tuple);
			if (seen.has(key)) return;
			seen.add(key);
			out.push(tuple);
		};
		for (const change of overlay.values()) {
			if (change.op === 'insert') emit(change.newRow);
			else if (change.op === 'delete') emit(change.oldRow);
			else { emit(change.oldRow); emit(change.newRow); }
		}
		return out;
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
						// A source schema change invalidates any compiled residual / row-time
						// plan; detach both. The MV reads "stale" until refreshed or recreated,
						// which re-registers it.
						const mk = mvKey(mv.schemaName, mv.name);
						this.releaseEntry(mk);
						this.releaseRowTime(mk);
					}
				}
			} else if (event.type === 'materialized_view_removed') {
				const mk = mvKey(event.schemaName, event.objectName);
				this.releaseEntry(mk);
				this.releaseRowTime(mk);
			}
		});
	}

	/**
	 * Compile + register an MV for incremental (`on-commit-incremental`) or
	 * row-time write-through (`row-time`) maintenance. No-op for `manual`. Throws
	 * when the body is ineligible for the chosen policy — the create emitter rolls
	 * the MV back on throw.
	 */
	registerMaterializedView(mv: MaterializedViewSchema): void {
		const key = mvKey(mv.schemaName, mv.name);
		if (mv.refreshPolicy?.kind === 'on-commit-incremental') {
			// Cache the source-union change-scope so a `select` from this MV projects to
			// its sources in `analyzeChangeScope` (the backing table is never written
			// through the user change log — it is maintained at COMMIT). v1 is the
			// conservative union of a `full` watch per source table.
			mv.sourceScope = buildSourceUnionScope(mv.sourceTables);
			this.releaseEntry(key);
			const compiled = this.compile(mv);
			const subscription = this.buildSubscription(mv, compiled);
			compiled.subscriptionDisposer = this.executor.register(subscription);
			this.incremental.set(key, compiled);
			// A new incremental entry changes the MV-dependency graph (it may produce
			// or consume another MV's backing table) — recompute the cached graph lazily.
			this.topoRanks = null;
			this.consumedBacking = null;
			log('Registered incremental materialized view %s.%s', mv.schemaName, mv.name);
		} else if (mv.refreshPolicy?.kind === 'row-time') {
			// Same change-scope substitution as incremental: the backing table is
			// maintained off the user change log (here, synchronously at the DML
			// boundary), so a `Database.watch` on this MV must project to its sources
			// rather than the never-change-logged backing table.
			mv.sourceScope = buildSourceUnionScope(mv.sourceTables);
			this.releaseRowTime(key);
			const plan = this.buildRowTimePlan(mv); // throws on ineligible shape
			this.rowTime.set(key, plan);
			let set = this.rowTimeBySource.get(plan.sourceBase);
			if (!set) { set = new Set(); this.rowTimeBySource.set(plan.sourceBase, set); }
			set.add(key);
			log('Registered row-time materialized view %s.%s', mv.schemaName, mv.name);
		}
	}

	/** Detach an MV's incremental subscription / row-time plan + capture demand (DROP path). */
	unregisterMaterializedView(schemaName: string, name: string): void {
		const key = mvKey(schemaName, name);
		this.releaseEntry(key);
		this.releaseRowTime(key);
	}

	/**
	 * Fire incremental maintenance for every MV impacted by the current commit.
	 * Mirrors the watcher contract: invoked after all connections commit but
	 * before the change log clears; per-MV apply errors are logged and swallowed
	 * (a failing MV never rolls the user's commit back).
	 */
	async runPostCommit(): Promise<void> {
		if (this.incremental.size === 0) return;
		// Reset the per-pass delta overlay. Each producer MV's per-binding apply
		// repopulates it (and `globallyChangedBacking`) so its dependents converge
		// this same commit.
		this.pendingDelta.clear();
		this.globallyChangedBacking.clear();
		try {
			// Process MVs in dependency-topological order and rescan the change
			// source between subscriptions, so a producer's backing-table write is
			// visible to its consumers in this single pass (the MV-dependency graph
			// is a DAG, so one ordered pass converges the whole chain).
			const ranks = this.getTopoRanks();
			await this.executor.runAll({
				order: (subs) => [...subs].sort(
					(a, b) => (ranks.get(a.id) ?? Number.POSITIVE_INFINITY) - (ranks.get(b.id) ?? Number.POSITIVE_INFINITY),
				),
				rescanPerSubscription: true,
			});
		} catch (err) {
			// apply() swallows its own errors; this is defensive against a kernel throw.
			log('Post-commit materialized-view maintenance threw: %O', err);
		}
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const key of [...this.incremental.keys()]) {
			this.releaseEntry(key);
		}
		for (const key of [...this.rowTime.keys()]) {
			this.releaseRowTime(key);
		}
		this.executor.disposeAll();
	}

	private releaseEntry(key: string): void {
		const entry = this.incremental.get(key);
		if (!entry) return;
		this.incremental.delete(key);
		// Removing an incremental entry changes the MV-dependency graph.
		this.topoRanks = null;
		this.consumedBacking = null;
		try { entry.subscriptionDisposer(); } catch (err) { log('MV subscription disposer for %s threw: %O', key, err); }
		for (const d of entry.captureDisposers) {
			try { d(); } catch (err) { log('MV capture disposer for %s threw: %O', key, err); }
		}
		entry.captureDisposers.length = 0;
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

	/* ─────────────────────────── compilation ─────────────────────────── */

	private compile(mv: MaterializedViewSchema): CompiledIncrementalMV {
		const db = this.ctx as unknown as Database;
		const { plan } = this.ctx._buildPlan([mv.selectAst as AST.Statement]);
		const analyzed = this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;

		// Derive maintenance bindings directly. NOTE: we deliberately do NOT use
		// `extractBindings`' classification here — its 'row'/'group' is *equality-
		// pinned* (it reports a bare MV scan, and a group-by over non-key columns,
		// as 'global'), which is the right notion for assertions/watchers but not
		// for MV maintenance. MV maintenance binds on a source's identity:
		//   - an aggregate over bare source columns → 'group' on those columns;
		//   - otherwise a row-preserving body → 'row' on each source's primary key.
		// Row-preserving bodies may read one *or more* sources (inner/cross joins);
		// each source binds on its own PK and is gated independently downstream by
		// `computeDeleteKeyOrder` — a source whose PK does not cleanly cover the
		// backing physical PK falls back to a full rebuild (always correct, just not
		// incremental). Recursive-CTE and set-operation bodies have no bounded
		// per-binding residual, so they classify whole-MV 'global' (full rebuild on
		// any source change). The remaining row-collapsing shapes (outer/semi/anti
		// joins, aggregate-over-join, multi-source DISTINCT) are rejected and deferred.
		const tableRefByRelKey = collectTableRefs(analyzed);
		if (tableRefByRelKey.size === 0) {
			throw new QuereusError(
				`materialized view '${mv.name}': 'on-commit-incremental' refresh requires the body to read at `
					+ `least one source table; use 'manual' refresh`,
				StatusCode.UNSUPPORTED,
			);
		}

		const perRelation = new Map<string, BindingMode>();
		const relationToBase = new Map<string, string>();

		const agg = findAggregate(analyzed);
		// A recursive CTE computes a fixpoint: a single changed source row can ripple
		// through arbitrarily many iterations, so there is no bounded per-binding
		// residual that recomputes "the affected rows only". Classify the whole MV as
		// 'global' so any source mutation triggers a full rebuildBacking at COMMIT —
		// always correct, including shrinking-closure deletes (a from-scratch recompute
		// is always right). This must run BEFORE the aggregate / join branches: a
		// recursive body whose outer query aggregates or joins (e.g. `select count(*)
		// from closure`, or the `r ⋈ edges` join inside the recursive case) must not be
		// misrouted into the aggregate / non-inner-join rejections. True incremental
		// delta evaluation (semi-naïve insert + DRed delete) is deferred to
		// materialized-view-recursive-semi-naive-delta.
		if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) {
			for (const [relKey, ref] of tableRefByRelKey) {
				const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
				perRelation.set(relKey, { kind: 'global' });
				relationToBase.set(relKey, base);
			}
		} else if (containsNodeType(analyzed, PlanNodeType.SetOperation)) {
			// A set operation (union / intersect / except / union all) is bag-distinguishing
			// across its branches: whether a recomputed row belongs in the MV depends on the
			// *full* state of both branches, not just the changed tuples — so there is no
			// bounded per-binding residual (the same "no bounded residual" property the
			// recursive branch above has). Classify every source as 'global' so any source
			// mutation re-derives the entire body at COMMIT via rebuildBacking (the same
			// recompute manual `refresh` runs) — always correct, including rows that should
			// *vanish* because the other branch's multiplicity changed, but not algorithmically
			// incremental. This must run BEFORE the aggregate / join branches: a set-op body
			// whose branches aggregate or join must not be misrouted into those rejections.
			// True count-based delta evaluation (and the bag-additive `union all` per-binding
			// fast path) is deferred to materialized-view-incremental-set-ops-delta.
			for (const [relKey, ref] of tableRefByRelKey) {
				const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
				perRelation.set(relKey, { kind: 'global' });
				relationToBase.set(relKey, base);
			}
		} else if (agg) {
			// Aggregate maintenance binds on the group key of a single source. An
			// aggregate over a join would need OLD/NEW group recompute across the
			// join's fan-in, which v1 does not model — defer.
			if (tableRefByRelKey.size > 1) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh does not support `
						+ `aggregate-over-join bodies yet `
						+ `(filed: materialized-view-incremental-aggregate-join); use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			const [srcRelKey, srcRef] = [...tableRefByRelKey.entries()][0];
			const srcBase = `${srcRef.tableSchema.schemaName}.${srcRef.tableSchema.name}`.toLowerCase();
			relationToBase.set(srcRelKey, srcBase);
			const srcAttrToCol = new Map<number, number>();
			srcRef.getAttributes().forEach((a, i) => srcAttrToCol.set(a.id, i));

			if (agg.groupBy.length === 0) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh does not support `
						+ `whole-table aggregate (no GROUP BY) bodies; use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			const groupColumns: number[] = [];
			for (const expr of agg.groupBy) {
				const col = expr instanceof ColumnReferenceNode ? srcAttrToCol.get(expr.attributeId) : undefined;
				if (col === undefined) {
					throw new QuereusError(
						`materialized view '${mv.name}': 'on-commit-incremental' refresh requires GROUP BY over bare `
							+ `source columns; use 'manual' refresh`,
						StatusCode.UNSUPPORTED,
					);
				}
				groupColumns.push(col);
			}
			perRelation.set(srcRelKey, { kind: 'group', groupColumns });
		} else {
			// Row-preserving path — one or more inner/cross-joined sources. Reject
			// the row-collapsing shapes a per-binding delete-then-recompute cannot
			// maintain, then bind every source on its own primary key. (Set-op bodies
			// were already routed to 'global' above, so none reach here.)
			//
			// A multi-source DISTINCT collapses rows other sources also contribute, so
			// a per-binding delete can remove rows that should survive. Single-source
			// DISTINCT keeps its existing behavior untouched.
			if (tableRefByRelKey.size > 1 && containsNodeType(analyzed, PlanNodeType.Distinct)) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh does not support `
						+ `DISTINCT over a join yet; use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			// Outer/semi/anti joins null-extend or filter rows on the non-clean side,
			// complicating the recompute slice — defer. Inner/cross joins are
			// row-preserving and maintainable per the per-source gate below.
			if (tableRefByRelKey.size > 1 && hasNonInnerJoin(analyzed)) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh supports only inner/cross `
						+ `joins for multi-source bodies; outer/semi/anti joins are not maintainable yet `
						+ `(filed: materialized-view-incremental-outer-joins); use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			for (const [relKey, ref] of tableRefByRelKey) {
				const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
				const pkCols = ref.tableSchema.primaryKeyDefinition.map(d => d.index);
				if (pkCols.length === 0) {
					throw new QuereusError(
						`materialized view '${mv.name}': 'on-commit-incremental' refresh requires every source to `
							+ `have a primary key, but '${base}' has none; use 'manual' refresh`,
						StatusCode.UNSUPPORTED,
					);
				}
				perRelation.set(relKey, { kind: 'row', keyColumns: pkCols });
				relationToBase.set(relKey, base);
			}
		}
		const bindings: PlanBindings = { perRelation, relationToBase };

		const baseTablesInPlan = new Set<string>();
		const pkIndicesByBase = new Map<string, number[]>();
		for (const base of bindings.relationToBase.values()) {
			baseTablesInPlan.add(base);
			if (!pkIndicesByBase.has(base)) {
				const [schemaName, tableName] = base.split('.');
				const table = this.ctx._findTable(tableName, schemaName);
				if (table) pkIndicesByBase.set(base, table.primaryKeyDefinition.map(d => d.index));
			}
		}

		// Register projection capture for binding columns outside the PK (PK is
		// always captured implicitly). Mirrors the assertion path's recordExtras.
		const captureDisposers: Array<() => void> = [];
		const extraByBase = new Map<string, Set<number>>();
		const recordExtras = (base: string, cols: readonly number[]): void => {
			const pkSet = new Set<number>(pkIndicesByBase.get(base) ?? []);
			for (const c of cols) {
				if (pkSet.has(c)) continue;
				let set = extraByBase.get(base);
				if (!set) { set = new Set<number>(); extraByBase.set(base, set); }
				set.add(c);
			}
		};
		for (const [relKey, mode] of bindings.perRelation) {
			const base = bindings.relationToBase.get(relKey);
			if (!base) continue;
			if (mode.kind === 'row') recordExtras(base, mode.keyColumns);
			else if (mode.kind === 'group') recordExtras(base, mode.groupColumns);
		}
		for (const [base, extra] of extraByBase) {
			captureDisposers.push(this.ctx.registerCaptureSpec(base, { extraColumns: extra }));
		}

		// Backing-table physical PK (the column order the btree keys on).
		const backing = this.ctx._findTable(mv.backingTableName, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));
		const physicalPkOutCols = backingPkDefinition.map(d => d.index);

		// Pre-compile per-relation residuals + delete-key plans.
		const residualsByRelation = new Map<string, ResidualArtifacts>();
		const producingByAttrId = collectProducingExprs(analyzed);
		for (const [relKey, mode] of bindings.perRelation) {
			if (mode.kind === 'global') continue;
			const bindCols = mode.kind === 'row' ? mode.keyColumns : mode.groupColumns;
			const paramPrefix: 'pk' | 'gk' = mode.kind === 'row' ? 'pk' : 'gk';
			const rewritten = injectKeyFilter(analyzed, relKey, bindCols, paramPrefix);
			const optimizedPlan = this.ctx.optimizer.optimize(rewritten, db) as BlockNode;
			const instruction = emitPlanNode(optimizedPlan, new EmissionContext(db));
			const scheduler = new Scheduler(instruction);
			const deleteKeyOrder = computeDeleteKeyOrder(
				analyzed, tableRefByRelKey.get(relKey), producingByAttrId, bindCols, physicalPkOutCols,
			);

			// Lateral-TVF fan-out (v1: a single base source feeding one correlated
			// lateral TVF). A base-row change maps to MANY backing rows, which the
			// per-binding `deleteKeyOrder` (one exact PK) cannot delete — so it is
			// `null` here and the shape would otherwise full-rebuild every change.
			// When the backing PK leads with the base PK (prefix isolation) AND the
			// TVF's advertisement proves the recomputed fan-out is a set on the
			// backing PK (set-ness gate), bound the delete by the base-PK prefix
			// instead. If either fact is unprovable, leave `prefixDelete` null — the
			// rebuild fallback stands (always correct, just not incremental).
			let prefixDelete: PrefixDeleteDescriptor | null = null;
			const baseRef = tableRefByRelKey.get(relKey);
			if (mode.kind === 'row' && tableRefByRelKey.size === 1 && baseRef) {
				const lateralTvf = detectLateralTvf(analyzed, baseRef);
				if (lateralTvf) {
					const basePkCols = baseRef.tableSchema.primaryKeyDefinition.map(d => d.index);
					const descriptor = computePrefixDeleteOrder(
						analyzed, baseRef, producingByAttrId, bindCols, basePkCols, physicalPkOutCols, backingPkDefinition,
					);
					if (descriptor && tvfBackingPortionIsSuperkey(analyzed, lateralTvf, producingByAttrId, physicalPkOutCols)) {
						prefixDelete = descriptor;
					}
				}
			}

			residualsByRelation.set(relKey, { scheduler, bindColumns: [...bindCols], paramPrefix, deleteKeyOrder, prefixDelete });
		}

		return {
			bindings,
			baseTablesInPlan,
			pkIndicesByBase,
			residualsByRelation,
			backingPkDefinition,
			backingBase: mvKey(mv.schemaName, mv.backingTableName),
			subscriptionId: subscriptionIdFor(mv),
			captureDisposers,
			subscriptionDisposer: () => { /* replaced by register() */ },
		};
	}

	private buildSubscription(mv: MaterializedViewSchema, compiled: CompiledIncrementalMV): DeltaSubscription {
		const db = this.ctx as unknown as Database;
		const bindingsForExecutor = new Map<string, BindingMode>(compiled.bindings.perRelation);
		const relationToBase = new Map<string, string>(compiled.bindings.relationToBase);
		const pkIndicesByBase = new Map<string, readonly number[]>(compiled.pkIndicesByBase);

		const apply = async (input: DeltaApplyInput): Promise<void> => {
			try {
				// Diverged self-heal retry: a prior apply failed AND its full-rebuild
				// recovery also failed (Tier 2). The incremental delta only covers the
				// *new* change, not the old gap, so ignore it and re-attempt a full
				// re-materialization. Success clears the flag; a failure falls into the
				// catch and re-attempts once more.
				if (mv.diverged) {
					await this.recoveryRebuild(db, mv);
					mv.diverged = false;
					this.markBackingRebuilt(compiled);
					log('Materialized view %s.%s recovered from diverged state via full rebuild', mv.schemaName, mv.name);
					return;
				}

				// Any global relation (a 'global' binding — rejected at create — or a
				// cost-fallback demotion) makes a full rebuild the only correct option.
				if (input.globalRelations.size > 0) {
					await rebuildBacking(db, mv);
					this.markBackingRebuilt(compiled);
					return;
				}

				const ops: MaintenanceOp[] = [];
				for (const [relKey, tuples] of input.perRelationTuples) {
					const residual = compiled.residualsByRelation.get(relKey);
					if (!residual || (residual.deleteKeyOrder === null && !residual.prefixDelete)) {
						// No bounded per-binding delete (neither an exact MV-PK delete nor a
						// gated base-PK prefix delete) — rebuild (always correct).
						await rebuildBacking(db, mv);
						this.markBackingRebuilt(compiled);
						return;
					}
					for (const tuple of tuples) {
						if (residual.prefixDelete) {
							// Lateral-TVF fan-out: delete the changed base row's entire fan-out
							// by its base-PK prefix, then re-insert the recomputed fan-out.
							const prefix = residual.prefixDelete.baseKeyOrder.map(i => tuple[i]);
							ops.push({ kind: 'delete-by-prefix', prefix, prefixLength: residual.prefixDelete.prefixLength });
						} else {
							const key = this.buildDeleteKey(compiled, residual.deleteKeyOrder!, tuple);
							ops.push({ kind: 'delete-key', key });
						}
						const recomputed = await this.runResidual(residual, tuple);
						for (const row of recomputed) ops.push({ kind: 'upsert', row });
					}
				}

				if (ops.length === 0) return;
				const backing = this.ctx.schemaManager.getTable(mv.schemaName, mv.backingTableName);
				if (!backing) {
					throw new QuereusError(
						`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
						StatusCode.INTERNAL,
					);
				}
				// Write the backing table, then capture the resulting per-row deltas so a
				// dependent MV processed later in this pass observes them via the overlay.
				await this.applyMaintenanceAndCapture(mv, compiled, ops, getBackingManager(backing));
			} catch (err) {
				// Tier 1 — self-heal (the common case). The incremental apply failed;
				// the user's commit always stands (no rollback). The always-correct
				// full rebuild is a *different* code path (whole-body `collectBodyRows`,
				// not the per-binding `runResidual`/`applyMaintenance` that just failed),
				// so a residual-specific or transient failure is very often recovered
				// here with correct data and no user-visible effect.
				warnLog('Incremental maintenance for %s.%s failed; attempting full rebuild (commit stands): %O', mv.schemaName, mv.name, err);
				try {
					await this.recoveryRebuild(db, mv);
					this.markBackingRebuilt(compiled);
					if (mv.diverged) {
						mv.diverged = false;
						log('Materialized view %s.%s recovered via full rebuild', mv.schemaName, mv.name);
					}
				} catch (err2) {
					// Tier 2 — visible divergence (the worst case). Even the always-correct
					// rebuild failed: the backing table genuinely cannot be re-materialized.
					// Mark diverged so reads error unconditionally (a separate notion from
					// `stale`) until a successful refresh/rebuild, instead of silently
					// serving data that has drifted from the sources.
					mv.diverged = true;
					warnLog('Incremental maintenance for %s.%s could not self-heal; marked diverged (refresh required): %O', mv.schemaName, mv.name, err2);
				}
			}
		};

		return {
			id: subscriptionIdFor(mv),
			dependencies: compiled.baseTablesInPlan,
			bindings: bindingsForExecutor,
			relationToBase,
			pkIndicesByBase,
			apply,
			dispose: () => { /* resources released by releaseEntry */ },
		};
	}

	/** Build a backing-table delete key from a binding tuple, in physical-PK order. */
	private buildDeleteKey(
		compiled: CompiledIncrementalMV,
		deleteKeyOrder: number[],
		tuple: readonly SqlValue[],
	): BTreeKeyForPrimary {
		const keyValues: SqlValue[] = deleteKeyOrder.map(i => tuple[i]);
		return buildPrimaryKeyFromValues(keyValues, compiled.backingPkDefinition);
	}

	/**
	 * Full-rebuild recovery wrapper — the single seam the `'rebuild'` fault fires
	 * at. Shared by the Tier-1 apply-failure recovery and the diverged self-heal
	 * retry so both rebuild attempts behave identically under fault injection.
	 */
	private async recoveryRebuild(db: Database, mv: MaterializedViewSchema): Promise<void> {
		this.maintenanceFaultInjector?.('rebuild');
		await rebuildBacking(db, mv);
	}

	/** Run a residual scheduler for one binding tuple and collect its output rows. */
	private async runResidual(residual: ResidualArtifacts, tuple: readonly SqlValue[]): Promise<Row[]> {
		this.maintenanceFaultInjector?.('residual');
		const params: Record<string, SqlValue> = {};
		for (let i = 0; i < tuple.length; i++) {
			params[`${residual.paramPrefix}${i}`] = tuple[i];
		}
		const runtimeCtx: RuntimeContext = {
			db: this.ctx as unknown as Database,
			stmt: undefined,
			params,
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			tracer: this.ctx.getInstructionTracer(),
			enableMetrics: this.ctx.options.getBooleanOption('runtime_stats'),
		};
		const result = await residual.scheduler.run(runtimeCtx);
		const rows: Row[] = [];
		if (isAsyncIterable(result)) {
			for await (const row of result as AsyncIterable<Row>) rows.push(row);
		}
		return rows;
	}

	/**
	 * Write a per-binding maintenance batch to the backing table, then capture the
	 * resulting per-row deltas into the pass overlay so a dependent MV processed
	 * later in this same pass observes them. Reads each touched backing row just
	 * before and just after the (synchronous, latched) write to synthesize an
	 * insert/update/delete overlay change keyed by serialized PK. Full rows are
	 * stored so the overlay can project any column a dependent's binding requests.
	 */
	private async applyMaintenanceAndCapture(
		mv: MaterializedViewSchema,
		compiled: CompiledIncrementalMV,
		ops: MaintenanceOp[],
		manager: MemoryTableManager,
	): Promise<void> {
		// No dependent reads this backing table — nothing will consume an overlay
		// delta, so skip the before/after backing reads and just write. Keeps a
		// non-cascading (leaf) MV at zero capture overhead.
		if (!this.getConsumedBackingBases().has(compiled.backingBase)) {
			this.maintenanceFaultInjector?.('apply');
			await manager.applyMaintenance(ops);
			return;
		}

		// A `delete-by-prefix` op removes an unbounded set of backing PKs that the
		// per-row before/after overlay capture cannot enumerate from the op alone.
		// For a cascade producer, mark the backing globally changed so its
		// dependents re-evaluate in full this pass (always correct; a finer per-row
		// capture of the fan-out is a later optimization, see docs/incremental-maintenance.md).
		if (ops.some(op => op.kind === 'delete-by-prefix')) {
			this.maintenanceFaultInjector?.('apply');
			await manager.applyMaintenance(ops);
			this.markBackingRebuilt(compiled);
			return;
		}

		// De-duplicated set of touched backing PKs. Delete-key ops carry the key
		// directly; upsert ops derive it from the row's physical-PK columns via the
		// same `buildPrimaryKeyFromValues(..., backingPkDefinition)` `buildDeleteKey`
		// uses, so the two serialize identically and dedup cleanly.
		const touched = new Map<string, BTreeKeyForPrimary>();
		for (const op of ops) {
			let key: BTreeKeyForPrimary;
			if (op.kind === 'delete-key') {
				key = op.key;
			} else if (op.kind === 'upsert') {
				key = buildPrimaryKeyFromValues(compiled.backingPkDefinition.map(d => op.row[d.index]), compiled.backingPkDefinition);
			} else {
				// delete-by-prefix is handled before this point (cascade producers take
				// the markBackingRebuilt path); it never reaches the per-row capture.
				continue;
			}
			touched.set(pkToString(key), key);
		}

		// Snapshot the touched rows from the committed base BEFORE the write.
		const beforeRows = new Map<string, Row | null>();
		for (const [s, key] of touched) {
			beforeRows.set(s, manager.lookupEffectiveRow(key, manager.currentCommittedLayer));
		}

		this.maintenanceFaultInjector?.('apply');
		await manager.applyMaintenance(ops);

		// Read the touched rows AFTER the write and synthesize the overlay deltas.
		const overlay = this.overlayFor(compiled.backingBase);
		for (const [s, key] of touched) {
			const before = beforeRows.get(s) ?? null;
			const after = manager.lookupEffectiveRow(key, manager.currentCommittedLayer);
			const change = synthesizeOverlayChange(before, after);
			if (change) overlay.set(s, change);
			else overlay.delete(s);
		}
	}

	/** Record that a backing table was rebuilt wholesale this pass — dependents
	 *  must re-evaluate globally (no per-row deltas were captured). */
	private markBackingRebuilt(compiled: CompiledIncrementalMV): void {
		this.globallyChangedBacking.add(compiled.backingBase);
	}

	/** Get (creating if absent) the overlay map for a backing base. */
	private overlayFor(base: string): Map<string, OverlayChange> {
		let m = this.pendingDelta.get(base);
		if (!m) { m = new Map(); this.pendingDelta.set(base, m); }
		return m;
	}

	/**
	 * Topological rank per `DeltaSubscription.id` over the incremental MVs. Edges
	 * run producer-backing-base → consumer (a consumer whose body reads another
	 * MV's backing table). The MV-dependency graph is a DAG — an MV's body is fixed
	 * at create and any upstream MV must already exist — so Kahn's algorithm yields
	 * a total order in a single pass. A (structurally impossible) cycle degrades
	 * loudly: the unprocessed nodes are logged and appended in insertion order.
	 */
	private getTopoRanks(): Map<string, number> {
		if (this.topoRanks) return this.topoRanks;
		this.topoRanks = this.computeTopoRanks();
		return this.topoRanks;
	}

	/**
	 * Set of backing bases consumed by *another* incremental MV's body — the
	 * producer side of a cascade edge. A backing base outside this set has no
	 * dependent, so its producer skips per-pass delta capture. Cached; shares the
	 * topo-cache invalidation (recomputed lazily after register/unregister).
	 */
	private getConsumedBackingBases(): Set<string> {
		if (this.consumedBacking) return this.consumedBacking;
		const producers = new Set<string>();
		for (const c of this.incremental.values()) producers.add(c.backingBase);
		const consumed = new Set<string>();
		for (const c of this.incremental.values()) {
			for (const base of c.baseTablesInPlan) {
				if (base !== c.backingBase && producers.has(base)) consumed.add(base);
			}
		}
		this.consumedBacking = consumed;
		return consumed;
	}

	private computeTopoRanks(): Map<string, number> {
		const entries = [...this.incremental.entries()];
		// backing base → owning MV key (each backing table has exactly one MV).
		const producerByBacking = new Map<string, string>();
		for (const [key, c] of entries) producerByBacking.set(c.backingBase, key);

		const consumersOf = new Map<string, string[]>();
		const inDegree = new Map<string, number>();
		for (const [key] of entries) inDegree.set(key, 0);
		for (const [key, c] of entries) {
			for (const base of c.baseTablesInPlan) {
				const producer = producerByBacking.get(base);
				if (!producer || producer === key) continue;
				let list = consumersOf.get(producer);
				if (!list) { list = []; consumersOf.set(producer, list); }
				list.push(key);
				inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
			}
		}

		const ordered: string[] = [];
		const queue: string[] = [];
		for (const [key] of entries) if ((inDegree.get(key) ?? 0) === 0) queue.push(key);
		while (queue.length > 0) {
			const k = queue.shift()!;
			ordered.push(k);
			for (const consumer of consumersOf.get(k) ?? []) {
				const d = (inDegree.get(consumer) ?? 0) - 1;
				inDegree.set(consumer, d);
				if (d === 0) queue.push(consumer);
			}
		}

		if (ordered.length < entries.length) {
			const seen = new Set(ordered);
			const cyclic = entries.map(([k]) => k).filter(k => !seen.has(k));
			warnLog('Cyclic materialized-view dependency among [%s]; processing in insertion order (convergence not guaranteed)', cyclic.join(', '));
			for (const k of cyclic) ordered.push(k);
		}

		const ranks = new Map<string, number>();
		ordered.forEach((mvK, i) => {
			const c = this.incremental.get(mvK);
			if (c) ranks.set(c.subscriptionId, i);
		});
		return ranks;
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
	 */
	async maintainRowTime(
		sourceBase: string,
		change: { op: 'insert' | 'update' | 'delete'; oldRow?: Row; newRow?: Row },
	): Promise<void> {
		const keys = this.rowTimeBySource.get(sourceBase.toLowerCase());
		if (!keys || keys.size === 0) return;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (plan) await this.applyRowTimeChange(plan, change);
		}
	}

	/** Compute and apply one plan's per-row backing delta. */
	private async applyRowTimeChange(
		plan: RowTimeMaintenancePlan,
		change: { op: 'insert' | 'update' | 'delete'; oldRow?: Row; newRow?: Row },
	): Promise<void> {
		const inScope = (row: Row): boolean => plan.predicate === undefined || plan.predicate.evaluate(row) === true;
		const project = (row: Row): Row => plan.projectionSourceCols.map(sc => row[sc]) as Row;
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
		if (ops.length === 0) return;

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const manager = getBackingManager(backing);
		const connection = await this.getBackingConnection(manager, `${plan.backingSchema}.${plan.backingTableName}`);
		manager.applyMaintenanceToLayer(connection, ops);
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
	 * a **passthrough** projection (every backing column resolves to a source column
	 * via attribute provenance) that covers every source PK column, and a partial
	 * WHERE evaluable on a single source row. This is a strict superset of the
	 * coverage prover's recognized shape — it reuses the same shape primitives the
	 * incremental gate uses (`collectTableRefs`, provenance via `resolveSourceCol`).
	 */
	private buildRowTimePlan(mv: MaterializedViewSchema): RowTimeMaintenancePlan {
		const db = this.ctx as unknown as Database;
		const { plan } = this.ctx._buildPlan([mv.selectAst as AST.Statement]);
		const analyzed = this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;

		const reject = (detail: string): never => {
			throw new QuereusError(
				`materialized view '${mv.name}': 'row-time' refresh ${detail}; `
					+ `use 'on-commit-incremental' or 'manual' refresh`,
				StatusCode.UNSUPPORTED,
			);
		};

		// Single source `T`. (A join, self-join, or TVF fan-out surfaces ≥2 table
		// references or a TVF node — caught here and by the node-type checks below.)
		const tableRefs = [...collectTableRefs(analyzed).values()];
		if (tableRefs.length === 0) reject('requires the body to read exactly one source table');
		if (tableRefs.length > 1) reject('supports only a single-source body (no joins)');
		const tableRef = tableRefs[0];
		const sourceSchema = tableRef.tableSchema;
		const sourceBase = `${sourceSchema.schemaName}.${sourceSchema.name}`.toLowerCase();

		// Row-collapsing / fan-out / unbounded shapes break one-source-row →
		// one-backing-row, so write-through could not be a pure projection.
		if (findAggregate(analyzed)) reject('does not support aggregate bodies');
		if (containsAnyJoin(analyzed)) reject('does not support join bodies');
		if (containsNodeType(analyzed, PlanNodeType.Distinct)) reject('does not support DISTINCT bodies');
		if (containsNodeType(analyzed, PlanNodeType.SetOperation)) reject('does not support set-operation bodies');
		if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) reject('does not support recursive-CTE bodies');
		if (containsNodeType(analyzed, PlanNodeType.TableFunctionCall)) reject('does not support table-valued-function bodies');
		if (mv.selectAst.type === 'select' && (mv.selectAst.limit !== undefined || mv.selectAst.offset !== undefined)) {
			reject('does not support LIMIT/OFFSET bodies');
		}

		const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
		if (sourcePkCols.length === 0) reject(`requires source '${sourceBase}' to have a primary key`);

		const backing = this.ctx._findTable(mv.backingTableName, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}

		// Passthrough projection: every backing output column must forward a source
		// column (attribute-id provenance, exactly as `computeDeleteKeyOrder`),
		// making maintenance a pure column permutation of the changed row.
		const sourceAttrToCol = new Map<number, number>();
		tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
		const producingByAttrId = collectProducingExprs(analyzed);
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) reject('body produced no relational output');

		const projectionSourceCols: number[] = [];
		for (let outCol = 0; outCol < rootAttrs!.length; outCol++) {
			const attr = rootAttrs![outCol];
			const sourceCol = attr ? resolveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
			if (sourceCol === undefined) {
				reject('requires every projected column to be a passthrough source column (no computed/expression columns)');
			}
			projectionSourceCols.push(sourceCol!);
		}

		// Every source PK column must be projected so the backing key is a
		// deterministic function of the source row (and identifies that row).
		const projected = new Set(projectionSourceCols);
		for (const pk of sourcePkCols) {
			if (!projected.has(pk)) {
				reject(`requires the body to project every source primary-key column (missing '${sourceSchema.columns[pk]?.name ?? pk}')`);
			}
		}

		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// Partial WHERE must be evaluable on a single source row (no subqueries /
		// cross-row references). `compilePredicate` throws on unsupported forms.
		let predicate: CompiledPredicate | undefined;
		const bodyWhere = mv.selectAst.type === 'select' ? mv.selectAst.where : undefined;
		if (bodyWhere) {
			try {
				predicate = compilePredicate(bodyWhere, sourceSchema.columns);
			} catch (e) {
				reject(`requires a WHERE evaluable on a single source row (${e instanceof Error ? e.message : String(e)})`);
			}
		}

		return {
			mv,
			sourceBase,
			backingSchema: mv.schemaName,
			backingTableName: mv.backingTableName,
			backingPkDefinition,
			projectionSourceCols,
			predicate,
		};
	}

	/* ──────────────── row-time covering enforcement ──────────────── */

	/**
	 * Resolve the linked, `row-time`, enforcement-ready covering MV for a UNIQUE
	 * constraint on `schema.table`, or `undefined`. The constraint's
	 * `coveringStructureName` forward pointer (set by the eager prove-and-link) is
	 * the source of truth; this confirms a live `row-time` plan exists for the
	 * source and the MV is neither `stale` (structural breakage) nor `diverged`
	 * (data drift) — only then is its backing table row-time consistent enough to
	 * answer conflict resolution. O(1) negative fast path off {@link rowTimeBySource}
	 * so a source table with no row-time covering MV pays a single map lookup and
	 * stays on the synchronous index/scan path.
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
			if (mv.stale || mv.diverged) return undefined; // not row-time consistent
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

		const [srcSchemaName, srcTableName] = plan.sourceBase.split('.');
		const sourceSchema = this.ctx._findTable(srcTableName, srcSchemaName);
		if (!sourceSchema) return [];

		// Inverse projection: source column index → backing column index (first
		// occurrence). `projectionSourceCols[j]` is the source column behind backing
		// column `j`, so this reverses it.
		const sourceColToBacking = new Map<number, number>();
		plan.projectionSourceCols.forEach((sc, backingCol) => {
			if (!sourceColToBacking.has(sc)) sourceColToBacking.set(sc, backingCol);
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

/** Stable diagnostic id for an MV's incremental `DeltaSubscription`. */
function subscriptionIdFor(mv: MaterializedViewSchema): string {
	return `materialized-view:${mv.schemaName}.${mv.name}`;
}

/** Serialize an SqlValue tuple to a stable string key. Handles bigint and bytes
 *  (which `JSON.stringify` cannot) and is only ever used as a map key (never split). */
function serializeTuple(values: readonly SqlValue[]): string {
	const parts: string[] = [];
	for (const v of values) {
		if (v === null) parts.push('null');
		else if (typeof v === 'bigint') parts.push(`b:${v.toString()}`);
		else if (typeof v === 'number') parts.push(`n:${v}`);
		else if (typeof v === 'string') parts.push(`s:${v}`);
		else if (typeof v === 'boolean') parts.push(`B:${v}`);
		else if (v instanceof Uint8Array) parts.push(`x:${Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('')}`);
		else parts.push(`j:${JSON.stringify(v)}`);
	}
	return parts.join('\u0001');
}

/** Serialize a backing-table primary key (scalar or composite) to a string. */
function pkToString(key: BTreeKeyForPrimary): string {
	return serializeTuple(Array.isArray(key) ? key as SqlValue[] : [key as SqlValue]);
}

/** Synthesize an overlay change from a touched backing row's before/after images. */
function synthesizeOverlayChange(before: Row | null, after: Row | null): OverlayChange | null {
	if (before && after) return { op: 'update', oldRow: before, newRow: after };
	if (!before && after) return { op: 'insert', newRow: after };
	if (before && !after) return { op: 'delete', oldRow: before };
	return null;
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

/**
 * True if the plan carries any join that is not a plain inner/cross join.
 * Duck-types a `joinType` property so it spans the logical {@link JoinNode} and
 * the physical join variants (mirroring how {@link findAggregate} spans the
 * logical/physical aggregates); a join-bearing node whose join type is absent or
 * unreadable is treated conservatively as non-inner (⇒ rejected).
 */
function hasNonInnerJoin(node: PlanNode): boolean {
	if (JOIN_NODE_TYPES.has(node.nodeType)) {
		const jt = (node as Partial<{ joinType: unknown }>).joinType;
		if (jt !== 'inner' && jt !== 'cross') return true;
	}
	for (const child of node.getChildren()) {
		if (hasNonInnerJoin(child as unknown as PlanNode)) return true;
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

/**
 * Compute how to project a binding tuple onto the backing table's physical
 * primary key for the per-binding delete. Returns `bindingTupleOrder` where
 * entry `j` is the binding-tuple index supplying physical-PK column `j`'s value,
 * or `null` when the binding does not cover the full physical PK cleanly (the
 * caller then falls back to a full rebuild).
 *
 * Provenance: a passthrough output column forwards its source attribute id, so
 * its id is directly the source column's id; an aggregate group-by column mints
 * a fresh id but `getProducingExprs()` maps it back to the group-by expression
 * (a `ColumnReferenceNode` whose `attributeId` is the source column's id).
 */
function computeDeleteKeyOrder(
	analyzedRoot: BlockNode,
	tableRef: TableReferenceNode | undefined,
	producingByAttrId: Map<number, ScalarPlanNode>,
	bindColumns: readonly number[],
	physicalPkOutCols: readonly number[],
): number[] | null {
	if (!tableRef) return null;

	// source attribute id → source column index, for the target table reference.
	const sourceAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));

	// binding source-column index → its position in the binding tuple.
	const sourceColToBindPos = new Map<number, number>();
	bindColumns.forEach((c, i) => sourceColToBindPos.set(c, i));

	const rootAttrs = relationalAttributes(analyzedRoot);
	if (!rootAttrs) return null;

	const order: number[] = [];
	for (const pkOutCol of physicalPkOutCols) {
		const attr = rootAttrs[pkOutCol];
		if (!attr) return null;
		const sourceCol = resolveSourceCol(attr.id, sourceAttrToCol, producingByAttrId);
		if (sourceCol === undefined) return null;
		const bindPos = sourceColToBindPos.get(sourceCol);
		if (bindPos === undefined) return null;
		order.push(bindPos);
	}
	return order;
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

/* ─────────────────── lateral-TVF fan-out maintenance ─────────────────── */

/** Collect every {@link TableFunctionCallNode} in a plan (recursive `getChildren` walk). */
function collectTableFunctionCalls(node: PlanNode, out: TableFunctionCallNode[] = []): TableFunctionCallNode[] {
	if (node instanceof TableFunctionCallNode) out.push(node);
	for (const child of node.getChildren()) collectTableFunctionCalls(child as unknown as PlanNode, out);
	return out;
}

/** Attribute ids referenced by a TVF's operand expressions (recursive scalar walk). */
function collectOperandAttrIds(tvf: TableFunctionCallNode): Set<number> {
	const ids = new Set<number>();
	const walk = (n: PlanNode): void => {
		if (n instanceof ColumnReferenceNode) ids.add(n.attributeId);
		for (const c of n.getChildren()) walk(c as unknown as PlanNode);
	};
	for (const op of tvf.operands) walk(op as unknown as PlanNode);
	return ids;
}

/**
 * Detect the v1 lateral-TVF fan-out shape: a single {@link TableFunctionCallNode}
 * whose operands correlate *only* to the bound base source (e.g. the `t.arr` in
 * `base t cross join lateral json_each(t.arr)`). Returns the TVF node, or
 * `undefined` when the shape is anything else (no TVF, a constant/non-correlated
 * TVF, multiple TVFs, or a TVF referencing a relation other than the base) — all
 * of which stay on the always-correct rebuild fallback.
 */
function detectLateralTvf(analyzedRoot: PlanNode, baseRef: TableReferenceNode): TableFunctionCallNode | undefined {
	const tvfs = collectTableFunctionCalls(analyzedRoot);
	if (tvfs.length !== 1) return undefined;
	const baseAttrIds = new Set(baseRef.getAttributes().map(a => a.id));
	const operandAttrs = collectOperandAttrIds(tvfs[0]);
	if (operandAttrs.size === 0) return undefined; // not correlated (constant TVF)
	for (const id of operandAttrs) {
		if (!baseAttrIds.has(id)) return undefined; // correlated to something other than base
	}
	return tvfs[0];
}

/**
 * Fact (1) — prefix isolation. The backing physical PK must decompose into a
 * *leading run* of columns that each resolve (via attribute provenance) to a
 * `base` PK column and together cover ALL of `base.PK`, followed by ≥1
 * TVF-supplied column. Deleting every backing row whose leading prefix equals
 * the changed base PK then removes exactly that base row's fan-out (base PK is
 * unique, so no other base row shares the prefix). Returns the descriptor, or
 * `null` when the base PK is not such a clean leading prefix (⇒ rebuild).
 *
 * The leading prefix columns must additionally be **ascending** so the matching
 * backing rows form a single contiguous, forward-scannable run for the
 * `delete-by-prefix` range delete (a desc leading column ⇒ `null` ⇒ rebuild).
 */
function computePrefixDeleteOrder(
	analyzedRoot: BlockNode,
	baseRef: TableReferenceNode,
	producingByAttrId: Map<number, ScalarPlanNode>,
	bindColumns: readonly number[],
	basePkCols: readonly number[],
	physicalPkOutCols: readonly number[],
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean }>,
): PrefixDeleteDescriptor | null {
	const baseAttrToCol = new Map<number, number>();
	baseRef.getAttributes().forEach((a, i) => baseAttrToCol.set(a.id, i));
	const sourceColToBindPos = new Map<number, number>();
	bindColumns.forEach((c, i) => sourceColToBindPos.set(c, i));
	const basePkSet = new Set(basePkCols);

	const rootAttrs = relationalAttributes(analyzedRoot);
	if (!rootAttrs) return null;

	const baseKeyOrder: number[] = [];
	const covered = new Set<number>();
	for (let j = 0; j < physicalPkOutCols.length; j++) {
		if (backingPkDefinition[j]?.desc === true) break; // leading run must be ascending
		const attr = rootAttrs[physicalPkOutCols[j]];
		if (!attr) break;
		const baseCol = resolveSourceCol(attr.id, baseAttrToCol, producingByAttrId);
		if (baseCol === undefined || !basePkSet.has(baseCol)) break; // run ends at the first non-base-PK column
		const bindPos = sourceColToBindPos.get(baseCol);
		if (bindPos === undefined) break;
		baseKeyOrder.push(bindPos);
		covered.add(baseCol);
	}

	// The leading run must cover *all* of base PK …
	if (covered.size !== basePkSet.size) return null;
	if (baseKeyOrder.length === 0) return null;
	// … and stop before the end: a backing PK that is *entirely* base-PK columns
	// is one-row-per-base-row (no fan-out) — the exact `delete-key` path applies.
	if (baseKeyOrder.length === physicalPkOutCols.length) return null;

	return { baseKeyOrder, prefixLength: baseKeyOrder.length };
}

/**
 * Fact (2) — fan-out set-ness. The TVF-derived portion of the backing PK must be
 * a **superkey** of the TVF output relation, so the per-base-row re-insert batch
 * is a set on the backing PK (no two distinct fan-out rows collapse). Within one
 * base row's fan-out the base-derived backing columns are constant, so set-ness
 * reduces to: the backing-PK columns supplied by the TVF distinguish every TVF
 * output row. Discharged from the TVF's `relationalAdvertisement`:
 *   - some advertised `keys` entry ⊆ the backing-PK TVF columns, OR
 *   - `isSet` AND the backing-PK TVF columns cover *every* TVF output column.
 * Anything weaker ⇒ `false` ⇒ the gate fails and the shape full-rebuilds
 * (never a silent fan-out dedup). Out-of-range advertised key indices are
 * naturally rejected (they cannot be members of the valid backing-PK column set).
 */
function tvfBackingPortionIsSuperkey(
	analyzedRoot: BlockNode,
	tvf: TableFunctionCallNode,
	producingByAttrId: Map<number, ScalarPlanNode>,
	physicalPkOutCols: readonly number[],
): boolean {
	const schema = tvf.functionSchema;
	if (!isTableValuedFunctionSchema(schema)) return false;
	const rootAttrs = relationalAttributes(analyzedRoot);
	if (!rootAttrs) return false;

	const tvfAttrToCol = new Map<number, number>();
	tvf.getAttributes().forEach((a, i) => tvfAttrToCol.set(a.id, i));

	// TVF output column indices that appear in the backing PK.
	const tvfPkCols = new Set<number>();
	for (const pkOutCol of physicalPkOutCols) {
		const attr = rootAttrs[pkOutCol];
		if (!attr) continue;
		const tvfCol = resolveSourceCol(attr.id, tvfAttrToCol, producingByAttrId);
		if (tvfCol !== undefined) tvfPkCols.add(tvfCol);
	}
	if (tvfPkCols.size === 0) return false;

	const adv = schema.relationalAdvertisement;
	const ops = tvf.operands;
	const colCount = schema.returnType.columns.length;

	// Advertised-key route: some advertised key ⊆ the backing-PK TVF columns.
	const resolvedKeys = adv ? resolveAdvertisement(adv.keys, ops, schema) : undefined;
	if (resolvedKeys) {
		for (const key of resolvedKeys) {
			if (key.length > 0 && key.every(c => tvfPkCols.has(c.index))) return true;
		}
	}

	// isSet route: the TVF output is a set on *all* its columns, and the backing
	// PK carries all of them.
	const resolvedIsSet = adv ? resolveAdvertisement(adv.isSet, ops, schema) : undefined;
	const isSet = resolvedIsSet ?? schema.returnType.isSet;
	if (isSet) {
		let coversAll = true;
		for (let i = 0; i < colCount; i++) {
			if (!tvfPkCols.has(i)) { coversAll = false; break; }
		}
		if (coversAll) return true;
	}

	return false;
}
