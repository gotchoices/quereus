import type * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Attribute, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { CollateNode } from '../nodes/scalar.js';
import { buildExpression } from './expression.js';

/**
 * One output column of a SELECT list, in source order (stars expanded).
 *
 * `expr` is the AST that produced the column — the authored expression for a
 * normal result column, or a synthesized `{type:'column', name}` for a column a
 * star expanded to. That synthesized name is NOT a reliable handle: it is
 * unqualified, so two same-named columns from different join sides collapse onto
 * it. `sourceAttribute` therefore carries the exact input attribute a
 * star-expanded column came from, so a positional reference can bind to it
 * directly instead of re-resolving the name.
 */
export interface SelectListEntry {
	/** The AST that produced this output column (authored, or synthesized for a star). */
	readonly expr: AST.Expression;
	/** Star-expanded entries only: the exact input attribute this column came from. */
	readonly sourceAttribute?: { readonly attr: Attribute; readonly index: number };
	/**
	 * The `as` alias this column was written with, if any. Star-expanded entries
	 * never carry one, so a star column's name cannot shadow a source column when
	 * a caller matches ORDER BY names against select-list aliases.
	 */
	readonly alias?: string;
}

/**
 * Builds the source-order list of SELECT-list output columns, with
 * SELECT * / table.* expanded against the input relation's attributes.
 * Each entry corresponds to one output column, in source order. Used so that
 * GROUP BY / ORDER BY ordinal references (1-based) can resolve back to the
 * column that produced the Nth output column.
 */
export function buildSelectListEntries(
	columns: AST.ResultColumn[],
	input: RelationalPlanNode,
): SelectListEntry[] {
	const result: SelectListEntry[] = [];
	for (const column of columns) {
		if (column.type === 'all') {
			const allAttrs = input.getAttributes();
			allAttrs.forEach((attr, index) => {
				if (column.table && attr.relationName?.toLowerCase() !== column.table.toLowerCase()) return;
				const colExpr: AST.ColumnExpr = { type: 'column', name: attr.name };
				result.push({ expr: colExpr, sourceAttribute: { attr, index } });
			});
		} else if (column.type === 'column') {
			result.push({ expr: column.expr, alias: column.alias });
		}
	}
	return result;
}

/**
 * If `expr` is a positional reference — a bare integer literal, optionally under a
 * unary `+`/`-` and/or `collate` wrappers (`order by 2 collate nocase`) — returns the
 * 1-based entry of `selectList` it names. Out-of-range / zero / negative ordinals
 * raise an error, collate wrapper or not. Any other expression shape returns null so
 * the caller can fall through to normal expression building (e.g., `group by 1 + 0`
 * keeps its constant-expression semantics).
 *
 * The collate wrapper is not reported here; {@link buildOrdinalAwareExpression}
 * applies it to the resolved column.
 */
export function resolveOrdinalReference(
	expr: AST.Expression,
	selectList: readonly SelectListEntry[],
	clauseName: 'GROUP BY' | 'ORDER BY',
): SelectListEntry | null {
	return resolveOrdinalTerm(expr, selectList, clauseName)?.entry ?? null;
}

function resolveOrdinalTerm(
	expr: AST.Expression,
	selectList: readonly SelectListEntry[],
	clauseName: 'GROUP BY' | 'ORDER BY',
): { readonly entry: SelectListEntry; readonly collate?: AST.CollateExpr } | null {
	const term = parseOrdinalTerm(expr);
	if (!term) return null;
	assertOrdinalInRange(term.position, selectList.length, clauseName, expr);
	return { entry: selectList[term.position - 1], collate: term.collate };
}

/**
 * Builds one GROUP BY / ORDER BY term that sits *below* (or beside) the
 * projection producing the SELECT list, so there are no output attributes to
 * bind a positional reference to yet.
 *
 * A positional reference still must not go through a NAME: for a star-expanded
 * column the synthesized name is unqualified, so `select * from t1 join t2 …
 * group by 4` would re-resolve `v` to whichever side happens to be first in
 * scope. When the resolved entry carries its source attribute, reference that
 * attribute directly; otherwise re-plan the authored expression, which is what
 * the ordinal literally stands for. A `collate` suffix on the ordinal is applied
 * to whichever of the two the ordinal resolved to.
 */
export function buildOrdinalAwareExpression(
	context: PlanningContext,
	expr: AST.Expression,
	selectList: readonly SelectListEntry[],
	clauseName: 'GROUP BY' | 'ORDER BY',
	allowAggregates: boolean = false,
): ScalarPlanNode {
	const resolved = resolveOrdinalTerm(expr, selectList, clauseName);
	if (!resolved) {
		return buildExpression(context, expr, allowAggregates);
	}
	const { entry, collate } = resolved;
	const target = buildSourceAttributeReference(entry, context.scope)
		?? buildExpression(context, entry.expr, allowAggregates);
	return applyOrdinalCollate(context.scope, collate, target);
}

/**
 * A direct reference to a star-expanded entry's source attribute, or null when
 * the entry is an authored expression (which must be re-planned instead).
 */
function buildSourceAttributeReference(entry: SelectListEntry, scope: Scope): ColumnReferenceNode | null {
	if (!entry.sourceAttribute) return null;
	const { attr, index } = entry.sourceAttribute;
	const colExpr: AST.ColumnExpr = attr.relationName
		? { type: 'column', name: attr.name, table: attr.relationName }
		: { type: 'column', name: attr.name };
	return new ColumnReferenceNode(scope, colExpr, attr.type, attr.id, index);
}

/**
 * Resolves a 1-based positional ORDER BY ordinal against a relation whose output
 * attributes ARE the SELECT list — the final `ProjectNode` of a single SELECT, or
 * a `SetOperationNode` for a compound. The ordinal maps directly to the Nth
 * OUTPUT column (index `n-1`), returning a `ColumnReferenceNode` over that
 * column's attribute/type.
 *
 * Binding by attribute rather than by name is what makes a positional reference
 * mean "the Nth result column" rather than "re-resolve the text that produced it":
 * a SELECT-list alias cannot shadow the target (`select b as a, a as z … order by
 * 2`), two same-named columns under a star cannot be confused (`select * from t1
 * join t2 … order by 4`), and a computed column (window function, aggregate) is
 * READ from the output rather than recomputed in a scope that cannot evaluate it.
 * The reference also inherits the column's RESOLVED type — including a compound's
 * cross-input `collationName`/`collationSource` — so an ordinal ORDER BY stays in
 * lockstep with dedup, exactly like the column-name form.
 *
 * ORDER BY only: GROUP BY always runs BELOW the projection that produces the
 * select list, so it has no output attributes to bind to (see
 * {@link buildOrdinalAwareExpression}).
 *
 * A `collate` suffix (`order by 1 collate nocase`) wraps the returned reference in
 * that collation, overriding the column's own.
 *
 * Returns null for any non-ordinal expression shape (same recognition as
 * `resolveOrdinalReference`) so the caller falls through to normal expression
 * building. Out-of-range / zero / negative ordinals raise the same prepare-time
 * error as `resolveOrdinalReference`.
 */
export function resolveOrdinalOutputColumn(
	expr: AST.Expression,
	outputRelation: RelationalPlanNode,
	scope: Scope,
): ScalarPlanNode | null {
	const term = parseOrdinalTerm(expr);
	if (!term) return null;
	// NOTE: the range is the relation's full output arity. A `SetOperationNode` that
	// surfaces membership flag columns advertises them here too, so an ordinal could
	// address one; harmless today because flags are introduced by optimizer rewrites,
	// long after this runs at build time. If a flagged set-op ever reaches ORDER BY
	// building, bound the range to the compound's data arity instead.
	const columns = outputRelation.getType().columns;
	assertOrdinalInRange(term.position, columns.length, 'ORDER BY', expr);
	const index = term.position - 1;
	const column = columns[index];
	const attr = outputRelation.getAttributes()[index];
	const colExpr: AST.ColumnExpr = { type: 'column', name: column.name || attr.name };
	const columnRef = new ColumnReferenceNode(scope, colExpr, column.type, attr.id, index);
	return applyOrdinalCollate(scope, term.collate, columnRef);
}

/** A positional term as written: its (unchecked) 1-based position and any collate suffix. */
interface OrdinalTerm {
	readonly position: number;
	/** The OUTERMOST `collate` wrapper — the effective one, as for nested `CollateNode`s. */
	readonly collate?: AST.CollateExpr;
}

/**
 * Recognises a positional reference: an integer literal (optionally signed) under
 * any number of `collate` wrappers. Seeing through the wrappers before deciding
 * whether the term is positional matches SQLite (`sqlite3ExprSkipCollate`), so
 * `order by 5 collate nocase` is an out-of-range position, not a constant key.
 */
function parseOrdinalTerm(expr: AST.Expression): OrdinalTerm | null {
	let collate: AST.CollateExpr | undefined;
	let inner = expr;
	while (inner.type === 'collate') {
		collate ??= inner;
		inner = inner.expr;
	}
	const position = extractOrdinalValue(inner);
	return position === null ? null : { position, collate };
}

function assertOrdinalInRange(
	position: number,
	count: number,
	clauseName: 'GROUP BY' | 'ORDER BY',
	expr: AST.Expression,
): void {
	if (position >= 1 && position <= count) return;
	throw new QuereusError(
		`${clauseName} position ${position} is not in the SELECT list (1..${count})`,
		StatusCode.ERROR,
		undefined,
		expr.loc?.start.line,
		expr.loc?.start.column,
	);
}

/**
 * Applies a positional term's collate suffix to the column it resolved to.
 *
 * The node's AST is synthesized as `<resolved column> collate <name>` rather than
 * reusing the user's wrapper, whose text is `1 collate nocase`: grouped-query
 * coverage and post-aggregate redirection match expressions by AST fingerprint, so a
 * grouping key must fingerprint as the column it stands for — exactly like the named
 * form `group by a collate nocase` — and never as the constant `1 collate nocase`.
 *
 * An operand that already carries the same explicit collation is returned as is.
 * Rewrapping would not change how it compares, but its fingerprint (`a collate nocase
 * collate nocase`) would stop `select a collate nocase k … group by 1 collate nocase`
 * from recognising its own SELECT-list column as the grouping key.
 */
function applyOrdinalCollate(
	scope: Scope,
	collate: AST.CollateExpr | undefined,
	operand: ScalarPlanNode,
): ScalarPlanNode {
	if (!collate) return operand;
	const operandType = operand.getType();
	if (operandType.collationSource === 'explicit'
		&& operandType.collationName?.toUpperCase() === collate.collation.toUpperCase()) {
		return operand;
	}
	const expression: AST.CollateExpr = {
		type: 'collate',
		expr: operand.expression,
		collation: collate.collation,
		loc: collate.loc,
	};
	return new CollateNode(scope, expression, operand);
}

function extractOrdinalValue(expr: AST.Expression): number | null {
	if (expr.type === 'literal') {
		const v = expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) return v;
		return null;
	}
	// Unary `-N` parses as UnaryExpr(-, Literal(N)). Likewise `+N`.
	if (expr.type === 'unary' && (expr.operator === '-' || expr.operator === '+') && expr.expr.type === 'literal') {
		const v = expr.expr.value;
		if (typeof v === 'number' && Number.isInteger(v)) {
			return expr.operator === '-' ? -v : v;
		}
	}
	return null;
}
