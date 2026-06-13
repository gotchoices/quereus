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
 *     incompatible change); the next successful refresh clears the flag. One
 *     carve-out: a **body-irrelevant** `table_modified` (constraint/stats/tags-only —
 *     columns and physical PK identical, see `isBodyIrrelevantTableChange`) instead
 *     RECOMPILES each live dependent's row-time plan in place
 *     (`tryRecompileMaterializedViewLive`, gated by shape re-derivation), falling
 *     back to mark-stale on any failure — so DROP/ADD/RENAME CONSTRAINT and ANALYZE
 *     no longer de-liven dependents whose backing shape is unaffected. The SAME
 *     subscription also rebuilds a maintained table's compiled **derived-row
 *     constraint validator** when a *constraint-only* dependency — an FK parent or a
 *     subquery-CHECK target, neither a derivation source — is renamed/dropped/re-created
 *     (see {@link MaterializedViewManager.rebuildConstraintValidatorsFor}); without
 *     this the validator, compiled once at registration, would keep resolving against
 *     the dead/renamed incarnation and fail maintenance writes with an internal
 *     module-connect error.
 *
 *  2. **Row-time write-through** (`maintainRowTime`) — the backing table is kept
 *     consistent *synchronously* with each source row-write, driven from the
 *     runtime DML boundary (not at COMMIT). Each MV's maintenance is **cost-gated with a
 *     floor**: the builder matches the body to a bounded-delta arm (the covering-index
 *     inverse projection, an aggregate / lateral-TVF / 1:1-join residual) when one fits —
 *     each source row then maps to a bounded backing delta, no full scan — and otherwise
 *     falls through to the always-correct **full-rebuild floor** (re-evaluate the whole
 *     body, replace the backing). **No body is rejected for its shape;** the only
 *     create-time rejections are non-shape (non-determinism, bag/no-key, no relational
 *     output, and a full-rebuild-only body over a source past the size threshold). The
 *     write targets the backing table's *pending* transaction layer through the same
 *     connection a `select` from the MV uses, so the change is visible mid-transaction
 *     (reads-own-writes) and is committed/rolled-back in lockstep with the source write by
 *     the coordinated commit (see {@link MaterializedViewManager.buildMaintenancePlan}).
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type ScalarPlanNode, type RowDescriptor, type RelationalPlanNode, isRelationalNode, isScalarNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { FilterNode } from '../planner/nodes/filter.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Scheduler } from '../runtime/scheduler.js';
import { RowContextMap } from '../runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { isAsyncIterable } from '../runtime/utils.js';
import type { RuntimeContext } from '../runtime/types.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { TableFunctionCallNode } from '../planner/nodes/table-function-call.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
import { keysOf } from '../planner/util/fd-utils.js';
import { deriveCoarsenedBackingKey, resolveValuePreservingSourceCol } from '../planner/analysis/coarsened-key.js';
import { proveOneToOneJoin } from '../planner/analysis/coverage-prover.js';
import { CapabilityDetectors } from '../planner/framework/characteristics.js';
import {
	selectMaintenanceStrategy,
	isFullRebuildPathological,
	seqScanCost,
	filterCost,
	projectCost,
	type MaintenanceSourceStats,
	type MaintenanceStrategy,
} from '../planner/cost/index.js';
import { resolveBackingHost, isBodyIrrelevantTableChange, tryRecompileMaterializedViewLive } from '../runtime/emit/materialized-view-helpers.js';
import { assertTransitiveRestrictsForParentMutation, executeForeignKeyActionsAndLens } from '../runtime/foreign-key-actions.js';
import { buildDerivedRowValidator, makePoisonedDerivedRowValidator, validateDerivedRowImage, type DerivedRowConstraintValidator } from './derived-row-validator.js';
import { buildPrimaryKeyFromValues } from '../vtab/memory/utils/primary-key.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import type { BackingHost, BackingRowChange, MaintenanceOp } from '../vtab/backing-host.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import { compilePredicate, type CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import { compareSqlValues, rowsValueIdentical } from '../util/comparison.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { TableSchema, UniqueConstraintSchema } from '../schema/table.js';
import type { Database } from './database.js';
import type { DatabaseEventEmitter, MaintenanceCollisionEvent } from './database-events.js';
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

	/** Database event emitter — the row-time collision telemetry channel
	 *  ({@link MaterializedViewManager.detectAndReportCoarseningCollisions}) queues
	 *  {@link MaintenanceCollisionEvent}s here. Already exposed for the transaction
	 *  manager; reused narrowly. */
	getEventEmitter(): DatabaseEventEmitter;

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
 * `incremental-maintenance-substrate-spike` design). The builder
 * ({@link MaterializedViewManager.buildMaintenancePlan}) produces four bounded-delta arms:
 * `'inverse-projection'` (the covering-index shape), `'residual-recompute'` (single-source
 * aggregates), `'prefix-delete'` (single-source lateral-TVF fan-out), and `'join-residual'`
 * (the provably-1:1 inner join) — each applied **per source row, immediately**. The
 * `'full-rebuild'` floor (the always-correct convergence point for bodies no bounded-delta
 * arm fits) is the fall-through the builder routes to whenever no bounded-delta arm matches;
 * it is the one **deferred** arm — marked dirty per row and rebuilt once per statement at
 * {@link MaterializedViewManager.flushDeferredRebuilds}.
 */
export type MaintenancePlan =
	| InverseProjectionPlan
	| FullRebuildPlan
	| ResidualRecomputePlan
	| PrefixDeletePlan
	| JoinResidualPlan;

/**
 * Structural subset of the fields the forward (driving-source) residual-recompute
 * apply path reads — shared by the aggregate {@link ResidualRecomputePlan} and the
 * 1:1-join {@link JoinResidualPlan} so both drive {@link MaterializedViewManager.applyForwardResidual}
 * unchanged. For an aggregate the forward key is the group key (`'gk'`); for a join
 * it is the driving table `T`'s PK (`'pk'`).
 */
interface ForwardResidualPlan {
	mv: MaintainedTableSchema;
	backingSchema: string;
	backingTableName: string;
	/** Cached scheduler for the key-filtered residual (the body with `injectKeyFilter`
	 *  applied on the driving source). Re-run per affected key, bound through the live txn. */
	residualScheduler: Scheduler;
	bindParamPrefix: 'gk' | 'pk';
	/** Source-column indices of the forward binding key (group columns / `T`'s PK columns). */
	bindColumns: number[];
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	backingPkSourceCols: number[];
}

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
 * One **weakened** column of a coarsened backing key K′, precomputed once at
 * registration for the row-time collision telemetry
 * ({@link MaterializedViewManager.detectAndReportCoarseningCollisions}). Carries the
 * backing column index to read from each {@link BackingRowChange} image, the
 * **source** (pre-coarsening, stricter) collation the divergence test compares
 * under, the **output** (coarsened) collation the backing key enforces, and the
 * column name for the {@link MaintenanceCollisionEvent} payload. Derived from
 * `mv.derivation.coarsenedKey.weakened` (column names) via `mv.columnIndexMap`.
 */
interface CoarseningWatchColumn {
	/** Backing column index (= body output column index) the weakened K′ column lands at. */
	readonly index: number;
	/** Source key enforcement collation (pre-coarsening); the divergence test compares under it. */
	readonly sourceCollation: string;
	/** Output (coarsened) collation the backing key enforces. */
	readonly outputCollation: string;
	/** Backing/output column name (for the event payload's `weakenedColumns`). */
	readonly column: string;
}

/**
 * Common identity + cost-gate fields shared by every {@link MaintenancePlan} arm.
 * `chosenStrategy` / `sourceStats` are set once by the create-time cost gate
 * ({@link MaterializedViewManager.buildMaintenancePlan}, via `selectMaintenanceStrategy`)
 * and are not re-evaluated per write, except for the residual → rebuild demotion
 * (`shouldDegradeToRebuild`; dormant until the residual arm is reachable).
 */
interface MaintenancePlanCommon {
	/** The MV this plan maintains. */
	mv: MaintainedTableSchema;
	/** Lowercased `schema.table` of the single source `T`. */
	sourceBase: string;
	backingSchema: string;
	backingTableName: string;
	/** Strategy the cost gate chose: argmin `maintenanceCost` over the body's sound strategies. */
	chosenStrategy: MaintenanceStrategy;
	/** Create-time cost inputs (StatsProvider + forward optimizer), retained so the DML
	 *  boundary can re-cost residual vs. rebuild against the actual changeCardinality. */
	sourceStats: MaintenanceSourceStats;
	/** Compiled declared-CHECK/FK validator over derived row images — present ONLY
	 *  when the maintained table declares ≥1 applicable CHECK or ≥1 FK (the
	 *  zero-overhead gate: MV-sugar backings and constraint-less maintained tables
	 *  carry `undefined` and pay nothing per write). Built once at registration
	 *  ({@link MaterializedViewManager.registerMaterializedView}); applied to each
	 *  insert/update {@link BackingRowChange} before the cascade. */
	derivedRowValidator?: DerivedRowConstraintValidator;
	/** Precomputed weakened-K′-column watch list for row-time collision telemetry —
	 *  present ONLY when `mv.derivation.coarsenedKey` is stamped (the zero-overhead
	 *  gate: a provable-key / refining-lineage-key MV carries `undefined` and pays
	 *  nothing per write — detection short-circuits on this field). Built once at
	 *  registration ({@link MaterializedViewManager.registerMaterializedView} →
	 *  {@link MaterializedViewManager.buildCoarseningWatch}); read by
	 *  {@link MaterializedViewManager.detectAndReportCoarseningCollisions} from both
	 *  the bounded-delta and full-rebuild maintenance arms. */
	coarseningWatch?: ReadonlyArray<CoarseningWatchColumn>;
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
 * The always-correct **floor**: a body for which no bounded-delta arm is sound is
 * maintained by re-evaluating it in full per writing statement and replacing the backing
 * transactionally (a single `'replace-all'` {@link MaintenanceOp} — a keyed diff against
 * the backing's pending layer, so the delta still commits/rolls-back with the source
 * write and still drives the MV-over-MV cascade). The whole optimized body is compiled
 * once at registration into {@link bodyScheduler}; {@link MaterializedViewManager.applyFullRebuild}
 * runs it to completion against live source state and diffs the result into the backing.
 *
 * Reachability: `buildMaintenancePlan` routes a body here whenever no bounded-delta arm
 * fits ({@link MaterializedViewManager.tryBuildBoundedDeltaArm} returns `null`). It is the
 * one **deferred** arm — marked dirty per source row and rebuilt exactly once at the
 * end-of-statement flush ({@link MaterializedViewManager.flushDeferredRebuilds}), so a bulk
 * write is O(body) not O(rows × body). See `docs/materialized-views.md` § Full-rebuild floor.
 */
export interface FullRebuildPlan extends MaintenancePlanCommon {
	readonly kind: 'full-rebuild';
	/** The optimized body compiled once at registration — the **whole** body (no
	 *  `injectKeyFilter`), with the read-side MV rewrite suppressed so it reads its sources,
	 *  not the backing it populates. Re-run to completion per writing statement, bound
	 *  through the live transaction (reads-own-writes), to recompute every backing row. */
	bodyScheduler: Scheduler;
	/** Every source base (lowercased `schema.table`) the body reads — set-op legs, every
	 *  join source, etc. The plan is indexed under each in `rowTimeBySource` (via
	 *  {@link planSourceBases}), so a write to **any** of them triggers a rebuild; missing
	 *  one would leave the MV stale on that source's writes. `sourceBase` (the
	 *  {@link MaintenancePlanCommon} field) holds the first of these for parity. */
	sourceBases: string[];
}

/**
 * The general-body residual-recompute arm: per source change, derive the affected
 * binding key(s) from the changed row, run a key-filtered residual of the body against
 * **live mid-transaction source state**, and apply the keyed diff — upsert the recomputed
 * slice (replacing the old row at the same backing key; a value-identical recompute is
 * suppressed by the host, see vtab/backing-host.ts) or, when the residual returns
 * nothing, delete the emptied key. Wired for the **single-source aggregate** shape
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
 * The single-source lateral-TVF fan-out arm: a body of the shape
 * `select T.pk…, …, f.* from T cross join lateral tvf(<args over T>) f`, where each base
 * row of `T` fans out to **N** backing rows (one per row the TVF emits for it). The
 * backing PK is the **composite product key** `(T.pk ∪ tvf-key)` that
 * `optimizer-keyed-cross-product-join-keys` advertises through `keysOf` over the lateral
 * join, with the base PK as its **leading prefix** (asserted at build).
 *
 * Per changed base row, maintenance is a **keyed diff of the recomputed fan-out against
 * the existing effective slice for the base-PK prefix** (read via the host's
 * `scanEffective`, since one base row owns many backing rows sharing the prefix): re-run
 * the TVF fan-out **residual** for that base row, delete only the existing keys the
 * recompute no longer produces, and **upsert** each recomputed row (value-identical
 * upserts are suppressed by the host). An UPDATE diffs both the OLD and NEW base keys
 * (the base PK may move); a DELETE diffs the old slice to all-deletes; an INSERT diffs
 * against an empty slice. This reuses the residual kernel of {@link ResidualRecomputePlan}
 * unchanged — the affected-key derivation, the `injectKeyFilter` residual (pinned to the
 * base `TableReferenceNode` with the `'pk'` prefix), reads-own-writes execution, the cost
 * gate — and differs only in the **prefix-slice** diff (vs point-key) and the **N-row**
 * residual (vs ≤1). The body's WHERE, if any, is part of the residual (so an out-of-scope
 * base row fans out to zero rows), exactly as in the aggregate arm.
 *
 * `chosenStrategy` is `'residual-recompute'` (the shared key-filtered re-execution cost
 * shape — the fan-out factor is unknown at create); `kind` is `'prefix-delete'` (the
 * apply-arm dispatcher). `degradeToRebuild` is dormant (as in the aggregate arm).
 */
export interface PrefixDeletePlan extends MaintenancePlanCommon {
	readonly kind: 'prefix-delete';
	/** Substrate parity (the base-PK 'row' binding); unread by the apply path, which uses
	 *  `bindColumns` / `backingPrefixSourceCols`. */
	binding: BindingMode;
	degradeToRebuild: boolean;
	/** Cached scheduler for the base-PK-keyed residual (the body with `injectKeyFilter`
	 *  applied on `T`, `'pk'` prefix). Re-run per affected base key; fans out to N rows. */
	residualScheduler: Scheduler;
	bindParamPrefix: 'pk';
	/** Source-`T` PK column indices (the base key). The affected key tuple is
	 *  `bindColumns.map(c => changedRow[c])`, bound to `pk{i}`. */
	bindColumns: number[];
	/** Full backing-table physical primary key (base-PK prefix ++ TVF-key tail). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	/** Number of leading backing-PK columns that form the base-PK prefix (= `bindColumns.length`). */
	basePrefixLength: number;
	/** Source-`T` column projected into each leading (base-prefix) backing-PK column, in
	 *  backing-PK order. The by-prefix delete key for a changed row `R` is
	 *  `backingPrefixSourceCols.map(sc => R[sc])`. */
	backingPrefixSourceCols: number[];
}

/**
 * The 1:1 row-preserving **inner/cross join** arm: a body
 * `select … from T join P on T.fk = P.id` where `T` contributes **exactly one** MV row
 * per governed `T` row (proven by {@link proveOneToOneJoin} — no row loss via NOT-NULL
 * FK→PK referential integrity, no fan-out via `isUnique(T.pk)` at the join frame). The
 * backing is keyed on `T`'s PK (the composite product key `keysOf` advertises across the
 * 1:1 join collapses to `T`'s PK), so each changed `T` row maps to one backing row.
 *
 * Reuses the residual kernel of {@link ResidualRecomputePlan} on its **driving (`T`)**
 * side via {@link ForwardResidualPlan}: a `T`-keyed (`'pk'`) residual recomputes the one
 * joined row for a changed `T` row (run residual → upsert the recomputed row, or delete
 * the key when it returns nothing), identical to a `'row'`-binding aggregate of size 1.
 * `applyForwardResidual` drives it.
 *
 * The **lookup (`P`)** side is the join arm's distinct problem: the MV's `sourceTables`
 * includes `P`, so a write to `P` also fires maintenance, but the forward residual is
 * keyed on `T`'s PK and a `P` row joins *many* `T` rows. This plan therefore carries a
 * **second residual keyed on `P`'s PK** (`lookupResidualScheduler`): for a `P` change it
 * runs `… where P.pk = :pk0` (the body **including** its WHERE) against live state,
 * returning every currently in-scope joined row (each carrying its `T.pk` backing key), and
 * **upserts** each.
 *
 * **WHERE handling — bounded-delta over a partial-WHERE 1:1 join.** A body WHERE is
 * classified at build by which base table(s) its columns reference
 * ({@link MaterializedViewManager.buildJoinResidualPlan}):
 *  - **`T`-only predicate** — no extra machinery. The forward (`T`) residual already injects
 *    + applies the WHERE (an out-of-scope `T` row recomputes to zero residual rows ⇒ its
 *    delete-without-upsert removes the backing row), and a `T`-column predicate cannot move
 *    the membership set `{ T : T.fk = P.pk }`, so the lookup side stays **upsert-only**
 *    (`lookupMembershipResidualScheduler` absent) — sound for the same reason the no-WHERE
 *    arm is.
 *  - **`P`-referencing predicate** (or both sides) — a `P` write can flip a row's WHERE truth
 *    and so add/remove a backing row, which upsert-only could never delete. The lookup side
 *    becomes **delete-capable**: `lookupMembershipResidualScheduler` is the body with
 *    `injectKeyFilter` on `P` but the WHERE **stripped** (membership only). Per affected `P`
 *    key {@link MaterializedViewManager.applyLookupResidual} diffs it against the in-scope
 *    `lookupResidualScheduler` (WHERE retained): membership keys the in-scope recompute no
 *    longer produces are deleted, the in-scope rows are upserted — a keyed diff that converges
 *    the membership both ways without churning the unchanged rows.
 *
 * Still inner/cross only; outer joins and **fanning** (non-1:1) joins continue to fall to the
 * full-rebuild floor. See `docs/incremental-maintenance.md` § join-residual and the soundness
 * note in {@link MaterializedViewManager.applyLookupResidual}.
 */
export interface JoinResidualPlan extends MaintenancePlanCommon, ForwardResidualPlan {
	readonly kind: 'join-residual';
	/** Substrate parity: the driving `T`'s `'row'`/PK binding. */
	binding: BindingMode;
	degradeToRebuild: boolean;
	bindParamPrefix: 'pk';
	/** Lowercased `schema.table` of the lookup source `P` (distinct from `sourceBase` = `T`). */
	lookupBase: string;
	/** Cached scheduler for the in-scope lookup-keyed residual (the body — WHERE **retained** —
	 *  with `injectKeyFilter` applied on `P`, `'pk'` prefix). Re-run per affected `P` key;
	 *  returns the currently in-scope joined rows to upsert. */
	lookupResidualScheduler: Scheduler;
	/** Delete-capable lookup membership residual (the body with the WHERE **stripped** and
	 *  `injectKeyFilter` on `P`). Present **iff** the body WHERE references `P`: the lookup side
	 *  must then delete the backing key of every currently-referencing `T` row (regardless of
	 *  scope) before re-upserting the in-scope survivors, so a `P` write that flips a row's WHERE
	 *  membership adds/removes its backing row. Absent for a no-WHERE or `T`-only-WHERE body
	 *  (the lookup side is sound upsert-only — membership cannot move on a `P` write). */
	lookupMembershipResidualScheduler?: Scheduler;
	/** Source-`P` PK column indices (the lookup key). The affected key tuple for a `P`
	 *  change is `lookupBindColumns.map(c => changedRow[c])`, bound to `pk{i}`. */
	lookupBindColumns: number[];
	lookupBindParamPrefix: 'pk';
}

/**
 * Per-statement cache of resolved backing {@link VirtualTableConnection}s, keyed by the
 * lowercased backing `schema.table`. Created **once per DML generator run** (one
 * statement) and threaded through the maintenance path so the backing-connection
 * resolution — a scan over *all* the Database's active connections in
 * {@link MaterializedViewManager.getBackingConnection} — is paid once per
 * (statement, backing) instead of once per source row. This amortizes the dominant
 * per-row overhead of a bulk `insert`/`update`/`delete` over a covered table.
 *
 * It is purely a resolution cache: each **bounded-delta** arm's per-row ops are still
 * applied **immediately** to the cached connection's pending transaction layer, so a later
 * same-statement row's enforcement scan (`lookupCoveringConflicts`) still observes every
 * earlier row's backing write. The one exception is the **full-rebuild** arm, which the DML
 * boundary defers to a single end-of-statement {@link MaterializedViewManager.flushDeferredRebuilds}
 * (tracked in a separate per-statement dirty set, not this cache) — sound because a
 * full-rebuild MV is never a covering structure, so no enforcement scan depends on its
 * per-row visibility. See `docs/materialized-views.md` § Synchronous, transactional,
 * per-statement. Because the cache is scoped to one generator run, the connection it holds
 * cannot be torn down mid-statement; the cold enforcement/eviction paths that omit the cache
 * re-resolve the *same* connection deterministically, so reads-own-writes is unaffected.
 */
export type BackingConnectionCache = Map<string, VirtualTableConnection>;

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
				// A `table_modified` whose old/new differ only in fields a body cannot
				// read — constraint metadata (DROP/RENAME/ADD CONSTRAINT, declarative FK
				// retargets, rename propagation's constraint-AST rewrites on other
				// tables), statistics (ANALYZE), tags, defaults — cannot change what a
				// dependent body evaluates to, so live dependents are RECOMPILED in
				// place (shape-gated) instead of marked stale. The classifier's
				// reference-equality guard keeps emitBackingInvalidation's synthetic
				// same-object event body-RELEVANT — that event drives the MV-over-MV
				// staleness cascade and must keep staling consumers.
				const bodyIrrelevant = event.type === 'table_modified'
					&& isBodyIrrelevantTableChange(event.oldObject, event.newObject);
				for (const mv of this.ctx.schemaManager.getAllMaintainedTables()) {
					if (!mv.derivation.sourceTables.includes(changed)) continue;
					if (bodyIrrelevant) {
						// An already-stale dependent skips entirely: there is no live
						// plan to recompile, and only REFRESH may clear a pre-existing
						// flag (the backing may be behind); re-releasing the (absent)
						// plan and re-emitting invalidation would be pointless churn.
						if (mv.derivation.stale) continue;
						// On success the MV stays live: `stale` untouched, plan rebuilt
						// against the new catalog, and NO emitBackingInvalidation — the
						// backing stays maintained, so cached plans reading it remain
						// correct (a plan reading the *source* invalidates via its own
						// direct statement dependency on the source table). Any failure
						// falls through to the stale path below, verbatim.
						if (tryRecompileMaterializedViewLive(this.ctx as unknown as Database, mv)) continue;
					}
					if (!mv.derivation.stale) {
						mv.derivation.stale = true;
						log('Marked materialized view %s.%s stale due to %s on %s', mv.schemaName, mv.name, event.type, changed);
					}
					// A source schema change invalidates the compiled row-time plan;
					// detach it. The MV reads "stale" until refreshed or recreated,
					// which re-registers it.
					this.releaseRowTime(mvKey(mv.schemaName, mv.name));
					// Invalidate any cached prepared-statement plan reading this MV's
					// backing table so it recompiles and re-hits the build-time `stale`
					// guard (see emitBackingInvalidation). This is load-bearing for a plan
					// compiled while the MV was NOT stale: its only schema dependency is the
					// backing table, which the source event never names. (A plan compiled
					// while already stale instead carries a direct dependency on the source —
					// the while-stale build-time re-validation resolves and records it — so
					// the emit is defensive redundancy there, not a correctness requirement.)
					// Emitting per qualifying event (rather than only on the false→true
					// transition) also re-propagates the cascade down an MV-over-MV chain.
					this.emitBackingInvalidation(mv);
				}
				// Rebuild any derived-row validator that depends on the changed table as a
				// CONSTRAINT-ONLY dependency (FK parent / subquery-CHECK target — never a
				// derivation source, handled above). Runs AFTER the source loop so a plan
				// the source path just released is naturally skipped (it is gone from
				// `rowTime`). `matchOwnName` covers the rename: an FK-parent / CHECK-target
				// rename rewrites THIS maintained table's own FK/CHECK in place and fires
				// `table_modified` on the maintained table itself (the original dependency
				// name is gone from the catalog), so the dependency-set match alone misses it.
				// Runs for body-irrelevant events too — this IS the constraint-only-
				// dependency rebuild path; a just-recompiled dependent's validator was
				// already rebuilt fresh inside registerMaterializedView, so the second
				// rebuild here is idempotent.
				this.rebuildConstraintValidatorsFor(changed, /*matchOwnName*/ true);
			} else if (event.type === 'table_added') {
				// A re-created dependency (previously dropped → poisoned or absent-parent
				// fallback validator) self-heals: rebuild any validator that named it. No
				// own-name match — a maintained table's own creation registers its validator
				// directly. The table is already in the catalog when this fires.
				const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
				this.rebuildConstraintValidatorsFor(changed, /*matchOwnName*/ false);
			} else if (event.type === 'materialized_view_removed') {
				this.releaseRowTime(mvKey(event.schemaName, event.objectName));
			}
		});
	}

	/**
	 * Rebuild the derived-row constraint validator of every registered plan whose
	 * validator depends on `changed` (lowercased `schema.table`): it names `changed`
	 * in {@link DerivedRowConstraintValidator.dependencyTables} (FK parent /
	 * subquery-CHECK target), or — when `matchOwnName` — `changed` IS the maintained
	 * table itself (the rename signal; see {@link subscribeToSchemaChanges}).
	 *
	 * The derivation is unaffected by a constraint-only dependency's DDL, so this
	 * rebuilds the validator ONLY — no {@link releaseRowTime}, no staleness, no
	 * maintenance interruption. The rebuild reads the CURRENT catalog record
	 * (`getMaintainedTable`) so a rename re-resolves against the new name, and
	 * replacing the validator also refreshes its `dependencyTables` (a rename re-keys
	 * `{main.parent}` → `{main.parent2}`, so a later drop of `parent2` is caught too).
	 *
	 * Rebuild-failure handling: a rebuild THROWS when the subquery-CHECK target was
	 * dropped (`buildConstraintChecks` → optimize raises a sited "table not found").
	 * The throw is caught and a {@link makePoisonedDerivedRowValidator} installed, so
	 * (a) this listener never propagates an exception — a schema-change event must not
	 * fail the unrelated DDL that triggered it — and (b) the next derivation write
	 * surfaces the clear sited planning error instead of the stale validator's internal
	 * module-connect failure. The FK-parent-dropped case does NOT throw: the
	 * absent-parent null-guards-only fallback (`buildChildSideFKChecks`) builds cleanly,
	 * so the rebuilt validator is healthy (a non-NULL ref fails with the maintained-table
	 * FK attribution; a NULL ref is admitted under MATCH SIMPLE).
	 */
	private rebuildConstraintValidatorsFor(changed: string, matchOwnName: boolean): void {
		for (const plan of this.rowTime.values()) {
			const validator = plan.derivedRowValidator;
			if (!validator) continue;
			const ownName = `${validator.schemaName}.${validator.tableName}`.toLowerCase();
			if (!validator.dependencyTables.has(changed) && !(matchOwnName && changed === ownName)) continue;
			const currentMv = this.ctx.schemaManager.getMaintainedTable(validator.schemaName, validator.tableName);
			// MV gone (dropped) — `materialized_view_removed` releases the plan separately.
			if (!currentMv) continue;
			try {
				plan.derivedRowValidator = buildDerivedRowValidator(this.ctx as unknown as Database, currentMv);
				log('Rebuilt derived-row validator for %s after schema change on %s', ownName, changed);
			} catch (err) {
				const error = err instanceof QuereusError
					? err
					: new QuereusError(
						`rebuilding derived-row validator for '${ownName}' failed: ${(err as Error).message}`,
						StatusCode.ERROR,
					);
				log('Derived-row validator rebuild for %s failed after schema change on %s (%s); installing poisoned validator',
					ownName, changed, error.message);
				plan.derivedRowValidator = makePoisonedDerivedRowValidator(validator, error);
			}
		}
	}

	/**
	 * Emit a synthetic `table_modified` event for `mv`'s backing table so any cached
	 * prepared-statement plan that reads the backing table directly invalidates →
	 * recompiles → re-hits the build-time `stale` guard in `building/select.ts`.
	 *
	 * A `select … from mv` compiled while the MV was NOT stale resolves to a
	 * `TableReference` against the maintained table itself, so its only schema
	 * dependency is that table. The *source* change event that marks the MV stale never
	 * names the maintained table, so without this emit the cached plan would re-run the
	 * scan and serve stale rows against a structurally-changed source — bypassing the
	 * guard a fresh prepare would hit. (A plan compiled while the MV is *already* stale
	 * is separately safe: the while-stale build-time re-validation resolves the body's
	 * source tables and records them as direct statement dependencies, so a later source
	 * change invalidates it without this emit — verified by the regression suite, which
	 * stays green even with the emit removed for that case.) The `Statement` listener
	 * maps `table_*` → `'table'` and matches on type + objectName (+ optional schemaName)
	 * only, ignoring the payload, so the maintained `TableSchema` is passed as both old/new.
	 *
	 * **Same-object payload contract (load-bearing coupling).** Passing the SAME object
	 * as `oldObject` and `newObject` is what keeps this synthetic event body-RELEVANT to
	 * `isBodyIrrelevantTableChange` (its reference-equality guard) — so it cascades
	 * staleness down an MV-over-MV chain instead of triggering the consumers'
	 * recompile-in-place path. Every genuine `table_modified` emitter passes distinct
	 * old/new objects. If this payload ever changes, change the classifier's guard with
	 * it (see the matching comment in runtime/emit/materialized-view-helpers.ts).
	 *
	 * Safety: the event names the maintained table itself, which is never in its OWN
	 * `sourceTables` (self-reference is rejected at create), so this manager's listener
	 * treats it as a no-op for a plain MV; for an MV-over-MV chain it conservatively
	 * cascades staleness down the producer→consumer DAG (acyclic — a consumer requires
	 * its producer to pre-exist), so the nested notification terminates. If the table
	 * lookup unexpectedly fails the MV is already in a broken state — skip the emit
	 * rather than fabricate a partial event.
	 */
	private emitBackingInvalidation(mv: MaintainedTableSchema): void {
		const backing = this.ctx.schemaManager.getTable(mv.schemaName, mv.name);
		if (!backing) {
			log('Skipping backing invalidation for %s.%s: backing table %s not found (MV already broken)',
				mv.schemaName, mv.name, mv.name);
			return;
		}
		this.ctx.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName: mv.schemaName,
			objectName: mv.name,
			oldObject: backing,
			newObject: backing,
		});
	}

	/**
	 * Compile + register an MV for row-time write-through maintenance. Always
	 * builds the maintenance plan via {@link buildMaintenancePlan}, which throws on a
	 * body that is not row-time maintainable — the create emitter rolls the MV back on
	 * throw, so an ineligible body errors cleanly at create time.
	 */
	registerMaterializedView(mv: MaintainedTableSchema): void {
		const key = mvKey(mv.schemaName, mv.name);
		// Cache the source-union change-scope so a `select` from this MV projects to
		// its sources in `analyzeChangeScope`: the backing table is maintained off the
		// user change log (synchronously at the DML boundary), so a `Database.watch`
		// on this MV must project to its sources rather than the never-change-logged
		// backing table. v1 is the conservative union of a `full` watch per source.
		mv.derivation.sourceScope = buildSourceUnionScope(mv.derivation.sourceTables);
		this.releaseRowTime(key);
		const plan = this.buildMaintenancePlan(mv); // throws on ineligible shape
		// Compile the declared-CHECK/FK derived-row validator (undefined when the
		// table declares nothing — the zero-overhead gate). Built here, inside the
		// registration the create/attach paths roll back on throw, so a constraint
		// that cannot compile (e.g. a non-deterministic CHECK without the pragma)
		// errors cleanly at create time.
		plan.derivedRowValidator = buildDerivedRowValidator(this.ctx as unknown as Database, mv);
		// Precompute the weakened-K′-column watch for row-time collision telemetry.
		// `undefined` unless this MV carries a coarsened backing key — the zero-overhead
		// gate that keeps a non-coarsened MV's maintenance path untouched (see
		// {@link detectAndReportCoarseningCollisions}).
		plan.coarseningWatch = this.buildCoarseningWatch(mv);
		this.rowTime.set(key, plan);
		// Index the plan under every source base it reads. Single-source arms index
		// under `sourceBase` only; the 1:1-join arm also indexes under the lookup base
		// so a write to `P` fires maintenance too (handled by the reverse residual).
		for (const base of planSourceBases(plan)) {
			let set = this.rowTimeBySource.get(base);
			if (!set) { set = new Set(); this.rowTimeBySource.set(base, set); }
			set.add(key);
		}
		log('Registered row-time materialized view %s.%s', mv.schemaName, mv.name);
	}

	/** Detach an MV's row-time plan + its source-base index entry (DROP path). */
	unregisterMaterializedView(schemaName: string, name: string): void {
		this.releaseRowTime(mvKey(schemaName, name));
	}

	/**
	 * Force-mark an MV stale: set the flag, detach its row-time plan, and invalidate
	 * cached prepared-statement plans reading its backing so the next reference
	 * re-hits the build-time stale guard. Mirrors the schema-change listener's stale
	 * transition exactly; exposed for the ALTER … RENAME propagation failure path
	 * (a dependent MV whose in-place body rewrite / backing rename / re-registration
	 * failed mid-way must not keep serving its backing as if live).
	 */
	markMaterializedViewStale(mv: MaintainedTableSchema): void {
		if (!mv.derivation.stale) {
			mv.derivation.stale = true;
			log('Marked materialized view %s.%s stale (forced)', mv.schemaName, mv.name);
		}
		this.releaseRowTime(mvKey(mv.schemaName, mv.name));
		this.emitBackingInvalidation(mv);
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
		for (const base of planSourceBases(plan)) {
			const set = this.rowTimeBySource.get(base);
			if (set) {
				set.delete(key);
				if (set.size === 0) this.rowTimeBySource.delete(base);
			}
		}
	}

	/* ──────────────────── convergence ordering ──────────────────── */

	/**
	 * The source bases (lowercased `schema.table`) an MV's body reads — the
	 * dependency edges {@link Database.refreshAllMaterializedViews} orders the
	 * convergence sweep on. A registered (live) MV reports its compiled plan's
	 * bases ({@link planSourceBases} — the same set `rowTimeBySource` indexes it
	 * under). A **stale** MV has no live plan (a body-relevant source change
	 * released it), so its bases come from the recorded
	 * {@link import('../schema/derivation.js').TableDerivation.sourceTables} — the
	 * body's source-table set captured at (re)registration and kept current
	 * through every reshape. That recorded set is identical to what re-planning
	 * the body would derive (the create/refresh path fills it from the same
	 * analysis), but never re-plans a stale body that may no longer plan — so the
	 * ordering pass cannot throw a planning error before the per-MV refresh
	 * surfaces the real staleness diagnostic.
	 */
	sourceBasesFor(mv: MaintainedTableSchema): readonly string[] {
		const plan = this.rowTime.get(mvKey(mv.schemaName, mv.name));
		return plan ? planSourceBases(plan) : mv.derivation.sourceTables;
	}

	/**
	 * All maintained tables in **source-dependency order**: a base MV precedes
	 * every MV whose body reads it (MV-over-MV — in the unified model a base MV's
	 * backing is a table under its own name, so a dependent's
	 * {@link sourceBasesFor} contains that qualified name). A sequential refresh
	 * sweep over this order is correct because refresh is commit-first per MV: a
	 * base MV's backing commits before a dependent's body re-reads it
	 * ({@link Database.refreshAllMaterializedViews}).
	 *
	 * Edges are `sourceBasesFor(mv)` intersected with the MV-key set (a non-MV
	 * source is no ordering constraint); Kahn's algorithm produces the order.
	 * Throws {@link StatusCode.INTERNAL} on a cycle — the create-time gates
	 * (`assertNoSelfReference` / `assertNoDerivationCycle`) reject recursive MVs,
	 * so a cycle here is an impossible-state backstop, never a silently dropped MV.
	 */
	materializedViewRefreshOrder(): MaintainedTableSchema[] {
		const mvs = this.ctx.schemaManager.getAllMaintainedTables();
		const byKey = new Map<string, MaintainedTableSchema>();
		for (const mv of mvs) byKey.set(mvKey(mv.schemaName, mv.name), mv);

		// Prerequisite count (in-degree) + reverse adjacency (base → consumers).
		const indegree = new Map<string, number>();
		const consumers = new Map<string, string[]>();
		for (const key of byKey.keys()) { indegree.set(key, 0); consumers.set(key, []); }

		for (const mv of mvs) {
			const key = mvKey(mv.schemaName, mv.name);
			const prereqs = new Set<string>();
			for (const base of this.sourceBasesFor(mv)) {
				const baseKey = base.toLowerCase();
				// A non-MV source is no ordering constraint; a self-edge is impossible
				// (create-time gate) — skip both, and dedup so a body reading a base
				// twice adds one edge.
				if (baseKey === key || !byKey.has(baseKey) || prereqs.has(baseKey)) continue;
				prereqs.add(baseKey);
				consumers.get(baseKey)!.push(key);
				indegree.set(key, indegree.get(key)! + 1);
			}
		}

		// Kahn: drain zero-in-degree keys in catalog-enumeration order (stable).
		const order: MaintainedTableSchema[] = [];
		const ready: string[] = [];
		for (const key of byKey.keys()) if (indegree.get(key) === 0) ready.push(key);
		while (ready.length > 0) {
			const key = ready.shift()!;
			order.push(byKey.get(key)!);
			for (const dep of consumers.get(key)!) {
				const next = indegree.get(dep)! - 1;
				indegree.set(dep, next);
				if (next === 0) ready.push(dep);
			}
		}

		if (order.length !== mvs.length) {
			throw new QuereusError(
				`materialized-view convergence ordering found a dependency cycle among maintained tables `
					+ `(ordered ${order.length} of ${mvs.length}) — recursive materialized views are rejected at create time`,
				StatusCode.INTERNAL,
			);
		}
		return order;
	}

	/* ──────────────────── coarsening collision telemetry ──────────────────── */

	/**
	 * Precompute the weakened-K′-column watch list for row-time collision telemetry —
	 * one entry per coarsening column of the MV's coarsened backing key. Returns
	 * `undefined` (the zero-overhead gate) unless `mv.derivation.coarsenedKey` is
	 * stamped with ≥1 weakened column: a provable-key or refining-lineage-key MV builds
	 * no watch, so {@link detectAndReportCoarseningCollisions} short-circuits and the
	 * maintenance path is untouched. Each weakened column name resolves to its backing
	 * column index via `mv.columnIndexMap` (the maintained table IS the backing table),
	 * carrying the source → output collations the divergence test needs.
	 */
	private buildCoarseningWatch(mv: MaintainedTableSchema): ReadonlyArray<CoarseningWatchColumn> | undefined {
		const coarsened = mv.derivation.coarsenedKey;
		if (!coarsened || coarsened.weakened.length === 0) return undefined;
		const watch: CoarseningWatchColumn[] = [];
		for (const w of coarsened.weakened) {
			const index = mv.columnIndexMap.get(w.column.toLowerCase());
			// Defensive: a weakened name that does not resolve to a backing column would
			// be a derivation/stamp inconsistency — skip it rather than mis-key the read.
			if (index === undefined) {
				log("Coarsening watch: weakened column '%s' not found on backing %s.%s; skipping",
					w.column, mv.schemaName, mv.name);
				continue;
			}
			watch.push({
				index,
				sourceCollation: w.sourceCollation,
				outputCollation: w.outputCollation,
				column: w.column,
			});
		}
		return watch.length > 0 ? watch : undefined;
	}

	/**
	 * Observe-only row-time collision telemetry: scan the **realized**
	 * {@link BackingRowChange}s a maintenance apply produced and queue a
	 * {@link MaintenanceCollisionEvent} for each one that is a key-coarsening collision —
	 * an `update` whose replaced backing row came from a **distinct source identity**
	 * than the incoming row's, merged under the coarsened backing key K′ (last-writer-win).
	 *
	 * **Zero-overhead gate.** Returns immediately unless `plan.coarseningWatch` is present
	 * (only a coarsened-key MV builds one). A non-coarsened MV never scans `backingChanges`.
	 *
	 * **Criterion.** For each `'update'` change, a weakened K′ column is *diverged* when its
	 * old/new backing values differ under the **source** (pre-coarsening, stricter) collation.
	 * An `update` here means the incoming row landed on an existing backing row sharing K′
	 * under the **output** collation (that is what made the upsert replacing, not inserting);
	 * if those rows are equal under the source collation it is the same source row's value
	 * being updated (e.g. an `email` change — not reported), and if they differ under the
	 * source collation two distinct source identities (`'Bob'`/`'bob'`) collapsed onto one
	 * backing key (reported). `insert`/`delete` changes are never collisions (new key / removal).
	 *
	 * Runs **independently** of the cascade — it neither consumes nor reorders the
	 * `backingChanges` routed onward (observe-only), so an MV-over-MV chain is unperturbed.
	 * The queued event rides the emitter's transaction batching, so a collision inside a
	 * rolled-back transaction reports nothing and does not increment the counter.
	 */
	private detectAndReportCoarseningCollisions(
		plan: MaintenancePlan,
		backingChanges: readonly BackingRowChange[],
	): void {
		const watch = plan.coarseningWatch;
		if (!watch) return;
		const coarsened = plan.mv.derivation.coarsenedKey;
		if (!coarsened) return; // defensive — a watch implies a stamped coarsenedKey
		// K′ key column indices (ALL key columns, in key order) for the event payload's `key`.
		// Resolved once for the whole batch; collisions are rare so this is off the hot path.
		const keyIndices = coarsened.columns.map(name => plan.mv.columnIndexMap.get(name.toLowerCase()) ?? -1);
		const emitter = this.ctx.getEventEmitter();
		for (const change of backingChanges) {
			if (change.op !== 'update') continue;
			const weakenedColumns: string[] = [];
			for (const w of watch) {
				if (compareSqlValues(change.oldRow[w.index], change.newRow[w.index], w.sourceCollation) !== 0) {
					weakenedColumns.push(w.column);
				}
			}
			if (weakenedColumns.length === 0) continue;
			const event: MaintenanceCollisionEvent = {
				schemaName: plan.backingSchema,
				tableName: plan.backingTableName,
				key: keyIndices.map(i => change.newRow[i]),
				weakenedColumns,
				oldRow: change.oldRow,
				newRow: change.newRow,
			};
			emitter.queueCollision(event);
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
	 *
	 * `deferred` is the optional per-statement deferred-rebuild set (MV keys). A
	 * `'full-rebuild'` plan re-evaluates the WHOLE body, so applying it per source row is
	 * O(rows × body) — pathological. When the DML boundary supplies a `deferred` set, a
	 * full-rebuild plan is instead marked dirty here (no per-row apply) and rebuilt exactly
	 * once at the end-of-statement {@link flushDeferredRebuilds} boundary. The bounded-delta
	 * arms stay per-row-immediate (cheap, and the covering-UNIQUE enforcement scan depends on
	 * their per-row backing visibility; a full-rebuild MV is never a covering structure, so
	 * deferring it cannot starve that scan). A cold caller without a `deferred` set falls
	 * through to an inline rebuild — a safe, unamortized fallback that the
	 * enforcement/eviction callers never actually reach (they never name a full-rebuild MV).
	 */
	async maintainRowTime(
		sourceBase: string,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
		deferred?: Set<string>,
		depth = 0,
	): Promise<void> {
		const changedBase = sourceBase.toLowerCase();
		const keys = this.rowTimeBySource.get(changedBase);
		if (!keys || keys.size === 0) return;
		for (const key of keys) {
			const plan = this.rowTime.get(key);
			if (!plan) continue;
			// Full-rebuild is the one deferred arm — mark dirty and drain at flush.
			if (plan.kind === 'full-rebuild' && deferred) {
				deferred.add(key);
				continue;
			}
			const backingChanges = await this.applyMaintenancePlan(plan, change, changedBase, cache);
			if (backingChanges.length === 0) continue;
			// Row-time coarsening collision telemetry: observe-only over the realized
			// delta (gated on `coarseningWatch` — a no-op for a non-coarsened MV). Runs
			// independently of the cascade below; it neither consumes nor reorders the
			// backing changes routed onward.
			this.detectAndReportCoarseningCollisions(plan, backingChanges);
			// Declared CHECK / child-side FK over the rows this delta wrote — BEFORE
			// cascading, so a consumer never consumes an invalid producer row. Every
			// row already in the backing was validated when it entered (the bulk
			// validation at create/attach seeds the induction), so only the delta is
			// validated. No-op (`undefined`) for a constraint-less table.
			if (plan.derivedRowValidator) {
				await this.validateDerivedChanges(plan, plan.derivedRowValidator, backingChanges, cache);
			}
			// Parent-side referential enforcement: this maintenance delete/key-update of an
			// `M` row may orphan rows in an ordinary table `C` whose FK references `M`. Fire
			// the shared engine over the backing delta — RESTRICT-walk then declared actions —
			// after `M`'s own image is validated, before the MV-over-MV cascade. Runs whether
			// or not `M` has MV consumers (placed before the leaf fast-path).
			await this.enforceParentSideReferentialActions(plan, backingChanges);
			const backingBase = `${plan.backingSchema}.${plan.backingTableName}`.toLowerCase();
			if (!this.rowTimeBySource.has(backingBase)) continue; // leaf — no dependents
			this.assertCascadeDepth(depth + 1, backingBase);
			for (const bc of backingChanges) {
				await this.maintainRowTime(backingBase, bc, cache, deferred, depth + 1);
			}
		}
	}

	/**
	 * Flush the per-statement deferred full-rebuild set at the end-of-statement boundary:
	 * rebuild every dirtied full-rebuild MV exactly once (not once per source row) and
	 * cascade each rebuild's effective {@link BackingRowChange}(s) onward so MV-over-MV
	 * consumers converge.
	 *
	 * Drained as a worklist over the producer→consumer DAG. Each rebuild calls
	 * {@link applyFullRebuild} (re-run the whole body against live mid-transaction source
	 * state → a `'replace-all'` diff) and routes the realized delta back through
	 * {@link maintainRowTime} with the SAME `deferred` set: an incremental consumer applies
	 * inline; a full-rebuild consumer re-dirties into the drain (rebuilt in a later round,
	 * after its producer's delta has landed). The drain proceeds in **rounds** — each round
	 * snapshots the current dirty set, clears it, and rebuilds each member, collecting the
	 * next round's re-dirties — so a consumer is never permanently stale (a producer rebuilt
	 * in the same round re-dirties it for the next), and convergence takes at most one round
	 * per level of the full-rebuild sub-DAG.
	 *
	 * Termination: the dependency DAG is acyclic (a consumer MV requires its producer to
	 * pre-exist), so the longest full-rebuild chain — hence the round count — is bounded by
	 * the registered-row-time-MV count. Exceeding it signals a structurally-impossible cycle
	 * and fails loud ({@link assertFlushRounds}) — the worklist analogue of
	 * {@link assertCascadeDepth}. This should never fire.
	 *
	 * The DML executor calls this INSIDE the statement-atomicity savepoint (after the row
	 * loop, before the savepoint release), so a failed rebuild rolls the whole statement
	 * back. An empty set is a no-op (no overhead on statements touching no full-rebuild MV).
	 */
	async flushDeferredRebuilds(
		deferred: Set<string>,
		cache?: BackingConnectionCache,
	): Promise<void> {
		let round = 0;
		while (deferred.size > 0) {
			this.assertFlushRounds(++round);
			const batch = [...deferred];
			deferred.clear();
			for (const key of batch) {
				const plan = this.rowTime.get(key);
				// Only full-rebuild plans are ever deferred; a non-full-rebuild key (or a
				// plan released mid-flush) is a no-op. Defensive — `maintainRowTime` only
				// ever adds `'full-rebuild'` keys.
				if (!plan || plan.kind !== 'full-rebuild') continue;
				const backingChanges = await this.applyFullRebuild(plan, cache);
				if (backingChanges.length === 0) continue;
				// Coarsening collision telemetry over the rebuild diff — the full-rebuild
				// floor's collation-keyed `replace-all` realizes the same LWW merge as the
				// bounded-delta arms (observe-only; gated on `coarseningWatch`).
				this.detectAndReportCoarseningCollisions(plan, backingChanges);
				// Validate the rebuild diff's written images at the flush boundary —
				// the full-rebuild analogue of the per-row validation in
				// {@link maintainRowTime} (deferred-rebuild semantics preserved: a bulk
				// source write fails once at end-of-statement, not per source row).
				if (plan.derivedRowValidator) {
					await this.validateDerivedChanges(plan, plan.derivedRowValidator, backingChanges, cache);
				}
				// Parent-side referential enforcement for the rebuild diff's deletes/key-updates,
				// fired inside the statement-atomicity savepoint (the flush runs before its
				// release) so a RESTRICT failure or cascade error unwinds the whole statement.
				await this.enforceParentSideReferentialActions(plan, backingChanges);
				const backingBase = `${plan.backingSchema}.${plan.backingTableName}`.toLowerCase();
				if (!this.rowTimeBySource.has(backingBase)) continue; // leaf — no dependents
				for (const bc of backingChanges) {
					// Cascade at depth 0: an incremental consumer applies inline (its own
					// `assertCascadeDepth` backstops that recursion); a full-rebuild consumer
					// re-dirties `deferred` for the next round.
					await this.maintainRowTime(backingBase, bc, cache, deferred);
				}
			}
		}
	}

	/**
	 * Round backstop for {@link flushDeferredRebuilds}. The full-rebuild sub-DAG is acyclic,
	 * so the drain converges in at most one round per chain level — bounded by the row-time
	 * MV count. A round count beyond that (`+1` slack for an initial dirty set already
	 * spanning multiple levels) signals a structural impossibility (a cycle) — fail loud
	 * rather than spin. This should never fire.
	 */
	private assertFlushRounds(round: number): void {
		if (round > this.rowTime.size + 1) {
			throw new QuereusError(
				`materialized-view deferred-rebuild flush exceeded maximum rounds (${this.rowTime.size + 1}) — `
					+ `a row-time dependency cycle should be structurally impossible`,
				StatusCode.INTERNAL,
			);
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
	 * yields `'inverse-projection'` (covering-index shape), `'residual-recompute'`
	 * (single-source aggregate), `'prefix-delete'` (single-source lateral-TVF fan-out), and
	 * `'full-rebuild'` (the floor — re-evaluate the whole body and replace the backing). The
	 * floor ignores the specific `change` (it rebuilds wholesale); the others derive a
	 * bounded per-row delta from it.
	 */
	private async applyMaintenancePlan(
		plan: MaintenancePlan,
		change: BackingRowChange,
		changedBase: string,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		switch (plan.kind) {
			case 'inverse-projection':
				return this.applyInverseProjection(plan, change, cache);
			case 'residual-recompute':
				return this.applyForwardResidual(plan, change, cache);
			case 'prefix-delete':
				return this.applyPrefixDelete(plan, change, cache);
			case 'join-residual':
				return this.applyJoinResidual(plan, change, changedBase, cache);
			case 'full-rebuild':
				return this.applyFullRebuild(plan, cache);
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
	 * `applyRowTimeChange`, plus the equal-image short-circuit: an UPDATE whose old and
	 * new projected images are value-identical (both in scope) projects to NO backing
	 * delta — the dominant no-op echo (a source update touching only unprojected columns,
	 * or rewriting a projected column to its existing value) is suppressed before any
	 * backing-connection work. Accurate by the maintenance invariant (the backing row IS
	 * the old image's projection), so nothing would have changed; the host's
	 * value-identical upsert skip (vtab/backing-host.ts) remains the effective-state
	 * backstop for the paths that do emit ops.
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
			// UPDATE: a both-in-scope, same-backing-key change is one upsert (the host
			// reports a single `update`); otherwise delete the old image if it was in
			// scope and upsert the new image if it is — predicate-scope transitions and
			// key-changing updates are genuinely two-sided. The scope check reads the
			// SOURCE row (the predicate may reference unprojected columns), so both
			// images must be in scope for the equal-image short-circuit.
			const oldIn = inScope(change.oldRow);
			const newIn = inScope(change.newRow);
			if (oldIn && newIn) {
				const oldImage = project(change.oldRow);
				const newImage = project(change.newRow);
				// Byte-faithful identity (rowsValueIdentical): subsumes key equality, and a
				// collation-equal / byte-different image is NOT suppressed (it must re-key
				// the stored bytes) — the same discipline as the host-level upsert skip.
				if (rowsValueIdentical(oldImage, newImage)) return [];
				if (this.backingPkEqual(plan.backingPkDefinition, oldImage, newImage)) {
					// Same backing key (collation-aware — a collation-equal / byte-different
					// key is the SAME btree identity, and the upsert re-keys the stored
					// bytes): one upsert replaces the row wholesale, so the host reports
					// a single `update` — matching the residual arms' post-suppression
					// shape (one cascade dispatch, one change-log entry, no secondary-index
					// churn from a delete+insert at an unchanged key).
					ops.push({ kind: 'upsert', row: newImage });
				} else {
					ops.push({ kind: 'delete-key', key: keyOf(oldImage) });
					ops.push({ kind: 'upsert', row: newImage });
				}
			} else {
				if (oldIn) ops.push({ kind: 'delete-key', key: keyOf(project(change.oldRow)) });
				if (newIn) ops.push({ kind: 'upsert', row: project(change.newRow) });
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
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return host.applyMaintenance(connection, ops);
	}

	/**
	 * Validate the row images a maintenance apply WROTE (insert/update
	 * {@link BackingRowChange}s — a delete writes no image) against the plan's
	 * compiled {@link DerivedRowConstraintValidator}. Inline checks abort the
	 * writing statement with the maintained-table-attributed CONSTRAINT error;
	 * auto-deferred checks (subquery CHECK, every child-side FK) queue to the
	 * deferred-constraint queue and validate at commit. Deferred entries are
	 * pinned to the backing connection the maintenance write used (resolved from
	 * the per-statement cache, or re-resolved deterministically — the same
	 * connection either way) so commit-time evaluation reads the same pending
	 * state, mirroring the DML pipeline's active-connection capture.
	 */
	private async validateDerivedChanges(
		plan: MaintenancePlan,
		validator: DerivedRowConstraintValidator,
		changes: readonly BackingRowChange[],
		cache?: BackingConnectionCache,
	): Promise<void> {
		let connectionId: string | undefined;
		if (validator.checks.some(c => c.needsDeferred)) {
			const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
			if (backing) {
				const host = this.backingHost(backing);
				const conn = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
				connectionId = conn.connectionId;
			}
		}
		for (const change of changes) {
			if (change.op === 'delete') continue;
			await validateDerivedRowImage(this.ctx as unknown as Database, validator, change.newRow, connectionId);
		}
	}

	/**
	 * Fire **parent-side** referential enforcement over the backing rows a maintenance
	 * apply REMOVED or re-keyed (delete / key-update {@link BackingRowChange}s — an insert
	 * has no parent-side action). When the maintained table `M` is the PARENT (FK target)
	 * of an FK declared on an ordinary table `C` (`create table C (… references M(col) …)`),
	 * a maintenance-driven delete/key-update of the referenced `M` row would silently orphan
	 * `C`'s rows, bypassing the declared RESTRICT / referential action. This is the
	 * **dual** of {@link validateDerivedChanges} (constraints declared *on* `M`); the FK here
	 * lives on `C` and references `M`, so it is invisible to `M`'s own plan/validator.
	 *
	 * It reuses the SAME shared referential-action engine the DML executor and the
	 * external-change ingestion seam use — no third copy — applying its two functions over
	 * each backing change exactly as `database-external-changes.ts` does:
	 *  - {@link assertTransitiveRestrictsForParentMutation} — pre-walk the transitive cascade
	 *    closure and throw a CONSTRAINT error naming `M` on any surviving RESTRICT child;
	 *  - {@link executeForeignKeyActionsAndLens} — run declared CASCADE / SET NULL / SET DEFAULT,
	 *    re-entering the DML executor (the already-holding-the-mutex variant) for each cascaded
	 *    child write, so `C`'s own constraints, watches, nested cascades, and (if `C` is itself
	 *    an MV source) its own maintenance all fire.
	 *
	 * Ordering: called AFTER the backing delta has landed in the pending layer (the RESTRICT
	 * walk runs POST-application — the child rows it keys off still exist because the cascade
	 * has not run yet) and AFTER `M`'s own image is validated, matching the DML executor's
	 * per-change order (capture → MV maintenance → FK actions) and the external-changes seam.
	 * `lensRouted = false`: a maintenance backing write is a physical basis write (maintained
	 * tables are not lens basis spines). A surviving RESTRICT throws up through
	 * {@link maintainRowTime} → the DML executor → the statement, rolling back the source write
	 * attributed to `M`.
	 *
	 * Gate: a cheap `foreign_keys`-pragma early-return keeps the pragma-off path free (the
	 * engine also early-returns, but skipping the `getTable` + loop avoids all per-change work).
	 * NOT gated on `plan.derivedRowValidator` — that gate is child-side (constraints *on* `M`);
	 * an inbound FK lives on `C` and leaves `M`'s plan untouched. Beyond the gate it fires
	 * unconditionally per delete/update change, but the engine no longer pays an `O(catalog)`
	 * scan: both calls route through `SchemaManager.getReferencingForeignKeys`, the precomputed
	 * reverse-FK index, so an `M` that nothing references resolves to the shared empty bucket and
	 * each call early-returns in O(1) — a maintained table with no inbound FK (the common case)
	 * pays only the pragma check plus one map lookup per delete/key-update change.
	 */
	private async enforceParentSideReferentialActions(
		plan: MaintenancePlan,
		changes: readonly BackingRowChange[],
	): Promise<void> {
		const db = this.ctx as unknown as Database;
		if (!db.options.getBooleanOption('foreign_keys')) return; // cheap gate; engine early-returns too
		// The backing `TableSchema` — same object validateDerivedChanges resolves; its `.name`
		// equals `M`'s, so an FK on `C` (`references M`) matches the engine's referencing scan.
		const parent = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!parent) return; // backing gone ⇒ MV already broken
		for (const change of changes) {
			if (change.op === 'insert') continue; // inserts have no parent-side actions
			await assertTransitiveRestrictsForParentMutation(db, parent, change.op, change.oldRow, change.newRow);
			await executeForeignKeyActionsAndLens(db, parent, change.op, change.oldRow, change.newRow);
		}
	}

	/**
	 * Resolve the {@link BackingHost} capability surface for a backing table —
	 * see `vtab/backing-host.ts` for the contract. The host is resolved fresh per
	 * use (a map lookup on the owning module), so a drop+recreate of the backing
	 * always yields the new incarnation's host.
	 */
	private backingHost(backing: TableSchema): BackingHost {
		// The ctx IS the Database (same construction as buildMaintenancePlan's cast).
		return resolveBackingHost(this.ctx as unknown as Database, backing);
	}

	/**
	 * Obtain (lazily create + register) the backing table's
	 * {@link VirtualTableConnection} for the current transaction. Reuses the same
	 * connection a `select` from the MV resolves to (so reads-own-writes holds) —
	 * matched among the Database's registered connections by
	 * {@link BackingHost.ownsConnection}, which is pinned to the live backing
	 * incarnation; a freshly created connection is registered with the Database so
	 * the coordinated commit/rollback covers its pending state in lockstep with the
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
		host: BackingHost,
		qualifiedName: string,
		cache?: BackingConnectionCache,
	): Promise<VirtualTableConnection> {
		const cacheKey = qualifiedName.toLowerCase();
		const cached = cache?.get(cacheKey);
		if (cached) return cached;
		for (const c of this.ctx.getConnectionsForTable(qualifiedName)) {
			if (host.ownsConnection(c)) {
				cache?.set(cacheKey, c);
				return c;
			}
		}
		const conn = host.connect();
		await this.ctx.registerConnection(conn);
		cache?.set(cacheKey, conn);
		return conn;
	}

	/**
	 * Build the row-time maintenance plan for an MV — **cost-gated, with a floor, never a
	 * shape allowlist**. The builder tries to match a bounded-delta arm by shape
	 * ({@link tryBuildBoundedDeltaArm}); a body that matches **none** falls through to the
	 * always-correct {@link buildFullRebuildPlan} floor (re-evaluate the whole body, replace
	 * the backing transactionally). **No body is rejected for its shape.** Only four
	 * create-time rejections remain, all non-shape:
	 *  - a **non-deterministic** body without `pragma nondeterministic_schema` — a hard reject
	 *    in the matched arm (so the arm-specific determinism diagnostic survives) or, for a
	 *    body matching no arm, in the floor's whole-body determinism check;
	 *  - a **bag** (no provable unique key) — the floor's `keysOf` reject (a duplicate-producing
	 *    body usually fails the set contract earlier, at create-fill);
	 *  - a body with **no relational output**;
	 *  - a **full-rebuild-only body over a source past the size threshold**
	 *    ({@link isFullRebuildPathological}, the `materialized_view_rebuild_row_threshold` option).
	 *
	 * The single source may itself be another MV's backing table (an MV-over-MV body):
	 * `building/select.ts` rewrites a reference to `mv1` into a `TableReference` against
	 * `mv1`'s backing table, so the source base is `mv1`'s backing base and the same checks
	 * evaluate against the (keyed `memory`) backing schema unchanged. A write to `mv1` then
	 * drives `mv2` via the cascade in {@link maintainRowTime}.
	 *
	 * Eligibility is a *cost choice* among the body's structurally-sound strategies
	 * ({@link selectMaintenanceStrategy}): the bounded-delta arms are preferred by the argmin
	 * cost gate, and full-rebuild is selected exactly when no bounded-delta arm is sound (an
	 * empty sound set resolves to the floor) — so an existing eligible shape is unaffected.
	 */
	private buildMaintenancePlan(mv: MaintainedTableSchema): MaintenancePlan {
		const db = this.ctx as unknown as Database;
		// Analyze the MV's own body to compile maintenance; suppress the read-side
		// rewrite so the body stays over its SOURCE table, not re-pointed at this
		// MV's backing (which the maintenance plan is what keeps consistent).
		const analyzed = db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
			const { plan } = this.ctx._buildPlan([mv.derivation.selectAst as AST.Statement]);
			return this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;
		});

		// Try a bounded-delta arm; a shape that fits none falls through to the floor.
		const boundedDelta = this.tryBuildBoundedDeltaArm(mv, analyzed);
		return boundedDelta ?? this.buildFullRebuildPlan(mv, analyzed);
	}

	/**
	 * Route the analyzed body to the matching bounded-delta arm, or return `null` when its
	 * shape fits **no** bounded-delta arm (the caller then builds the full-rebuild floor).
	 * Each arm builder likewise returns `null` on a sub-shape mismatch and falls through
	 * here. The arms keep only **determinism** as a hard reject (so their arm-specific
	 * determinism diagnostic survives — see the individual builders); every other mismatch
	 * is a `null` fall-through. Bag / no-output / size rejects live in the floor.
	 */
	private tryBuildBoundedDeltaArm(mv: MaintainedTableSchema, analyzed: BlockNode): MaintenancePlan | null {
		// A body that reads no source table has no bounded-delta arm → floor (which rejects
		// a sourceless body). (A self-join / TVF fan-out surfaces ≥2 refs or a TVF node.)
		const tableRefs = [...collectTableRefs(analyzed).values()];
		if (tableRefs.length === 0) return null;

		// Shapes no bounded-delta arm models — a window function reads across the partition,
		// set ops / recursive CTEs / DISTINCT / row caps are out of the bounded-delta model.
		// They are NOT rejected: a deterministic, keyed such body is maintained by the floor.
		if (containsNodeType(analyzed, PlanNodeType.Window)) return null;
		if (containsNodeType(analyzed, PlanNodeType.Distinct)) return null;
		if (containsNodeType(analyzed, PlanNodeType.SetOperation)) return null;
		if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) return null;
		if (mv.derivation.selectAst.type === 'select' && (mv.derivation.selectAst.limit !== undefined || mv.derivation.selectAst.offset !== undefined)) {
			return null;
		}

		const tableRef = tableRefs[0];
		const sourceSchema = tableRef.tableSchema;
		const sourceBase = `${sourceSchema.schemaName}.${sourceSchema.name}`.toLowerCase();

		// Single base source `T` joined to ONE lateral table-valued function — a fan-out
		// body (each base row produces N backing rows) → the prefix-delete arm. Routed
		// *before* the generic join branch below, because a lateral fan-out surfaces BOTH a
		// Join and a TableFunctionCall. A multi-base TVF body falls to the floor.
		if (containsNodeType(analyzed, PlanNodeType.TableFunctionCall)) {
			if (tableRefs.length !== 1) return null;
			return this.buildLateralTvfPrefixDeletePlan(mv, analyzed, tableRef, sourceBase);
		}

		// Any join → the provably-1:1 join-residual arm. A fanning (non-1:1) join, an outer
		// join, a >2-source join, an aggregate over a join, or a partial WHERE returns `null`
		// from the builder → floor. (The lateral-TVF fan-out above is matched first because
		// it also surfaces a join node.)
		if (containsAnyJoin(analyzed)) {
			return this.buildJoinResidualPlan(mv, analyzed, tableRefs);
		}
		// A non-join multi-source body (e.g. a WHERE-subquery over a second table) has no
		// bounded-delta arm → floor.
		if (tableRefs.length > 1) return null;

		// Single-source aggregate (`group by` over bare columns) → residual-recompute arm.
		// Each changed source row belongs to exactly one group; maintenance recomputes that
		// group's backing row from live state. A scalar aggregate (no GROUP BY) falls to the
		// floor.
		const aggregate = findAggregate(analyzed);
		if (aggregate) {
			return this.buildAggregateResidualPlan(mv, analyzed, tableRef, sourceBase, aggregate);
		}

		// The covering-index shape → inverse-projection arm (the default single-source arm).
		return this.buildInverseProjectionPlan(mv, analyzed, tableRef, sourceBase);
	}

	/**
	 * Build an `'inverse-projection'` plan for the covering-index shape: a single
	 * row-preserving source `T` with a primary key, a linear
	 * `TableReference → optional Filter → Project → optional Sort` body, a projection that
	 * resolves every source PK column (and every backing-key column) to a **passthrough**
	 * source column — non-key columns may instead be a **deterministic scalar expression**
	 * over the source row — and a partial WHERE evaluable on a single source row. Returns
	 * `null` on any **shape** mismatch (the caller falls through to the full-rebuild floor);
	 * a **non-deterministic** computed column is the one hard reject (its arm-specific
	 * determinism diagnostic must survive rather than fall through to the floor's generic one).
	 */
	private buildInverseProjectionPlan(
		mv: MaintainedTableSchema,
		analyzed: BlockNode,
		tableRef: TableReferenceNode,
		sourceBase: string,
	): MaintenancePlan | null {
		const db = this.ctx as unknown as Database;
		const sourceSchema = tableRef.tableSchema;

		const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
		if (sourcePkCols.length === 0) return null; // source has no PK → floor

		const backing = this.ctx._findTable(mv.name, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
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
		//
		// "Passthrough" is value-preserving lineage (`resolveValuePreservingSourceCol`):
		// a bare column reference, OR one wrapped in `collate` / a no-op `cast` — those
		// wrappers copy the source VALUE verbatim, so the column-copy maintenance is
		// exact. This is what lets the collation-weakening migration shape (`select b
		// collate nocase as b from t`) register here with its coarsened backing key:
		// the per-row upsert is keyed under the backing PK's (output) collation, so a
		// colliding source row last-write-wins into the shared backing row, and a
		// delete of one colliding sibling removes the shared row (the documented
		// anomaly — docs/materialized-views.md § Coarsened backing keys).
		const sourceAttrToCol = new Map<number, number>();
		const sourceDescriptor: RowDescriptor = [];
		tableRef.getAttributes().forEach((a, i) => {
			sourceAttrToCol.set(a.id, i);
			sourceDescriptor[a.id] = i;
		});
		const producingByAttrId = collectProducingExprs(analyzed);
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) return null; // no relational output → floor (which hard-rejects it)

		const projectors: BackingProjector[] = [];
		for (let outCol = 0; outCol < rootAttrs!.length; outCol++) {
			const attr = rootAttrs![outCol];
			const sourceCol = attr ? resolveValuePreservingSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
			if (sourceCol !== undefined) {
				projectors.push({ kind: 'passthrough', sourceCol });
				continue;
			}
			// Computed column: a deterministic scalar over the source row. A
			// non-deterministic producer is a HARD reject (the arm-specific determinism
			// diagnostic must survive — so `random()` fails on *determinism*, not by silently
			// falling to a still-rejected floor); a deterministic-but-unsupported *shape*
			// (no resolvable producer, a subquery / cross-row reference, an async form)
			// returns `null` → the floor.
			const colName = attr?.name ?? `#${outCol}`;
			const producing = attr ? producingByAttrId.get(attr.id) : undefined;
			if (!producing) return null;
			const det = checkDeterministic(producing);
			if (!det.valid) {
				throw cannotMaterialize(mv.name,
					`it projects a non-deterministic expression column '${colName}' (${det.expression}); `
						+ `a row-time backing value must be reproducible from the source row`);
			}
			if (!isSingleRowEvaluable(producing, sourceDescriptor)) return null;
			let evalFn: (row: Row) => SqlValue;
			try {
				evalFn = compileSourceRowEvaluator(db, producing, sourceDescriptor);
			} catch {
				return null; // not row-time maintainable as a single-row scalar → floor
			}
			projectors.push({ kind: 'expr', eval: evalFn });
		}

		// Every source PK column must be projected as a passthrough column so the backing
		// key is a deterministic identity of the source row that `lookupCoveringConflicts`
		// can invert. A PK column produced only via an expression (or not at all) breaks
		// that recovery.
		const passthroughSourceCols = new Set(
			projectors.flatMap(p => p.kind === 'passthrough' ? [p.sourceCol] : []),
		);
		for (const pk of sourcePkCols) {
			if (!passthroughSourceCols.has(pk)) return null; // PK not passthrough-projected → floor
		}

		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// A computed column may never land in the backing primary key: the btree keys on
		// it and `lookupCoveringConflicts` recovers the source PK from it, both of which
		// require a passthrough source-column identity.
		for (const d of backingPkDefinition) {
			if (projectors[d.index]?.kind !== 'passthrough') return null; // computed backing-key col → floor
		}

		// Partial WHERE must be evaluable on a single source row (no subqueries /
		// cross-row references). `compilePredicate` throws on unsupported forms; an
		// unsupported WHERE shape falls to the floor.
		let predicate: CompiledPredicate | undefined;
		const bodyWhere = mv.derivation.selectAst.type === 'select' ? mv.derivation.selectAst.where : undefined;
		if (bodyWhere) {
			try {
				predicate = compilePredicate(bodyWhere, sourceSchema.columns);
			} catch {
				return null; // WHERE not evaluable on a single source row → floor
			}
		}

		// ── Cost gate (incremental-maintenance-cost-gate) ──
		// The covering-index shape's only structurally-sound maintenance strategy is
		// 'inverse-projection' (O(1) per changed row); 'full-rebuild' is the floor for bodies
		// this arm did NOT match (reached via the `null` fall-through above), so it is not a
		// competitor here. Eligibility is thus a cost choice among the sound strategies (argmin
		// maintenanceCost); for this shape it resolves to inverse-projection while recording the
		// choice + the cost inputs the runtime reuses.
		const soundStrategies: MaintenanceStrategy[] = ['inverse-projection'];
		const sourceStats = this.estimateMaintenanceStats(sourceSchema, projectors.length, predicate !== undefined);
		// Create-time change-cardinality estimate: ~1% of the source per statement (typical OLTP).
		const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
		const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);

		// Defensive: this arm's sound set is exactly ['inverse-projection']. A different choice
		// would mean the set grew without the corresponding apply-arm — fail loud rather than
		// register an unexecutable plan.
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
			backingTableName: mv.name,
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
	 * or return `null` on a shape mismatch (the caller falls through to the full-rebuild
	 * floor). Each changed source row belongs to exactly one group `(g1,…)`; maintaining the
	 * MV means recomputing that group's backing row from live state — delete the old slice,
	 * run the group-keyed residual, upsert the recomputed slice (zero rows when the group
	 * emptied). See {@link ResidualRecomputePlan} and `docs/incremental-maintenance.md`
	 * § residual-recompute.
	 *
	 * A **non-deterministic** group/aggregate expression is the one hard reject (the
	 * arm-specific determinism diagnostic must survive); every other mismatch — a scalar
	 * aggregate, a computed group key, a backing key that is not the group key — returns
	 * `null` → the floor.
	 *
	 * NOTE: the group binding is derived **directly** from the aggregate node's bare GROUP
	 * BY columns, not via `extractBindings`. `analyzeRowSpecific`'s `'group'` classification
	 * additionally requires the group key to cover a *source* unique key (so it reports
	 * `'global'` for the common `group by <non-key>` body), which is the wrong test here —
	 * the backing is keyed by the group key regardless of whether it is a source key.
	 */
	private buildAggregateResidualPlan(
		mv: MaintainedTableSchema,
		analyzed: BlockNode,
		tableRef: TableReferenceNode,
		sourceBase: string,
		aggregate: AggregateLike,
	): MaintenancePlan | null {
		// A scalar aggregate (no GROUP BY) is one global row keyed by the empty key — no
		// bounded-delta group binding, so it falls to the floor.
		if (aggregate.groupBy.length === 0) return null;

		// Map T's output attributes to source column indices. T is a bare
		// `TableReferenceNode`, so output-column index == source-column index.
		const sourceAttrToCol = new Map<number, number>();
		tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
		const producingByAttrId = collectProducingExprs(analyzed);

		// Transitive provenance: chase output-attr → producing ColumnReference chains
		// (Project-over-Aggregate adds a hop the single-hop `resolveSourceCol` cannot
		// follow) until landing on a T source column, or `undefined`.
		const resolveToSourceCol = (attrId: number): number | undefined =>
			resolveTransitiveSourceCol(attrId, sourceAttrToCol, producingByAttrId);

		// Each GROUP BY expression must be a bare source column (a computed group key has
		// no source-column index to bind / key the backing on) → otherwise the floor.
		const groupColumns: number[] = [];
		for (const expr of aggregate.groupBy) {
			if (!(expr instanceof ColumnReferenceNode)) return null;
			const sourceCol = sourceAttrToCol.get((expr as ColumnReferenceNode).attributeId);
			if (sourceCol === undefined) return null;
			groupColumns.push(sourceCol);
		}

		// Determinism: a residual must reproduce exactly what `select <body>` returns, so a
		// volatile group/aggregate expression (random()/now()/volatile UDF) is a HARD reject.
		for (const expr of aggregate.groupBy) {
			const det = checkDeterministic(expr);
			if (!det.valid) throw cannotMaterialize(mv.name, `it groups by a non-deterministic expression (${det.expression})`);
		}
		for (const agg of aggregate.aggregates) {
			const det = checkDeterministic(agg.expression);
			if (!det.valid) throw cannotMaterialize(mv.name, `it aggregates a non-deterministic expression (${det.expression})`);
		}

		// Backing table + its physical PK. The aggregate's group-key FD
		// (`propagateAggregateFds`) makes the group key the backing key (via `keysOf`).
		const backing = this.ctx._findTable(mv.name, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// Map each backing-PK column back to the source group column it projects, so a
		// changed row's old backing-slice delete key can be built. Every backing-PK column
		// MUST resolve to a GROUP BY source column — else the backing key is not the group
		// key and point-keyed delete+upsert would be unsound → fall to the floor.
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) return null;
		const groupColumnSet = new Set(groupColumns);
		const backingPkSourceCols: number[] = [];
		for (const d of backingPkDefinition) {
			const attr = rootAttrs[d.index];
			const sourceCol = attr ? resolveToSourceCol(attr.id) : undefined;
			if (sourceCol === undefined || !groupColumnSet.has(sourceCol)) return null;
			backingPkSourceCols.push(sourceCol);
		}

		// Compile + cache the group-keyed residual once (the body with `g1 = :gk0 AND …`
		// injected on T). Re-run per affected group key against the live transaction.
		const relKey = `${sourceBase}#${tableRef.id ?? 'unknown'}`;
		const residualScheduler = this.compileResidual(analyzed, relKey, groupColumns, 'gk');
		if (!residualScheduler) return null; // could not parameterize the residual → floor

		// ── Cost gate ──
		// The residual is the structurally-sound incremental arm for an aggregate body;
		// 'full-rebuild' is the always-correct floor for shapes where the residual is NOT
		// sound, so (as with inverse-projection) it is not a competitor here. We still
		// record the chosen strategy + cost inputs for parity with the substrate.
		const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
		const hasPredicate = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
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
			backingTableName: mv.name,
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
	 * Build a `'join-residual'` plan for a provably-1:1 row-preserving **inner/cross join**
	 * body (`select … from T join P on T.fk = P.id`), or return `null` on a shape mismatch
	 * (the caller falls through to the full-rebuild floor). The driving table `T` is the one
	 * whose PK the optimizer surfaced as the backing key (the 1:1 join collapses the composite
	 * product key to `T`'s PK); the other base ref is the lookup `P`. See {@link JoinResidualPlan}
	 * and `docs/incremental-maintenance.md` § join-residual.
	 *
	 * Soundness gates (a mismatch on any returns `null` → floor): exactly two base tables; no
	 * aggregate over the join; the backing PK is exactly `T`'s PK projected as passthrough
	 * columns (so each changed `T` row maps to one backing row and the reverse residual's rows
	 * carry the backing key); the join is provably 1:1 on `T` ({@link proveOneToOneJoin} — no
	 * row loss via NOT-NULL FK→PK RI, no fan-out via the join-frame `isUnique(T.pk)`); and the
	 * join is **inner/cross** (an outer join would make the lookup-side reverse residual unsound
	 * — filtering `P` drops the null-extended rows). A **non-deterministic** projection is the
	 * one hard reject (its arm-specific determinism diagnostic must survive).
	 *
	 * **A body WHERE is now accepted** (it is no longer a blanket reject): the predicate is
	 * classified by which base table(s) its columns reference (reusing the per-base-ref
	 * attribute→source-column maps below). A `T`-only predicate needs nothing extra — the
	 * forward residual already carries it and the membership set `{ T : T.fk = P.pk }` cannot
	 * move on a `P` write, so the lookup side stays upsert-only. A predicate referencing `P` (or
	 * both sides) switches the lookup side to a **delete-capable** reverse residual by building
	 * `lookupMembershipResidualScheduler` (the body with the WHERE stripped, keyed on `P`). See
	 * {@link JoinResidualPlan}'s "WHERE handling" note and {@link applyLookupResidual}.
	 */
	private buildJoinResidualPlan(
		mv: MaintainedTableSchema,
		analyzed: BlockNode,
		tableRefs: TableReferenceNode[],
	): MaintenancePlan | null {
		// A >2-source join or an aggregate over the join has no join-residual binding → floor.
		// A body WHERE is no longer rejected here — it is classified (T-only vs P-referencing)
		// below, after `T`/`P` are identified, and routed to the matching lookup-side strategy.
		if (tableRefs.length !== 2) return null;
		if (findAggregate(analyzed)) return null;

		const backing = this.ctx._findTable(mv.name, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) return null;
		const producingByAttrId = collectProducingExprs(analyzed);

		// Per-base-ref attribute → source-column maps. `T` and `P` are bare
		// TableReferenceNodes (output-col index == source-col index).
		const refInfos = tableRefs.map(ref => {
			const attrToCol = new Map<number, number>();
			ref.getAttributes().forEach((a, i) => attrToCol.set(a.id, i));
			return { ref, attrToCol };
		});

		// Identify the driving table `T` as the one every backing-PK column resolves to, and
		// map each backing-PK column to its `T` source column (the delete key the forward arm
		// builds). A backing-PK column resolving to neither ref — or columns spanning both —
		// means the backing is not keyed on a single source's PK (the join is not provably
		// 1:1, or `keysOf` fell back to all-columns): reject.
		let tIndex: number | undefined;
		const backingPkSourceCols: number[] = [];
		for (const d of backingPkDefinition) {
			const attr = rootAttrs[d.index];
			let resolvedRef: number | undefined;
			let resolvedCol: number | undefined;
			for (let i = 0; i < refInfos.length; i++) {
				const sc = attr ? resolveTransitiveSourceCol(attr.id, refInfos[i].attrToCol, producingByAttrId) : undefined;
				if (sc !== undefined) { resolvedRef = i; resolvedCol = sc; break; }
			}
			// A backing-PK column resolving to neither ref, or columns spanning both, means the
			// backing is not keyed on a single source's PK (not provably 1:1) → fall to the floor.
			if (resolvedRef === undefined) return null;
			if (tIndex === undefined) tIndex = resolvedRef;
			else if (tIndex !== resolvedRef) return null;
			backingPkSourceCols.push(resolvedCol!);
		}
		if (tIndex === undefined) return null;

		const tRef = refInfos[tIndex].ref;
		const pRef = refInfos[tIndex === 0 ? 1 : 0].ref;
		const tSchema = tRef.tableSchema;
		const pSchema = pRef.tableSchema;
		const sourceBase = `${tSchema.schemaName}.${tSchema.name}`.toLowerCase();
		const lookupBase = `${pSchema.schemaName}.${pSchema.name}`.toLowerCase();
		if (sourceBase === lookupBase) return null; // self-join → floor

		// The backing key must be EXACTLY the driving source's PK (each `T` row → one backing
		// row). `keysOf` surfaced `T.pk` for the 1:1 join; verify it resolved to a real PK key
		// (not the all-columns fallback) by set-equality with `T`'s declared PK.
		const tPkCols = tSchema.primaryKeyDefinition.map(d => d.index);
		if (tPkCols.length === 0) return null;
		const backingPkSet = new Set(backingPkSourceCols);
		if (backingPkSet.size !== tPkCols.length || !tPkCols.every(c => backingPkSet.has(c))) return null;

		// Prove the join is 1:1 on `T` (no row loss + no fan-out), reusing the coverage
		// prover's shared join predicates over the analyzed body. A fanning / non-1:1 join
		// falls to the floor.
		const root = rootRelationalNode(analyzed);
		if (!root) return null;
		const proof = proveOneToOneJoin(root, tSchema);
		if (!proof.ok) return null;

		// Restrict to inner/cross: the lookup-side reverse residual filters `P`, which would
		// drop an outer join's null-extended rows (unsound). An outer 1:1 join falls to the floor.
		const topJoin = proof.topJoin;
		const joinType = topJoin && CapabilityDetectors.isJoin(topJoin) ? topJoin.getJoinType() : undefined;
		if (joinType !== 'inner' && joinType !== 'cross') return null;

		// Determinism: the residual must reproduce exactly what `select <body>` returns, so a
		// volatile projection (random()/now()/volatile UDF) is a HARD reject.
		for (const attr of rootAttrs) {
			const producing = attr ? producingByAttrId.get(attr.id) : undefined;
			if (!producing) continue; // a bare passthrough column has no producing expr to check
			const det = checkDeterministic(producing);
			if (!det.valid) {
				throw cannotMaterialize(mv.name,
					`it projects a non-deterministic expression (${det.expression}); a row-time backing value must be reproducible from the source rows`);
			}
		}

		// Forward (`T`) residual: the body with `T.pk = :pk0 AND …` injected on `T`. Recomputes
		// the one joined row for a changed `T` row (delegated to `applyForwardResidual`).
		const tRelKey = `${sourceBase}#${tRef.id ?? 'unknown'}`;
		const forwardResidual = this.compileResidual(analyzed, tRelKey, tPkCols, 'pk');
		if (!forwardResidual) return null;

		// Reverse (`P`) **in-scope** residual: the body — WHERE retained — with `P.pk = :pk0 AND …`
		// injected on `P`. Drives lookup-side maintenance — finds every currently in-scope joined
		// row referencing a changed `P` row.
		const pPkCols = pSchema.primaryKeyDefinition.map(d => d.index);
		if (pPkCols.length === 0) return null;
		const pRelKey = `${lookupBase}#${pRef.id ?? 'unknown'}`;
		const reverseResidual = this.compileResidual(analyzed, pRelKey, pPkCols, 'pk');
		if (!reverseResidual) return null;

		// Classify the body WHERE by which base table(s) its columns reference: a predicate that
		// references `P` (or both sides) can flip a row's WHERE membership on a `P` write, so the
		// lookup side must become delete-capable; a `T`-only predicate cannot move membership, so
		// the upsert-only reverse residual above stays sound. The membership residual is the body
		// with the WHERE **stripped** and the key filter on `P` — it returns every currently
		// referencing `T` row (regardless of scope) so its backing key can be deleted before the
		// in-scope survivors are re-upserted. Absent for a no-WHERE / `T`-only-WHERE body.
		const hasWhere = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
		// A volatile WHERE would make every residual (which embeds it) irreproducible → fall to
		// the floor's pragma-gated whole-body determinism reject, not an unsound bounded-delta arm.
		if (hasWhere && bodyWhereIsNonDeterministic(analyzed)) return null;
		const whereReferencesLookup = hasWhere
			&& bodyWhereReferencesLookup(analyzed, refInfos[tIndex].attrToCol, producingByAttrId);
		let lookupMembershipResidual: Scheduler | undefined;
		if (whereReferencesLookup) {
			const membership = this.compileLookupMembershipResidual(mv, lookupBase, pPkCols);
			if (!membership) return null; // could not strip + re-key the membership residual → floor
			lookupMembershipResidual = membership;
		}

		// ── Cost gate (parity with the other residual arms) ──
		const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
		const sourceStats = this.estimateMaintenanceStats(tSchema, backing.columns.length, hasWhere);
		const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
		const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
		if (chosenStrategy !== 'residual-recompute') {
			throw new QuereusError(
				`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
				StatusCode.INTERNAL,
			);
		}

		return {
			kind: 'join-residual',
			mv,
			sourceBase,
			backingSchema: mv.schemaName,
			backingTableName: mv.name,
			chosenStrategy,
			sourceStats,
			binding: { kind: 'row', keyColumns: [...tPkCols] },
			degradeToRebuild: false,
			residualScheduler: forwardResidual,
			bindParamPrefix: 'pk',
			bindColumns: tPkCols,
			backingPkDefinition,
			backingPkSourceCols,
			lookupBase,
			lookupResidualScheduler: reverseResidual,
			lookupMembershipResidualScheduler: lookupMembershipResidual,
			lookupBindColumns: pPkCols,
			lookupBindParamPrefix: 'pk',
		};
	}

	/**
	 * Compile the **lookup membership** residual for the join-residual arm's delete-capable
	 * lookup side: the MV body with its top-level WHERE **stripped** (membership only) and a
	 * key-equality filter injected on the lookup `P`, keyed `pk0…`. The WHERE is stripped at the
	 * AST level (a shallow clone dropping `where`) and the body re-built + re-analyzed, so only
	 * the WHERE is removed — the join, its `ON` condition, and any projection sub-expressions are
	 * preserved. Re-analysis assigns fresh node ids, so `P`'s reference is re-located by base name
	 * to compute the injection target. Returns `null` if the lookup ref or the key-filter
	 * injection could not be resolved (the caller then falls to the full-rebuild floor).
	 *
	 * Run per affected `P` key, this residual returns **every** `T` row currently joined to `P`
	 * via the join's `ON` condition — irrespective of the WHERE — so {@link applyLookupResidual}
	 * can delete each one's `T.pk` backing key before the in-scope residual re-upserts the
	 * survivors (the membership set the WHERE-bearing reverse residual would otherwise never
	 * shrink).
	 */
	private compileLookupMembershipResidual(
		mv: MaintainedTableSchema,
		lookupBase: string,
		pPkCols: readonly number[],
	): Scheduler | null {
		const db = this.ctx as unknown as Database;
		const strippedAst = { ...(mv.derivation.selectAst as AST.SelectStmt), where: undefined };
		const stripped = db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
			const { plan } = this.ctx._buildPlan([strippedAst as AST.Statement]);
			return this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;
		});
		// Re-locate `P` in the WHERE-stripped plan by base name (fresh node ids) to build the
		// injection target key the way `compileResidual`'s callers do.
		let pRelKey: string | undefined;
		for (const [relKey, ref] of collectTableRefs(stripped)) {
			if (`${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase() === lookupBase) {
				pRelKey = relKey;
				break;
			}
		}
		if (pRelKey === undefined) return null;
		return this.compileResidual(stripped, pRelKey, pPkCols, 'pk');
	}

	/**
	 * Build a `'full-rebuild'` plan — the always-correct floor — for an MV whose body matches
	 * no bounded-delta arm, or throw with a non-shape diagnostic. This is the fall-through
	 * builder {@link tryBuildBoundedDeltaArm} routes to on a `null` (no bounded-delta arm fits).
	 * See {@link FullRebuildPlan} and `docs/materialized-views.md` § Full-rebuild floor /
	 * § Primary key inference.
	 *
	 * Create-time rejections (none shape-based — the floor accepts general bodies):
	 * - **bag** body with no provable unique key (`keysOf` over the optimized body root is
	 *   empty) — there is no row identity to materialize on. `keysOf` already gates its
	 *   all-columns fallback on `isSet`, so a non-empty result is a real key (a true column
	 *   key OR the all-columns key of a provable set) and an empty result is exactly a bag.
	 *   (A duplicate-producing body usually fails the set contract earlier, at create-fill.)
	 * - **non-deterministic** body (any `random()`/`now()`/volatile UDF anywhere in the plan)
	 *   without `pragma nondeterministic_schema` — no maintenance could keep it equal to its
	 *   plain view (mirrors the per-arm determinism rejects and the DDL determinism gate);
	 * - body with **no relational output** (degenerate);
	 * - **size**: full-rebuild is the only sound strategy *and* the **largest** participating
	 *   source exceeds the `materialized_view_rebuild_row_threshold` option
	 *   ({@link isFullRebuildPathological}) — every DML write would re-scan that source.
	 *   `0` disables the size reject (accept any size).
	 */
	private buildFullRebuildPlan(mv: MaintainedTableSchema, analyzed: BlockNode): FullRebuildPlan {
		const db = this.ctx as unknown as Database;

		// Optimize the whole body ONCE — read-side MV rewrite suppressed so it reads its
		// sources, not the backing it populates — then derive the body's key + determinism
		// from, and compile its scheduler from, the SAME optimized plan.
		const optimized = db.schemaManager.withSuppressedMaterializedViewRewrite(
			() => this.ctx.optimizer.optimize(analyzed, db) as BlockNode,
		);
		const root = rootRelationalNode(optimized);
		if (!root) throw cannotMaterialize(mv.name, 'its body produced no relational output');

		// Backing key = the body's provable unique key. A bag (no provable key — a key-dropping
		// projection, a `union all` of overlapping inputs, …) has no row identity to key a
		// materialization on, so it must be a set. An all-columns pseudo-key is admitted only
		// when the body is provably a set (`keysOf` gates it on `isSet`); a bag with an
		// all-columns "key" still resolves to empty here and rejects, else duplicates would
		// collide on the backing key.
		//
		// One carve-out: a keyless body whose source key survives through value-preserving
		// passthrough lineage (the parallel-migration collation-weakening shape) is keyed on
		// the COARSENED lineage key instead of rejected — the same `deriveCoarsenedBackingKey`
		// derivation `deriveBackingShape` keyed the backing with, over the same fully-optimized
		// body, so the two agree by construction. Colliding rows then last-write-win under the
		// floor's collation-keyed `replace-all` diff (docs/materialized-views.md § Coarsened
		// backing keys); the create emitter owns the key-coarsening warning.
		if (keysOf(root).length === 0 && deriveCoarsenedBackingKey(root) === undefined) {
			throw cannotMaterialize(mv.name, 'its body has no provable unique key — it is a bag (e.g. a key-dropping '
				+ 'projection or a `union all` of overlapping inputs), so it must be a set');
		}

		// Whole-body determinism: a non-deterministic body can never be kept equal to its
		// plain view by any maintenance, so it is a hard reject unless the schema-determinism
		// gate is lifted. Mirrors the per-arm determinism rejects (and the DDL gate).
		if (!db.options.getBooleanOption('nondeterministic_schema')) {
			const nonDet = findNonDeterministic(analyzed);
			if (nonDet) {
				throw cannotMaterialize(mv.name, `its body is non-deterministic (${nonDet}); a materialized view body must be `
					+ 'reproducible to stay equal to its plain view (set `pragma nondeterministic_schema` to override)');
			}
		}

		// Every source the body reads (set-op legs, every join source, …) so a write to any of
		// them triggers a rebuild. Collected from the (pre-physical) analyzed plan, where every
		// source is a bare `TableReferenceNode` — the optimized plan may have wrapped them in
		// physical access nodes.
		const tableRefs = [...collectTableRefs(analyzed).values()];
		const sourceBases = [...new Set(
			tableRefs.map(ref => `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase()),
		)];
		if (sourceBases.length === 0) throw cannotMaterialize(mv.name, 'its body reads no source table');

		const backing = this.ctx._findTable(mv.name, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}

		// ── Cost gate + size reject ──
		// Full-rebuild is the floor: an EMPTY sound set resolves to it (`selectMaintenanceStrategy`).
		// Cost the rebuild against the LARGEST participating source — every write re-evaluates the
		// whole body, so the largest source it scans governs whether the per-write rebuild is
		// pathological (e.g. a tiny driving table joined to a huge lookup gates on the lookup).
		// Re-resolve each source's CURRENT schema (the analyzed plan node may carry a pre-`analyze`
		// snapshot whose `statistics` predates the latest counts) so the size gate reflects the
		// live source size at create time.
		const statsProvider = this.ctx.optimizer.getStats();
		let largestSchema = tableRefs[0].tableSchema;
		let largestRows = -1;
		for (const ref of tableRefs) {
			const live = this.liveSourceSchema(ref);
			const rows = statsProvider.tableRows(live) ?? DEFAULT_SOURCE_ROWS;
			if (rows > largestRows) { largestRows = rows; largestSchema = live; }
		}
		const sourceStats = this.estimateMaintenanceStats(largestSchema, backing.columns.length, /*hasPredicate*/ false);

		// Size reject: full-rebuild is the only sound strategy here, so a source past the
		// configurable threshold makes every write pathological. `0` disables the reject.
		const rebuildThreshold = db.options.getNumberOption('materialized_view_rebuild_row_threshold');
		if (isFullRebuildPathological(sourceStats, rebuildThreshold)) {
			const largestBase = `${largestSchema.schemaName}.${largestSchema.name}`.toLowerCase();
			throw cannotMaterialize(mv.name,
				`its only sound maintenance strategy is a full body rebuild, but its largest source '${largestBase}' has `
					+ `~${sourceStats.tableRows} rows, over the materialized_view_rebuild_row_threshold (${rebuildThreshold}) — `
					+ `every write would re-scan it. Raise or disable the threshold `
					+ `(\`pragma materialized_view_rebuild_row_threshold = 0\`)`);
		}

		// Compile the whole optimized body once into a reusable scheduler (no key filter).
		const bodyScheduler = new Scheduler(emitPlanNode(optimized, new EmissionContext(db)));

		const chosenStrategy = selectMaintenanceStrategy([], Math.max(1, sourceStats.tableRows * 0.01), sourceStats);
		if (chosenStrategy !== 'full-rebuild') {
			throw new QuereusError(
				`Internal error: cost gate selected '${chosenStrategy}' for the full-rebuild floor of materialized view '${mv.name}'`,
				StatusCode.INTERNAL,
			);
		}

		return {
			kind: 'full-rebuild',
			mv,
			sourceBase: sourceBases[0],
			backingSchema: mv.schemaName,
			backingTableName: mv.name,
			chosenStrategy,
			sourceStats,
			bodyScheduler,
			sourceBases,
		};
	}

	/**
	 * Compile the key-filtered residual for a binding into a reusable {@link Scheduler}:
	 * the analyzed body with a key-equality filter injected on `T`'s `TableReferenceNode`
	 * (parameterized `${paramPrefix}0…`), then optimized + emitted. Mirrors the assertion
	 * evaluator's residual compilation (`database-assertions.ts`) so the two cannot drift.
	 * Returns `null` if `injectKeyFilter` could not target `T` (the arm builder then falls
	 * through to the full-rebuild floor).
	 */
	private compileResidual(
		analyzed: BlockNode,
		relKey: string,
		bindColumns: readonly number[],
		paramPrefix: 'gk' | 'pk',
	): Scheduler | null {
		const db = this.ctx as unknown as Database;
		const rewritten = injectKeyFilter(analyzed, relKey, bindColumns, paramPrefix);
		if (rewritten === analyzed) return null; // could not parameterize the residual → floor
		// Suppress the read-side rewrite: the residual is the MV's own body (+ a key
		// filter) compiled to maintain its backing, so it must stay over the source.
		const optimized = db.schemaManager.withSuppressedMaterializedViewRewrite(
			() => this.ctx.optimizer.optimize(rewritten, db) as BlockNode,
		);
		const instruction = emitPlanNode(optimized, new EmissionContext(db));
		return new Scheduler(instruction);
	}

	/**
	 * Execute a cached key-filtered residual for one affected key tuple, returning its
	 * result rows (0 or 1 for the aggregate shape; 0..N for the lateral-TVF fan-out shape).
	 * Bound through a fresh {@link RuntimeContext} on the live `db` so the residual's source
	 * scan reuses `T`'s transaction connection and reads this statement's pending writes
	 * (reads-own-writes) — the synchronous analogue of
	 * `database-assertions.ts:executeResidualPerTuple`. Shared by the residual-recompute
	 * (`'gk'`) and prefix-delete (`'pk'`) arms.
	 */
	private async runResidual(
		residualScheduler: Scheduler,
		bindParamPrefix: 'gk' | 'pk',
		keyTuple: readonly SqlValue[],
	): Promise<Row[]> {
		const params: Record<string, SqlValue> = {};
		for (let i = 0; i < keyTuple.length; i++) {
			params[`${bindParamPrefix}${i}`] = keyTuple[i];
		}
		return this.runScheduler(residualScheduler, params);
	}

	/**
	 * Run a cached maintenance scheduler to completion against **live mid-transaction source
	 * state** and collect its result rows. Bound through a fresh strict {@link RuntimeContext}
	 * on the live `db` so the scan reuses the source's transaction connection and reads this
	 * statement's pending writes (reads-own-writes). The no-`stmt`, fresh-context shape is the
	 * synchronous analogue of `database-assertions.ts:executeResidualPerTuple`. Shared by the
	 * key-filtered residual arms ({@link runResidual}, parameterized) and the whole-body
	 * full-rebuild arm ({@link applyFullRebuild}, no params).
	 */
	private async runScheduler(scheduler: Scheduler, params: Record<string, SqlValue>): Promise<Row[]> {
		const rctx: RuntimeContext = {
			db: this.ctx as unknown as Database,
			stmt: undefined,
			params,
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			enableMetrics: false,
		};
		const result = await scheduler.run(rctx);
		const rows: Row[] = [];
		if (isAsyncIterable(result)) {
			for await (const r of result as AsyncIterable<Row>) rows.push(r);
		}
		return rows;
	}

	/**
	 * Maintain a `'full-rebuild'` MV: re-evaluate the **whole** body against live
	 * mid-transaction source state and replace the backing transactionally. Run the cached
	 * {@link FullRebuildPlan.bodyScheduler} to completion (no params — reads-own-writes via
	 * the same fresh-context path the residual arms use), collect every recomputed row, and
	 * apply a single `'replace-all'` {@link MaintenanceOp}: a keyed diff (by backing PK) of
	 * the recomputed rows against the backing's current pending-layer contents (insert/
	 * update/delete, identical rows skipped). The diff rides the backing's **pending**
	 * `TransactionLayer`, so it commits/rolls-back in lockstep with the source write, and the
	 * returned effective {@link BackingRowChange}(s) drive the MV-over-MV cascade unchanged.
	 *
	 * Unlike the bounded-delta arms this ignores the specific changed row — the floor
	 * rebuilds wholesale. It is therefore deferred to a single end-of-statement flush
	 * ({@link flushDeferredRebuilds}) rather than run per source row, so a bulk statement
	 * rebuilds exactly once; this is that one rebuild. An empty body (zero rows) yields a
	 * `'replace-all' []`, which empties the backing.
	 */
	private async applyFullRebuild(
		plan: FullRebuildPlan,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		const rows = await this.runScheduler(plan.bodyScheduler, {});

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return host.applyMaintenance(connection, [{ kind: 'replace-all', rows }]);
	}

	/**
	 * Compute a **forward** key-filtered residual plan's per-row backing delta and apply it:
	 * derive the affected binding key(s) from the changed row (OLD ∪ NEW, deduped), re-run
	 * the key-filtered residual against live source state for each, and apply the **keyed
	 * diff**: a non-empty recomputed slice is upserted (the backing key IS the affected key,
	 * so the upsert replaces the old row wholesale — no delete-first — and the host's
	 * value-identical upsert skip turns a no-op recompute into ZERO effective changes
	 * instead of delete+insert churn); an emptied slice (residual returns nothing) emits the
	 * point delete, removing the stale backing row (nothing reported if it was already
	 * absent). Returns the effective {@link BackingRowChange}(s) the backing layer realized,
	 * for the MV-over-MV cascade — a real same-key change now reports one `update`.
	 *
	 * Shared by the single-source aggregate (`'residual-recompute'`, group key, ≤1 row per
	 * key) and the 1:1-join (`'join-residual'`, the driving table `T`'s PK, exactly the one
	 * joined row per key) arms — both bind on the forward driving source via
	 * {@link ForwardResidualPlan}; the only difference is the binding (group vs PK).
	 *
	 * Per-row recompute is correct without per-statement batching: every change to a key
	 * triggers a full recompute of that key's slice from live (reads-own-writes) state, so
	 * the last change to touch a key writes the authoritative backing row. Batching/dedup
	 * across a whole statement is an affordability optimization deferred with the
	 * statement-flush boundary (see the ticket handoff).
	 */
	private async applyForwardResidual(
		plan: ForwardResidualPlan,
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
			const recomputed = await this.runResidual(plan.residualScheduler, plan.bindParamPrefix, keyTuple);
			// Keep only the recomputed rows whose backing key equals the affected key.
			// The residual for key K must only contribute K's slice; any other row is
			// spurious and is dropped. This is the soundness net for an emptied group: when
			// no source row matches the key, a *correct* grouped residual returns zero rows,
			// but a constant-pinned multi-column grouped aggregate is mis-collapsed by the
			// optimizer into a *scalar* aggregate that emits one all-NULL `count=0` row over
			// the empty input (a pre-existing optimizer bug, filed separately as
			// `fix/optimizer-constant-group-aggregate-empty-input-spurious-row`). That row's
			// key ≠ K, so it is filtered here and the delete-without-upsert correctly removes
			// the emptied group's backing row.
			const slice = recomputed.filter(row => this.residualRowMatchesKey(plan, row, keyVals));
			if (slice.length === 0) {
				// Emptied slice: delete-without-upsert removes the stale backing row (the
				// host reports nothing if the key was already absent).
				ops.push({ kind: 'delete-key', key: deleteKey });
			} else {
				// The slice shares the affected backing key, so each upsert REPLACES the old
				// backing row — no delete-first — and the host's value-identical skip
				// (vtab/backing-host.ts) suppresses a recompute that changed nothing.
				for (const row of slice) ops.push({ kind: 'upsert', row });
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
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return host.applyMaintenance(connection, ops);
	}

	/**
	 * True iff `row`'s backing primary-key columns equal `keyVals` (the affected binding
	 * key, in `backingPkDefinition` order), under each column's collation. Used to keep
	 * only the residual row(s) belonging to the recomputed key — see
	 * {@link applyForwardResidual}.
	 */
	private residualRowMatchesKey(plan: ForwardResidualPlan, row: Row, keyVals: readonly SqlValue[]): boolean {
		for (let i = 0; i < plan.backingPkDefinition.length; i++) {
			const d = plan.backingPkDefinition[i];
			if (compareSqlValues(row[d.index], keyVals[i], d.collation) !== 0) return false;
		}
		return true;
	}

	/**
	 * Dispatch a `'join-residual'` plan on **which source changed**. A write to the driving
	 * table `T` (`changedBase === plan.sourceBase`) is the forward case — recompute the one
	 * joined row keyed on `T`'s PK, identical to a size-1 `'row'`-binding residual — so it
	 * delegates straight to {@link applyForwardResidual} (delete old backing slice → run the
	 * `T`-keyed residual → upsert). A write to the lookup table `P` is the reverse case,
	 * handled by {@link applyLookupResidual}.
	 */
	private async applyJoinResidual(
		plan: JoinResidualPlan,
		change: BackingRowChange,
		changedBase: string,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		if (changedBase === plan.sourceBase) {
			return this.applyForwardResidual(plan, change, cache);
		}
		return this.applyLookupResidual(plan, change, cache);
	}

	/**
	 * Maintain a `'join-residual'` MV for a **lookup-side (`P`)** change: refresh the joined
	 * rows referencing each affected `P` key. Derive the affected `P` key(s) from the changed
	 * row (OLD ∪ NEW, deduped on `P`'s PK), and for each run the in-scope lookup-keyed residual
	 * (`… where P.pk = :pk0`, the body's WHERE retained) against live source state — returning
	 * every currently in-scope joined row, each carrying its `T.pk` backing key — and **upsert**
	 * each.
	 *
	 * **Upsert-only is sound for a no-WHERE / `T`-only-WHERE body.** For an inner/cross join with
	 * enforced RI and a predicate that cannot reference `P`, the *set* of backing rows referencing
	 * a given `P` row is `{ T : T.fk = P.pk }`, determined entirely by `T.fk` (a `T` column the
	 * `P` write cannot change), and the WHERE — over `T` only — cannot flip on a `P` write. So a
	 * `P` change can only re-derive the lookup-projected columns of those existing backing rows
	 * (an upsert at the unchanged `T.pk` key), never add or remove one: a `P` insert with no
	 * referencing `T` rows yields an empty residual (no-op); a `P` delete is only admissible (RI)
	 * when no `T` references it (empty residual); a `P` payload update upserts the affected rows
	 * with the new value.
	 *
	 * **A `P`-referencing WHERE needs the delete-capable pass.** When the body WHERE references
	 * `P`, a `P` write can flip a joined row's WHERE truth and so add or remove its backing row —
	 * which the in-scope upsert above (it returns *only* in-scope rows) could never delete. The
	 * builder then supplies `lookupMembershipResidualScheduler` (the body with the WHERE stripped,
	 * keyed on `P`). Per affected `P` key this runs both residuals against the same live state and
	 * applies the **keyed diff**: it **deletes** only the membership keys the in-scope recompute no
	 * longer produces (rows that left scope — the delete keys come from live `T` via the join, so
	 * they match existing backing keys and touch nothing belonging to another `P`; membership and
	 * in-scope rows read the same live state, so their key bytes match exactly), and **upserts**
	 * every in-scope row. A row leaving scope is deleted (removed); a row entering scope is
	 * upserted (added); an unchanged in-scope row's upsert is suppressed by the host's
	 * value-identical skip (vtab/backing-host.ts) — ZERO effective changes instead of the former
	 * delete+insert refresh churn; a changed in-scope row reports one `update`. The membership
	 * residual MUST ignore the WHERE — else a row leaving scope would never be deleted.
	 *
	 * A `T`-side membership change (insert/delete/FK-move) is the *forward* path's job and fires
	 * its own maintenance. Returns the effective {@link BackingRowChange}(s) for the MV-over-MV
	 * cascade. Per-row recompute is correct without batching for the same
	 * last-write-wins-against-live-state reason as {@link applyForwardResidual}.
	 */
	private async applyLookupResidual(
		plan: JoinResidualPlan,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		// Distinct affected lookup keys (OLD ∪ NEW), deduped on `P`'s PK values.
		const affected = new Map<string, SqlValue[]>();
		const addFrom = (row: Row): void => {
			const keyTuple = plan.lookupBindColumns.map(c => row[c]);
			const dedupKey = canonKeyValues(keyTuple);
			if (!affected.has(dedupKey)) affected.set(dedupKey, keyTuple);
		};
		if (change.op === 'insert') addFrom(change.newRow);
		else if (change.op === 'delete') addFrom(change.oldRow);
		else { addFrom(change.oldRow); addFrom(change.newRow); }

		const ops: MaintenanceOp[] = [];
		for (const keyTuple of affected.values()) {
			const recomputed = await this.runResidual(plan.lookupResidualScheduler, plan.lookupBindParamPrefix, keyTuple);
			// Delete-capable (P-referencing WHERE): keyed diff of the membership residual
			// (WHERE stripped) against the in-scope recompute — delete ONLY the membership
			// keys the recompute no longer produces (rows that left the WHERE scope), not
			// every member. Both residuals read the same live state, so a surviving row's
			// key bytes match exactly (the byte-canonical set lookup is exact). Deletes
			// precede upserts, preserving the prior arm's ordering discipline.
			if (plan.lookupMembershipResidualScheduler) {
				const produced = new Set(recomputed.map(row =>
					canonKeyValues(plan.backingPkDefinition.map(d => row[d.index]))));
				const members = await this.runResidual(plan.lookupMembershipResidualScheduler, plan.lookupBindParamPrefix, keyTuple);
				for (const row of members) {
					const keyVals = plan.backingPkDefinition.map(d => row[d.index]);
					if (produced.has(canonKeyValues(keyVals))) continue; // still in scope — upserted below
					ops.push({ kind: 'delete-key', key: buildPrimaryKeyFromValues(keyVals, plan.backingPkDefinition) });
				}
			}
			// Upsert every in-scope row; the host's value-identical skip suppresses the
			// unchanged ones (an in-scope refresh that changed nothing reports nothing).
			for (const row of recomputed) ops.push({ kind: 'upsert', row });
		}
		if (ops.length === 0) return [];

		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);
		return host.applyMaintenance(connection, ops);
	}

	/**
	 * Build a `'prefix-delete'` plan for a single-source lateral-TVF fan-out body
	 * (`select T.pk…, …, f.* from T cross join lateral tvf(<args over T>) f`), or return
	 * `null` on a shape mismatch (the caller falls through to the full-rebuild floor). The
	 * backing PK is the composite product key `(T.pk ∪ tvf-key)` that `keysOf` advertises
	 * through the lateral join; the base PK is its leading prefix. See {@link PrefixDeletePlan}
	 * and `docs/incremental-maintenance.md` § prefix-delete.
	 *
	 * Soundness gates (a mismatch on any returns `null` → floor): exactly one lateral TVF and
	 * one join (no nested/multi TVF, no aggregate over the fan-out); the TVF advertises a
	 * per-call key; the base PK projected and forming the **leading prefix** of the backing PK
	 * with a non-empty TVF-key tail (so each base row's fan-out rows are individually
	 * addressable and a by-prefix delete selects exactly one base row's slice). An `order by`
	 * over the fan-out that reorders the composite key so the base PK no longer leads is a
	 * `null` fall-through (the floor maintains it wholesale). The body's WHERE, if any, is part
	 * of the residual (so an out-of-scope base row fans out to zero rows), exactly as in the
	 * aggregate arm. A **non-deterministic** TVF / argument is the one hard reject (its
	 * arm-specific determinism diagnostic must survive).
	 */
	private buildLateralTvfPrefixDeletePlan(
		mv: MaintainedTableSchema,
		analyzed: BlockNode,
		tableRef: TableReferenceNode,
		sourceBase: string,
	): MaintenancePlan | null {
		// Exactly one lateral TVF and one join. A second base table is already excluded by
		// the single-source check upstream; this falls to the floor for a second TVF / chained
		// lateral join (`t join lateral tvf1 join lateral tvf2`).
		if (countNodeType(analyzed, PlanNodeType.TableFunctionCall) !== 1) return null;
		if (countJoins(analyzed) !== 1) return null;
		// An aggregate over the fan-out is a different shape → floor (the TVF route is taken
		// before the aggregate route, so an `... group by` over a lateral TVF lands here).
		if (findAggregate(analyzed)) return null;

		// Determinism: a residual must reproduce exactly what `select <body>` returns, so a
		// volatile TVF (or a volatile argument expression) is a HARD reject.
		const tvf = findTableFunctionCall(analyzed);
		if (!tvf) {
			// Unreachable — countNodeType(...) === 1 above guarantees one exists.
			throw new QuereusError(`Internal error: lateral TVF node not found for materialized view '${mv.name}'`, StatusCode.INTERNAL);
		}
		if (tvf.physical.deterministic === false) {
			throw cannotMaterialize(mv.name,
				`it fans out through a non-deterministic table-valued function '${tvf.functionName}' (a row-time fan-out must be reproducible from the base row)`);
		}
		for (const operand of tvf.operands) {
			const det = checkDeterministic(operand);
			if (!det.valid) throw cannotMaterialize(mv.name, `it passes a non-deterministic argument (${det.expression}) to the lateral table-valued function`);
		}

		// The lateral TVF must advertise a per-call key, so the composite product key is a
		// real column key `(base PK ∪ TVF key)` rather than the all-columns / `isSet`
		// fallback. Without one the fan-out rows are not individually addressable by a proper
		// key — the by-prefix delete + keyed upsert would be unsound — so fall to the floor.
		// `getType().keys` carries the validated advertisement (an out-of-range key
		// advertisement is dropped, leaving this empty), so it is the authoritative
		// "did the TVF advertise a usable key" signal.
		if (tvf.getType().keys.length === 0) return null;

		// Base T's PK source columns.
		const sourceSchema = tableRef.tableSchema;
		const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
		if (sourcePkCols.length === 0) return null;

		// Backing table + its physical PK (the composite product key).
		const backing = this.ctx._findTable(mv.name, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));

		// Map each output attribute to a base-T source column (or `undefined` for a TVF
		// output column). T's attributes pass through the join unchanged, so a base-PK
		// output column resolves to a T column while a TVF-key output column does not.
		const sourceAttrToCol = new Map<number, number>();
		tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
		const producingByAttrId = collectProducingExprs(analyzed);
		const rootAttrs = relationalAttributes(analyzed);
		if (!rootAttrs) return null;

		// Prefix soundness: the LEADING `basePrefixLen` backing-PK columns must each
		// project (transitively) a distinct base-T PK column, their set must equal the base
		// PK, and there must be a non-empty TVF-key tail. So the base PK is the leading
		// prefix of the composite product key and the by-prefix delete selects exactly one
		// base row's fan-out. A composite key that did not form this way falls to the floor.
		const basePrefixLen = sourcePkCols.length;
		if (backingPkDefinition.length <= basePrefixLen) return null;
		const basePkSet = new Set(sourcePkCols);
		const leadingSourceCols = new Set<number>();
		const backingPrefixSourceCols: number[] = [];
		for (let i = 0; i < basePrefixLen; i++) {
			const d = backingPkDefinition[i];
			const attr = rootAttrs[d.index];
			const sc = attr ? resolveTransitiveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
			if (sc === undefined || !basePkSet.has(sc)) return null; // base PK not the leading prefix → floor
			// Soundness precondition for the binary prefix scan (the property
			// `prefix-delete-noncase-collation-regression-test` locks in): the backing base-PK
			// column MUST inherit the source PK column's collation. The btree orders this prefix
			// by `d.collation`, but the keyed diff's existing-slice read (`scanEffective` with
			// the base prefix, in `applyPrefixDelete`) early-terminates the prefix scan on a
			// BINARY compare (scan-layer.ts) — sound ONLY because source-PK uniqueness under that
			// collation collapses each collation class to a single binary value, so a base row's
			// fan-out rows are binary-homogeneous and contiguous. A backing collation MORE
			// permissive than the source's would let collation-equal/binary-different base rows
			// interleave and break that. The backing column derives its collation from the body
			// relation's type (deriveBackingShape), so a mismatch is an internal derivation bug —
			// fail loud rather than register an unsound plan.
			const backingColl = normalizeCollation(d.collation);
			const sourceColl = normalizeCollation(sourceSchema.columns[sc!]?.collation);
			if (backingColl !== sourceColl) {
				throw new QuereusError(
					`Internal error: materialized view '${mv.name}' backing base-PK column `
						+ `'${backing.columns[d.index]?.name ?? d.index}' has collation '${backingColl}' but its source `
						+ `primary-key column '${sourceSchema.columns[sc!]?.name ?? sc}' has collation '${sourceColl}'; `
						+ `the prefix-delete arm's binary prefix scan requires the backing base-PK column to inherit the `
						+ `source PK collation (see scan-layer.ts early-termination)`,
					StatusCode.INTERNAL,
				);
			}
			leadingSourceCols.add(sc!);
			backingPrefixSourceCols.push(sc!);
		}
		if (leadingSourceCols.size !== basePkSet.size) return null; // prefix does not cover the base PK → floor
		// The TVF-key tail must NOT re-use a base-PK column — else the fan-out rows would
		// not be distinguished and the "key" would be base-only (defensive: the product key
		// places the TVF key, a distinct relation's columns, in the tail). Otherwise → floor.
		for (let i = basePrefixLen; i < backingPkDefinition.length; i++) {
			const d = backingPkDefinition[i];
			const attr = rootAttrs[d.index];
			const sc = attr ? resolveTransitiveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
			if (sc !== undefined && basePkSet.has(sc)) return null;
		}

		// Compile + cache the base-PK-keyed residual once (the body with `T.pk = :pk0 AND …`
		// injected on T). Re-run per affected base key against the live transaction; it
		// re-runs the lateral join + TVF for that single base row, fanning out to N rows.
		const relKey = `${sourceBase}#${tableRef.id ?? 'unknown'}`;
		const residualScheduler = this.compileResidual(analyzed, relKey, sourcePkCols, 'pk');
		if (!residualScheduler) return null; // could not parameterize the residual → floor

		// ── Cost gate ──
		// The fan-out residual shares the residual-recompute cost shape (a key-filtered
		// re-execution of the body); the fan-out factor (rows per base key) is not known at
		// create, so we cost it as a residual and record the choice for substrate parity.
		// The synchronous reject-at-create / degrade-to-rebuild machinery stays dormant, as
		// it does for the other arms (a TVF whose fan-out is pathological is not detectable
		// without fan-out stats — deferred with the fanning-keyed-join follow-up).
		const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
		const hasPredicate = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
		const sourceStats = this.estimateMaintenanceStats(sourceSchema, backing.columns.length, hasPredicate);
		const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
		const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
		if (chosenStrategy !== 'residual-recompute') {
			throw new QuereusError(
				`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
				StatusCode.INTERNAL,
			);
		}

		return {
			kind: 'prefix-delete',
			mv,
			sourceBase,
			backingSchema: mv.schemaName,
			backingTableName: mv.name,
			chosenStrategy,
			sourceStats,
			binding: { kind: 'row', keyColumns: [...sourcePkCols] },
			degradeToRebuild: false,
			residualScheduler,
			bindParamPrefix: 'pk',
			bindColumns: sourcePkCols,
			backingPkDefinition,
			basePrefixLength: basePrefixLen,
			backingPrefixSourceCols,
		};
	}

	/**
	 * Compute a `'prefix-delete'` plan's per-row backing delta and apply it: derive the
	 * affected base key(s) from the changed row (OLD ∪ NEW, deduped on the base key), and
	 * for each — re-run the base-PK-keyed residual against live source state and apply the
	 * **keyed diff against the existing effective fan-out slice** (read via the host's
	 * `scanEffective` with the base prefix, pending over committed — the same contiguous
	 * range the former wholesale `'delete-by-prefix'` removed): delete ONLY the existing
	 * keys the recompute no longer produces, upsert every recomputed row (the host's
	 * value-identical skip suppresses the unchanged ones). A base-PK-changing UPDATE
	 * recomputes both the OLD base key (slice diffs to all-deletes; the residual returns
	 * nothing for the now-absent old PK) and the NEW base key (new fan-out upserted); a
	 * DELETE diffs the old slice to all-deletes; an INSERT diffs against an empty slice
	 * (all upserts). An emptied/shrunk fan-out keeps the delete-without-upsert exactly —
	 * a disappearance is never "skipped". Returns the effective
	 * {@link BackingRowChange}(s) the backing layer realized, for the MV-over-MV cascade.
	 *
	 * Prefix-scan soundness is unchanged from the wholesale arm: the diff's slice read
	 * uses the same binary `equalityPrefix` scan `'delete-by-prefix'` used, sound under
	 * the build-time collation gate (the backing base-PK prefix inherits the source PK
	 * collation, and source-PK uniqueness collapses each collation class to one binary
	 * value). The stored slice's prefix bytes always equal the OLD image's (the slice was
	 * projected from that very source row), and OLD ∪ NEW both iterate, so a case-only
	 * base-PK rewrite still converges: the OLD-prefix pass pairs the slice with the
	 * recomputed rows (key pairing is collation-aware — the btree's identity — so a
	 * collation-equal key is REPLACED by its upsert, never also deleted) and the byte
	 * change surfaces as `update`s that re-key the stored bytes.
	 *
	 * Structurally the same as {@link applyForwardResidual}, differing only in the
	 * **prefix-slice** diff (one base row owns N backing rows sharing the prefix) and the
	 * **N-row** residual. Per-row recompute is correct without per-statement batching: the
	 * residual reads live (reads-own-writes) state, so the last write to a base key produces
	 * the authoritative slice. (Statement-level dedup of distinct base keys is the same
	 * affordability optimization deferred for the aggregate arm.)
	 */
	private async applyPrefixDelete(
		plan: PrefixDeletePlan,
		change: BackingRowChange,
		cache?: BackingConnectionCache,
	): Promise<BackingRowChange[]> {
		// Distinct affected base keys (OLD ∪ NEW), deduped on the base-PK values. `keyTuple`
		// binds the residual (`pk{i}`); `prefix` is the slice's leading-PK equality key (the
		// base-PK values in backing-PK order — identical here since the base PK leads the
		// backing PK, but kept distinct for clarity).
		const affected = new Map<string, { keyTuple: SqlValue[]; prefix: SqlValue[] }>();
		const addFrom = (row: Row): void => {
			const keyTuple = plan.bindColumns.map(c => row[c]);
			const dedupKey = canonKeyValues(keyTuple);
			if (affected.has(dedupKey)) return;
			affected.set(dedupKey, { keyTuple, prefix: plan.backingPrefixSourceCols.map(sc => row[sc]) });
		};
		if (change.op === 'insert') addFrom(change.newRow);
		else if (change.op === 'delete') addFrom(change.oldRow);
		else { addFrom(change.oldRow); addFrom(change.newRow); }

		// Resolved up front (unlike the point-op arms): the keyed diff reads the existing
		// effective slice before any op exists. The former wholesale arm always emitted ops,
		// so this resolves no more connections than it did.
		const backing = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${plan.backingTableName}' for materialized view '${plan.mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`, cache);

		const ops: MaintenanceOp[] = [];
		for (const { keyTuple, prefix } of affected.values()) {
			const recomputed = await this.runResidual(plan.residualScheduler, plan.bindParamPrefix, keyTuple);
			// The residual for base key K filters T to K, so every row it returns shares K's
			// base-PK prefix; the prefix-match guard is a defensive soundness net (mirrors
			// the aggregate arm's `residualRowMatchesKey`).
			const slice = recomputed.filter(row => this.residualRowMatchesBasePrefix(plan, row, prefix));
			// Existing effective fan-out rows for this base prefix (pending over committed).
			const existing: Row[] = [];
			for await (const row of host.scanEffective(connection, { equalityPrefix: prefix })) {
				existing.push(row);
			}
			// Keyed diff. Key pairing is collation-aware over the full backing PK (the btree's
			// identity): a recomputed row whose key is collation-equal to an existing row
			// REPLACES it via the upsert below, so it must not also be deleted. Deletes precede
			// upserts (the wholesale arm's ordering discipline). The delete keys are built from
			// the EXISTING rows' stored values, so the host's collation-aware point lookup
			// always finds them.
			for (const ex of existing) {
				if (slice.some(row => this.backingPkEqual(plan.backingPkDefinition, row, ex))) continue;
				ops.push({
					kind: 'delete-key',
					key: buildPrimaryKeyFromValues(plan.backingPkDefinition.map(d => ex[d.index]), plan.backingPkDefinition),
				});
			}
			for (const row of slice) ops.push({ kind: 'upsert', row });
		}
		if (ops.length === 0) return [];
		return host.applyMaintenance(connection, ops);
	}

	/**
	 * True iff two backing rows agree on every backing-PK column under that column's
	 * collation — the btree's key identity. Pairs an existing slice row with the
	 * recomputed row that replaces it in {@link applyPrefixDelete}'s keyed diff.
	 */
	private backingPkEqual(
		pkDef: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>,
		a: Row,
		b: Row,
	): boolean {
		for (const d of pkDef) {
			if (compareSqlValues(a[d.index], b[d.index], d.collation) !== 0) return false;
		}
		return true;
	}

	/**
	 * True iff `row`'s **leading** (base-prefix) backing-PK columns equal `prefixVals` (the
	 * affected base key, in backing-PK order), under each column's collation. Keeps only the
	 * residual fan-out row(s) belonging to the recomputed base key — see
	 * {@link applyPrefixDelete}.
	 */
	private residualRowMatchesBasePrefix(plan: PrefixDeletePlan, row: Row, prefixVals: readonly SqlValue[]): boolean {
		for (let i = 0; i < plan.basePrefixLength; i++) {
			const d = plan.backingPkDefinition[i];
			if (compareSqlValues(row[d.index], prefixVals[i], d.collation) !== 0) return false;
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
	/**
	 * The CURRENT `TableSchema` of a source `TableReferenceNode`, re-resolved through the
	 * schema manager. A plan node captures the schema as of plan-build; a later `analyze`
	 * replaces the catalog entry with one carrying fresh `statistics`, so the stale captured
	 * schema would report pre-`analyze` row counts. Re-resolving keeps the floor's size gate
	 * on the live source size. Falls back to the node's captured schema if the name no longer
	 * resolves (it always should — the body planned).
	 */
	private liveSourceSchema(ref: TableReferenceNode): TableSchema {
		const captured = ref.tableSchema;
		return this.ctx._findTable(captured.name, captured.schemaName) ?? captured;
	}

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
	 * this confirms a live row-time plan exists for the source, the MV is not
	 * `stale` (structural breakage), and the plan is **per-row maintained** — only
	 * then is its backing table row-time consistent enough to answer conflict
	 * resolution. A `'full-rebuild'` plan is deferred to the end-of-statement flush
	 * (its backing lags the source mid-statement), so it can never serve as a
	 * covering structure for a synchronous per-row UNIQUE probe — it is skipped here
	 * regardless of any (informational) `coveringStructureName` link, which keeps the
	 * eligibility flip from opening a stale-read enforcement path. O(1) negative fast
	 * path off {@link rowTimeBySource} so a source table with no row-time covering MV
	 * pays a single map lookup and stays on the synchronous index/scan path.
	 */
	findRowTimeCoveringStructure(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): MaintainedTableSchema | undefined {
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
			// A deferred full-rebuild MV is not per-row consistent (reconciled only at
			// the end-of-statement flush), so it cannot answer a synchronous probe.
			if (plan.chosenStrategy === 'full-rebuild') return undefined;
			if (mv.derivation.stale) return undefined; // not row-time consistent
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
	 * reflects all prior rows of the statement. The backing is hosted by whatever
	 * backing-host-capable module the MV declared (`memory` by default, the store
	 * module under `using store`), independent of the source module — the host's
	 * `scanEffective` abstracts the storage.
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
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		newRow: Row,
		newSourcePk: readonly SqlValue[],
	): Promise<Array<{ pk: SqlValue[]; row?: Row }>> {
		const plan = this.rowTime.get(mvKey(mv.schemaName, mv.name));
		if (!plan) return [];
		// Covering-conflict resolution reads the inverse projection (source↔backing
		// column map). Only the `'inverse-projection'` arm carries it; the other arms do
		// not cover a source UNIQUE constraint in the covering sense, so a covering
		// structure is never linked to one — defensively skip if reached.
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
		const host = this.backingHost(backing);
		const connection = await this.getBackingConnection(host, `${plan.backingSchema}.${plan.backingTableName}`);

		const conflicts: Array<{ pk: SqlValue[]; row?: Row }> = [];
		// Fast path: a backing-PK prefix scan keyed on `newRow`'s UC values. The
		// covering-index shape guarantees the leading backing-PK columns are the UC
		// columns, so this seeks to the matching block and early-terminates instead of
		// scanning the whole backing. `undefined` ⇒ the gate failed (non-binary
		// collation / unexpected shape) and we fall back to the full effective scan,
		// which re-compares with the source collation and is therefore
		// collation-correct. The host executes the scan over the connection's
		// effective (reads-own-writes) state; the binary-collation soundness gate
		// stays engine-side in {@link tryBuildCoveringPrefix}.
		const equalityPrefix = this.tryBuildCoveringPrefix(plan, uc, sourceSchema, newRow);
		for await (const backingRow of host.scanEffective(connection, { equalityPrefix })) {
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

/** Canonical upper-case collation name (absent ⇒ `BINARY`). Used to compare a backing-PK
 *  column's collation against its source PK column's at plan-build (see
 *  {@link MaterializedViewManager.buildLateralTvfPrefixDeletePlan}). */
function normalizeCollation(collation: string | undefined): string {
	return (collation ?? 'BINARY').toUpperCase();
}

function mvKey(schemaName: string, name: string): string {
	return `${schemaName}.${name}`.toLowerCase();
}

/** Every source base (lowercased `schema.table`) a plan must be indexed under in
 *  `rowTimeBySource`. Single-source arms read one base; the 1:1-join arm also reads
 *  the lookup base, so a write to `P` fires maintenance too; the full-rebuild floor reads
 *  every source its body touches (set-op legs, all join sources). */
function planSourceBases(plan: MaintenancePlan): string[] {
	if (plan.kind === 'full-rebuild') {
		return plan.sourceBases;
	}
	if (plan.kind === 'join-residual' && plan.lookupBase !== plan.sourceBase) {
		return [plan.sourceBase, plan.lookupBase];
	}
	return [plan.sourceBase];
}

/** Walk the whole plan; return the string form of the first non-deterministic scalar
 *  expression (a `random()`/`now()`/volatile UDF, anywhere in the body), or `undefined`
 *  when the body is fully deterministic. The full-rebuild floor's whole-body determinism
 *  gate uses this — a non-deterministic body can never be kept equal to its plain view.
 *  `physical.deterministic` is computed lazily and propagates from leaves, so checking each
 *  scalar node is sound on either the pre-physical or optimized plan. */
function findNonDeterministic(node: PlanNode): string | undefined {
	if (isScalarNode(node)) {
		const det = checkDeterministic(node as ScalarPlanNode);
		if (!det.valid) return det.expression ?? node.toString();
	}
	for (const child of node.getChildren()) {
		const found = findNonDeterministic(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
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

/** Count nodes of the given type (recursive `getChildren` walk). Used by the
 *  lateral-TVF gate to reject nested/multiple TVFs. */
function countNodeType(node: PlanNode, type: PlanNodeType): number {
	let n = node.nodeType === type ? 1 : 0;
	for (const child of node.getChildren()) n += countNodeType(child as unknown as PlanNode, type);
	return n;
}

/** Count join nodes (logical + physical) in the plan — used to reject a chained
 *  lateral join (the admitted lateral-TVF shape carries exactly one). */
function countJoins(node: PlanNode): number {
	let n = 0;
	for (const t of JOIN_NODE_TYPES) n += countNodeType(node, t);
	return n;
}

/** Find the first {@link TableFunctionCallNode} anywhere in the plan, or `undefined`. */
function findTableFunctionCall(node: PlanNode): TableFunctionCallNode | undefined {
	if (node instanceof TableFunctionCallNode) return node;
	for (const child of node.getChildren()) {
		const found = findTableFunctionCall(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
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
 * Transitive provenance: chase an output-attr → producing `ColumnReference` chain (a
 * Project-over-Aggregate or a passthrough-through-Join adds a hop the single-hop
 * {@link resolveSourceCol} cannot follow) until landing on a base-source column, or
 * `undefined` (e.g. a TVF-output column with no base-source identity). Shared by the
 * aggregate-residual and lateral-TVF arms.
 */
function resolveTransitiveSourceCol(
	attrId: number,
	sourceAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): number | undefined {
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
}

/**
 * True iff the analyzed join body's WHERE references the lookup table `P` (or any base other
 * than the driving `T`) — the classification the join-residual arm uses to decide whether the
 * lookup side must be delete-capable (see {@link MaterializedViewManager.buildJoinResidualPlan}).
 * The body WHERE — possibly split by predicate-pushdown — surfaces as one or more
 * {@link FilterNode}s above/around the join; the join's own `ON` condition lives inside the
 * JoinNode (not a Filter) and so is excluded. Each column a filter predicate references is
 * resolved against `T`'s attribute→source-column map (transitively); a reference that does NOT
 * resolve to a `T` column is a `P` (the arm requires exactly two base refs, `T` and `P`) — or
 * otherwise non-`T` — reference. Conservative by construction: an unresolved reference counts as
 * lookup-referencing, so the cheaper `T`-only upsert-only path is taken only when **every**
 * filter column provably belongs to `T`.
 */
function bodyWhereReferencesLookup(
	analyzed: BlockNode,
	tAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): boolean {
	const filterAttrs = new Set<number>();
	collectFilterPredicateAttrs(analyzed as unknown as PlanNode, filterAttrs);
	for (const attrId of filterAttrs) {
		if (resolveTransitiveSourceCol(attrId, tAttrToCol, producingByAttrId) === undefined) return true;
	}
	return false;
}

/** Collect every attribute id referenced by a ColumnReferenceNode inside any {@link FilterNode}
 *  predicate in the plan (the body WHERE; the join `ON` condition is not a Filter). */
function collectFilterPredicateAttrs(node: PlanNode, out: Set<number>): void {
	if (node instanceof FilterNode) collectColumnRefAttrs(node.predicate as unknown as PlanNode, out);
	for (const child of node.getChildren()) collectFilterPredicateAttrs(child as unknown as PlanNode, out);
}

/** Collect every {@link ColumnReferenceNode} attribute id in a scalar subtree. */
function collectColumnRefAttrs(node: PlanNode, out: Set<number>): void {
	if (node instanceof ColumnReferenceNode) out.add(node.attributeId);
	for (const child of node.getChildren()) collectColumnRefAttrs(child as unknown as PlanNode, out);
}

/**
 * True iff any {@link FilterNode} predicate in the body (the body WHERE) is non-deterministic.
 * The join-residual arm embeds the body WHERE in every residual (forward, in-scope reverse, and
 * — when delete-capable — membership), so a volatile predicate (`random()`/`now()`/a volatile
 * UDF) would make them irreproducible and diverge from the plain view. The arm therefore declines
 * such a body (returns `null` → the full-rebuild floor, which applies the **pragma-gated**
 * whole-body determinism reject — rejected without `pragma nondeterministic_schema`, accepted as a
 * wholesale rebuild with it), preserving the pre-WHERE-widening behavior rather than building an
 * unsound bounded-delta residual.
 */
function bodyWhereIsNonDeterministic(analyzed: BlockNode): boolean {
	const visit = (node: PlanNode): boolean => {
		if (node instanceof FilterNode && !checkDeterministic(node.predicate).valid) return true;
		for (const child of node.getChildren()) {
			if (visit(child as unknown as PlanNode)) return true;
		}
		return false;
	};
	return visit(analyzed as unknown as PlanNode);
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

/** The root relational node of a block's final relational statement — the node whose
 *  attributes {@link relationalAttributes} reads — or `undefined`. Feeds the shared
 *  coverage-prover join predicates ({@link proveOneToOneJoin}) for the join-residual arm. */
function rootRelationalNode(block: BlockNode): RelationalPlanNode | undefined {
	const children = block.getChildren();
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i] as unknown as PlanNode;
		if (isRelationalNode(child)) return child as unknown as RelationalPlanNode;
	}
	return undefined;
}

/**
 * The diagnostic for a create-time **hard** reject — one of the four non-shape rejections
 * the cost-gated-with-floor model keeps (non-determinism, bag/no-key, no relational output,
 * size). Names the MV and steers to a plain `view` (live re-evaluation) or
 * `create table ... as <body>` (a one-off snapshot) — never a refresh policy, never an
 * internal implementation detail. Used by the arm builders (for their arm-specific
 * determinism diagnostic) and by {@link MaterializedViewManager.buildFullRebuildPlan}.
 */
function cannotMaterialize(mvName: string, detail: string): QuereusError {
	return new QuereusError(
		`materialized view '${mvName}' cannot be materialized: ${detail}. For this body, use a `
			+ `plain 'create view' (live re-evaluation) or 'create table ... as <body>' (a one-off snapshot)`,
		StatusCode.UNSUPPORTED,
	);
}

/**
 * True iff a computed projection expression can be evaluated as a pure function of the
 * changed source row — i.e. it contains no subquery / relational subtree (cross-row) and
 * every column reference resolves to a source column (no correlated / outer reference).
 * This is the "shape" gate distinct from the determinism gate (a determinism failure is
 * caught earlier by `checkDeterministic`); a `false` here is a `null` fall-through to the
 * full-rebuild floor, not a hard reject.
 */
function isSingleRowEvaluable(expr: ScalarPlanNode, sourceDescriptor: RowDescriptor): boolean {
	const visit = (node: PlanNode): boolean => {
		if (node !== expr && isRelationalNode(node)) return false; // a subquery / relational subtree
		if (node instanceof ColumnReferenceNode && sourceDescriptor[node.attributeId] === undefined) {
			return false; // references a value outside the source row
		}
		for (const child of node.getChildren()) {
			if (!visit(child as unknown as PlanNode)) return false;
		}
		return true;
	};
	return visit(expr);
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
