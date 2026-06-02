import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';

/**
 * The one scope-aware column-substitution primitive the view-mutation backward
 * path shares (`docs/view-updateability.md` § Selection).
 *
 * Three callers used to each carry a near-parallel copy of "rewrite column
 * references X→Y in an expression / query, scope-aware (shadowing, taint, deep
 * subquery descent)":
 *  - `single-source.ts` — the view-column → base-term descent and the
 *    correlation-qualifier of a substituted base term (both DEEP / scope-aware),
 *  - `multi-source.ts` — view-column → alias-qualified base term,
 *  - `lens-enforcement.ts` — logical → basis column rewriting.
 *
 * They share a shadowing/taint model and differ only in the substitution map and
 * the qualification rule. This module owns the structural tree-walker
 * ({@link transformExpr} and the clones built on it), the FROM-source column-name
 * resolution that drives the shadow set ({@link collectFromColumnNames}), and the
 * scope-aware descent ({@link transformScopedExpr} / {@link transformScopedQuery})
 * parameterized by a {@link ScopeContext} value object. Each caller supplies a
 * `ScopeContext` (its substitution closure + taint policy + reject builders); the
 * descent itself — shadow accumulation across nested scopes, the
 * `unsupported-subquery-correlation` taint logic, sibling-leg scoping — is shared.
 */

// --- structural expression walker -----------------------------------------

/**
 * Structurally clone an expression, substituting column references via
 * `substitute`. A substituted replacement is cloned but NOT re-substituted
 * (the replacement is already in target terms).
 *
 * Subquery operands (`subquery` / `exists` / `in … (select …)`) are descended
 * into via the optional `descend` transformer, so a column reference nested
 * inside a correlated subquery of a user predicate / assigned value is rewritten
 * to its lineage (scope-aware — see {@link transformScopedQuery}). With `descend`
 * omitted the subquery operand is passed through structurally — byte-identical to
 * a plain structural rewrite — which keeps every top-level-only caller (and
 * {@link cloneExpr}'s no-substitution clone) unchanged.
 */
export function transformExpr(
	expr: AST.Expression,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
	descend?: (query: AST.QueryExpr) => AST.QueryExpr,
): AST.Expression {
	switch (expr.type) {
		case 'column': {
			const replacement = substitute(expr);
			if (replacement) return cloneExpr(replacement);
			return { ...expr };
		}
		case 'binary':
			return { ...expr, left: transformExpr(expr.left, substitute, descend), right: transformExpr(expr.right, substitute, descend) };
		case 'unary':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'function':
			return { ...expr, args: expr.args.map(a => transformExpr(a, substitute, descend)) };
		case 'cast':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'collate':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'between':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute, descend),
				lower: transformExpr(expr.lower, substitute, descend),
				upper: transformExpr(expr.upper, substitute, descend),
			};
		case 'case':
			return {
				...expr,
				baseExpr: expr.baseExpr ? transformExpr(expr.baseExpr, substitute, descend) : undefined,
				whenThenClauses: expr.whenThenClauses.map(w => ({
					when: transformExpr(w.when, substitute, descend),
					then: transformExpr(w.then, substitute, descend),
				})),
				elseExpr: expr.elseExpr ? transformExpr(expr.elseExpr, substitute, descend) : undefined,
			};
		case 'in':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute, descend),
				values: expr.values ? expr.values.map(v => transformExpr(v, substitute, descend)) : undefined,
				subquery: expr.subquery && descend ? descend(expr.subquery) : expr.subquery,
			};
		case 'subquery':
			return { ...expr, query: descend ? descend(expr.query) : expr.query };
		case 'exists':
			return { ...expr, subquery: descend ? descend(expr.subquery) : expr.subquery };
		default:
			// literal / identifier / parameter / windowFunction / functionSource —
			// no nested scalar/relational operand to rewrite.
			return { ...expr };
	}
}

/** Deep structural clone of an expression, including any nested subqueries. */
export function cloneExpr(expr: AST.Expression): AST.Expression {
	return transformExpr(expr, () => undefined, cloneQueryExpr);
}

/** Deep structural clone of a relation-producing subquery (no substitution). */
export function cloneQueryExpr(query: AST.QueryExpr): AST.QueryExpr {
	return mapQueryExprUniform(query, () => undefined);
}

/**
 * Apply a column substitution uniformly through a subquery's structure — NOT
 * scope-aware. The substitution decides purely on the column's own qualifier
 * (e.g. {@link cloneQueryExpr}'s no-op, or the multi-source SET-value qualifier
 * strip), so the enclosing scope is irrelevant and the same `substitute` is
 * applied at every nesting depth. The `with` clause is preserved structurally —
 * a CTE body cannot correlate to the enclosing query, so it needs no rewrite.
 */
export function mapQueryExprUniform(
	query: AST.QueryExpr,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
): AST.QueryExpr {
	const descend = (q: AST.QueryExpr): AST.QueryExpr => mapQueryExprUniform(q, substitute);
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, descend);
	if (query.type === 'select') return rebuildSelect(query, onExpr, descend, descend);
	if (query.type === 'values') return { ...query, values: query.values.map(row => row.map(onExpr)) };
	// INSERT/UPDATE/DELETE … RETURNING as a subquery — structural shallow clone (no
	// scalar operands to thread here; the view-mutation descent rejects these).
	return { ...query };
}

/**
 * Structurally rebuild a `SelectStmt`, applying `onExpr` to every scalar
 * expression in the select's OWN scope (projections, `where`, `groupBy`,
 * `having`, `orderBy`, `limit`, `offset`, and join `ON` conditions), `onNested`
 * to a subquery nested in that scope (a FROM `SubquerySource`), and `onLeg` to a
 * sibling compound / union leg (which correlates to the SAME outer scope as this
 * select, not to this select's FROM). The `with` clause is preserved structurally.
 */
function rebuildSelect(
	sel: AST.SelectStmt,
	onExpr: (e: AST.Expression) => AST.Expression,
	onNested: (q: AST.QueryExpr) => AST.QueryExpr,
	onLeg: (q: AST.QueryExpr) => AST.QueryExpr,
): AST.SelectStmt {
	return {
		...sel,
		columns: sel.columns.map(rc => rc.type === 'all' ? { ...rc } : { ...rc, expr: onExpr(rc.expr) }),
		from: sel.from?.map(fc => rebuildFrom(fc, onExpr, onNested)),
		where: sel.where ? onExpr(sel.where) : undefined,
		groupBy: sel.groupBy ? sel.groupBy.map(onExpr) : undefined,
		having: sel.having ? onExpr(sel.having) : undefined,
		orderBy: sel.orderBy ? sel.orderBy.map(ob => ({ ...ob, expr: onExpr(ob.expr) })) : undefined,
		limit: sel.limit ? onExpr(sel.limit) : undefined,
		offset: sel.offset ? onExpr(sel.offset) : undefined,
		compound: sel.compound ? { ...sel.compound, select: onLeg(sel.compound.select) } : undefined,
		union: sel.union ? onLeg(sel.union) as AST.SelectStmt : undefined,
	};
}

/** Rebuild a FROM clause, threading `onExpr` into join conditions / TVF args and
 *  `onNested` into a subquery source. */
function rebuildFrom(
	fc: AST.FromClause,
	onExpr: (e: AST.Expression) => AST.Expression,
	onNested: (q: AST.QueryExpr) => AST.QueryExpr,
): AST.FromClause {
	switch (fc.type) {
		case 'table':
			return { ...fc };
		case 'join':
			return {
				...fc,
				left: rebuildFrom(fc.left, onExpr, onNested),
				right: rebuildFrom(fc.right, onExpr, onNested),
				condition: fc.condition ? onExpr(fc.condition) : undefined,
			};
		case 'functionSource':
			return { ...fc, args: fc.args.map(onExpr) };
		case 'subquerySource':
			return { ...fc, subquery: onNested(fc.subquery) };
	}
}

// --- FROM column-name resolution (shadow-set construction) ----------------

/**
 * Resolve the lowercased set of column names a subquery's FROM sources introduce
 * into scope, or `null` when any source's columns cannot be resolved statically
 * (a TVF, a `select *` / unnamed-projection subquery source, or an unknown name
 * such as a CTE reference). A `null` marks the scope (and everything nested in
 * it) **tainted**: a descent can no longer prove an unqualified reference is
 * *not* a local column, so the {@link ScopeContext} decides whether to reject or
 * carry the taint forward.
 */
export function collectFromColumnNames(
	ctx: PlanningContext,
	from: readonly AST.FromClause[] | undefined,
): Set<string> | null {
	const acc = new Set<string>();
	if (!from) return acc;
	for (const fc of from) {
		const names = fromSourceColumnNames(ctx, fc);
		if (names === null) return null;
		for (const n of names) acc.add(n);
	}
	return acc;
}

/** Lowercased column names a single FROM source introduces, or `null` if unresolvable. */
function fromSourceColumnNames(ctx: PlanningContext, fc: AST.FromClause): Set<string> | null {
	switch (fc.type) {
		case 'table':
			return tableSourceColumnNames(ctx, fc);
		case 'join': {
			const left = fromSourceColumnNames(ctx, fc.left);
			if (left === null) return null;
			const right = fromSourceColumnNames(ctx, fc.right);
			if (right === null) return null;
			for (const n of right) left.add(n);
			return left;
		}
		case 'subquerySource':
			return fc.columns && fc.columns.length > 0
				? new Set(fc.columns.map(c => c.toLowerCase()))
				: projectionOutputNames(fc.subquery);
		case 'functionSource':
			// A table-valued function's output columns are not statically known here.
			return null;
	}
}

/** Lowercased column names of a base table / view / MV named in a FROM, or `null`. */
function tableSourceColumnNames(ctx: PlanningContext, src: AST.TableSource): Set<string> | null {
	const schemaName = src.table.schema;
	const table = ctx.schemaManager.getTable(schemaName, src.table.name);
	if (table) return new Set(table.columns.map(c => c.name.toLowerCase()));
	const view = ctx.schemaManager.getView(schemaName ?? null, src.table.name);
	if (view) {
		return view.columns && view.columns.length > 0
			? new Set(view.columns.map(c => c.toLowerCase()))
			: projectionOutputNames(view.selectAst);
	}
	const mv = ctx.schemaManager.getMaterializedView(schemaName ?? null, src.table.name);
	if (mv) {
		return mv.columns && mv.columns.length > 0
			? new Set(mv.columns.map(c => c.toLowerCase()))
			: projectionOutputNames(mv.selectAst);
	}
	// Unknown name (a CTE reference, or a not-yet-resolvable source).
	return null;
}

/**
 * The lowercased output column names of a relation-producing subquery, or `null`
 * when they cannot be determined statically (`select *`, an unnamed computed
 * projection, a VALUES / DML body) — a conservative signal to taint the scope.
 */
function projectionOutputNames(query: AST.QueryExpr): Set<string> | null {
	if (query.type !== 'select') return null;
	const names = new Set<string>();
	for (const rc of query.columns) {
		if (rc.type === 'all') return null;
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
		if (name === undefined) return null;
		names.add(name.toLowerCase());
	}
	return names;
}

// --- scope-aware substitution ---------------------------------------------

/**
 * The caller-specific knobs of a scope-aware substitution. The descent
 * ({@link transformScopedQuery}) owns the shadow accumulation / taint
 * propagation / sibling-leg scoping; this object owns only what differs between
 * callers: the per-column substitution rule and how to treat an unresolvable
 * scope or an embedded data-modifying subquery.
 */
export interface ScopeContext {
	/**
	 * Build the per-column substitution closure for ONE scope, given the set of
	 * column names shadowed by this (and enclosing) scopes and whether the scope is
	 * tainted (an enclosing scope's columns proved unresolvable). Returns the
	 * replacement expression for a column, or `undefined` to leave it untouched.
	 * May throw a structured diagnostic (e.g. a tainted scope rejecting an
	 * unqualified, correlation-ambiguous reference).
	 */
	makeSubstitute(shadowed: ReadonlySet<string>, tainted: boolean): (col: AST.ColumnExpr) => AST.Expression | undefined;
	/**
	 * Policy when a scope's FROM columns are unresolvable (`collectFromColumnNames`
	 * returns `null`): `'taint'` carries `tainted = true` forward (the substitution
	 * decides per-reference), `'reject'` raises {@link rejectUnresolvableScope}
	 * immediately rather than risk a silent mis-bind.
	 */
	readonly unresolvableScope: 'taint' | 'reject';
	/**
	 * Raise the structured diagnostic for an unresolvable scope. Required (and only
	 * called) when `unresolvableScope === 'reject'`; a `'taint'` policy never invokes
	 * it, so it may be omitted there.
	 */
	rejectUnresolvableScope?(): never;
	/** Raise the structured diagnostic for an embedded data-modifying (INSERT/UPDATE/DELETE) subquery. */
	rejectDmlSubquery(): never;
}

const NO_SHADOW: ReadonlySet<string> = new Set<string>();

/**
 * Scope-aware substitution over an expression, entered at the outermost scope
 * (no shadowing, untainted). Used to rewrite a substituted *term* whose own
 * correlation refs must be (re-)bound (the single-source base-term qualifier).
 */
export function transformScopedExpr(ctx: PlanningContext, scope: ScopeContext, expr: AST.Expression): AST.Expression {
	const substitute = scope.makeSubstitute(NO_SHADOW, false);
	const descend = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, NO_SHADOW, false);
	return transformExpr(expr, substitute, descend);
}

/**
 * Scope-aware transform of an inner `QueryExpr`. Rewrites column references
 * correlated to the outer scope per the {@link ScopeContext}, while leaving
 * subquery-local same-named columns untouched.
 *
 * `shadowed` is the set of column names introduced by ENCLOSING subquery scopes;
 * `tainted` is set once an enclosing scope's columns proved unresolvable (so the
 * `ScopeContext`'s substitution can reject an unqualified, ambiguous reference at
 * this depth or below). A `select`'s own FROM column names join the shadow set
 * for its clauses and any subquery nested in them; a sibling compound / union leg
 * keeps the incoming `shadowed` / `tainted` (it correlates to the same outer
 * scope, not to this select's FROM).
 */
export function transformScopedQuery(
	ctx: PlanningContext,
	scope: ScopeContext,
	query: AST.QueryExpr,
	shadowed: ReadonlySet<string>,
	tainted: boolean,
): AST.QueryExpr {
	if (query.type === 'values') {
		// No FROM — the value rows correlate to the enclosing scope unchanged.
		const substitute = scope.makeSubstitute(shadowed, tainted);
		const descend = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, shadowed, tainted);
		const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, descend);
		return { ...query, values: query.values.map(row => row.map(onExpr)) };
	}
	if (query.type !== 'select') {
		// An embedded INSERT/UPDATE/DELETE … RETURNING subquery — too rich to analyse
		// for correlation; reject rather than risk a partial rewrite.
		scope.rejectDmlSubquery();
	}

	const sel = query;
	const local = collectFromColumnNames(ctx, sel.from);
	let innerShadow: ReadonlySet<string>;
	let scopeTainted: boolean;
	if (local === null) {
		if (scope.unresolvableScope === 'reject') scope.rejectUnresolvableScope!();
		// Taint: shadowing cannot be proven, so the enclosing shadow set is kept and
		// the scope (and everything nested in it) is marked tainted.
		innerShadow = shadowed;
		scopeTainted = true;
	} else {
		// References in THIS select's clauses see this select's FROM in addition to
		// any enclosing scope, so its locals join the shadow set.
		innerShadow = new Set<string>([...shadowed, ...local]);
		scopeTainted = tainted;
	}

	const substitute = scope.makeSubstitute(innerShadow, scopeTainted);
	// A subquery nested inside this select's clauses / FROM sees this select's FROM,
	// so it inherits `innerShadow` / `scopeTainted`.
	const onNested = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, innerShadow, scopeTainted);
	// A compound / union leg is a SIBLING select correlating to the SAME outer scope
	// as this one — it does NOT see this select's FROM, so it keeps the incoming
	// `shadowed` / `tainted`.
	const onLeg = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, shadowed, tainted);
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, onNested);
	return rebuildSelect(sel, onExpr, onNested, onLeg);
}
