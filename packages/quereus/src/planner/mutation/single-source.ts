import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { sqlValuesEqual } from '../../util/comparison.js';
import { buildSelectStmt } from '../building/select.js';
import { classifyViewBody } from './propagate.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import { deriveViewColumns, type ViewColumn } from '../analysis/update-lineage.js';
import { readDefaultFor, type ReservedTagMap } from './mutation-tags.js';
import { parseExpressionString } from '../../parser/index.js';

/**
 * Single-source view-mediated DML rewriting (the single-source spine of the
 * view-mutation substrate).
 *
 * When an INSERT / UPDATE / DELETE targets a view whose body is a single-source
 * projection-and-filter, these helpers analyse the body and produce an
 * equivalent statement targeting the underlying base table. The base statement
 * is then planned by the ordinary base-table builder, so all constraint /
 * conflict / RETURNING / FK / mutation-context machinery is reused verbatim and
 * `getChangeScope()` / `Database.watch` see the base write with no extra wiring.
 *
 * These produce exactly one {@link import('./propagate.js').BaseOp} per call;
 * `propagate()` wraps the result and the builder (`building/view-mutation-builder.ts`)
 * re-plans it into a `ViewMutationNode`. Multi-source fan-out (more than one
 * base op) is the next phase.
 *
 * The same rewrite drives **materialized-view write-through**: every MV is
 * (post row-time consolidation) a single-source projection-and-filter — a strict
 * subset of the shape this classifier accepts — so DML targeting an MV name is
 * rewritten to its source `T` and re-planned identically; the existing row-time
 * maintenance hook then brings the backing into sync within the same statement
 * (reads-own-writes, rollback in lockstep). Hence the view parameter is the
 * minimal {@link MutableViewLike} structural shape both `ViewSchema` and
 * `MaterializedViewSchema` satisfy — the rewrite reads only `name` /
 * `schemaName` / `selectAst` / `columns`. See `docs/materialized-views.md`
 * § Write boundary and `docs/view-updateability.md`.
 *
 * RETURNING-through-views is a later phase — rejected here with a structured
 * diagnostic.
 */

/**
 * The minimal view-schema surface the rewrite reads — satisfied by both
 * `ViewSchema` and `MaterializedViewSchema`. Keeping the parameter structural
 * lets MV write-through reuse the plain-view rewrite verbatim, with no MV-shaped
 * special-casing in the three builders.
 */
export interface MutableViewLike {
	readonly name: string;
	readonly schemaName: string;
	readonly selectAst: AST.QueryExpr;
	readonly columns?: ReadonlyArray<string>;
	/** View-level metadata tags — the `view-ddl` site of the override surface. */
	readonly tags?: Readonly<Record<string, SqlValue>>;
}

/** A base column pinned to a constant by the view's selection predicate. */
interface FilterConstant {
	readonly baseColumnName: string;
	readonly valueExpr: AST.Expression;
	readonly value: SqlValue | undefined;
}

interface ViewAnalysis {
	readonly baseTable: TableSchema;
	readonly viewColumns: readonly ViewColumn[];
	/** The view body's WHERE predicate (in base-column terms), if any. */
	readonly filterPredicate?: AST.Expression;
	readonly filterConstants: readonly FilterConstant[];
	/** view-column-name (lowercase) → replacement expression in base terms. */
	readonly columnMap: ReadonlyMap<string, AST.Expression>;
}

function columnExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

function tableIdentifier(table: TableSchema): AST.IdentifierExpr {
	return { type: 'identifier', name: table.name, schema: table.schemaName };
}

/** Flatten a conjunction (`a AND b AND c`) into its conjuncts. */
function flattenAnd(expr: AST.Expression): AST.Expression[] {
	if (expr.type === 'binary' && expr.operator === 'AND') {
		return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
	}
	return [expr];
}

/** Conjoin two optional predicates with AND. */
export function combineAnd(a: AST.Expression | undefined, b: AST.Expression | undefined): AST.Expression | undefined {
	if (a && b) return { type: 'binary', operator: 'AND', left: a, right: b };
	return a ?? b;
}

/**
 * Structurally clone an expression, substituting column references via
 * `substitute`. A substituted replacement is cloned but NOT re-substituted
 * (the replacement is already in base terms). Subqueries are passed through
 * un-rewritten — a Phase-1 limitation noted in the docs.
 */
export function transformExpr(
	expr: AST.Expression,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
): AST.Expression {
	switch (expr.type) {
		case 'column': {
			const replacement = substitute(expr);
			if (replacement) return cloneExpr(replacement);
			return { ...expr };
		}
		case 'binary':
			return { ...expr, left: transformExpr(expr.left, substitute), right: transformExpr(expr.right, substitute) };
		case 'unary':
			return { ...expr, expr: transformExpr(expr.expr, substitute) };
		case 'function':
			return { ...expr, args: expr.args.map(a => transformExpr(a, substitute)) };
		case 'cast':
			return { ...expr, expr: transformExpr(expr.expr, substitute) };
		case 'collate':
			return { ...expr, expr: transformExpr(expr.expr, substitute) };
		case 'between':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute),
				lower: transformExpr(expr.lower, substitute),
				upper: transformExpr(expr.upper, substitute),
			};
		case 'case':
			return {
				...expr,
				baseExpr: expr.baseExpr ? transformExpr(expr.baseExpr, substitute) : undefined,
				whenThenClauses: expr.whenThenClauses.map(w => ({
					when: transformExpr(w.when, substitute),
					then: transformExpr(w.then, substitute),
				})),
				elseExpr: expr.elseExpr ? transformExpr(expr.elseExpr, substitute) : undefined,
			};
		case 'in':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute),
				values: expr.values ? expr.values.map(v => transformExpr(v, substitute)) : undefined,
			};
		default:
			// literal / identifier / parameter / subquery / exists / windowFunction /
			// functionSource — passed through structurally (subqueries un-rewritten).
			return { ...expr };
	}
}

/** Deep structural clone of an expression. */
export function cloneExpr(expr: AST.Expression): AST.Expression {
	return transformExpr(expr, () => undefined);
}

/**
 * Rewrite base-term column references so they resolve against the single base
 * table after the rewrite. The view body may qualify its base columns by the
 * source's alias or the base table name (`x.col` / `pa.col`); the rewritten
 * statement has exactly one source, so those qualifiers are dropped (an
 * unqualified reference resolves unambiguously). Subqueries are not descended
 * into — `transformExpr` passes them through structurally, preserving any inner
 * correlation (a Phase-1 limitation noted in the docs).
 */
function normalizeBaseRefs(expr: AST.Expression, aliases: ReadonlySet<string>): AST.Expression {
	return transformExpr(expr, (col) =>
		col.table && aliases.has(col.table.toLowerCase()) ? { type: 'column', name: col.name } : undefined,
	);
}

/**
 * Plan the view body, gate it for phase-1 mutability, and derive the
 * view→base column model. Throws a structured diagnostic on any unsupported
 * shape.
 */
function analyzeView(ctx: PlanningContext, view: MutableViewLike): ViewAnalysis {
	// Lens read-only gate: a logical table whose primary key is not reconstructible
	// at the lens boundary deploys read-only (the prover sets `LensSlot.readOnly`;
	// docs/lens.md § Coverage checklist). Reads still resolve through the registered
	// view; any mutation errors here with a precise diagnostic. The lookup only
	// matches a logical schema's lens slot — a plain view / MV (physical schema) has
	// none, so this never false-positives on ordinary view write-through.
	const lensSlot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	if (lensSlot?.readOnly) {
		raiseMutationDiagnostic({
			reason: 'lens-read-only',
			table: view.name,
			message: `cannot write through logical table '${view.schemaName}.${view.name}': its primary key is not reconstructible at the lens boundary, so it is read-only (deploy advisory lens.pk-not-reconstructible)`,
		});
	}

	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	// Build the body plan and gate it (joins / aggregates / set-ops / recursive
	// CTEs / VALUES bodies are rejected here).
	const bodyPlan = buildSelectStmt(ctx, sel);
	if (!isRelationalNode(bodyPlan)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' body did not produce a relation`,
		});
	}
	const classification = classifyViewBody(bodyPlan as RelationalPlanNode);
	if (classification.kind === 'rejected') {
		raiseMutationDiagnostic({
			reason: classification.reason,
			table: view.name,
			message: `cannot write through view '${view.name}': ${classification.detail}`,
		});
	}
	const baseTable = classification.baseTable.tableSchema;

	// Single-level base-table source only: a body that sources another view/CTE
	// inlines to one table ref but its inner filters/projections live in the
	// plan, not in this view's selectAst — driving the rewrite from selectAst
	// would silently drop them. Reject (the inline-and-propagate generality is
	// a later phase).
	if (!sel.from || sel.from.length !== 1 || sel.from[0].type !== 'table') {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through view '${view.name}': only a single base-table source is supported in phase 1`,
		});
	}
	const fromTable = sel.from[0];
	if (ctx.schemaManager.getView(fromTable.table.schema ?? null, fromTable.table.name)) {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through view '${view.name}': its body references another view; nested-view mutation is not yet supported`,
		});
	}
	// MV-over-MV (or a plain view over an MV): the body's single source is itself a
	// materialized view, so `buildSelectStmt` resolved it to that MV's *backing* table —
	// re-planning the rewrite against the backing name would hit a relation that is
	// read-only to user DML. Write-through one level down (route to the inner MV's own
	// write-through + the maintenance cascade) is deferred; reject cleanly. The
	// source→backing maintenance cascade is unaffected — that is the read/maintain
	// direction; this guards only the MV-name *write* direction.
	if (ctx.schemaManager.getMaterializedView(fromTable.table.schema ?? null, fromTable.table.name)) {
		raiseMutationDiagnostic({
			reason: 'nested-view',
			table: view.name,
			message: `cannot write through '${view.name}': its body reads a materialized view; `
				+ `write-through to a materialized-view-over-materialized-view is not yet supported — write the base source instead`,
		});
	}

	// LIMIT / OFFSET / DISTINCT are accepted by the plan-walk classifier as
	// pass-through operators (so it can still reach the base table), but the
	// predicate-conjoin rewrite cannot faithfully reproduce them: a row-count
	// window or duplicate-collapse is not capturable as a WHERE predicate, so a
	// mutation would affect base rows outside what the view exposes. Reject here
	// rather than silently widening the write. (Phase 2 substrate territory.)
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through view '${view.name}': a LIMIT/OFFSET body is not decomposable in phase 1 (a mutation would escape the limited window)`,
		});
	}
	if (sel.distinct) {
		raiseMutationDiagnostic({
			reason: 'unsupported-distinct',
			table: view.name,
			message: `cannot write through view '${view.name}': a DISTINCT body has no 1:1 base-row lineage and is not updateable in phase 1`,
		});
	}

	// Names that qualify the single base source inside the body — its alias (if
	// any) and the table name as written. References so qualified are normalized
	// to unqualified form when threaded into the rewritten single-source statement.
	const baseAliases = new Set<string>([fromTable.table.name.toLowerCase()]);
	if (fromTable.alias) baseAliases.add(fromTable.alias.toLowerCase());

	// Build the view-column lineage model from the projection list (shared with
	// the update-lineage analysis surface).
	const viewColumns = deriveViewColumns(sel, baseTable, view.columns);

	// Build the remap table: each view column → its base-term replacement
	// (computed expressions are normalized so any alias-qualified base column
	// resolves against the rewritten single-source statement).
	const columnMap = new Map<string, AST.Expression>();
	for (const vc of viewColumns) {
		columnMap.set(
			vc.name.toLowerCase(),
			vc.lineage.kind === 'base' ? columnExpr(vc.lineage.baseColumnName) : normalizeBaseRefs(vc.lineage.expr, baseAliases),
		);
	}

	const filterConstants = extractFilterConstants(sel.where, baseTable);
	const filterPredicate = sel.where ? normalizeBaseRefs(sel.where, baseAliases) : undefined;

	return { baseTable, viewColumns, filterPredicate, filterConstants, columnMap };
}

/** Extract `baseColumn = literal` bindings from the view's selection predicate. */
function extractFilterConstants(where: AST.Expression | undefined, baseTable: TableSchema): FilterConstant[] {
	const out: FilterConstant[] = [];
	if (!where) return out;
	for (const conj of flattenAnd(where)) {
		if (conj.type !== 'binary' || conj.operator !== '=') continue;
		const colSide = conj.left.type === 'column' ? conj.left : conj.right.type === 'column' ? conj.right : undefined;
		const litSide = conj.left.type === 'literal' ? conj.left : conj.right.type === 'literal' ? conj.right : undefined;
		if (!colSide || !litSide) continue;
		const baseCol = baseTable.columns.find(c => c.name.toLowerCase() === colSide.name.toLowerCase());
		if (!baseCol) continue;
		const value = litSide.value instanceof Promise ? undefined : litSide.value;
		out.push({ baseColumnName: baseCol.name, valueExpr: litSide, value });
	}
	return out;
}

function findViewColumn(analysis: ViewAnalysis, name: string, view: MutableViewLike): ViewColumn {
	const vc = analysis.viewColumns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!vc) {
		throw new QuereusError(`Column '${name}' not found in view '${view.name}'`, StatusCode.ERROR);
	}
	return vc;
}

/** Resolve a view column to a writable base column, rejecting computed columns. */
function requireBaseColumn(vc: ViewColumn): string {
	if (vc.lineage.kind === 'computed') {
		raiseMutationDiagnostic({
			reason: 'no-inverse',
			column: vc.name,
			message: `cannot write through view: column '${vc.name}' is a computed (non-invertible) expression and is read-only`,
		});
	}
	return vc.lineage.baseColumnName;
}

/**
 * Resolve a `default_for.<col>` column name to its base column. The name may be
 * a base column (the documented `default_for.created` case, where the column is
 * projected away by the view) or a view column with `base` lineage. An unknown
 * name is a structured `tag-target-not-found` — a typo must fail loudly, not
 * silently no-op.
 */
function resolveDefaultForColumn(analysis: ViewAnalysis, colName: string, view: MutableViewLike): string {
	const baseCol = analysis.baseTable.columns.find(c => c.name.toLowerCase() === colName);
	if (baseCol) return baseCol.name;
	const vc = analysis.viewColumns.find(c => c.name.toLowerCase() === colName);
	if (vc && vc.lineage.kind === 'base') return vc.lineage.baseColumnName;
	raiseMutationDiagnostic({
		reason: 'tag-target-not-found',
		column: colName,
		table: view.name,
		message: `cannot write through view '${view.name}': 'quereus.update.default_for.${colName}' names column '${colName}', which is not a column of the view or its base table '${analysis.baseTable.name}'`,
	});
}

/** Build a substitution fn that remaps view column references to base terms. */
function remapper(analysis: ViewAnalysis): (col: AST.ColumnExpr) => AST.Expression | undefined {
	return (col) => analysis.columnMap.get(col.name.toLowerCase());
}

// --- INSERT ---------------------------------------------------------------

export function rewriteViewInsert(ctx: PlanningContext, stmt: AST.InsertStmt, view: MutableViewLike, tags?: ReservedTagMap): AST.InsertStmt {
	rejectReturning(stmt.returning, view);
	const analysis = analyzeView(ctx, view);

	// Target view columns: explicit list, or all non-generated view columns.
	const targetNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: analysis.viewColumns.filter(vc => !vc.generated).map(vc => vc.name);

	const baseColumns = targetNames.map(name => requireBaseColumn(findViewColumn(analysis, name, view)));

	// Merge the view's constant-FD defaults: a base column pinned by the
	// selection predicate is supplied automatically when omitted, and a
	// user-supplied literal that contradicts the pin is rejected at plan time.
	const appendColumns: string[] = [];
	const appendExprs: AST.Expression[] = [];
	const isSupplied = (baseCol: string): boolean =>
		baseColumns.some(b => b.toLowerCase() === baseCol.toLowerCase())
		|| appendColumns.some(b => b.toLowerCase() === baseCol.toLowerCase());
	for (const fc of analysis.filterConstants) {
		const idx = baseColumns.findIndex(b => b.toLowerCase() === fc.baseColumnName.toLowerCase());
		if (idx >= 0) {
			checkContradiction(stmt.source, idx, fc, view);
		} else {
			appendColumns.push(fc.baseColumnName);
			appendExprs.push(fc.valueExpr);
		}
	}

	// `quereus.update.default_for.<col>` supplies an omitted-insert default ahead
	// of the base column's declared default (docs/view-updateability.md §Projection
	// step 5, § Tags). It fills only a column the insert and the constant-FD chain
	// left omitted — an explicit user value or a stronger predicate pin wins.
	for (const [colName, exprText] of readDefaultFor(tags)) {
		const baseCol = resolveDefaultForColumn(analysis, colName, view);
		if (isSupplied(baseCol)) continue;
		appendColumns.push(baseCol);
		appendExprs.push(parseExpressionString(exprText));
	}

	const finalColumns = [...baseColumns, ...appendColumns];

	let source: AST.QueryExpr = stmt.source;
	if (appendExprs.length > 0) {
		if (stmt.source.type !== 'values') {
			raiseMutationDiagnostic({
				reason: 'unsupported-source',
				table: view.name,
				message: `cannot write through view '${view.name}': supplying selection-predicate defaults requires a VALUES source in phase 1`,
			});
		}
		source = {
			type: 'values',
			values: stmt.source.values.map(row => [...row, ...appendExprs.map(cloneExpr)]),
		};
	}

	return {
		type: 'insert',
		table: tableIdentifier(analysis.baseTable),
		columns: finalColumns,
		source,
		onConflict: stmt.onConflict,
		upsertClauses: stmt.upsertClauses,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/** Reject an insert literal that contradicts a selection-predicate constant. */
function checkContradiction(source: AST.QueryExpr, columnIndex: number, fc: FilterConstant, view: MutableViewLike): void {
	if (source.type !== 'values' || fc.value === undefined) return;
	for (const row of source.values) {
		const cell = row[columnIndex];
		if (!cell || cell.type !== 'literal' || cell.value instanceof Promise) continue;
		if (!sqlValuesEqual(cell.value, fc.value)) {
			raiseMutationDiagnostic({
				reason: 'predicate-contradiction',
				column: fc.baseColumnName,
				table: view.name,
				message: `insert into view '${view.name}' contradicts its selection predicate on column '${fc.baseColumnName}'`,
			});
		}
	}
}

// --- UPDATE ---------------------------------------------------------------

export function rewriteViewUpdate(ctx: PlanningContext, stmt: AST.UpdateStmt, view: MutableViewLike): AST.UpdateStmt {
	rejectReturning(stmt.returning, view);
	const analysis = analyzeView(ctx, view);
	const substitute = remapper(analysis);

	const assignments = stmt.assignments.map(asg => ({
		column: requireBaseColumn(findViewColumn(analysis, asg.column, view)),
		value: transformExpr(asg.value, substitute),
	}));

	const userWhere = stmt.where ? transformExpr(stmt.where, substitute) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'update',
		table: tableIdentifier(analysis.baseTable),
		assignments,
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

// --- DELETE ---------------------------------------------------------------

export function rewriteViewDelete(ctx: PlanningContext, stmt: AST.DeleteStmt, view: MutableViewLike): AST.DeleteStmt {
	rejectReturning(stmt.returning, view);
	const analysis = analyzeView(ctx, view);
	const substitute = remapper(analysis);

	const userWhere = stmt.where ? transformExpr(stmt.where, substitute) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'delete',
		table: tableIdentifier(analysis.baseTable),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/** RETURNING through a view is a later phase — reject it explicitly for now. */
function rejectReturning(returning: AST.ResultColumn[] | undefined, view: MutableViewLike): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through view '${view.name}' is not yet supported (phase 6)`,
		});
	}
}
