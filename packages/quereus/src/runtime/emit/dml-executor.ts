import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun, OutputValue } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError, ConstraintError, FailConflictError, RollbackConflictError, throwIfAborted } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue, type SubProgram, isConstraintViolation } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../util/mutation-statement.js';
import type { UpdateArgs, VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { hasNativeEventSupport } from '../../util/event-support.js';
import { sqlValueIdentical } from '../../util/comparison.js';
import { withAsyncRowContext } from '../context-helpers.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { executeForeignKeyActionsAndLens, assertTransitiveRestrictsForParentMutation } from '../foreign-key-actions.js';
import type { BackingConnectionCache } from '../../core/database-materialized-views.js';
import type { BackingRowChange } from '../../vtab/backing-host.js';

/**
 * Module-scope counter producing unique statement-savepoint names across
 * concurrent emissions. Names must be unique within the TransactionManager's
 * savepoint stack; per-runInsert counters would collide for nested mutations
 * (e.g. FK cascade during the parent insert).
 */
let stmtSavepointCounter = 0;

/**
 * Runtime UPSERT clause with pre-resolved evaluator callbacks.
 * The callbacks are resolved by the scheduler from the params array.
 */
interface RuntimeUpsertClause {
	conflictTargetIndices?: number[];
	action: 'nothing' | 'update';
	/** Indices into the evaluators array for each assignment (column index -> evaluator index) */
	assignmentIndices?: Map<number, number>;
	/** Index into the evaluators array for WHERE condition, or -1 if no WHERE */
	whereIndex: number;
	/** Row descriptor for NEW references */
	newRowDescriptor?: RowDescriptor;
	/** Row descriptor for existing row references */
	existingRowDescriptor?: RowDescriptor;
}

/**
 * Returns true when the table's owning *module* natively emits data events.
 * The gate must consult the MODULE, not the vtab instance: StoreModule exposes
 * getEventEmitter only at the module level — its table instances do not — so an
 * instance check spuriously reports "no native support" and the engine double-emits
 * alongside the module's native emitter. Mirrors the schema-event gate in
 * schema/manager.ts (emitAutoSchemaEventIfNeeded).
 */
function moduleHasNativeDataEvents(ctx: RuntimeContext, tableSchema: TableSchema): boolean {
	const moduleName = tableSchema.vtabModuleName;
	const moduleReg = moduleName ? ctx.db._getVtabModule(moduleName) : undefined;
	return hasNativeEventSupport(moduleReg?.module);
}

/**
 * Returns true when the target table's owning *module* guarantees per-scan
 * snapshot isolation — a `query()` iterator sees a stable snapshot even if
 * `update()` mutates the same table mid-scan. Consulted by runUpdate/runDelete
 * to decide whether a predicate DELETE/UPDATE may stream the source scan or must
 * first drain it (physical Halloween avoidance). Consults the MODULE, not the
 * vtab instance — mirrors moduleHasNativeDataEvents. Default (flag unset) =
 * false = not snapshot-isolated = drain before mutating.
 */
function moduleHasScanSnapshotIsolation(ctx: RuntimeContext, tableSchema: TableSchema): boolean {
	const moduleName = tableSchema.vtabModuleName;
	const moduleReg = moduleName ? ctx.db._getVtabModule(moduleName) : undefined;
	return moduleReg?.module?.scanSnapshotIsolation === true;
}

/**
 * Fully drain a source scan into an in-memory array, closing the scan cursor
 * before any write is applied. This is the read-phase / write-phase separation
 * that avoids the physical Halloween hazard for modules WITHOUT per-scan
 * snapshot isolation: a predicate DELETE/UPDATE must finish reading which rows
 * to change before it starts changing them, or the first write invalidates the
 * cursor path the scan is still walking. Reads are side-effect-free, so draining
 * before the statement savepoint opens is safe.
 */
async function drainSourceRows(rows: AsyncIterable<Row>): Promise<Row[]> {
	const buffered: Row[] = [];
	for await (const row of rows) {
		buffered.push(row);
	}
	return buffered;
}

/**
 * Resolve the row source a predicate UPDATE/DELETE feeds to
 * `runWithStatementSavepoints`: stream it verbatim when the target module has
 * per-scan snapshot isolation, otherwise drain it up front (read/write phase
 * separation — see {@link drainSourceRows}).
 *
 * The drain is consumed HERE, outside `runWithStatementSavepoints`' try/finally,
 * so a scan or abort error mid-drain would otherwise skip the target vtab's
 * `disconnect()` that finally guarantees. Guard it: on a drain failure, disconnect
 * the already-connected target vtab before propagating, matching the streaming
 * path (where the source is consumed inside that try/finally).
 */
async function resolveDmlSourceRows(
	ctx: RuntimeContext,
	vtab: VirtualTable,
	tableSchema: TableSchema,
	rows: AsyncIterable<Row>,
): Promise<AsyncIterable<Row> | Iterable<Row>> {
	if (moduleHasScanSnapshotIsolation(ctx, tableSchema)) {
		return rows;
	}
	try {
		return await drainSourceRows(rows);
	} catch (e) {
		await disconnectVTable(ctx, vtab);
		throw e;
	}
}

/**
 * Emit an automatic data change event for modules without native event support.
 */
function emitAutoDataEvent(
	ctx: RuntimeContext,
	tableSchema: TableSchema,
	type: 'insert' | 'update' | 'delete',
	key: SqlValue[],
	oldRow?: Row,
	newRow?: Row,
	changedColumns?: string[]
): void {
	ctx.db._getEventEmitter().emitAutoDataEvent(
		tableSchema.vtabModuleName ?? 'memory',
		{
			type,
			schemaName: tableSchema.schemaName,
			tableName: tableSchema.name,
			key,
			oldRow,
			newRow,
			changedColumns,
			remote: false, // Auto-emitted events are always local
		}
	);
}

/**
 * Synchronously drive row-time (write-through) materialized-view maintenance for
 * one source row-write, immediately after the change is recorded. A no-op fast
 * path (one synchronous map lookup) when no `row-time` MV depends on `tableKey`,
 * so non-covered tables pay effectively nothing. The maintenance writes the
 * covering MV's backing table within the same transaction (visible mid-statement;
 * committed/rolled-back in lockstep with this write) — see
 * `core/database-materialized-views.ts` § row-time write-through.
 *
 * `cache` is the per-statement {@link BackingConnectionCache} the generator owns: it
 * amortizes the backing-connection resolution over the whole statement (one scan per
 * backing instead of one per source row) while still applying each bounded-delta arm's
 * ops immediately, so within-statement enforcement visibility is unchanged.
 *
 * `deferred` is the per-statement deferred-rebuild set the generator owns: a full-rebuild
 * covering MV is marked dirty here (not applied per row) and rebuilt once at the
 * end-of-statement flush ({@link runWithStatementSavepoints}). Bounded-delta arms stay
 * per-row-immediate.
 */
async function maintainRowTimeStructures(
	ctx: RuntimeContext,
	tableKey: string,
	change: BackingRowChange,
	cache: BackingConnectionCache,
	deferred: Set<string>,
): Promise<void> {
	if (!ctx.db._hasRowTimeCoveringStructures(tableKey)) return;
	await ctx.db._maintainRowTimeCoveringStructures(tableKey, change, cache, deferred);
}

/**
 * Evaluate the per-statement mutation-context evaluators once, producing the
 * context row passed to the mutation-statement builders (or undefined when
 * there are no context evaluators). Shared by all three DML generators.
 */
async function evaluateContextRow(
	ctx: RuntimeContext,
	contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>,
): Promise<Row | undefined> {
	if (contextEvaluators.length === 0) return undefined;
	const contextRow: SqlValue[] = [];
	for (const evaluator of contextEvaluators) {
		contextRow.push(await evaluator(ctx) as SqlValue);
	}
	return contextRow as Row;
}

/**
 * Engine-level READONLY backstop for maintained tables — the defense-in-depth
 * second net behind plan-time write-through dispatch.
 *
 * A maintained table's rows are *derived* (it carries a {@link TableDerivation};
 * `schema/derivation.ts`). The only engine surfaces permitted to write them are
 * the privileged backing-host paths (`applyMaintenance` / `replaceContents`, the
 * attach/refresh reconcile, the store rehydrate-refill, the isolation flush
 * `trustedWrite`) — none of which route through the DML executor. User DML naming
 * a maintained table is rewritten to **write-through** against the body's base
 * source at plan time (the three DML builders' view-mutation dispatch + the
 * resolved-schema backstop), so a `DmlExecutorNode` whose target still carries a
 * derivation can only be a plan-time mis-dispatch — a direct-write plan that
 * would silently diverge the derived contents from the source. This converts that
 * whole bug class into a loud READONLY error at emit time.
 *
 * Keyed structurally on `derivation` presence ({@link isMaintainedTable}) — never
 * on the table name. Emit-time (a single prepare-time check), not per-row: zero
 * runtime cost, and re-checked on every re-plan because `set / drop maintained`
 * invalidate the `'table'` statement-cache dependency. Exported so a spec test can
 * exercise it directly with a derivation-bearing schema: the backstop is
 * deliberately unreachable from SQL (plan-time dispatch routes every reachable
 * spelling away from it), so the exported guard plus the one wiring call site is
 * the honest pin.
 */
export function assertNotMaintainedTableTarget(tableSchema: TableSchema): void {
	if (isMaintainedTable(tableSchema)) {
		throw new QuereusError(
			`table '${tableSchema.schemaName}.${tableSchema.name}' is a maintained table — its contents are derived `
			+ `and may not be written directly (user DML routes through write-through; this plan bypassed the dispatch — engine bug)`,
			StatusCode.READONLY,
		);
	}
}

export function emitDmlExecutor(plan: DmlExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// READONLY backstop: a DmlExecutorNode targeting a maintained table is a
	// plan-time mis-dispatch (user DML should have been rewritten to write-through
	// against the base source). Reject loudly rather than letting a direct write
	// silently diverge the derived contents — see assertNotMaintainedTableTarget.
	assertNotMaintainedTableTarget(tableSchema);

	// Pre-calculate primary key column indices from schema (needed for update/delete)
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	// Emit mutation context evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (plan.mutationContextValues && plan.contextAttributes) {
		for (const attr of plan.contextAttributes) {
			const valueNode = plan.mutationContextValues.get(attr.name);
			if (!valueNode) {
				throw new QuereusError(`Missing mutation context value for '${attr.name}'`, StatusCode.INTERNAL);
			}
			const instruction = emitCallFromPlan(valueNode, ctx);
			contextEvaluatorInstructions.push(instruction);
		}
	}

	// Build UPSERT clause metadata and emit evaluator instructions
	// All evaluators are collected into a single array that gets passed as params
	const upsertEvaluatorInstructions: Instruction[] = [];
	let runtimeUpsertClauses: RuntimeUpsertClause[] | undefined;

	if (plan.upsertClauses && plan.upsertClauses.length > 0) {
		runtimeUpsertClauses = plan.upsertClauses.map(clause => {
			const runtime: RuntimeUpsertClause = {
				conflictTargetIndices: clause.conflictTargetIndices,
				action: clause.action,
				whereIndex: -1,
				newRowDescriptor: clause.newRowDescriptor,
				existingRowDescriptor: clause.existingRowDescriptor,
			};

			if (clause.action === 'update' && clause.assignments) {
				runtime.assignmentIndices = new Map();
				for (const [colIndex, valueNode] of clause.assignments) {
					const evaluatorIndex = upsertEvaluatorInstructions.length;
					const instruction = emitCallFromPlan(valueNode, ctx);
					upsertEvaluatorInstructions.push(instruction);
					runtime.assignmentIndices.set(colIndex, evaluatorIndex);
				}
			}

			if (clause.whereCondition) {
				runtime.whereIndex = upsertEvaluatorInstructions.length;
				const whereInstruction = emitCallFromPlan(clause.whereCondition, ctx);
				upsertEvaluatorInstructions.push(whereInstruction);
			}

			return runtime;
		});
	}

	// --- Operation-specific run generators ------------------------------------

	/**
	 * Match an UPSERT clause against a unique constraint violation.
	 *
	 * The vtab's constraint result reports the conflicting `existingRow` but not
	 * which specific UNIQUE constraint fired. We therefore infer the match by
	 * value: a clause covers the conflict only when the proposed row equals the
	 * existing row at every one of the clause's conflict-target columns. This is
	 * what scopes `DO NOTHING` / `DO UPDATE` to its declared target — including a
	 * PK-targeted clause, which simply has the PK columns as its targets. A
	 * conflict on a *different* unique constraint (e.g. a secondary UNIQUE) leaves
	 * the target columns unequal, so no clause matches and the caller aborts with
	 * a UNIQUE constraint error.
	 *
	 * Returns the matching clause if found, undefined otherwise.
	 */
	function matchUpsertClause(
		existingRow: Row,
		proposedRow: Row,
		clauses: RuntimeUpsertClause[]
	): RuntimeUpsertClause | undefined {
		for (const clause of clauses) {
			if (!clause.conflictTargetIndices) {
				// No conflict target specified - matches any unique constraint
				return clause;
			}

			// Match when the proposed values equal the existing row at the clause's
			// conflict-target columns — i.e. the conflict is on those columns.
			// NOTE: two residual corners this value-comparison cannot disambiguate,
			// neither in scope here:
			//  - Multi-constraint coincidence: if an insert violates the targeted
			//    constraint AND another unique constraint at once, and the vtab
			//    returns the targeted constraint's existingRow, the row is still
			//    suppressed though the uncovered conflict should abort. The vtab
			//    short-circuits on the first violation, so even full
			//    constraint-identity tracking couldn't fix this without it
			//    reporting every violated constraint.
			//  - Representation-sensitive keys: sqlValueIdentical is numeric-storage-class
			//    tolerant (bigint/number no longer diverge), but `proposedRow` reaches us
			//    pre-affinity-coercion (the insert pipeline defers type conversion to the
			//    vtab's storage layer) while `existingRow` is the already-coerced stored
			//    row. So a conflict the vtab raised under affinity (e.g. insert '1' into an
			//    INTEGER key holding 1) OR under a coarser collation (e.g. NOCASE
			//    case-variant) compares unequal here and aborts rather than skips.
			//    Both share one fix: compare the way the constraint enforces — apply
			//    the column's affinity to the proposed value and compare via the
			//    constraint's enforcement collation (uniqueEnforcementCollations +
			//    compareSqlValuesFast) instead of sqlValueIdentical. Well-formed seeds
			//    re-present byte-identical literals, so seed idempotency is
			//    unaffected; this only bites type-mismatched ON CONFLICT writes.
			const conflictMatch = clause.conflictTargetIndices.every(idx =>
				sqlValueIdentical(existingRow[idx], proposedRow[idx])
			);

			if (conflictMatch) {
				return clause;
			}
		}
		return undefined;
	}


	/**
	 * Execute the DO UPDATE path for an UPSERT clause.
	 * Returns the updated row or undefined if WHERE condition fails.
	 */
	async function executeUpsertUpdate(
		rctx: RuntimeContext,
		vtab: VirtualTable,
		clause: RuntimeUpsertClause,
		existingRow: Row,
		proposedRow: Row,
		contextRow: Row | undefined,
		upsertEvaluators: SubProgram[]
	): Promise<{ updatedRow: Row; flatRow: Row } | undefined> {
		// Check WHERE condition if present
		if (clause.whereIndex >= 0 && clause.newRowDescriptor && clause.existingRowDescriptor) {
			const whereEvaluator = upsertEvaluators[clause.whereIndex];
			// Evaluate WHERE with both NEW (proposed) and existing row contexts
			const whereResult = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
				return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
					return await whereEvaluator(rctx);
				});
			});

			// If WHERE evaluates to false/null, skip this row (DO NOTHING equivalent)
			if (!whereResult) {
				return undefined;
			}
		}

		// Build the updated row by starting with existing row and applying assignments
		const updatedRow = [...existingRow] as Row;

		if (clause.assignmentIndices && clause.newRowDescriptor && clause.existingRowDescriptor) {
			// Evaluate assignment expressions with proper contexts
			for (const [colIndex, evaluatorIndex] of clause.assignmentIndices) {
				const evaluator = upsertEvaluators[evaluatorIndex];
				const value = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
					return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
						return await evaluator(rctx);
					});
				}) as SqlValue;
				updatedRow[colIndex] = value;
			}
		}

		// Extract the primary key from existing row
		const keyValues = pkColumnIndicesInSchema.map(idx => existingRow[idx]);

		// Perform the UPDATE operation
		const updateArgs: UpdateArgs = {
			operation: 'update',
			values: updatedRow,
			oldKeyValues: keyValues,
			onConflict: ConflictResolution.ABORT,
			mutationStatement: vtab.wantStatements ?
				buildUpdateStatement(tableSchema, updatedRow, keyValues, contextRow) : undefined
		};

		const updateResult = await vtab.update!(updateArgs);

		if (isConstraintViolation(updateResult)) {
			throw new ConstraintError(
				updateResult.message ?? `${updateResult.constraint} constraint failed during UPSERT update`,
				StatusCode.CONSTRAINT
			);
		}

		if (!updateResult.row) {
			return undefined;
		}

		// Build a flat row for RETURNING (OLD = existing, NEW = updated)
		const flatRow: Row = [...existingRow, ...updatedRow];

		return { updatedRow, flatRow };
	}

	/**
	 * Translate a generic ConstraintError into the right OR-clause subclass
	 * based on the active statement-level conflict resolution. FAIL and
	 * RollbackConflictError pass through unchanged. The iterator-level
	 * cleanup uses the subclass to decide commit-vs-rollback semantics.
	 */
	function translateConflictError(
		err: unknown,
		stmtOR: ConflictResolution | undefined,
	): unknown {
		if (!(err instanceof ConstraintError)) return err;
		if (err instanceof FailConflictError || err instanceof RollbackConflictError) return err;

		if (stmtOR === ConflictResolution.FAIL) {
			return new FailConflictError(err.message, err.code);
		}
		if (stmtOR === ConflictResolution.ROLLBACK) {
			return new RollbackConflictError(err.message, err.code);
		}
		return err;
	}

	/**
	 * Shared statement-/row-level savepoint scaffold for multi-row DML, used by
	 * all three generators. Owns the savepoint lifecycle that makes a multi-row
	 * mutation atomic inside an explicit transaction, plus the per-row OR FAIL
	 * savepoint that keeps prior rows while undoing only the failing row.
	 * INSERT/UPDATE/DELETE reduce to a `processRow` closure carrying the
	 * operation-specific body (vtab.update + bookkeeping + FK actions + events).
	 *
	 * - non-FAIL (ABORT default / IGNORE / REPLACE / ROLLBACK): one
	 *   statement-scope savepoint, released after the loop completes and
	 *   rolled-back-and-released on ANY throw escaping the loop — whether from
	 *   the source iterator (e.g. a ConstraintCheckNode above the executor
	 *   raising NOT NULL / CHECK before a row is yielded) or from `processRow`
	 *   (a vtab-returned constraint, or a RESTRICT pre-check). This is the
	 *   statement-atomicity guarantee, mirroring SQLite's implicit
	 *   per-statement savepoint: all of a statement's row effects apply or none.
	 * - OR FAIL: per-row savepoint, released on success, rolled back on throw,
	 *   so the failing row's partial work (incl. a row-time backing write that
	 *   lands before a later maintenance throw) is undone while earlier rows
	 *   survive. FAIL deliberately skips the statement-scope wrap.
	 *
	 * Always uses the broadcast savepoint helpers so per-connection savepoint
	 * stacks stay in lockstep with the TransactionManager's stack — including a
	 * connection registered lazily mid-statement (the row-time backing
	 * connection registers on the first maintenance call; Database.registerConnection
	 * replays the active savepoint depth onto it, which already includes the
	 * statement savepoint created before the row loop).
	 */
	async function* runWithStatementSavepoints(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		// AsyncIterable when streaming the source scan (INSERT, and
		// snapshot-isolated UPDATE/DELETE targets); a buffered Row[] when a
		// non-snapshot-isolated UPDATE/DELETE has drained its source up front to
		// separate the read phase from the write phase. `for await ... of`
		// consumes either — the savepoint/FAIL-mode logic below is unchanged.
		rows: AsyncIterable<Row> | Iterable<Row>,
		isFailMode: boolean,
		processRow: (flatRow: Row) => Promise<Row | undefined>,
		deferredRebuilds: Set<string>,
		backingConnCache: BackingConnectionCache,
	): AsyncIterable<Row> {
		let failSavepointCounter = 0;

		// For non-FAIL modes wrap the whole statement so a mid-statement failure
		// unwinds partial writes from earlier rows. FAIL keeps prior rows, so it
		// uses the per-row savepoint (opened inside the loop) instead. Share the
		// module-scope counter so a cascade-nested savepoint name (e.g. an FK
		// cascade UPDATE during a parent UPDATE) can't collide with the parent's.
		const stmtSavepointName = !isFailMode
			? `__stmt_atomic_${stmtSavepointCounter++}`
			: undefined;
		if (stmtSavepointName) {
			await ctx.db._createSavepointBroadcast(stmtSavepointName);
		}

		try {
			try {
				for await (const flatRow of rows) {
					// Cooperative cancellation checkpoint for scan-less / output-less
					// mutations. A bulk INSERT/UPDATE/DELETE whose source is not a table
					// scan (e.g. INSERT … VALUES, or INSERT … SELECT from a TVF / CTE with
					// no base-table read) is reached by neither the scan-leaf checkpoint
					// nor the statement output-row boundary, so without this poll a
					// caller's abort could only take effect once the whole drain finished.
					// Polling once per source row interrupts the drain at the next row
					// boundary; the throw routes through the savepoint machinery below,
					// unwinding this statement's partial writes. Cheap relative to the
					// per-row vtab.update() this loop already awaits.
					throwIfAborted(ctx.signal);

					// OR FAIL per-row savepoint. Broadcast (not the bare variant)
					// so a connection registering mid-row keeps its stack in
					// lockstep — see the doc comment above.
					let savepointName: string | undefined;
					if (isFailMode) {
						savepointName = `__or_fail_${failSavepointCounter++}`;
						await ctx.db._createSavepointBroadcast(savepointName);
					}

					let rowToYield: Row | undefined;
					let succeeded = false;
					try {
						rowToYield = await processRow(flatRow);
						succeeded = true;
					} catch (e) {
						if (savepointName) {
							await ctx.db._rollbackAndReleaseSavepointBroadcast(savepointName);
							savepointName = undefined;
						}
						// Translate plain constraint violations to FAIL/ROLLBACK error
						// subclasses so the iterator-level cleanup picks the right
						// finalization branch.
						throw translateConflictError(e, plan.onConflict);
					}

					if (succeeded && savepointName) {
						await ctx.db._releaseSavepointBroadcast(savepointName);
					}

					if (rowToYield !== undefined) {
						yield rowToYield;
					}
				}
				// End-of-statement boundary: drain the deferred full-rebuild set NOW — after
				// every source row has been applied (so each rebuild reads all this
				// statement's writes) and BEFORE the statement savepoint releases (so a
				// failed rebuild rolls the whole statement back). Inside the try, so a flush
				// error routes to the rollback branch below. A no-op when nothing deferred.
				if (deferredRebuilds.size > 0) {
					await ctx.db._flushDeferredRebuilds(deferredRebuilds, backingConnCache);
				}
				if (stmtSavepointName) {
					await ctx.db._releaseSavepointBroadcast(stmtSavepointName);
				}
			} catch (e) {
				if (stmtSavepointName) {
					await ctx.db._rollbackAndReleaseSavepointBroadcast(stmtSavepointName);
				} else if (deferredRebuilds.size > 0) {
					// OR FAIL keeps the rows that already succeeded (it runs with no
					// statement-scope savepoint), so a mid-statement abort does NOT unwind
					// them. Their deferred full-rebuild MVs must therefore still be flushed
					// before the conflict error propagates — otherwise the backing would lag
					// the surviving source rows mid-transaction (read(MV) != evaluate(body)).
					// The failing row's own per-row savepoint already reverted its writes, so
					// the rebuild re-evaluates over exactly the surviving rows. The original
					// conflict error is re-thrown after the flush. (A flush failure here is a
					// genuine maintenance error and supersedes the conflict error, matching
					// "a maintenance error fails the source write".)
					await ctx.db._flushDeferredRebuilds(deferredRebuilds, backingConnCache);
				}
				throw e;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// INSERT ----------------------------------------------------
	// Number of context evaluators (used to split params in runInsert)
	const numContextEvaluators = contextEvaluatorInstructions.length;


	async function* runInsert(
		ctx: RuntimeContext,
		rows: AsyncIterable<Row>,
		...allEvaluators: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		// Split evaluators: first numContextEvaluators are context, rest are upsert
		const contextEvaluators = allEvaluators.slice(0, numContextEvaluators);
		const upsertEvaluators = allEvaluators.slice(numContextEvaluators) as SubProgram[];

		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache: resolve each covering MV's backing
		// connection once for the whole statement rather than once per source row.
		const backingConnCache: BackingConnectionCache = new Map();
		// Per-statement deferred full-rebuild set (MV keys): full-rebuild covering MVs
		// are marked dirty during the row loop and rebuilt once at the end-of-statement
		// flush in runWithStatementSavepoints.
		const deferredRebuilds = new Set<string>();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;
		// Stamp the per-row mutation ordinal so a column `default` referencing
		// `mutation_ordinal()` (a per-row surrogate allocator) resolves to the 1-based
		// position of the row being produced. The defaults are evaluated upstream as
		// each row is *pulled*, so the ordinal is set BEFORE pulling — see
		// `stampMutationOrdinal`.
		yield* runWithStatementSavepoints(
			ctx, vtab, stampMutationOrdinal(ctx, rows), isFailMode,
			(flatRow) => processInsertRow(
				ctx, vtab, needsAutoEvents, flatRow, contextRow, runtimeUpsertClauses, upsertEvaluators, backingConnCache, deferredRebuilds,
			),
			deferredRebuilds, backingConnCache,
		);
	}

	/**
	 * Wrap the INSERT source so `rctx.mutationOrdinal` holds the 1-based ordinal of the
	 * row about to be produced. The column-default projection runs upstream when each
	 * row is *pulled*, so the ordinal is set immediately before `it.next()` — that pull
	 * drives the default evaluation for exactly that row, and `mutation_ordinal()` reads
	 * the just-set value. Saved/restored so a nested mutation (an FK cascade, a
	 * row-time backing write) does not see a stale ordinal, and cleared in `finally` so
	 * it never leaks past the statement.
	 */
	async function* stampMutationOrdinal(rctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
		const saved = rctx.mutationOrdinal;
		const it = rows[Symbol.asyncIterator]();
		let ordinal = 0;
		try {
			while (true) {
				rctx.mutationOrdinal = ordinal + 1;
				const next = await it.next();
				if (next.done) break;
				ordinal += 1;
				yield next.value;
			}
		} finally {
			rctx.mutationOrdinal = saved;
			if (it.return) await it.return();
		}
	}

	/**
	 * Performs a single row's INSERT side-effects (vtab.update + bookkeeping +
	 * UPSERT handling + REPLACE handling). Returns the row to yield downstream,
	 * or undefined if the row should be skipped (IGNORE / DO NOTHING).
	 *
	 * Throws ConstraintError on violations the executor cannot recover from.
	 */
	async function processInsertRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		runtimeUpsertClauses: RuntimeUpsertClause[] | undefined,
		upsertEvaluators: SubProgram[],
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
	): Promise<Row | undefined> {
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildInsertStatement(tableSchema, newRow, contextRow);
		}

		const args: UpdateArgs = {
			operation: 'insert',
			values: newRow,
			oldKeyValues: undefined,
			// Pass undefined when there's no statement-level OR clause so the vtab
			// can fall back to per-constraint defaultConflict directives. The memory
			// module treats undefined as ABORT when no constraint default is set.
			onConflict: plan.onConflict,
			mutationStatement
		};

		const result = await vtab.update!(args);

		if (isConstraintViolation(result)) {
			if (result.constraint === 'unique' && runtimeUpsertClauses && result.existingRow) {
				const matchingClause = matchUpsertClause(result.existingRow, newRow, runtimeUpsertClauses);
				if (matchingClause) {
					if (matchingClause.action === 'nothing') {
						return undefined;
					}
					const updateResult = await executeUpsertUpdate(
						ctx, vtab, matchingClause, result.existingRow, newRow, contextRow, upsertEvaluators,
					);
					if (!updateResult) return undefined;

					const existingKeyValues = pkColumnIndicesInSchema.map(idx => result.existingRow![idx]);
					ctx.db._recordUpdate(
						tableKey,
						result.existingRow!,
						updateResult.updatedRow,
						pkColumnIndicesInSchema,
					);
					await maintainRowTimeStructures(ctx, tableKey,
						{ op: 'update', oldRow: result.existingRow!, newRow: updateResult.updatedRow }, backingConnCache, deferredRebuilds);
					await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'update', result.existingRow!, updateResult.updatedRow, plan.lensRouted);

					if (needsAutoEvents) {
						const changedColumns: string[] = [];
						for (let i = 0; i < tableSchema.columns.length; i++) {
							if (!sqlValueIdentical(result.existingRow![i], updateResult.updatedRow[i])) {
								changedColumns.push(tableSchema.columns[i].name);
							}
						}
						emitAutoDataEvent(
							ctx, tableSchema, 'update',
							existingKeyValues,
							[...result.existingRow!], [...updateResult.updatedRow],
							changedColumns,
						);
					}
					return updateResult.flatRow;
				}
			}
			// No UPSERT clause matched — propagate; caller wraps for FAIL/ROLLBACK.
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not inserted (e.g., IGNORE mode at vtab level)
		if (!result.row) {
			return undefined;
		}

		// Internal REPLACE evictions (rows at OTHER PKs removed to resolve a non-PK
		// UNIQUE conflict) run the full delete pipeline here, before the new row's
		// own bookkeeping — evict-then-write, matching the substrate journal order.
		await processEvictions(ctx, needsAutoEvents, tableKey, result.evictedRows, backingConnCache, deferredRebuilds);

		const replacedRow = result.replacedRow;

		if (replacedRow) {
			const newKeyValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
			ctx.db._recordUpdate(tableKey, replacedRow, newRow, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'update', oldRow: replacedRow, newRow }, backingConnCache, deferredRebuilds);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', replacedRow, undefined, plan.lensRouted);

			if (needsAutoEvents) {
				const changedColumns: string[] = [];
				for (let i = 0; i < tableSchema.columns.length; i++) {
					if (!sqlValueIdentical(replacedRow[i], newRow[i])) {
						changedColumns.push(tableSchema.columns[i].name);
					}
				}
				emitAutoDataEvent(ctx, tableSchema, 'update', newKeyValues, [...replacedRow], [...newRow], changedColumns);
			}
		} else {
			const pkValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
			ctx.db._recordInsert(tableKey, newRow, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'insert', newRow }, backingConnCache, deferredRebuilds);

			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'insert', pkValues, undefined, [...newRow]);
			}
		}

		return flatRow;
	}

	/**
	 * Drive the full delete pipeline for every internal REPLACE eviction reported
	 * in `evictedRows` — rows at *other PKs* a substrate removed to resolve a non-PK
	 * UNIQUE conflict for this same `vtab.update()` call. The substrate deletes the
	 * row from its own storage but cannot run the cross-cutting post-write steps
	 * (change-tracking, row-time MV maintenance, FK cascade, auto-events) — those
	 * live solely here. So each evicted row is processed as a full DELETE, exactly
	 * like {@link processDeleteRow}'s own bookkeeping.
	 *
	 * Called *before* the writing row's own insert/update bookkeeping so the
	 * eviction's row-time maintenance and FK cascade land in the substrate's
	 * evict-then-write order (a later same-key backing write must not be undone by
	 * an earlier-PK eviction's delete).
	 */
	async function processEvictions(
		ctx: RuntimeContext,
		needsAutoEvents: boolean,
		tableKey: string,
		evictedRows: readonly Row[] | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
	): Promise<void> {
		if (!evictedRows || evictedRows.length === 0) return;
		for (const evicted of evictedRows) {
			// RESTRICT / NO ACTION enforcement for the eviction's would-be delete.
			// The substrate already physically removed the evicted row inside
			// vtab.update(), so there is no pre-mutation point. Run the transitive
			// RESTRICT scan post-eviction (the child rows it keys off remain) and,
			// on a violation, throw — runWithStatementSavepoints rolls back the
			// statement savepoint, unwinding both the eviction and the writing row.
			// Mirrors the pre-check processDeleteRow runs for a plain DELETE.
			//
			// lensRouted = false (the default) on both FK calls: an internal REPLACE
			// eviction is a physical basis effect (a row at another PK the substrate
			// removed to resolve a non-PK UNIQUE conflict), not a write through the
			// lens, so it bears only physical (basis-declared) FK semantics.
			await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', evicted);
			const evictedKeyValues = pkColumnIndicesInSchema.map(idx => evicted[idx]);
			ctx.db._recordDelete(tableKey, evicted, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'delete', oldRow: evicted }, backingConnCache, deferredRebuilds);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', evicted);
			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...evicted]);
			}
		}
	}

	// UPDATE ----------------------------------------------------
	async function* runUpdate(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache + deferred full-rebuild set (see runInsert).
		const backingConnCache: BackingConnectionCache = new Map();
		const deferredRebuilds = new Set<string>();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;
		// Physical Halloween avoidance: unless the target module guarantees per-scan
		// snapshot isolation, fully drain the source match set (closing the scan
		// cursor) BEFORE applying any write — otherwise the first UPDATE invalidates
		// the very cursor path the source scan is still walking.
		// NOTE: draining materializes the whole match set; a non-snapshot-isolated
		// `UPDATE big SET ... WHERE rare` matching millions buffers them all. That is
		// the accepted cost of correctness (such a module cannot safely stream-update
		// anyway); memory tables set scanSnapshotIsolation and keep streaming.
		const sourceRows = await resolveDmlSourceRows(ctx, vtab, tableSchema, rows);
		yield* runWithStatementSavepoints(
			ctx, vtab, sourceRows, isFailMode,
			(flatRow) => processUpdateRow(ctx, vtab, needsAutoEvents, flatRow, contextRow, backingConnCache, deferredRebuilds),
			deferredRebuilds, backingConnCache,
		);
	}

	/**
	 * Performs a single row's UPDATE side-effects (RESTRICT pre-check +
	 * vtab.update + REPLACE eviction + bookkeeping + FK actions + events).
	 * Returns the row to yield downstream, or undefined if the row was not
	 * updated (row not found). Throws ConstraintError on violations the executor
	 * cannot recover from; the caller (runWithStatementSavepoints) translates it
	 * for FAIL/ROLLBACK modes.
	 */
	async function processUpdateRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
	): Promise<Row | undefined> {
		const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		// Extract primary key values from the OLD row (these identify which row to update)
		const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
			if (pkColIdx >= oldRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			return oldRow[pkColIdx];
		});

		// Build mutation statement if logging is enabled
		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildUpdateStatement(tableSchema, newRow, keyValues, contextRow);
		}

		// Defense-in-depth RESTRICT enforcement: the plan-time `NOT EXISTS`
		// check is the primary path, but some vtab modules evaluate the
		// embedded subquery differently from a plain row scan. Pre-walk
		// the transitive cascade closure so RESTRICTs at any depth fire
		// BEFORE vtab.update — needed for rowid-mode backends (lamina)
		// where post-mutation OLD-value scans dereference through the
		// just-mutated parent and find zero rows.
		await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'update', oldRow, newRow, plan.lensRouted);

		const args: UpdateArgs = {
			operation: 'update',
			values: newRow,
			oldKeyValues: keyValues,
			// Pass undefined when there's no statement-level OR clause so the vtab
			// can fall back to per-constraint defaultConflict directives. The memory
			// module treats undefined as ABORT when no constraint default is set.
			onConflict: plan.onConflict,
			mutationStatement
		};

		const result = await vtab.update!(args);

		// Handle constraint violations — caller translates for FAIL/ROLLBACK.
		if (isConstraintViolation(result)) {
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not updated (row not found returns ok with no row)
		if (!result.row) {
			return undefined;
		}

		// If the UPDATE moved this row onto an occupied PK under REPLACE,
		// the vtab returns the displaced row. Surface its deletion BEFORE
		// the move bookkeeping so change tracking, FK cascade, and auto-events
		// see the same evict-then-move sequence the vtab journals (manager.ts
		// records delete(newPk, evicted) before the move). Running the
		// eviction's FK cascade first also avoids ON UPDATE CASCADE pulling
		// children onto PK_new and then having an unrelated ON DELETE CASCADE
		// for the evicted row wipe them out.
		if (result.replacedRow) {
			const evictedKeyValues = pkColumnIndicesInSchema.map(idx => result.replacedRow![idx]);
			ctx.db._recordDelete(
				tableKey,
				result.replacedRow,
				pkColumnIndicesInSchema,
			);
			await maintainRowTimeStructures(ctx, tableKey,
				{ op: 'delete', oldRow: result.replacedRow }, backingConnCache, deferredRebuilds);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', result.replacedRow, undefined, plan.lensRouted);
			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...result.replacedRow]);
			}
		}

		// Internal REPLACE evictions (rows at OTHER PKs removed to resolve a non-PK
		// UNIQUE conflict for this same update) run the full delete pipeline here,
		// after any same-PK replacedRow handling and before the moved row's own
		// bookkeeping — evict-then-write, matching the substrate journal order.
		await processEvictions(ctx, needsAutoEvents, tableKey, result.evictedRows, backingConnCache, deferredRebuilds);

		// Track change (UPDATE): pass full rows so the change capture can
		// project the columns any active subscription cares about.
		ctx.db._recordUpdate(
			tableKey,
			oldRow,
			newRow,
			pkColumnIndicesInSchema,
		);
		await maintainRowTimeStructures(ctx, tableKey,
			{ op: 'update', oldRow, newRow }, backingConnCache, deferredRebuilds);

		// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
		await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'update', oldRow, newRow, plan.lensRouted);

		// Emit auto event for modules without native event support
		if (needsAutoEvents) {
			// Compute changed columns
			const changedColumns: string[] = [];
			for (let i = 0; i < tableSchema.columns.length; i++) {
				const oldVal = oldRow[i];
				const newVal = newRow[i];
				if (!sqlValueIdentical(oldVal, newVal)) {
					changedColumns.push(tableSchema.columns[i].name);
				}
			}
			emitAutoDataEvent(ctx, tableSchema, 'update', keyValues, [...oldRow], [...newRow], changedColumns);
		}

		return flatRow;
	}

	// DELETE ----------------------------------------------------
	async function* runDelete(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache + deferred full-rebuild set (see runInsert).
		const backingConnCache: BackingConnectionCache = new Map();
		const deferredRebuilds = new Set<string>();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;
		// Physical Halloween avoidance — see the matching note in runUpdate. Unless
		// the target module guarantees per-scan snapshot isolation, drain the source
		// match set (closing the scan cursor) before applying any DELETE, so the
		// first delete cannot invalidate the cursor path the scan is still walking.
		const sourceRows = await resolveDmlSourceRows(ctx, vtab, tableSchema, rows);
		yield* runWithStatementSavepoints(
			ctx, vtab, sourceRows, isFailMode,
			(flatRow) => processDeleteRow(ctx, vtab, needsAutoEvents, flatRow, contextRow, backingConnCache, deferredRebuilds),
			deferredRebuilds, backingConnCache,
		);
	}

	/**
	 * Performs a single row's DELETE side-effects (RESTRICT pre-check +
	 * vtab.update + bookkeeping + FK actions + events). Returns the row to yield
	 * downstream, or undefined if the row was not deleted (row not found).
	 * Throws ConstraintError / RESTRICT errors; the caller
	 * (runWithStatementSavepoints) translates constraint violations for
	 * FAIL/ROLLBACK modes.
	 */
	async function processDeleteRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
	): Promise<Row | undefined> {
		const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
			if (pkColIdx >= oldRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			return oldRow[pkColIdx];
		});

		// Build mutation statement if logging is enabled
		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildDeleteStatement(tableSchema, keyValues, contextRow);
		}

		// Defense-in-depth RESTRICT enforcement — see comment on the UPDATE
		// path above.
		await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', oldRow, undefined, plan.lensRouted);

		const args: UpdateArgs = {
			operation: 'delete',
			values: undefined,
			oldKeyValues: keyValues,
			onConflict: plan.onConflict ?? ConflictResolution.ABORT,
			mutationStatement
		};

		const result = await vtab.update!(args);

		// Handle constraint violations (unlikely for DELETE, but be consistent).
		if (isConstraintViolation(result)) {
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not deleted (row not found returns ok with no row)
		if (!result.row) {
			return undefined;
		}

		// Track change (DELETE): record OLD row + PK indices so capture
		// can project the columns subscribers care about.
		ctx.db._recordDelete(
			tableKey,
			oldRow,
			pkColumnIndicesInSchema,
		);
		await maintainRowTimeStructures(ctx, tableKey,
			{ op: 'delete', oldRow }, backingConnCache, deferredRebuilds);

		// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
		await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', oldRow, undefined, plan.lensRouted);

		// Emit auto event for modules without native event support
		if (needsAutoEvents) {
			emitAutoDataEvent(ctx, tableSchema, 'delete', keyValues, [...oldRow]);
		}

		return flatRow;
	}

	// Select the correct generator based on operation
	let run: InstructionRun;
	switch (plan.operation) {
		case 'insert': run = asRun(runInsert); break;
		case 'update': run = asRun(runUpdate); break;
		case 'delete': run = asRun(runDelete); break;
		default:
			throw new QuereusError(`Unknown DML operation: ${plan.operation}`, StatusCode.INTERNAL);
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...upsertEvaluatorInstructions],
		run,
		note: `execute${plan.operation}(${plan.table.tableSchema.name})`
	};
}
