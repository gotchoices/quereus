import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun, OutputValue } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError, ConstraintError, FailConflictError, RollbackConflictError } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue, isConstraintViolation } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../util/mutation-statement.js';
import type { UpdateArgs, VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import { hasNativeEventSupport } from '../../util/event-support.js';
import { sqlValuesEqual } from '../../util/comparison.js';
import { withAsyncRowContext } from '../context-helpers.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { executeForeignKeyActions, assertTransitiveRestrictsForParentMutation } from '../foreign-key-actions.js';

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

export function emitDmlExecutor(plan: DmlExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

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

			// Check if the conflict target columns match the PK columns
			// For now, we match if the conflict target is the PK or a subset
			// A more complete implementation would track which specific constraint was violated
			const isPkMatch = clause.conflictTargetIndices.length === pkColumnIndicesInSchema.length &&
				clause.conflictTargetIndices.every((idx, i) => idx === pkColumnIndicesInSchema[i]);

			if (isPkMatch) {
				return clause;
			}

			// Check if proposed values at conflict target indices match existing row
			// (this handles the case where the conflict is on those specific columns)
			const conflictMatch = clause.conflictTargetIndices.every(idx =>
				sqlValuesEqual(existingRow[idx], proposedRow[idx])
			);

			if (conflictMatch) {
				return clause;
			}
		}
		return undefined;
	}

	// Type for UPSERT evaluator callback (resolved by scheduler)
	type UpsertEvaluator = (ctx: RuntimeContext) => OutputValue;

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
		upsertEvaluators: UpsertEvaluator[]
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
		const upsertEvaluators = allEvaluators.slice(numContextEvaluators) as UpsertEvaluator[];

		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		// OR FAIL needs per-row rollback so a later row's failure doesn't undo prior rows.
		// We open a savepoint, do the row's work, release on success, rollback on error.
		const isFailMode = plan.onConflict === ConflictResolution.FAIL;
		let failSavepointCounter = 0;

		// For non-FAIL modes (ABORT default / IGNORE / REPLACE / ROLLBACK) we wrap
		// the whole statement in a savepoint so a mid-statement constraint failure
		// unwinds partial writes from earlier rows. Use the broadcast helper so
		// per-connection savepoint stacks stay in lockstep with the
		// TransactionManager's stack (otherwise an outer user-level SAVEPOINT
		// could index into a stale placeholder).
		const wrapStatementSavepoint = !isFailMode;
		const stmtSavepointName = wrapStatementSavepoint
			? `__or_abort_${stmtSavepointCounter++}`
			: undefined;
		if (stmtSavepointName) {
			await ctx.db._createSavepointBroadcast(stmtSavepointName);
		}

		try {
			try {
				for await (const flatRow of rows) {
					// OR FAIL per-row savepoint. Like the statement-scope wrap above,
					// we use the broadcast helper so per-connection savepoint stacks
					// stay in lockstep with TransactionManager's. If a new connection
					// registers mid-row (e.g. via CTE materialization that
					// instantiates a new memory-backed table), Database.registerConnection
					// replays the active depth onto it — without broadcasting our
					// create here, that replay would offset its stack by one and a
					// subsequent user-level ROLLBACK TO would restore the wrong layer.
					let savepointName: string | undefined;
					if (isFailMode) {
						savepointName = `__or_fail_${failSavepointCounter++}`;
						await ctx.db._createSavepointBroadcast(savepointName);
					}

					let rowToYield: Row | undefined;
					let succeeded = false;
					try {
						rowToYield = await processInsertRow(
							ctx,
							vtab,
							needsAutoEvents,
							flatRow,
							contextRow,
							runtimeUpsertClauses,
							upsertEvaluators,
						);
						succeeded = true;
					} catch (e) {
						if (savepointName) {
							await ctx.db._rollbackAndReleaseSavepointBroadcast(savepointName);
							savepointName = undefined;
						}
						// Translate plain constraint violations to FAIL/ROLLBACK error subclasses
						// so the iterator-level cleanup picks the right finalization branch.
						throw translateConflictError(e, plan.onConflict);
					}

					if (succeeded && savepointName) {
						await ctx.db._releaseSavepointBroadcast(savepointName);
					}

					if (rowToYield !== undefined) {
						yield rowToYield;
					}
				}
				if (stmtSavepointName) {
					await ctx.db._releaseSavepointBroadcast(stmtSavepointName);
				}
			} catch (e) {
				if (stmtSavepointName) {
					await ctx.db._rollbackAndReleaseSavepointBroadcast(stmtSavepointName);
				}
				throw e;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
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
		upsertEvaluators: UpsertEvaluator[],
	): Promise<Row | undefined> {
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

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
						`${tableSchema.schemaName}.${tableSchema.name}`,
						result.existingRow!,
						updateResult.updatedRow,
						pkColumnIndicesInSchema,
					);
					await executeForeignKeyActions(ctx.db, tableSchema, 'update', result.existingRow!, updateResult.updatedRow);

					if (needsAutoEvents) {
						const changedColumns: string[] = [];
						for (let i = 0; i < tableSchema.columns.length; i++) {
							if (!sqlValuesEqual(result.existingRow![i], updateResult.updatedRow[i])) {
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

		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;
		const replacedRow = result.replacedRow;

		if (replacedRow) {
			const newKeyValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
			ctx.db._recordUpdate(tableKey, replacedRow, newRow, pkColumnIndicesInSchema);
			await executeForeignKeyActions(ctx.db, tableSchema, 'delete', replacedRow);

			if (needsAutoEvents) {
				const changedColumns: string[] = [];
				for (let i = 0; i < tableSchema.columns.length; i++) {
					if (!sqlValuesEqual(replacedRow[i], newRow[i])) {
						changedColumns.push(tableSchema.columns[i].name);
					}
				}
				emitAutoDataEvent(ctx, tableSchema, 'update', newKeyValues, [...replacedRow], [...newRow], changedColumns);
			}
		} else {
			const pkValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
			ctx.db._recordInsert(tableKey, newRow, pkColumnIndicesInSchema);

			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'insert', pkValues, undefined, [...newRow]);
			}
		}

		return flatRow;
	}

	// UPDATE ----------------------------------------------------
	async function* runUpdate(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
				const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);

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
				await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'update', oldRow, newRow);

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

				// Handle constraint violations
				if (isConstraintViolation(result)) {
					const baseErr = new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
					throw translateConflictError(baseErr, plan.onConflict);
				}

				// Skip if row was not updated (row not found returns ok with no row)
				if (!result.row) {
					continue;
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
						`${tableSchema.schemaName}.${tableSchema.name}`,
						result.replacedRow,
						pkColumnIndicesInSchema,
					);
					await executeForeignKeyActions(ctx.db, tableSchema, 'delete', result.replacedRow);
					if (needsAutoEvents) {
						emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...result.replacedRow]);
					}
				}

				// Track change (UPDATE): pass full rows so the change capture can
				// project the columns any active subscription cares about.
				ctx.db._recordUpdate(
					`${tableSchema.schemaName}.${tableSchema.name}`,
					oldRow,
					newRow,
					pkColumnIndicesInSchema,
				);

				// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
				await executeForeignKeyActions(ctx.db, tableSchema, 'update', oldRow, newRow);

				// Emit auto event for modules without native event support
				if (needsAutoEvents) {
					// Compute changed columns
					const changedColumns: string[] = [];
					for (let i = 0; i < tableSchema.columns.length; i++) {
						const oldVal = oldRow[i];
						const newVal = newRow[i];
						if (!sqlValuesEqual(oldVal, newVal)) {
							changedColumns.push(tableSchema.columns[i].name);
						}
					}
					emitAutoDataEvent(ctx, tableSchema, 'update', keyValues, [...oldRow], [...newRow], changedColumns);
				}

				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// DELETE ----------------------------------------------------
	async function* runDelete(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab);

		// Evaluate mutation context once per statement
		let contextRow: Row | undefined;
		if (contextEvaluators.length > 0) {
			contextRow = [];
			for (const evaluator of contextEvaluators) {
				const value = await evaluator(ctx) as SqlValue;
				contextRow.push(value);
			}
		}

		try {
			for await (const flatRow of rows) {
				const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);

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
				await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', oldRow);

				const args: UpdateArgs = {
					operation: 'delete',
					values: undefined,
					oldKeyValues: keyValues,
					onConflict: plan.onConflict ?? ConflictResolution.ABORT,
					mutationStatement
				};

				const result = await vtab.update!(args);

				// Handle constraint violations (unlikely for DELETE, but be consistent)
				if (isConstraintViolation(result)) {
					const baseErr = new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
					throw translateConflictError(baseErr, plan.onConflict);
				}

				// Skip if row was not deleted (row not found returns ok with no row)
				if (!result.row) {
					continue;
				}

				// Track change (DELETE): record OLD row + PK indices so capture
				// can project the columns subscribers care about.
				ctx.db._recordDelete(
					`${tableSchema.schemaName}.${tableSchema.name}`,
					oldRow,
					pkColumnIndicesInSchema,
				);

				// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
				await executeForeignKeyActions(ctx.db, tableSchema, 'delete', oldRow);

				// Emit auto event for modules without native event support
				if (needsAutoEvents) {
					emitAutoDataEvent(ctx, tableSchema, 'delete', keyValues, [...oldRow]);
				}

				yield flatRow;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// Select the correct generator based on operation
	let run: InstructionRun;
	switch (plan.operation) {
		case 'insert': run = runInsert as InstructionRun; break;
		case 'update': run = runUpdate as InstructionRun; break;
		case 'delete': run = runDelete as InstructionRun; break;
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
