/**
 * Materialized-view maintenance — plan types and the manager's decoupling context.
 *
 * The tagged {@link MaintenancePlan} union (one arm per maintenance strategy) plus the
 * shared plan shapes, the per-column {@link BackingProjector}, the coarsening-collision
 * watch column, the per-statement {@link BackingConnectionCache}, and the
 * {@link MaterializedViewManagerContext} the manager runs against. Split out of
 * `database-materialized-views.ts` (its class + orchestration) so the type surface reads
 * on its own; see that file and `docs/mv-maintenance.md` for how each arm is built and
 * applied.
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SqlValue, Row } from '../common/types.js';
import type { CollationFunction, CollationResolver } from '../types/logical-type.js';
import type { PrimaryKeyColumnDefinition } from '../schema/table.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import type { MaintenanceSourceStats, MaintenanceStrategy } from '../planner/cost/index.js';
import type { DerivedRowConstraintValidator } from './derived-row-validator.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import type { CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import type { Database } from './database.js';
import type { DatabaseEventEmitter } from './database-events.js';
import type * as AST from '../parser/ast.js';

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

	/** Name→function collation lookup against the owning database's registry (throws on an
	 *  unregistered name). Every collation-aware comparison the manager makes — key identity,
	 *  UNIQUE self-conflict, coarsening-collision divergence — resolves through this, so a
	 *  collation registered with `db.registerCollation(...)` is honored instead of silently
	 *  degrading to byte comparison. */
	getCollationResolver(): CollationResolver;

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
 * One backing primary-key column as a {@link MaintenancePlan} sees it: the btree's declared
 * `(index, direction, collation-name)` triple plus the collation *function* the name resolves
 * to, resolved once when the plan is built (`resolveBackingPkColumns`).
 *
 * The name stays for logging and plan equality; the function is what the per-row key
 * comparisons in `database-materialized-views-apply.ts` call, so they never pay a registry
 * lookup — nor silently fall back to byte comparison — per row.
 */
export interface BackingPkColumn extends PrimaryKeyColumnDefinition {
	/** Resolved comparator for {@link collation}; BINARY when the column declares no COLLATE. */
	readonly collationFn: CollationFunction;
}

/**
 * Structural subset of the fields the forward (driving-source) residual-recompute
 * apply path reads — shared by the aggregate {@link ResidualRecomputePlan} and the
 * 1:1-join {@link JoinResidualPlan} so both drive {@link MaterializedViewManager.applyForwardResidual}
 * unchanged. For an aggregate the forward key is the group key (`'gk'`); for a join
 * it is the driving table `T`'s PK (`'pk'`).
 */
export interface ForwardResidualPlan {
	mv: MaintainedTableSchema;
	backingSchema: string;
	backingTableName: string;
	/** Cached scheduler for the key-filtered residual (the body with `injectKeyFilter`
	 *  applied on the driving source). Re-run per affected key, bound through the live txn. */
	residualScheduler: Scheduler;
	bindParamPrefix: 'gk' | 'pk';
	/** Source-column indices of the forward binding key (group columns / `T`'s PK columns). */
	bindColumns: number[];
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
	backingPkSourceCols: number[];
}

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
export interface CoarseningWatchColumn {
	/** Backing column index (= body output column index) the weakened K′ column lands at. */
	readonly index: number;
	/** Source key enforcement collation (pre-coarsening); the divergence test compares under it. */
	readonly sourceCollation: string;
	/** {@link sourceCollation} resolved against the database registry, once at registration. */
	readonly sourceCollationFn: CollationFunction;
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
export interface MaintenancePlanCommon {
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
	/** Backing columns that are BOTH declared NOT NULL AND physical-PK members AND whose
	 *  re-derived body output column is nullable — the exact reachable "NOT-NULL
	 *  ordering-seeded PK over a loosened source" skew. Present ONLY when non-empty (the
	 *  zero-overhead gate: nearly every MV carries `undefined` and pays a single boolean
	 *  check per maintained write — the NOT-NULL/physical-PK set alone is non-empty for
	 *  almost every MV, so the discriminator is the body-nullability term). Precomputed once
	 *  at plan build ({@link MaterializedViewManager.buildMaintenancePlan}). Read by the
	 *  row-time guard in {@link MaterializedViewManager.maintainRowTime} /
	 *  {@link MaterializedViewManager.flushDeferredRebuilds}. The refresh path has its own
	 *  materialized-row equivalent (`assertNoNullInNotNullSeededPk` in
	 *  runtime/emit/materialized-view-helpers.ts). See
	 *  fix/bug-mv-rowtime-null-into-notnull-seeded-pk. */
	nullGuardColumns?: ReadonlyArray<{ readonly index: number; readonly name: string }>;
}

export interface InverseProjectionPlan extends MaintenancePlanCommon {
	readonly kind: 'inverse-projection';
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
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
 * write is O(body) not O(rows × body). See `docs/mv-maintenance.md` § Full-rebuild floor.
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
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
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
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
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
 * per-row visibility. See `docs/mv-maintenance.md` § Synchronous, transactional,
 * per-statement. Because the cache is scoped to one generator run, the connection it holds
 * cannot be torn down mid-statement; the cold enforcement/eviction paths that omit the cache
 * re-resolve the *same* connection deterministically, so reads-own-writes is unaffected.
 */
export type BackingConnectionCache = Map<string, VirtualTableConnection>;
