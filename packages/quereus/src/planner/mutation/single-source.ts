import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { type SqlValue } from '../../common/types.js';
import { sqlValuesEqual } from '../../util/comparison.js';
import { buildSelectStmt } from '../building/select.js';
import { classifyViewBody } from './propagate.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import { deriveViewColumns, resolveBaseSite, type ViewColumn } from '../analysis/update-lineage.js';
import { readDefaultFor, type ReservedTagMap } from './mutation-tags.js';
import { parseExpressionString } from '../../parser/index.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { transformExpr, cloneExpr, transformScopedExpr, transformScopedQuery, type ScopeContext } from './scope-transform.js';

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
 * RETURNING-through-views is supported: {@link rewriteViewReturning} rewrites the
 * clause into base terms and attaches it to the rewritten base statement, so the
 * base op's own RETURNING machinery yields the view-projected post-mutation rows
 * (insert/update against NEW, delete against OLD; computed view columns
 * re-evaluated against the post-mutation base values).
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

/**
 * Reserved, collision-proof correlation name synthesised onto the lowered
 * single-source UPDATE/DELETE target. The `__` internal-name convention (same family
 * as `__vmupd_keys` / `__shared_key`) guarantees it cannot collide with any
 * user-introduced FROM source, so a substituted subquery-descent base term qualified
 * with it (`__vm_self.col`) always binds the outer target row — even when the user
 * subquery FROM names the view's own base table. Lowered-target nesting cannot occur
 * (view-over-view / MV-over-MV / view-over-MV are all rejected by `analyzeView`, and a
 * user subquery is a plain SELECT that never re-lowers), so a single module-level
 * constant suffices: two `__vm_self`-aliased targets can never be in scope at once.
 */
const SELF_ALIAS = '__vm_self';

/** A base column pinned to a constant by the view's selection predicate. */
interface FilterConstant {
	readonly baseColumnName: string;
	readonly valueExpr: AST.Expression;
	readonly value: SqlValue | undefined;
}

/**
 * A view column whose lineage is a non-identity invertible transform of a single
 * base column (the `inverse` profile — e.g. `b + 1 as bp`). On the UPDATE write
 * path the assigned value is routed to {@link baseColumn} after being run through
 * {@link inverse} (`bp = 9` ⇒ `b = 9 - 1`), mirroring the multi-source spine
 * (`multi-source.ts` `decomposeUpdate`). An identity / rename column carries no
 * entry here (it routes through the ordinary `base` lineage via `columnMap` /
 * `requireBaseColumn`); an `opaque` (non-invertible) column carries none either, so
 * a write to it still raises `no-inverse`. INSERT is unaffected — `viewColumns`
 * keeps an inverse column `computed`, so it stays non-insertable (parity with
 * multi-source, whose envelope has no inverse hook).
 */
interface InverseSite {
	readonly baseColumn: string;
	readonly inverse: (written: AST.Expression) => AST.Expression;
	/** Domain restriction the profile carries (none shipped today — see analyzeView note). */
	readonly domain?: AST.Expression;
}

interface ViewAnalysis {
	readonly baseTable: TableSchema;
	readonly viewColumns: readonly ViewColumn[];
	/** The view body's WHERE predicate (in base-column terms), if any. */
	readonly filterPredicate?: AST.Expression;
	readonly filterConstants: readonly FilterConstant[];
	/** view-column-name (lowercase) → replacement expression in base terms. */
	readonly columnMap: ReadonlyMap<string, AST.Expression>;
	/** view-column-name (lowercase) → inverse-profile write site (UPDATE path only). */
	readonly inverseSites: ReadonlyMap<string, InverseSite>;
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
 * Rewrite base-term column references so they resolve against the single base
 * table after the rewrite. The view body may qualify its base columns by the
 * source's alias or the base table name (`x.col` / `pa.col`); the rewritten
 * statement has exactly one source, so those qualifiers are dropped (an
 * unqualified reference resolves unambiguously). This normalizes the **view
 * body's own** projection / WHERE terms (already in base terms); it does not
 * descend into subqueries, which is correct here — the body's own subqueries are
 * conjoined / projected verbatim, not re-bound against view columns. The
 * **user** predicate / assigned-value descent (where a nested reference can name
 * a *view* column) is handled separately by {@link makeViewColumnDescend}.
 */
function normalizeBaseRefs(expr: AST.Expression, aliases: ReadonlySet<string>): AST.Expression {
	return transformExpr(expr, (col) =>
		col.table && aliases.has(col.table.toLowerCase()) ? { type: 'column', name: col.name } : undefined,
	);
}

/**
 * Build the closure that correlation-qualifies a substituted base *term* emitted
 * INSIDE a subquery operand of a single-source rewrite. An unqualified base term
 * there would re-bind to a same-named source the subquery's own FROM introduces
 * (innermost SQL scoping) instead of correlating to the outer UPDATE/DELETE target
 * row. Qualifying it with `qualifierName` makes it correlate to the outer row
 * regardless of what the subquery FROM defines. For UPDATE/DELETE the caller passes
 * the lowered target's synthesised collision-proof alias ({@link SELF_ALIAS}), so the
 * qualified term binds the outer row even when the subquery FROM names the view's own
 * base table; INSERT (and the multi-source spine) leaves it at the base table name
 * (no target-row scan to collide with). Default is the bare base table name.
 *
 * The qualification is **scope-aware and DEEP** (it rides the shared
 * {@link transformScopedExpr} descent over {@link makeBaseQualifyScope}): it
 * qualifies a base-table column at the replacement's top level, and descends into a
 * nested scalar subquery WITHIN the replacement (a computed lineage term such as
 * `(select x from oth where fk = id)`), qualifying only the lineage's own
 * correlation refs — a base column not shadowed by the lineage subquery's own FROM
 * — and leaving the lineage's genuinely-local columns alone. The multi-source
 * spine passes no qualifier (its terms are already alias-qualified — `p.label`).
 *
 * Returns a fresh tree (does not mutate the shared `columnMap` entry).
 */
function makeBaseQualifier(
	ctx: PlanningContext,
	baseTable: TableSchema,
	qualifierName: string = baseTable.name,
): (repl: AST.Expression) => AST.Expression {
	const scope = makeBaseQualifyScope(baseTable, qualifierName);
	return (repl) => transformScopedExpr(ctx, scope, repl);
}

/**
 * The {@link ScopeContext} for the base-term correlation-qualifier — the
 * scope-aware DEEP qualify of a substituted base term. Its substitution qualifies
 * an unqualified BASE-table column that is not shadowed with `qualifierName` — the
 * lowered statement's correlation name (the synthesised {@link SELF_ALIAS} for
 * UPDATE/DELETE, the bare base table name for INSERT / multi-source). An
 * already-qualified ref, a non-base name (a lineage-local column such as the `x` /
 * `fk` a nested subquery's own FROM introduces), or a shadowed name is left untouched.
 * Restricting to base columns changes nothing for a `normalizeBaseRefs`-normalized
 * lineage (whose top-level refs are all base columns) and is the principled gate: only
 * the view's own base-term lineage is correlation-qualified, never a column a nested
 * source owns.
 *
 * An unresolvable scope (`select *` / TVF / CTE) is **rejected** rather than
 * tainted-and-deferred: shadowing cannot be proven, so the term could over- or
 * under-qualify into a silent wrong write (`unresolvableScope: 'reject'`).
 */
function makeBaseQualifyScope(baseTable: TableSchema, qualifierName: string = baseTable.name): ScopeContext {
	const qualifier = qualifierName;
	const baseCols = new Set(baseTable.columns.map(c => c.name.toLowerCase()));
	return {
		makeSubstitute: (shadowed) => (col) => {
			if (col.table) return undefined;
			const name = col.name.toLowerCase();
			if (shadowed.has(name) || !baseCols.has(name)) return undefined;
			return { ...col, table: qualifier };
		},
		unresolvableScope: 'reject',
		rejectUnresolvableScope: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			message: `cannot write through view: a computed column's lineage contains a correlated subquery whose source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source), so its correlation cannot be proven; restructure the view body`,
		}),
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			message: `cannot correlation-qualify a view lineage term: a data-modifying subquery (INSERT/UPDATE/DELETE) within it cannot be analysed`,
		}),
	};
}

// --- view-column descent into subquery operands ---------------------------
//
// `transformExpr` rewrites a view-column reference at the top level of a user
// predicate / assigned value. A reference nested inside a `subquery` / `exists` /
// `in`-subquery operand resolves in the *lowered* base statement's scope, where
// it can silently re-bind to a same-named base column instead of the view
// column's true lineage. The descent below (the shared scope-transform over
// {@link makeViewScope}) rewrites such a nested reference to its base term — but
// scope-aware, so it neither mis-binds a reference a subquery-local source
// introduces (`in (select note from src)` where `src.note` exists) nor touches a
// base-alias-qualified reference. A reference it cannot prove correlated (an
// unresolvable subquery source) is rejected loudly rather than mis-bound silently.
// See `docs/view-updateability.md` § Selection.

/**
 * The {@link ScopeContext} for the view-column → base-term descent. A reference is
 * rewritten to its base-term lineage only when it is genuinely correlated to the
 * outer view row:
 *
 * - **qualified by the view name** → an unambiguous view-output reference;
 *   substitute (when the name is a known view column).
 * - **unqualified**, a known view column, and NOT shadowed by a source local to
 *   this (or an enclosing) subquery scope → correlated to the outer view row;
 *   substitute.
 * - **qualified by any other (base-alias) name**, or a name some local source
 *   introduces → left untouched.
 *
 * In a **tainted** scope (one whose local column names could not be resolved
 * statically) an unqualified view-column-named reference cannot be proven
 * correlated, so it is rejected with `unsupported-subquery-correlation` rather than
 * silently mis-bound — hence `unresolvableScope: 'taint'` (the substitution decides
 * per-reference once tainted, instead of rejecting the whole scope up front).
 *
 * When a replacement is emitted inside a subquery operand, `baseQualify`
 * correlation-qualifies its base terms (scope-aware and deep — see
 * {@link makeBaseQualifier}) so they bind to the outer (UPDATE/DELETE target) row
 * rather than re-binding to a same-named local source. The single-source rewriters
 * pass it; the multi-source spine passes `undefined` (its base terms are already
 * alias-qualified — `p.label`). `resolve` returns a fresh tree, never the shared
 * `columnMap` entry.
 */
function makeViewScope(
	columnMap: ReadonlyMap<string, AST.Expression>,
	viewName: string,
	view: MutableViewLike,
	baseQualify?: (repl: AST.Expression) => AST.Expression,
): ScopeContext {
	const lcView = viewName.toLowerCase();
	const resolve = (name: string): AST.Expression | undefined => {
		const repl = columnMap.get(name);
		if (!repl || !baseQualify) return repl;
		return baseQualify(repl);
	};
	return {
		makeSubstitute: (shadowed, tainted) => (col) => {
			const name = col.name.toLowerCase();
			if (col.table) {
				return col.table.toLowerCase() === lcView ? resolve(name) : undefined;
			}
			if (shadowed.has(name)) return undefined;
			if (!columnMap.has(name)) return undefined;
			if (tainted) {
				raiseMutationDiagnostic({
					reason: 'unsupported-subquery-correlation',
					table: view.name,
					column: col.name,
					message: `cannot write through view '${view.name}': the reference '${col.name}' inside a subquery cannot be proven correlated to the view because the subquery's source columns are not statically resolvable (a 'select *' / table-valued function / unresolved source); qualify the reference with its base table or alias, or restructure the predicate`,
				});
			}
			return resolve(name);
		},
		unresolvableScope: 'taint',
		rejectDmlSubquery: () => raiseMutationDiagnostic({
			reason: 'unsupported-subquery-correlation',
			table: view.name,
			message: `cannot write through view '${view.name}': a data-modifying subquery (INSERT/UPDATE/DELETE) in a predicate or assigned value cannot be analysed for view-column correlation`,
		}),
	};
}

/**
 * Build the `descend` transformer threaded into the top-level {@link transformExpr}
 * calls on a user predicate / assigned value, so a view-column reference nested in
 * a `subquery` / `exists` / `in`-subquery operand is rewritten scope-aware to its
 * base-term lineage. `columnMap` is the view-col (lowercase) → base-term map;
 * `viewName` is the view's own name (so a `view.col` qualifier is recognised).
 *
 * `baseQualify` is the single-source lowered statement's correlation qualifier
 * (built by {@link makeBaseQualifier} from the base table); the multi-source spine
 * passes `undefined` (its base terms are already alias-qualified — `p.label`). See
 * {@link makeViewScope}.
 */
export function makeViewColumnDescend(
	ctx: PlanningContext,
	columnMap: ReadonlyMap<string, AST.Expression>,
	viewName: string,
	view: MutableViewLike,
	baseQualify?: (repl: AST.Expression) => AST.Expression,
): (query: AST.QueryExpr) => AST.QueryExpr {
	const scope = makeViewScope(columnMap, viewName, view, baseQualify);
	return (query) => transformScopedQuery(ctx, scope, query, new Set<string>(), false);
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

	// Inverse-profile write sites (UPDATE path): read the threaded plan-node
	// `updateLineage` off the already-planned body and, per view column, capture the
	// writable base column + its backward `inverse` closure. This is the single-source
	// dual of what the multi-source spine consumes via `analyzeBodyLineage`
	// (`backward-body.ts`). The identity-only AST readers (`deriveViewColumns` /
	// `classifyProjectionExpr` / `viewColumnsFromUpdateLineage`) are deliberately NOT
	// widened — their parity is pinned by `test/property.spec.ts` — so the richer
	// `base`+`inverse` chain is read separately here via the shared `resolveBaseSite`
	// and applied only to the SET target. An identity / rename column carries no
	// `inverse` (it routes through `columnMap` / `requireBaseColumn` unchanged), and an
	// `opaque` column has no `inverse` site, so it still raises `no-inverse`.
	// `viewColumns[i]` ↔ `attrs[i]` holds because `deriveViewColumns` and the planned
	// projection expand `select *` identically (the parity `viewColumnsFromUpdateLineage`
	// relies on); a `*` column is pure identity, so it is never picked up here regardless.
	const relBody = bodyPlan as RelationalPlanNode;
	const attrs = relBody.getAttributes();
	const lineage = relBody.physical.updateLineage;
	const inverseSites = new Map<string, InverseSite>();
	viewColumns.forEach((vc, i) => {
		const site = resolveBaseSite(lineage?.get(attrs[i]?.id));
		if (site.writable && !site.nullExtended && site.inverse && site.baseColumn) {
			inverseSites.set(vc.name.toLowerCase(), {
				baseColumn: site.baseColumn,
				inverse: site.inverse,
				// No shipped invertibility profile produces a `domain` (`x ± k` is
				// unrestricted over integers), so this is always absent today. Threaded
				// for parity with multi-source (`multi-source.ts` decomposeUpdate), not
				// yet conjoined into the identifying predicate — the documented deferral.
				...(site.domain ? { domain: site.domain } : {}),
			});
		}
	});

	return { baseTable, viewColumns, filterPredicate, filterConstants, columnMap, inverseSites };
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
		// A `set` target / `insert` target column that is not a view column at all —
		// the same encapsulation-leak guard the top-level `where` / `returning` scan
		// applies (a base-only column must not be writable through the view). Computed
		// view columns ARE found here and surface the `no-inverse` diagnostic instead.
		raiseUnknownViewColumn(name, view, analysis.viewColumns.map(c => c.name));
	}
	return vc;
}

/**
 * Visit every column reference at the TOP LEVEL of a scalar expression — i.e. NOT
 * descending into a `subquery` / `exists` / `in`-subquery operand (those nested
 * references resolve in the lowered base scope and are handled scope-aware by
 * {@link makeViewColumnDescend}; the nested-rebind correctness ticket
 * `view-mutation-single-source-subquery-base-term-local-rebind` owns them). The
 * structure mirrors {@link transformExpr} exactly, minus the subquery descent.
 */
function forEachTopLevelColumn(expr: AST.Expression, visit: (col: AST.ColumnExpr) => void): void {
	switch (expr.type) {
		case 'column':
			visit(expr);
			return;
		case 'binary':
			forEachTopLevelColumn(expr.left, visit);
			forEachTopLevelColumn(expr.right, visit);
			return;
		case 'unary':
		case 'cast':
		case 'collate':
			forEachTopLevelColumn(expr.expr, visit);
			return;
		case 'function':
			expr.args.forEach(a => forEachTopLevelColumn(a, visit));
			return;
		case 'between':
			forEachTopLevelColumn(expr.expr, visit);
			forEachTopLevelColumn(expr.lower, visit);
			forEachTopLevelColumn(expr.upper, visit);
			return;
		case 'case':
			if (expr.baseExpr) forEachTopLevelColumn(expr.baseExpr, visit);
			expr.whenThenClauses.forEach(w => { forEachTopLevelColumn(w.when, visit); forEachTopLevelColumn(w.then, visit); });
			if (expr.elseExpr) forEachTopLevelColumn(expr.elseExpr, visit);
			return;
		case 'in':
			forEachTopLevelColumn(expr.expr, visit);
			if (expr.values) expr.values.forEach(v => forEachTopLevelColumn(v, visit));
			// expr.subquery is a nested scope — intentionally not descended.
			return;
		default:
			// subquery / exists — nested scope, not validated here.
			// literal / identifier / parameter / windowFunction / functionSource —
			// no top-level column reference to validate.
			return;
	}
}

/**
 * Raise the structured `unknown-view-column` diagnostic for a reference that names
 * something the view does not expose. `displayColumns` is the view's exposed column
 * list (in display spelling) for the suggestion.
 */
export function raiseUnknownViewColumn(spelling: string, view: MutableViewLike, displayColumns: readonly string[]): never {
	raiseMutationDiagnostic({
		reason: 'unknown-view-column',
		column: spelling,
		table: view.name,
		message: `cannot write through view '${view.name}': '${spelling}' is not a column of the view`,
		suggestion: `view '${view.name}' exposes: ${displayColumns.join(', ')}.`,
	});
}

/**
 * Enforce **view-column scope** on the TOP-LEVEL references of a user `where` /
 * `returning` clause (the `set` targets are guarded separately at their resolution
 * point). Without this, a name that is not a view column passes through the
 * view→base remap unmapped and silently re-binds against the underlying base
 * table(s) — an encapsulation leak letting a column the view projects away be
 * filtered / returned. A reference must name a column the view exposes, optionally
 * qualified by the view's own name; a bare base-column name (`secret`), a renamed
 * column's base spelling (`label` for a `… as note` projection), or a view-qualified
 * unknown (`sv.secret`) are all rejected. A computed view column passes here (it IS
 * a view column) so a write to it still surfaces the existing `no-inverse`
 * diagnostic. Shared by the single-source spine and the multi-source join path so
 * the two read consistently.
 */
/** Single-source convenience: build the scope sets from a {@link ViewAnalysis}. */
function guardTopLevelScope(expr: AST.Expression, analysis: ViewAnalysis, view: MutableViewLike): void {
	assertTopLevelViewColumns(
		expr,
		new Set(analysis.viewColumns.map(c => c.name.toLowerCase())),
		analysis.viewColumns.map(c => c.name),
		view,
	);
}

export function assertTopLevelViewColumns(
	expr: AST.Expression,
	viewColumnNames: ReadonlySet<string>,
	displayColumns: readonly string[],
	view: MutableViewLike,
): void {
	const lcView = view.name.toLowerCase();
	forEachTopLevelColumn(expr, (col) => {
		const qualifier = col.table?.toLowerCase();
		const known = viewColumnNames.has(col.name.toLowerCase());
		if ((qualifier !== undefined && qualifier !== lcView) || !known) {
			raiseUnknownViewColumn(col.table ? `${col.table}.${col.name}` : col.name, view, displayColumns);
		}
	});
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
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view),
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
	const analysis = analyzeView(ctx, view);
	const substitute = remapper(analysis);
	// Qualify substituted subquery-descent base terms with the lowered target's
	// synthesised alias (SELF_ALIAS) so they correlate to the outer target row even
	// when the user subquery FROM names the view's own base table (the same-base-table
	// self-reference corner). The lowered statement carries `alias: SELF_ALIAS` below.
	const descend = makeViewColumnDescend(ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, SELF_ALIAS));

	// Scope guard: `set` targets, assigned values, and the top-level `where`
	// references must name view columns (a base-only name must not leak through to
	// the underlying table).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);
	const assignments = stmt.assignments.map(asg => {
		// Enforce view-column scope on the SET target (an unknown / base-only name is
		// rejected here; a computed view column is found and surfaces `no-inverse` below).
		const vc = findViewColumn(analysis, asg.column, view);
		// The assigned VALUE's top-level references must also name view columns — a
		// base-only name on the RHS would otherwise read a column the view projects
		// away (the same encapsulation leak as the `where` / `set`-target guard).
		guardTopLevelScope(asg.value, analysis, view);
		const loweredValue = transformExpr(asg.value, substitute, descend);
		// An inverse-profile column (e.g. `b + 1 as bp`) routes to its base column with
		// the lowered value run through the site's `inverse` (`set bp = 9` ⇒ `set b = 9 - 1`),
		// mirroring the multi-source spine. The inverse expects a value already in base
		// terms, so it wraps the lowered value LAST (after base-term substitution).
		const inv = analysis.inverseSites.get(asg.column.toLowerCase());
		if (inv) return { column: inv.baseColumn, value: inv.inverse(loweredValue) };
		// Identity / rename → its writable base column; opaque computed → `no-inverse`.
		return { column: requireBaseColumn(vc), value: loweredValue };
	});

	const userWhere = stmt.where ? transformExpr(stmt.where, substitute, descend) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'update',
		table: tableIdentifier(analysis.baseTable),
		// Synthesised collision-proof correlation name on the lowered target; the base
		// builder registers it as the target's AliasedScope alias so an `__vm_self.col`
		// term (emitted by the SELF_ALIAS qualifier above, incl. in RETURNING subqueries)
		// binds the outer target row regardless of the user subquery FROM.
		alias: SELF_ALIAS,
		assignments,
		where,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view, SELF_ALIAS),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

// --- DELETE ---------------------------------------------------------------

export function rewriteViewDelete(ctx: PlanningContext, stmt: AST.DeleteStmt, view: MutableViewLike): AST.DeleteStmt {
	const analysis = analyzeView(ctx, view);
	const substitute = remapper(analysis);
	// Qualify substituted subquery-descent base terms with the lowered target's
	// synthesised alias (SELF_ALIAS) so they correlate to the outer target row even
	// when the user subquery FROM names the view's own base table (the same-base-table
	// self-reference corner). The lowered statement carries `alias: SELF_ALIAS` below.
	const descend = makeViewColumnDescend(ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, SELF_ALIAS));

	// Scope guard: top-level `where` references must name view columns.
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);
	const userWhere = stmt.where ? transformExpr(stmt.where, substitute, descend) : undefined;
	const where = combineAnd(userWhere, analysis.filterPredicate ? cloneExpr(analysis.filterPredicate) : undefined);

	return {
		type: 'delete',
		table: tableIdentifier(analysis.baseTable),
		// Synthesised collision-proof correlation name on the lowered target; see
		// rewriteViewUpdate for the rationale (binds `__vm_self.col` to the outer row).
		alias: SELF_ALIAS,
		where,
		contextValues: stmt.contextValues,
		returning: rewriteViewReturning(ctx, stmt.returning, analysis, view, SELF_ALIAS),
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
}

/**
 * Rewrite a view-mediated RETURNING clause into base terms so it rides the base
 * op's own RETURNING machinery. The returned rows are projected through the
 * **view's** column list (not the base table's): each view-column reference is
 * substituted to its base-term lineage and the user's view-term output name is
 * preserved as the result-column alias. The base builder then evaluates the
 * clause against NEW (insert/update) or OLD (delete), i.e. the post-mutation
 * (or, for delete, the deleted) base row — so computed view columns re-evaluate
 * against the post-mutation base values. `returning *` expands to every view
 * column. Returns `undefined` for an absent/empty clause.
 *
 * OLD/NEW qualifiers on a view-column reference are not honored through a view
 * (the qualifier is dropped, so the base op's default NEW/OLD binding applies);
 * the documented surface is unqualified / view-qualified view columns.
 *
 * `correlationName` is the lowered target's correlation name used to qualify
 * substituted base terms emitted inside a RETURNING subquery (a RETURNING subquery can
 * correlate to the target row the same way a WHERE subquery can). UPDATE/DELETE pass
 * the synthesised {@link SELF_ALIAS}; INSERT leaves it at the base table name (default).
 */
export function rewriteViewReturning(
	ctx: PlanningContext,
	returning: AST.ResultColumn[] | undefined,
	analysis: ViewAnalysis,
	view: MutableViewLike,
	correlationName: string = analysis.baseTable.name,
): AST.ResultColumn[] | undefined {
	if (!returning || returning.length === 0) return undefined;
	const substitute = remapper(analysis);
	const descend = makeViewColumnDescend(ctx, analysis.columnMap, view.name, view, makeBaseQualifier(ctx, analysis.baseTable, correlationName));
	const out: AST.ResultColumn[] = [];
	for (const rc of returning) {
		if (rc.type === 'all') {
			// RETURNING * (or `view.*`) → every view column, projected through its
			// base-term lineage and named by the view column.
			for (const vc of analysis.viewColumns) {
				const baseExpr = analysis.columnMap.get(vc.name.toLowerCase());
				if (baseExpr) out.push({ type: 'column', expr: cloneExpr(baseExpr), alias: vc.name });
			}
			continue;
		}
		// Scope guard: a top-level `returning` reference must name a view column —
		// the same encapsulation guard as `where` / `set` (a base-only column the
		// view projects away must not leak through RETURNING).
		guardTopLevelScope(rc.expr, analysis, view);
		// Preserve the user's view-term output name BEFORE rewriting to base terms,
		// so the result column is named as written (the view column / its alias),
		// not the underlying base column.
		const alias = rc.alias ?? deriveReturningName(rc.expr);
		out.push({ type: 'column', expr: transformExpr(rc.expr, substitute, descend), alias });
	}
	return out;
}

/** The output name for an unaliased RETURNING expression (view-term spelling). */
function deriveReturningName(expr: AST.Expression): string {
	if (expr.type === 'column') return expr.table ? `${expr.table}.${expr.name}` : expr.name;
	return expressionToString(expr);
}
