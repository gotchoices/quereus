import { createLogger } from '../common/logger.js';
import { type SqlValue, StatusCode, type Row, type SqlParameters, type StatementOptions, type DeepReadonly, isSqlValue, describeSqlValueViolation } from '../common/types.js';
import { MisuseError, QuereusError, throwIfAborted } from '../common/errors.js';
import type { Database, ExistingRowScanPlanning } from './database.js';
import { isRelationType, type ColumnDef, type ScalarType } from '../common/datatype.js';
import { Parser } from '../parser/parser.js';
import type { Statement as ASTStatement } from '../parser/ast.js';
import type { BlockNode } from '../planner/nodes/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { InstructionTracer, RuntimeContext } from '../runtime/types.js';
import { WorkCounterCollector, computePlanShape, type PlanShape, type WorkCounterSnapshot } from '../runtime/work-counters.js';
import type { CardinalityObservations } from '../runtime/cardinality-observations.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { REPR_STRICT } from '../runtime/strict-flags.js';
import { assertRowConforms } from '../runtime/strict-representation.js';
import { Cached } from '../util/cached.js';
import { isAsyncIterable, disconnectVTable } from '../runtime/utils.js';
import type { VirtualTable } from '../vtab/table.js';
import type { TableSchema } from '../schema/table.js';
import { generateInstructionProgram, serializePlanTree } from '../planner/debug.js';
import { EmissionContext } from '../runtime/emission-context.js';
import type { BuildTimeDependencyTracker, RowSourceOverrides, SchemaDependency } from '../planner/planning-context.js';
import { boundKeyToParamKey, emptyBoundParams, getParameterTypes, normalizeBoundParams } from './param.js';
import { rowToObject } from './utils.js';
import { getPhysicalType, physicalTypeName, PhysicalType } from '../types/logical-type.js';
import type { CombinedAbortSignal } from '../util/abort-signal.js';
import { ensureAsyncGeneratorCleanupSupported } from '../util/async-generator-support.js';
import { InterruptibleIteration } from './interruptible-iteration.js';
import { analyzeChangeScope, type ChangeScope } from '../planner/analysis/change-scope.js';
import { analyzeWriteScope, bindWriteParameters, type WriteScope } from '../planner/analysis/write-scope.js';
import { collectScalarRequiredParams } from '../planner/analysis/scalar-param-usage.js';
import { isObjectClassValue } from '../util/comparison.js';
import { canonicalizeSqlValue } from '../util/numeric-canonical.js';
import { astToString } from '../emit/ast-stringify.js';
import { FeedbackReplanState, ReportedSizeSnapshot, overlayTableKey } from './database-cardinality-feedback.js';

const log = createLogger('core:statement');
const feedbackLog = createLogger('core:cardinality-feedback');
const errorLog = log.extend('error');

/** Lowercased `schema.table` of every table a plan read — the cardinality-feedback overlay's key. */
function tableDependencyKeys(dependencies: BuildTimeDependencyTracker): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const dep of dependencies.getDependencies()) {
		if (dep.type === 'table' && dep.schemaName) keys.add(overlayTableKey(dep.schemaName, dep.objectName));
	}
	return keys;
}

/**
 * Represents a prepared SQL statement.
 */
export class Statement {
	public readonly db: Database;
	public readonly originalSql: string;
	public readonly astBatch: ASTStatement[];
	private astBatchIndex: number = -1;
	private finalized = false;
	private busy = false;
	private boundArgs: Record<number | string, SqlValue> = emptyBoundParams();
	private plan: BlockNode | null = null;
	private emissionContext: EmissionContext | null = null;
	/**
	 * Cached scheduler for the emitted instruction tree. Emit + schedule are
	 * value-independent (emitters see only `(plan, EmissionContext)`, never bound
	 * params), so this is built once and reused across executions. Its lifetime is
	 * exactly the emission context's: nulled in lockstep with `this.emissionContext`
	 * at every invalidation site, and rebuilt lazily in `_iterateRowsRawInternal`.
	 */
	private scheduler: Scheduler | null = null;
	/**
	 * Work-counter state from the most recent metrics-enabled execution, or null
	 * when the last execution did not collect. The plan shape is captured AT
	 * EXECUTION time (not lazily in getWorkCounters) so a schema-invalidation
	 * recompile between the execution and the read cannot pair a new plan's shape
	 * with the old execution's counters.
	 */
	private workCounters: { collector: WorkCounterCollector; planShape: PlanShape } | null = null;
	private needsCompile = true;
	private columnDefCache = new Cached<DeepReadonly<ColumnDef>[]>(() => this.getColumnDefs());
	private schemaChangeUnsubscriber: (() => void) | null = null;
	/**
	 * Overlay keys of every table the cached plan reads, view and lens bodies included
	 * (they build in this statement's planning context). Recomputed on each compile and
	 * matched against cardinality-feedback shifts in {@link _noteCardinalityShift}.
	 */
	private planTableKeys: ReadonlySet<string> = new Set();
	/** Module-reported sizes the cached plan was costed with; re-checked in {@link dropPlanOnShift}. */
	private reportedSizes = ReportedSizeSnapshot.empty;
	// NOTE: one cooldown per Statement, shared by every statement of a multi-statement
	// batch, so a re-plan of one batch member delays the next member's; if batches ever
	// lean on prompt feedback re-plans, reset this on nextStatement().
	private readonly feedbackReplan = new FeedbackReplanState();
	/**
	 * Types of the parameters that have one: the explicit hints handed to `prepare()`,
	 * or — when the caller supplied values instead — the type each parameter's FIRST
	 * bound value implied. Undefined while no parameter has a type at all; see
	 * {@link establishParameterTypes} for why that is not the same as an empty map.
	 */
	private parameterTypes: Map<string | number, ScalarType> | undefined = undefined;
	/**
	 * True when {@link parameterTypes} came from an explicit hint map handed to
	 * `prepare()`. Such a map is CLOSED: a parameter it does not name stays ANY
	 * however it is later bound, and nothing is validated against it. That is a
	 * deliberate surface, not an oversight — `InternalStatementCache` prepares its FK
	 * probes with an EMPTY map precisely to get an affinity-neutral plan and no
	 * bind-time validation, so one cached statement can be rebound to an integer key
	 * on one row and a text key on the next.
	 */
	private readonly parameterTypesDeclared: boolean;
	/**
	 * Parameter names/indices used directly as a comparand in a scalar comparison
	 * (`= <> < <= > >=` / `IN` / `BETWEEN`) against a non-object scalar operand.
	 * Binding any of these to a JS array / plain object can never match, so it is
	 * rejected at bind time in {@link validateParameterTypes}. Recomputed on each
	 * (re)compilation from the logical plan; see `analysis/scalar-param-usage.ts`.
	 */
	private scalarRequiredParams: Set<string | number> = new Set();
	/** Debug options set via Database.prepareDebug(). @internal */
	_debugOptions?: import('../planner/planning-context.js').DebugOptions;
	/**
	 * @internal Schema-path override applied when this statement plans (compile is
	 * deferred, so setting this right after `db.prepare(...)` is race-free). Used by
	 * the stored-body seams (materialized-view body re-plans) so an unqualified name
	 * in the body resolves against the owning object's home schema, not the session
	 * path — see {@link Database._homeSchemaPath}.
	 */
	_schemaPathOverride?: string[];
	/**
	 * @internal The table whose declared mutation-context variables this statement reads
	 * as one that supplied no `with context` envelope. Set right after `db.prepare(...)`,
	 * under the same deferred-compile reasoning as {@link _schemaPathOverride}, by exactly
	 * one site: the existing-row CHECK scan (`validateChecksOverExistingRows`,
	 * `schema/constraint-builder.ts`), which prepares SQL text and so has no scope of its
	 * own to register the variables in. Keep it that way.
	 */
	_noEnvelopeContextTable?: TableSchema;
	/**
	 * @internal Tables this statement reads from the given rows instead of from their module (see
	 * `PlanningContext.rowSourceOverrides`). Set right after `db.prepare(...)`, under the same
	 * deferred-compile reasoning as {@link _schemaPathOverride}, by the existing-row scans run
	 * over each state a rollback could restore (`scanChecksOverRows` and `scanForOrphans`,
	 * `schema/constraint-builder.ts`), so each such pass re-runs the very SQL the effective
	 * pass ran.
	 */
	_rowSourceOverrides?: RowSourceOverrides;
	/**
	 * @internal When true, this statement emits with scalar fusion disabled, so its
	 * instruction graph is the full, faithful sub-program form. Set right after
	 * `db.prepare(...)` by debug introspection (the `execution_trace()` TVF), which
	 * joins trace events against `scheduler_program()` by instruction index — the two
	 * must agree, and `scheduler_program()` reports the unfused graph. Compile is
	 * deferred, so setting this before first iteration is race-free, exactly as
	 * {@link _schemaPathOverride} documents.
	 */
	_emitUnfused?: boolean;

	/**
	 * @internal - Use db.prepare().
	 * The `sqlOrAstBatch` can be a single SQL string (parsed internally) or a pre-parsed batch.
	 * `initialAstIndex` is for internal use when db.prepare might create one Statement per AST in a batch.
	 * `paramsOrTypes` can be initial parameter values (to infer types) or explicit types.
	 */
	constructor(
		db: Database,
		sqlOrAstBatch: string | ASTStatement[],
		initialAstIndex: number = 0,
		paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>
	) {
		this.db = db;
		if (typeof sqlOrAstBatch === 'string') {
			this.originalSql = sqlOrAstBatch;
			const parser = new Parser();
			this.astBatch = parser.parseAll(this.originalSql);
		} else {
			this.astBatch = sqlOrAstBatch;
			// Try to reconstruct originalSql if possible, or set a generic name
			this.originalSql = this.astBatch.map(s => astToString(s)).join('; ');
		}

		// Handle explicit parameter types or initial values
		this.parameterTypesDeclared = paramsOrTypes instanceof Map;
		if (paramsOrTypes instanceof Map) {
			// Explicit parameter types provided — taken as given, never extended.
			this.parameterTypes = paramsOrTypes;
		} else if (paramsOrTypes !== undefined) {
			// Initial parameter values. Keys collapse onto one spelling per parameter and
			// values canonicalize (a safe-range bigint narrows to number, R1 —
			// util/numeric-canonical.ts) as they enter boundArgs: per-bind, not per-row,
			// and shared by every ingress site (here, bind, bindAll, Database.exec,
			// change-scope's bindParameters).
			this.boundArgs = normalizeBoundParams(paramsOrTypes, 'prepare');
			// Types follow from those values NOW, not at the first compile: prepare-time
			// values are the declaration, so `prepare(sql, [1, 42]).run([2, 3.14])` must
			// be a type mismatch and not a re-inference. Routed through the shared helper
			// so the "no values is not an empty type map" rule holds here too — inferring
			// inline is what let `prepare(sql, [])` freeze an established-but-EMPTY map
			// and pin every later-bound parameter at ANY.
			this.establishParameterTypes();
		}

		if (this.astBatch.length === 0 && initialAstIndex === 0) {
			// No statements to run, effectively. nextStatement will return false.
			this.astBatchIndex = -1;
			this.needsCompile = false;
		} else if (initialAstIndex >= 0 && initialAstIndex < this.astBatch.length) {
			this.astBatchIndex = initialAstIndex;
			this.needsCompile = true; // Start by needing to compile the first indicated statement
		} else {
			throw new MisuseError("Initial AST index out of bounds for provided batch.");
		}
	}

	/** Advances to the next statement in the batch. Returns false if no more statements. */
	public nextStatement(): boolean {
		this.validateStatement("advance from");
		if (this.busy) throw new MisuseError("Statement busy, reset or complete current iteration first.");
		if (this.astBatchIndex < this.astBatch.length - 1) {
			this.astBatchIndex++;
			this.invalidatePlan();
			// Inferred types described the statement just left behind; a caller's explicit
			// hint map was given for the whole prepared text and stays in force.
			if (!this.parameterTypesDeclared) this.parameterTypes = undefined;
			return true;
		} else {
			return false;
		}
	}

	/** Returns the SQL fragment for the current statement, if available. */
	public getBlockSql(): string {
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			return "";
		}
		return astToString(this.getAstStatement());
	}

	/**
	 * Drops the compiled plan and everything derived from it, so the next
	 * {@link compile} rebuilds. THE one invalidation set — every caller that
	 * invalidates (schema change, statement advance, first bind onto a provisional
	 * plan, cardinality-feedback re-plan) goes through here so none can forget a
	 * member and leave, say, a stale scheduler emitted from a discarded plan.
	 */
	private invalidatePlan(): void {
		this.needsCompile = true;
		this.plan = null;
		this.emissionContext = null;
		this.scheduler = null;
		this.columnDefCache.clear();
		this.reportedSizes = ReportedSizeSnapshot.empty;
		this.feedbackReplan.onPlanDropped();
	}

	/**
	 * @internal The observed size of `key` (lowercased `schema.table`) shifted. Only marks
	 * a cached plan that reads it; the plan is dropped at an execution start the cooldown
	 * allows ({@link dropPlanOnShift}), so a running execution is never disturbed.
	 */
	_noteCardinalityShift(key: string): void {
		if (this.plan && this.planTableKeys.has(key)) this.feedbackReplan.markShift();
	}

	/**
	 * Drops a plan marked by an overlay shift, or whose module-reported sizes drifted since
	 * it compiled, when the statement's re-plan cooldown allows it.
	 */
	private dropPlanOnShift(): void {
		if (this.reportedSizes.drifted(this.db)) this.feedbackReplan.markShift();
		if (!this.feedbackReplan.onExecutionStart(this.db.optimizer.tuning.cardinalityFeedback.replanCooldown)) return;
		feedbackLog('Re-plan for statement: %s', this.getBlockSql().substring(0, 100));
		this.invalidatePlan();
	}

	/**
	 * The parameter types to plan with, covering every parameter that has a bound
	 * value by the time this runs.
	 *
	 * Each parameter's type is established ONCE — by the first value ever bound to it
	 * — and is never re-inferred afterwards. That frozen contract is what
	 * {@link validateParameterTypes} checks and what lets repeated executions reuse one
	 * plan. Extending the map is not re-inferring: a parameter with no type yet has
	 * never been planned against anything, so taking its first value's type contradicts
	 * nothing already announced.
	 *
	 * Explicit hints short-circuit all of this — see {@link parameterTypesDeclared}.
	 *
	 * Returns undefined while NO parameter has a type. That state must not be recorded
	 * as an established-but-empty map: an empty map is indistinguishable from "typed,
	 * and there are none", and recording it would pin every parameter at ANY even
	 * after values arrive.
	 */
	private establishParameterTypes(): Map<string | number, ScalarType> | undefined {
		if (this.parameterTypesDeclared) return this.parameterTypes;
		const inferred = getParameterTypes(this.boundArgs);
		if (!inferred || inferred.size === 0) return this.parameterTypes;
		if (this.parameterTypes === undefined) {
			this.parameterTypes = inferred;
		} else {
			for (const [key, type] of inferred) {
				if (!this.parameterTypes.has(key)) this.parameterTypes.set(key, type);
			}
		}
		return this.parameterTypes;
	}

	/** True when some bound value belongs to a parameter that has no type yet. */
	private hasUntypedBinding(): boolean {
		for (const key of Object.keys(this.boundArgs)) {
			if (!this.parameterTypes?.has(boundKeyToParamKey(key))) return true;
		}
		return false;
	}

	/**
	 * Called after every bind. A cached plan announces the parameter types that were
	 * established when it was built, so a bind that gives a value to a parameter that
	 * plan had NO type for — one compiled before any bind, or compiled while only some
	 * of the parameters were bound — no longer describes the query that will run.
	 * Discard it; the next compile plans against the newly available types.
	 *
	 * Costs at most one extra compile per parameter first bound after a compile, and
	 * none at all for a statement that binds before it plans.
	 *
	 * NOTE: `all(params)` / `get(params)` on a statement prepared WITHOUT values read
	 * `getColumnNames()` (which compiles) before handing `params` down, so they pay
	 * that extra compile on their first execution; `readConcurrency: 'committed'` adds
	 * {@link tryRouteConcurrent}'s compile ahead of it. Harmless: a result column's
	 * name and the column count come from the projection, and committed-read
	 * eligibility from the node kinds in the tree, so neither reads parameter types.
	 * If the extra compile ever shows up in a profile, bind at those call sites before
	 * reading names and pass `undefined` downstream, as {@link Database.get} already
	 * does.
	 */
	private dropStalePlanOnBind(): void {
		// A declared hint map never grows, so no bind can make the cached plan stale.
		if (!this.plan || this.parameterTypesDeclared) return;
		if (!this.hasUntypedBinding()) return;
		this.invalidatePlan();
	}

	/** @internal Plans the current AST statement */
	public compile(): BlockNode {
		if (this.plan && !this.needsCompile) return this.plan;

		this.validateStatement("compile/plan");
		this.columnDefCache.clear();

		log("Planning current statement (new runtime): %s", this.getBlockSql().substring(0, 100));
		let plan: BlockNode | undefined;
		try {
			const currentAst = this.getAstStatement();

			// Types come from the values bound so far, never from emptiness: compiling
			// with nothing bound leaves them undefined rather than freezing an empty (but
			// established) map, which would pin every parameter at ANY for the statement's
			// whole life. A parameter that already has a type keeps it — that frozen
			// contract is what validateParameterTypes checks, and what lets repeated
			// executions reuse one plan — while one bound for the FIRST time after this
			// plan was built has already invalidated it (see dropStalePlanOnBind).
			const parameterTypes = this.establishParameterTypes();

			// Pass parameter types directly to planning
			const { plan: rawPlan, schemaDependencies: dependencies } = this.db._buildPlan([currentAst], parameterTypes, this._schemaPathOverride, this.existingRowScanPlanning());
			// Collect array-valued-scalar-param guard targets from the LOGICAL plan,
			// before the access-path optimizer folds `col = ?` comparisons into index
			// seeks (which erases the comparison node). See validateParameterTypes.
			this.scalarRequiredParams = collectScalarRequiredParams(rawPlan);
			plan = this.db.optimizer.optimize(rawPlan, this.db) as BlockNode;
			this.planTableKeys = tableDependencyKeys(dependencies);
			this.reportedSizes = ReportedSizeSnapshot.capture(this.db, dependencies.getDependencies());

			// Always drop the previous listener before (re)compiling, even when the new
			// plan has no dependencies — otherwise a zero-dependency recompile leaks the
			// old listener on the schema-change notifier.
			if (this.schemaChangeUnsubscriber) {
				this.schemaChangeUnsubscriber();
				this.schemaChangeUnsubscriber = null;
			}

			// Set up schema change invalidation only when we have dependencies
			if (dependencies && dependencies.hasAnyDependencies()) {
				// Add new listener for schema changes that affect our dependencies
				this.schemaChangeUnsubscriber = this.db.schemaManager.getChangeNotifier().addListener(event => {
					// Map event type to the dependency type(s) it can affect
					let dependencyTypes: string[];
					if (event.type === 'view_modified') {
						dependencyTypes = ['view'];
					} else if (event.type === 'view_added' || event.type === 'view_removed') {
						dependencyTypes = ['view', 'view_read'];
					} else if (event.type === 'materialized_view_added'
						|| event.type === 'materialized_view_removed'
						|| event.type === 'materialized_view_modified') {
						// Unified model: a maintained table IS a table, so plans that read
						// or write it record 'table' dependencies — an attach/detach/
						// re-attach must invalidate them (a cached direct-write plan must
						// not survive an attach, nor a write-through plan a detach).
						// Legacy 'view' dependencies are still honored.
						dependencyTypes = ['table', 'view'];
					} else if (event.type.startsWith('table_')) {
						dependencyTypes = ['table'];
					} else if (event.type.startsWith('function_')) {
						dependencyTypes = ['function'];
					} else if (event.type.startsWith('module_')) {
						dependencyTypes = ['vtab_module'];
					} else if (event.type.startsWith('collation_')) {
						dependencyTypes = ['collation'];
					} else {
						return; // Unknown event type
					}

					// Check if this change affects any of our dependencies
					const planDependencies = dependencies.getDependencies();
					const affectedDependency = planDependencies.find((dep: SchemaDependency) =>
						dependencyTypes.includes(dep.type) &&
						dep.objectName === event.objectName &&
						(!dep.schemaName || dep.schemaName === event.schemaName)
					);

					if (affectedDependency) {
						log('Schema change invalidated plan for statement: %s %s', event.type, event.objectName);
						this.invalidatePlan();
					}
				});
			}

			this.needsCompile = false;
			log("Planning complete for current statement.");
		} catch (e) {
			errorLog("Planning failed for current statement: %O", e);
			if (e instanceof QuereusError) throw e;
			if (e instanceof Error) throw new QuereusError(`Planning error: ${e.message}`, StatusCode.INTERNAL, e);
			throw new QuereusError("Unknown planning error", StatusCode.INTERNAL);
		}
		if (!plan) throw new QuereusError("Planning resulted in no plan for current statement", StatusCode.INTERNAL);
		this.plan = plan;
		return plan;
	}

	/** @internal Gets or creates the emission context for this statement */
	private getEmissionContext(): EmissionContext {
		if (!this.emissionContext) {
			this.emissionContext = new EmissionContext(
				this.db,
				this._emitUnfused ? { fuseScalars: false } : undefined,
			);
		}
		return this.emissionContext;
	}

	/**
	 * Binds a user-provided argument value to a declared parameter name/index for the current statement.
	 */
	bind(key: number | string, value: SqlValue): this {
		this.validateStatement("bind argument for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		if (!isSqlValue(value)) {
			throw new MisuseError(`bind: invalid value for key '${key}': expected SqlValue, got ${describeSqlValueViolation(value)}`);
		}
		if (typeof key !== 'number' && typeof key !== 'string') {
			throw new MisuseError("Invalid argument key type");
		}
		// One spelling per parameter, as at every other ingress — ':p'/'$p'/'p' and
		// '1'/':1'/':01' each collapse to one key. The index range check runs AFTER
		// normalization so bind(':0') is rejected exactly as bind(0) is.
		const paramKey = typeof key === 'number' ? key : boundKeyToParamKey(key);
		if (typeof paramKey === 'number' && paramKey < 1) {
			throw new RangeError(`Argument index ${key} out of range (must be >= 1)`);
		}
		this.boundArgs[paramKey] = canonicalizeSqlValue(value);
		this.dropStalePlanOnBind();
		return this;
	}

	/**
	 * Binds all user-provided argument values for the current statement.
	 */
	bindAll(args: SqlParameters | SqlValue[]): this {
		this.validateStatement("bind all parameters for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		if (!Array.isArray(args) && (typeof args !== 'object' || args === null)) {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}
		// Normalize first, assign second: a rejected object (bad value, or one parameter
		// bound under two spellings) leaves the previous bindings untouched.
		this.boundArgs = normalizeBoundParams(args, 'bindAll');
		this.dropStalePlanOnBind();
		return this;
	}

	/** Checks if the current statement, when executed, is expected to produce rows. */
	public isQuery(): boolean {
		this.validateStatement("check if query");
		const blockPlan = this.compile();
		if (!blockPlan || blockPlan.statements.length === 0) return false;
		const lastStatementInBlock = blockPlan.statements[blockPlan.statements.length - 1];
		const relationType = lastStatementInBlock.getType();
		return isRelationType(relationType);
	}

	/**
	 * Low-level row iteration. Does NOT handle transactions - caller must manage.
	 * @internal
	 */
	private async *_iterateRowsRawInternal(
		params?: SqlParameters | SqlValue[],
		runtimeOverrides?: {
			tracer?: InstructionTracer;
			enableMetrics?: boolean;
			signal?: AbortSignal;
			/** Mutex-free committed read — see {@link RuntimeContext.readCommitted}. */
			readCommitted?: boolean;
		}
	): AsyncIterable<Row> {
		this.validateStatement("iterate rows for");
		if (this.busy) throw new MisuseError("Statement busy, another iteration may be in progress or reset needed.");

		// Pre-flight cancellation: reject immediately on an already-aborted signal.
		throwIfAborted(runtimeOverrides?.signal);

		if (params) this.bindAll(params);

		// Validate parameter types before execution
		this.validateParameterTypes();

		this.busy = true;
		// Per-execution cache of connected inner-scan vtab instances (see
		// runtime/emit/scan.ts). Declared out here so the teardown `finally` can
		// disconnect every instance exactly once on all exit paths (normal completion,
		// break, error, abort). `runtimeCtx` is likewise hoisted so `finally` can reach
		// it after the try body assigns it.
		const scanConnections = new Map<symbol, VirtualTable>();
		let runtimeCtx: RuntimeContext | undefined;
		let runtimeSignal: CombinedAbortSignal | undefined;
		let cardinalityObservations: CardinalityObservations | undefined;
		try {
			// Drop the previous execution's counters up front, so every early exit
			// below (empty block, compile throw) leaves `getWorkCounters()` reporting
			// nothing rather than the execution before last.
			this.workCounters = null;
			this.dropPlanOnShift();
			const blockPlanNode = this.compile();
			if (!blockPlanNode.statements.length) return;

			const emissionContext = this.getEmissionContext();
			// Emit + schedule once and reuse across executions — the instruction tree is
			// value-independent (bound params resolve from ctx.params at run time, not at
			// emit time), and its validity is exactly the emission context's, which is
			// nulled together with `this.scheduler` on any schema-dependency change.
			// NOTE: the emission context (and thus this scheduler) is cached, so toggling
			// the `trace_plan_stack` or `runtime_fuse_scalars` db options mid-life is
			// ignored until the plan is recompiled — the tracing wrap and the fuse-or-not
			// decision are both baked at emit time. Pre-existing behavior, unchanged here;
			// caching the scheduler does not regress it (per-run tracer wrapping lives in
			// the scheduler hooks, not baked). Recompile to pick up a toggle.
			if (!this.scheduler) {
				const rootInstruction = emitPlanNode(blockPlanNode, emissionContext);
				this.scheduler = new Scheduler(rootInstruction);
			}
			const scheduler = this.scheduler;
			const tracer = runtimeOverrides?.tracer ?? this.db.getInstructionTracer();
			const enableMetrics = runtimeOverrides?.enableMetrics ?? Boolean(this.db.getOption('runtime_metrics'));
			const signal = runtimeOverrides?.signal;
			// One collector per execution (concurrent iterations are refused by `busy`
			// above, so replacing the previous execution's collector is unambiguous).
			const collector = enableMetrics ? new WorkCounterCollector(scheduler) : undefined;
			if (collector) {
				this.workCounters = { collector, planShape: computePlanShape(blockPlanNode) };
			}
			cardinalityObservations = this.db._beginCardinalityObservations();
			// The scan and DML row checks see close() too. The output boundary below keeps the
			// caller's signal alone, so its no-signal fast path survives; close() interrupts an
			// iteration at that boundary itself (see InterruptibleIteration).
			runtimeSignal = this.db._statementSignal(signal);
			runtimeCtx = {
				db: this.db,
				stmt: this,
				params: this.boundArgs,
				context: createStrictRowContextMap(),
				tableContexts: wrapTableContextsStrict(new Map()),
				tracer,
				enableMetrics,
				signal: runtimeSignal.signal,
				scanConnections,
				readCommitted: runtimeOverrides?.readCommitted,
				workCounters: collector,
				cardinalityObservations,
			};

			// Validate captured schema objects once per execution — hoisted out of every
			// capturing instruction's run (see createValidatedInstruction). Runs after any
			// schema-change listener would have fired; a defensive existence check for a
			// schema change racing execution setup. Skip when nothing was captured.
			if (emissionContext.getCapturedObjectCount() > 0) {
				emissionContext.validateCapturedSchemaObjects();
			}

			const results = await scheduler.run(runtimeCtx);
			if (results) {
				if (Array.isArray(results) && results.length) {
					const lastStatementOutput = results[results.length - 1];
					if (isAsyncIterable(lastStatementOutput)) {
						yield* this._iterateWithSignal(lastStatementOutput as AsyncIterable<Row>, signal);
					}
				} else if (isAsyncIterable(results)) {
					yield* this._iterateWithSignal(results as AsyncIterable<Row>, signal);
				}
			}
		} catch (e) {
			errorLog('Runtime execution failed in iterateRows for current statement: %O', e);
			if (e instanceof QuereusError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Execution error: ${message}`, StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			// Disconnect every inner-scan instance connected during this execution,
			// exactly once. This `finally` runs after the consumer finishes draining
			// (normal completion, `break`, error, or abort — the async generator's
			// teardown), so the cached instances stay live for the whole streaming
			// window and are released here. `runtimeCtx` is undefined only on the
			// no-statements early return, where the map is empty anyway.
			runtimeSignal?.dispose();
			if (runtimeCtx) {
				for (const vtab of scanConnections.values()) {
					await disconnectVTable(runtimeCtx, vtab);
				}
			}
			scanConnections.clear();
			this.db._publishCardinalityObservations(cardinalityObservations, runtimeOverrides?.readCommitted ?? false);
			this.busy = false;
		}
	}

	/**
	 * Re-yields a row stream while honoring a cancellation signal at every row
	 * boundary. Covers output stages with no underlying table scan (e.g. `values`,
	 * recursive CTEs) that the scan-leaf checkpoint cannot reach.
	 * @internal
	 */
	private async *_iterateWithSignal(source: AsyncIterable<Row>, signal?: AbortSignal): AsyncIterable<Row> {
		if (!signal && !REPR_STRICT) {
			yield* source;
			return;
		}
		// QUEREUS_REPR_STRICT backstop seam: rows yielded to the caller. This is the only
		// one of the five seams that sees an EXPRESSION producing a non-canonical value
		// (an arithmetic path that forgot to narrow) — the scan, table-valued function,
		// write and UDF seams all sit upstream of it.
		//
		// R1 + R2, against each result column's announced type (a `ScalarType` inference,
		// reachable via `getColumnDefs()`). An announced ANY imposes no R2 constraint.
		//
		// NOTE: binary arithmetic over two safe-integer operands returns the raw double
		// when the exact answer escapes the safe range (`9007199254740991 * 3`), which the
		// announced INTEGER does not admit —
		// `backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`. No suite
		// site trips it today, but a boundary case added later would.
		//
		// The announced NULLABILITY flag is a separate axis this seam does not check:
		// R2 admits null in every position. A measurement run asserting "announced
		// non-nullable ⇒ no null cell" found ~28 violations across several classes
		// (builtins whose `inferReturnType` claims non-nullable while nulling on a null
		// argument, outer-join columns not widened, empty scalar subqueries) — see
		// `backlog/debt-announced-nullability-disagrees-with-produced-nulls`.
		const reprColumns = REPR_STRICT ? this.columnDefCache.value : undefined;
		const reprNames = reprColumns?.map(col => col.name);
		const reprTypes = reprColumns?.map(col => col.type.logicalType);
		for await (const row of source) {
			if (signal) throwIfAborted(signal);
			if (reprTypes) assertRowConforms(row, reprTypes, 'the statement result row', reprNames);
			yield row;
		}
	}

	/** @internal Low-level row iteration without overrides. */
	async *_iterateRowsRaw(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncIterable<Row> {
		yield* this._iterateRowsRawInternal(params, { signal });
	}

	/**
	 * @internal True when this execution should take the mutex-free committed-read
	 * path: the caller opted in (`readConcurrency: 'committed'`) and the compiled
	 * block passes {@link Database._isConcurrentReadEligible}. Compiles early
	 * (synchronously) — the serialized path is untouched and still compiles
	 * lazily inside the mutex when this returns false. Never throws: an
	 * ineligible or uncompilable statement falls back to the serialized path,
	 * where a compile error re-surfaces identically (compile failures are not
	 * memoized).
	 */
	private tryRouteConcurrent(options?: StatementOptions): boolean {
		if (options?.readConcurrency !== 'committed') return false;
		try {
			return this.db._isConcurrentReadEligible(this.compile());
		} catch (e) {
			log('committed-read routing declined (compile failed): %O', e);
			return false;
		}
	}

	/**
	 * @internal Mutex-free committed-read execution. Runs WITHOUT the exec mutex
	 * and MUST NOT touch the implicit-transaction lifecycle
	 * (`_finalizeImplicitTransaction` / `_ensureTransaction` / autocommit
	 * helpers) — any open implicit transaction belongs to the writer running
	 * alongside, and finalizing it here would commit or roll back the WRITER's
	 * transaction. Every table scan connects with `_readCommitted: true` (see
	 * `RuntimeContext.readCommitted`), serving the last committed state.
	 *
	 * The read registers with the database at first pull (not at routing time), so an
	 * iterator that is never consumed holds nothing; from then until its `finally`,
	 * `Database.close()` can interrupt it and waits for it to unwind.
	 */
	_iterateConcurrent(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Row> {
		return new InterruptibleIteration<Row>(iteration => this.concurrentIteration(params, options, iteration));
	}

	private async *concurrentIteration(params: SqlParameters | SqlValue[] | undefined, options: StatementOptions | undefined, iteration: InterruptibleIteration<Row>): AsyncGenerator<Row> {
		throwIfAborted(options?.signal);
		// This path skips Database._acquireExecMutex, so it refuses unsupported hosts itself.
		const supportCheck = ensureAsyncGeneratorCleanupSupported();
		if (supportCheck) await supportCheck;
		this.db._beginCommittedRead(iteration);
		try {
			yield* this._iterateRowsRawInternal(params, { signal: options?.signal, readCommitted: true });
		} finally {
			this.db._endCommittedRead(iteration);
		}
	}

	/**
	 * Iterates over result rows. Handles JIT transaction management - commits
	 * implicit transactions on successful completion, rolls back on error. The
	 * execution mutex is held until that has finished.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked on the first pull and at every row
	 *   boundary so iteration can be interrupted on a request timeout).
	 */
	iterateRows(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Row> {
		if (this.tryRouteConcurrent(options)) {
			// Mutex-free committed read: no transaction to finalize here — the
			// writer owns any open implicit transaction (see _iterateConcurrent).
			return this._iterateConcurrent(params, options);
		}
		return this._iterateRowsSerialized(params, options?.signal);
	}

	private _iterateRowsSerialized(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncIterableIterator<Row> {
		return this.db._iterateSerialized(() => this._iterateRowsRaw(params, signal), signal);
	}

	private _iterateObjectsSerialized(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncIterableIterator<Record<string, SqlValue>> {
		return this.db._iterateSerialized(() => this._iterateObjectsRaw(params, signal), signal);
	}

	private async *_iterateObjectsRaw(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncGenerator<Record<string, SqlValue>> {
		const names = this.getColumnNames();
		for await (const row of this._iterateRowsRaw(params, signal)) {
			yield rowToObject(row, names);
		}
	}

	/**
	 * Iterates over result rows while forcing instruction tracing for this execution.
	 * Metrics are disabled for trace runs to ensure the tracing scheduler mode is used.
	 *
	 * Takes the execution mutex, so code already running inside a statement, such as a
	 * table-valued function body, must call {@link _iterateRowsNestedWithTrace} instead.
	 */
	iterateRowsWithTrace(params: SqlParameters | SqlValue[] | undefined, tracer: InstructionTracer): AsyncIterableIterator<Row> {
		return this.db._iterateSerialized(() => this._iterateRowsTraced(params, tracer));
	}

	/**
	 * {@link iterateRowsWithTrace} for a statement run inside another statement, whose
	 * caller already holds the execution mutex. An implicit transaction open at the start
	 * belongs to the enclosing statement, which finalizes it; with none open, any
	 * transaction this statement starts is its own.
	 *
	 * @internal
	 *
	 * NOTE: when an enclosing implicit transaction is open and this statement fails, the
	 * trace functions swallow the error and the enclosing statement commits. The failed
	 * statement's own savepoints have undone its writes, except the rows OR FAIL keeps, but
	 * OR ROLLBACK does not end the enclosing transaction. If that ever matters for a trace
	 * run, surface the error from the trace functions.
	 */
	async *_iterateRowsNestedWithTrace(params: SqlParameters | SqlValue[] | undefined, tracer: InstructionTracer): AsyncGenerator<Row> {
		const body = () => this._iterateRowsTraced(params, tracer);
		if (this.db._isImplicitTransaction()) {
			yield* body();
		} else {
			yield* this.db._iterateFinalizing(body);
		}
	}

	private _iterateRowsTraced(params: SqlParameters | SqlValue[] | undefined, tracer: InstructionTracer): AsyncIterable<Row> {
		return this._iterateRowsRawInternal(params, { tracer, enableMetrics: false });
	}

	getColumnNames(): string[] {
		this.validateStatement("get column names for");
		return this.columnDefCache.value.map(col => col.name);
	}

	/**
	 * Machine-independent work counters from the most recent execution, or
	 * `undefined` when that execution did not collect (metrics off — the
	 * `runtime_stats`/`runtime_metrics` database option gates collection; no
	 * separate switch).
	 *
	 * The snapshot is a fresh by-value copy — a caller holding an earlier one
	 * never watches it mutate. Counts are only COMPLETE once the row iterable has
	 * been fully drained: breaking out of a `for await` yields a partial count
	 * that will read as a regression if compared against a drained run. An
	 * execution that threw likewise leaves the counts recorded up to the throw —
	 * partial, but diagnostic.
	 */
	getWorkCounters(): WorkCounterSnapshot | undefined {
		return this.workCounters
			? this.workCounters.collector.snapshot(this.workCounters.planShape)
			: undefined;
	}

	/**
	 * Plan-shape facts (node count and per-PlanNodeType tallies) for the current
	 * statement. Available after compile — no execution needed, so a harness that
	 * only ever prepares statements (e.g. the planner benchmark suite) can still
	 * report these.
	 */
	getPlanShape(): PlanShape {
		this.validateStatement("get plan shape for");
		return computePlanShape(this.compile());
	}

	/**
	 * Resets the prepared statement to its initial state, ready to be re-executed.
	 */
	async reset(): Promise<void> {
		this.validateStatement("reset");
		// Refuse while an iteration is in flight, matching bind/bindAll/clearBindings/
		// nextStatement. Clearing `busy` here would let a second iteration slip past the
		// guard in _iterateRowsRawInternal → two concurrent iterations over one statement.
		// finalize() remains the escape hatch that force-clears `busy`.
		if (this.busy) throw new MisuseError("Statement busy, cannot reset an in-flight iteration; complete or finalize it first.");
	}

	/**
	 * Clears all bound parameter values.
	 * Note: This does NOT trigger recompilation - parameter types are preserved.
	 */
	clearBindings(): this {
		this.validateStatement("clear bindings for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = emptyBoundParams();
		// Don't set needsCompile - parameter types are preserved
		return this;
	}

	/**
	 * Finalizes the statement, releasing associated resources.
	 */
	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		this.busy = false;
		this.boundArgs = emptyBoundParams();
		this.plan = null;
		this.emissionContext = null;
		this.scheduler = null;
		this.workCounters = null;
		this.columnDefCache.clear();
		this.astBatchIndex = -1;

		// Clean up schema change listener
		if (this.schemaChangeUnsubscriber) {
			this.schemaChangeUnsubscriber();
			this.schemaChangeUnsubscriber = null;
		}

		this.db._statementFinalized(this);
	}

	/**
	 * Executes the prepared statement with the given parameters until completion.
	 * Transactions are started lazily (just-in-time) when the first DML or DDL
	 * operation occurs. Implicit transactions are committed after execution.
	 *
	 * The execution is serialized through the database mutex to prevent concurrent
	 * transactions from interfering with each other.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at
	 *   execution boundaries during the run).
	 */
	async run(params?: SqlParameters | SqlValue[], options?: StatementOptions): Promise<void> {
		this.validateStatement("run");
		// Pre-flight cancellation: reject before acquiring the mutex / doing work.
		throwIfAborted(options?.signal);

		if (this.tryRouteConcurrent(options)) {
			// Mutex-free committed read (eligibility guarantees read-only): drain
			// without touching the implicit-transaction lifecycle.
			for await (const _ of this._iterateConcurrent(params, options)) {
				/* Consume all rows */
			}
			return;
		}

		for await (const _ of this._iterateRowsSerialized(params, options?.signal)) {
			/* Consume all rows */
		}
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves the first result row.
	 * Transactions are started lazily (just-in-time) when needed.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at the
	 *   row boundary while the first row is produced).
	 */
	async get(params?: SqlParameters | SqlValue[], options?: StatementOptions): Promise<Record<string, SqlValue> | undefined> {
		this.validateStatement("get first row for");
		// Pre-flight cancellation: reject before acquiring the mutex / doing work.
		throwIfAborted(options?.signal);

		if (this.tryRouteConcurrent(options)) {
			const names = this.getColumnNames();
			// The early return triggers the generator's return() → its finally, so
			// scan connections disconnect and the read scope ends.
			for await (const row of this._iterateConcurrent(params, options)) {
				return rowToObject(row, names);
			}
			return undefined;
		}

		// The early return closes the generator, which commits; a failed commit rejects here.
		for await (const row of this._iterateObjectsSerialized(params, options?.signal)) {
			return row;
		}
		return undefined;
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves all result rows.
	 * Transactions are started lazily (just-in-time) when needed.
	 * The mutex is held for the entire iteration, including the commit that ends it.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at every
	 *   row boundary so streaming can be interrupted on a request timeout).
	 */
	all(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Record<string, SqlValue>> {
		this.validateStatement("get all rows for");

		if (this.tryRouteConcurrent(options)) {
			return this._allConcurrentGenerator(params, options);
		}

		return this._iterateObjectsSerialized(params, options?.signal);
	}

	/**
	 * @internal Committed-read counterpart of {@link _iterateObjectsRaw}: maps the
	 * mutex-free row stream to objects. No transaction finalization — see
	 * {@link _iterateConcurrent}.
	 */
	private async *_allConcurrentGenerator(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncGenerator<Record<string, SqlValue>> {
		const names = this.getColumnNames();
		for await (const row of this._iterateConcurrent(params, options)) {
			yield rowToObject(row, names);
		}
	}

	/**
	 * Gets the parameters required by the current statement.
	 */
	getParameters(): SqlParameters {
		this.validateStatement("get parameters for");
		const blockPlan = this.compile();
		return { ...blockPlan.parameters };
	}

	/**
	 * Gets the data type of a column in the current row.
	 */
	getColumnType(index: number): Readonly<ScalarType> {
		this.validateStatement("get column type for");
		const columnDefs = this.columnDefCache.value;
		if (index < 0 || index >= columnDefs.length) {
			throw new RangeError(`Column index ${index} out of range.`);
		}
		return columnDefs[index].type;
	}

	/**
	 * Gets the name of a column by its index.
	 */
	getColumnName(index: number): string {
		this.validateStatement("get column name for");
		const names = this.getColumnNames();
		if (index < 0 || index >= names.length) {
			throw new RangeError(`Column index ${index} out of range (0-${names.length - 1})`);
		}
		return names[index];
	}

	getColumnDefs(): DeepReadonly<ColumnDef>[] {
		if (!this.plan) {
			if (this.astBatchIndex >= 0 && this.astBatchIndex < this.astBatch.length && this.needsCompile) {
				try { this.compile(); } catch { /*ignore compile error for _getColumnDefs, return empty */ }
			}
			if (!this.plan) return [];
		}
		const lastStatementPlanInBlock = this.plan.statements[this.plan.statements.length - 1];
		if (lastStatementPlanInBlock) {
			const relationType = lastStatementPlanInBlock.getType();
			if (isRelationType(relationType) && relationType.columns) {
				return [...relationType.columns];
			}
		}
		return [];
	}

	private validateStatement(operation: string): void {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			throw new MisuseError(`No current statement selected to ${operation}. Call nextStatement() first or ensure SQL was not empty.`);
		}
	}

	private getAstStatement(): ASTStatement {
		this.validateStatement("get AST for");
		return this.astBatch[this.astBatchIndex];
	}

	/**
	 * Validates that bound parameters match the expected types from compilation.
	 * Validates that the JavaScript value is compatible with the physical type of the declared logical type.
	 * @throws QuereusError if parameter types don't match
	 */
	private validateParameterTypes(): void {
		// Ensure the plan is compiled so `scalarRequiredParams` reflects the current
		// statement (compile() is memoized — cheap when already planned).
		this.compile();

		// Reject an array/object value bound to a parameter that is used as a scalar
		// comparand (`= <> < <= > >=` / `IN` / `BETWEEN` against a scalar operand).
		// Such a binding can never match — the OBJECT storage class sorts above every
		// scalar — so we diagnose it here at bind time rather than letting the query
		// silently return no rows. The set is collected structurally at plan time
		// (JSON-vs-JSON comparisons are excluded), so this never over-fires.
		for (const key of this.scalarRequiredParams) {
			// `scalarRequiredParams` keys are plan-side (already bare / numeric) and
			// boundArgs is normalized to the same keys at ingress, so one lookup finds
			// the binding whatever spelling the caller used. `undefined` still means
			// "not bound" — a parameter bound to `null` reads as `null` and is checked.
			const value = this.boundArgs[key];
			if (value !== undefined && isObjectClassValue(value)) {
				throw new QuereusError(
					`parameter ${typeof key === 'number' ? `?${key}` : `:${key}`} ` +
					`bound to an array/object value but used in a scalar comparison`,
					StatusCode.MISMATCH
				);
			}
		}

		if (!this.parameterTypes) return; // No parameter types established yet

		for (const [key, expectedType] of this.parameterTypes.entries()) {
			const value = this.boundArgs[key];

			// Allow undefined/missing parameters (they'll be caught at runtime if required)
			if (value === undefined) continue;

			// NULL is compatible with any nullable type
			if (value === null) {
				if (!expectedType.nullable) {
					throw new QuereusError(
						`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
						`expected non-nullable ${expectedType.logicalType.name}, got NULL`,
						StatusCode.MISMATCH
					);
				}
				continue;
			}

			// Get the physical type of the declared logical type
			const expectedPhysicalType = expectedType.logicalType.physicalType;

			// Get the physical type directly from the JavaScript value
			const actualPhysicalType = getPhysicalType(value);

			// Check if physical types are compatible
			// INTEGER is compatible with REAL (any integer is a valid real number)
			const isCompatible =
				actualPhysicalType === expectedPhysicalType ||
				(expectedPhysicalType === PhysicalType.REAL && actualPhysicalType === PhysicalType.INTEGER);

			if (!isCompatible) {
				throw new QuereusError(
					`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
					`expected ${expectedType.logicalType.name} (physical: ${physicalTypeName(expectedPhysicalType)}), ` +
					`got value with physical type ${physicalTypeName(actualPhysicalType)}`,
					StatusCode.MISMATCH
				);
			}
		}
	}

	/**
	 * Analyzes which base-table state and external inputs the statement may
	 * read from, returning a serializable `ChangeScope`. Bound parameters
	 * provided via `params` (or already bound to the statement) are
	 * substituted into the scope's row-binding placeholders; remaining
	 * placeholders surface under `unboundParameters`.
	 */
	getChangeScope(params?: SqlParameters | SqlValue[]): ChangeScope {
		this.validateStatement("get change scope for");
		const plan = this.getAnalysisPlan();
		const effectiveParams = params ?? (Object.keys(this.boundArgs).length > 0 ? this.boundArgs : undefined);
		const sm = this.db.schemaManager;
		return analyzeChangeScope(plan, {
			...(effectiveParams !== undefined ? { params: effectiveParams } : {}),
			// Project a maintained table's reference onto its cached source-union
			// scope, widening the watch to the sources whose mutations drive its
			// maintenance. (The table itself is change-logged too — maintenance
			// records its realized deltas — so this is granularity, not a
			// prerequisite.) Ordinary tables resolve to `undefined` and keep
			// reporting themselves.
			resolveMaterializedViewSource: (table) =>
				sm.getMaintainedTable(table.schema, table.table)?.derivation.sourceScope,
		});
	}

	/**
	 * Describes the statement's writes — one entry per write site: which rows
	 * it targets and how it chose them, where each written value comes from,
	 * what else it reads, which constraints could reject it, and whether
	 * re-applying it to its own result would change anything. A statement
	 * with no write site returns empty `writes`. Bound parameters (`params`,
	 * or those already bound to the statement) are substituted into the
	 * selection and read placeholders; the rest surface under
	 * `unboundParameters`. See docs/write-scope.md.
	 */
	getWriteScope(params?: SqlParameters | SqlValue[]): WriteScope {
		this.validateStatement("get write scope for");
		const plan = this.getAnalysisPlan();
		const effectiveParams = params ?? (Object.keys(this.boundArgs).length > 0 ? this.boundArgs : undefined);
		const scope = analyzeWriteScope(plan, this.db);
		return effectiveParams !== undefined ? bindWriteParameters(scope, effectiveParams) : scope;
	}

	/**
	 * @internal Build (or re-build) a pre-physical analysis plan for the
	 * current AST statement. Analysis-only callers (change-scope, write-scope,
	 * future binding-aware tools) need a plan whose TableReferenceNodes still
	 * sit in plain logical structure, not wrapped by physical access
	 * operators. This path is independent of the execution plan cache.
	 */
	private getAnalysisPlan(): BlockNode {
		const currentAst = this.getAstStatement();
		const { plan: rawPlan } = this.db._buildPlan([currentAst], this.establishParameterTypes(), this._schemaPathOverride, this.existingRowScanPlanning());
		return this.db.optimizer.optimizeForAnalysis(rawPlan, this.db) as BlockNode;
	}

	private existingRowScanPlanning(): ExistingRowScanPlanning {
		return { noEnvelopeContextTable: this._noEnvelopeContextTable, rowSourceOverrides: this._rowSourceOverrides };
	}

	/**
	 * Gets a detailed JSON representation of the query plan for debugging.
	 * @returns JSON string containing the detailed plan tree.
	 */
	getDebugPlan(): string {
		this.validateStatement("get debug plan for");
		const plan = this.compile();
		return serializePlanTree(plan);
	}

	/**
	 * Gets a human-readable instruction program for debugging.
	 * @returns String representation of the instruction program.
	 */
	getDebugProgram(): string {
		this.validateStatement("get debug program for");
		const plan = this.compile();
		// A fresh unfused context, NOT the cached one: this dump exists to show the
		// full instruction graph, and scalar fusion would dissolve scalar sub-programs
		// into opaque fused(...) entries. Debug introspection reports the unfused
		// graph; a normal execution still runs the (possibly fused) cached form.
		const emissionContext = new EmissionContext(this.db, { fuseScalars: false });
		const rootInstruction = emitPlanNode(plan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		return generateInstructionProgram(scheduler.instructions, scheduler.destinations);
	}
}

