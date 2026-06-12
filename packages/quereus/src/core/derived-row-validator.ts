/**
 * Per-row declared-constraint validation for rows a maintained-table derivation
 * writes — the steady-state half of the derived-row constraint contract (the
 * bulk half is the SQL-scan validation the attach core runs, see
 * `runtime/emit/materialized-view-helpers.ts` `validateDeclaredConstraintsOverContents`).
 *
 * A `create table … maintained as` table carries its declared CHECK / FK
 * constraints on the backing `TableSchema`, but every maintenance write lands
 * through the privileged backing surface, which the DML constraint pipeline
 * never sees. The validator built here closes that gap for the bounded-delta
 * and full-rebuild maintenance arms: it compiles the declared constraints ONCE
 * per registered maintained table — through the SAME builders the DML pipeline
 * uses (`buildConstraintChecks` / `buildChildSideFKChecks`) — and the
 * maintenance manager evaluates each insert/update {@link BackingRowChange}'s
 * new row image against them before cascading.
 *
 * Semantics (documented in `docs/materialized-views.md` § Derived-row
 * constraint validation):
 *  - **op-mask collapse** — a derived row image is neither a user INSERT nor
 *    UPDATE (which op maintenance realizes is an artifact of backing-key
 *    movement), so every written image is validated against every CHECK whose
 *    `operations` mask intersects INSERT | UPDATE, evaluated INSERT-shaped
 *    (OLD section all-NULL — an `old.<col>` reference evaluates NULL and the
 *    CHECK passes by the NULL-pass rule). A `delete` writes no image and is
 *    not CHECK-validated.
 *  - **FK pragma gate at evaluation time** — child-side FK existence is
 *    compiled unconditionally but evaluated only while
 *    `pragma foreign_keys` is on, re-read per validated row (the pragma can
 *    flip between create and a later source write). MATCH SIMPLE is inherited
 *    from the FK builder's null-guard chain.
 *  - **deferral parity** — a subquery-bearing CHECK (and every child-side FK,
 *    which is inherently EXISTS-shaped) routes to the deferred-constraint
 *    queue and validates at commit against final state, exactly as on an
 *    ordinary table; non-subquery CHECKs evaluate inline and abort the writing
 *    statement immediately. Deferred entries carry the maintained-table
 *    attribution through a wrapped evaluator (the queue's generic message
 *    never fires).
 *  - **always a hard abort** — derivation writes carry no user OR clause, so a
 *    violation is never masked by IGNORE/REPLACE (matching the DML rule that
 *    REPLACE never masks CHECK/FK).
 *
 * Zero-overhead gate: {@link buildDerivedRowValidator} returns `undefined`
 * when the table declares no applicable CHECK and no FK — every MV-sugar
 * backing (`buildBackingTableSchema` hard-codes empty constraints) and every
 * constraint-less maintained table builds and runs nothing.
 */

import type { Database } from './database.js';
import { type TableSchema, type RowConstraintSchema, RowOpFlag, type RowOpMask } from '../schema/table.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import { maintainedTableCheckViolationError, maintainedTableFkViolationError } from '../schema/constraint-builder.js';
import { buildConstraintChecks } from '../planner/building/constraint-builder.js';
import { buildChildSideFKChecks } from '../planner/building/foreign-key-builder.js';
import type { ConstraintCheck } from '../planner/nodes/constraint-check-node.js';
import { PlanNode, type RowDescriptor, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { GlobalScope } from '../planner/scopes/global.js';
import { ParameterScope } from '../planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../planner/planning-context.js';
import { columnSchemaToScalarType } from '../planner/type-utils.js';
import { buildOldNewRowDescriptors } from '../util/row-descriptor.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import { createRowSlot } from '../runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import type { RuntimeContext } from '../runtime/types.js';
import type { Row, SqlValue } from '../common/types.js';
import type { QuereusError } from '../common/errors.js';
import { expressionToString } from '../emit/ast-stringify.js';

/** One compiled declared constraint over a single derived row image. */
interface CompiledDerivedRowCheck {
	readonly kind: 'check' | 'fk-child';
	/** Attributed name (declared, or the `_check_<i>` / `_fk_<table>` defaults the DML pipeline uses). */
	readonly constraintName: string;
	/** Auto-defer flag from the DML builders: subquery-bearing CHECK / every child-side FK. */
	readonly needsDeferred: boolean;
	/** Evaluates the check against the current row context and THROWS the attributed
	 *  CONSTRAINT error on `false`/`0` (NULL passes); returns the raw value otherwise,
	 *  so it slots directly into the deferred queue's evaluator seat. */
	readonly evaluator: (rctx: RuntimeContext) => Promise<SqlValue>;
}

/**
 * Compiled per-maintained-table derived-row constraint validator. Built once at
 * maintenance registration ({@link Database.registerMaterializedView} →
 * `MaterializedViewManager`), carried on the maintenance plan, and applied to
 * each insert/update backing change by {@link validateDerivedRowImage}.
 */
export interface DerivedRowConstraintValidator {
	readonly schemaName: string;
	readonly tableName: string;
	readonly numColumns: number;
	/** Flat OLD/NEW descriptor the compiled expressions resolve against
	 *  (OLD = indices `0..n-1`, NEW = `n..2n-1`). */
	readonly flatRowDescriptor: RowDescriptor;
	readonly checks: ReadonlyArray<CompiledDerivedRowCheck>;
}

/** Fresh single-purpose planning context for compiling constraint expressions
 *  outside a statement build (the `explain.ts` standalone-context shape). */
function freshPlanningContext(db: Database): PlanningContext {
	return {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: new ParameterScope(new GlobalScope(db.schemaManager)),
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		outputScopes: new Map(),
	};
}

/**
 * Optimize + emit one built constraint expression and wrap it in the
 * throw-on-violation evaluator. Optimization runs the full pass stack so a
 * subquery-bearing expression's relational subtree becomes physical (the DML
 * pipeline gets this for free by optimizing the whole statement plan); a plain
 * scalar passes through unchanged. The wrapper throws the table-attributed
 * error itself so the SAME evaluator serves the inline path and the deferred
 * queue (whose generic `CHECK constraint failed` message must never surface
 * for a derived row).
 */
function compileDerivedRowCheck(
	db: Database,
	plan: ConstraintCheck,
	kind: 'check' | 'fk-child',
	constraintName: string,
	violation: () => QuereusError,
): CompiledDerivedRowCheck {
	const optimized = db.optimizer.optimize(plan.expression, db) as ScalarPlanNode;
	const scheduler = new Scheduler(emitPlanNode(optimized, new EmissionContext(db)));
	const evaluator = async (rctx: RuntimeContext): Promise<SqlValue> => {
		const value = await scheduler.run(rctx) as SqlValue;
		// The constraint-check truthy/NULL-pass rule: fail only on false / 0.
		if (value === false || value === 0) throw violation();
		return value;
	};
	return { kind, constraintName, needsDeferred: plan.needsDeferred, evaluator };
}

/**
 * Build the derived-row constraint validator for a maintained table, or
 * `undefined` when it declares nothing applicable (the zero-overhead gate).
 * Compiles through the DML pipeline's own builders over an INSERT-shaped
 * OLD/NEW attribute pair, so expression semantics (collations, scope
 * resolution, the auto-defer heuristic, determinism gating —
 * `pragma nondeterministic_schema` included) cannot drift from user DML.
 */
export function buildDerivedRowValidator(db: Database, mv: MaintainedTableSchema): DerivedRowConstraintValidator | undefined {
	// Op-mask collapse: any CHECK touching INSERT or UPDATE applies to a derived
	// row image; a delete-only CHECK never fires (a delete writes no image).
	const declaredChecks: Array<{ constraint: RowConstraintSchema; origIndex: number }> = [];
	mv.checkConstraints.forEach((constraint, origIndex) => {
		if ((constraint.operations & (RowOpFlag.INSERT | RowOpFlag.UPDATE)) !== 0) {
			declaredChecks.push({ constraint, origIndex });
		}
	});
	const fks = mv.foreignKeys ?? [];
	if (declaredChecks.length === 0 && fks.length === 0) return undefined;

	const ctx = freshPlanningContext(db);
	const oldAttributes = mv.columns.map(col => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		// OLD values are always NULL for the INSERT-shaped derived row image.
		type: columnSchemaToScalarType(col, { nullable: true }),
		sourceRelation: `OLD.${mv.name}`,
	}));
	const newAttributes = mv.columns.map(col => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: columnSchemaToScalarType(col),
		sourceRelation: `NEW.${mv.name}`,
	}));
	const { flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

	const checks: CompiledDerivedRowCheck[] = [];

	if (declaredChecks.length > 0) {
		// Widen each applicable mask to INSERT so the single INSERT-shaped build
		// admits `check on update (…)` constraints too (the collapse above).
		const collapsed = declaredChecks.map(d => ({
			...d.constraint,
			operations: (RowOpFlag.INSERT | RowOpFlag.UPDATE) as RowOpMask,
		}));
		const buildSchema: TableSchema = { ...mv, checkConstraints: Object.freeze(collapsed) };
		const plans = buildConstraintChecks(ctx, buildSchema, RowOpFlag.INSERT, oldAttributes, newAttributes, flatRowDescriptor);
		plans.forEach((plan, i) => {
			const { constraint, origIndex } = declaredChecks[i];
			const constraintName = constraint.name ?? `_check_${origIndex}`;
			const exprHint = expressionToString(constraint.expr);
			checks.push(compileDerivedRowCheck(db, plan, 'check', constraintName,
				() => maintainedTableCheckViolationError(mv.schemaName, mv.name, constraintName, exprHint)));
		});
	}

	// Build each FK through a single-FK schema view so the compiled check pairs
	// with its declaring FK (the builder may skip a malformed FK, which would
	// desynchronize a whole-array build).
	for (const fk of fks) {
		const single: TableSchema = { ...mv, foreignKeys: Object.freeze([fk]) };
		const plans = buildChildSideFKChecks(ctx, single, RowOpFlag.INSERT, oldAttributes, newAttributes);
		for (const plan of plans) {
			const constraintName = fk.name ?? `_fk_${mv.name}`;
			checks.push(compileDerivedRowCheck(db, plan, 'fk-child', constraintName,
				() => maintainedTableFkViolationError(mv.schemaName, mv.name, constraintName,
					fk.referencedSchema ?? mv.schemaName, fk.referencedTable)));
		}
	}

	if (checks.length === 0) return undefined;
	return {
		schemaName: mv.schemaName,
		tableName: mv.name,
		numColumns: mv.columns.length,
		flatRowDescriptor,
		checks,
	};
}

/**
 * Validate one derived row image (an insert/update {@link BackingRowChange}'s
 * `newRow`) against the table's compiled validator. Inline checks throw the
 * attributed CONSTRAINT error immediately (aborting the writing statement);
 * auto-deferred checks queue to the deferred-constraint queue and validate at
 * commit. `connectionId` pins the queued entries to the backing connection the
 * maintenance write used, mirroring the DML pipeline's active-connection capture.
 */
export async function validateDerivedRowImage(
	db: Database,
	validator: DerivedRowConstraintValidator,
	newRow: Row,
	connectionId?: string,
): Promise<void> {
	const fkEnabled = db.options.getBooleanOption('foreign_keys');
	// Flat OLD/NEW row, INSERT-shaped: OLD section all-NULL, NEW section the image.
	const flatRow = [...new Array<SqlValue>(validator.numColumns).fill(null), ...newRow] as Row;

	let rctx: RuntimeContext | undefined;
	let slot: ReturnType<typeof createRowSlot> | undefined;
	try {
		for (const check of validator.checks) {
			// The FK pragma gate, re-read at evaluation time — never cached at registration.
			if (check.kind === 'fk-child' && !fkEnabled) continue;

			if (check.needsDeferred) {
				db._queueDeferredConstraintRow(
					`${validator.schemaName}.${validator.tableName}`,
					check.constraintName,
					flatRow,
					validator.flatRowDescriptor,
					check.evaluator,
					connectionId,
				);
				continue;
			}

			if (!rctx) {
				rctx = {
					db,
					stmt: undefined,
					params: {},
					context: createStrictRowContextMap(),
					tableContexts: wrapTableContextsStrict(new Map()),
					enableMetrics: false,
				};
				slot = createRowSlot(rctx, validator.flatRowDescriptor);
				slot.set(flatRow);
			}
			await check.evaluator(rctx); // throws the attributed error on violation
		}
	} finally {
		slot?.close();
	}
}
