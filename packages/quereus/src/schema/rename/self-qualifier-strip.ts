import type * as AST from '../../parser/ast.js';
import { eq, type ResolveColumnInSource } from './shared.js';
import { hasSealedFrame, type ScopeFrame } from '../expr-scope/frame.js';
import { walkSchemaExpressionScope } from '../expr-scope/walk.js';

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (schema-authored row expressions)
// ──────────────────────────────────────────────────────────────────────

interface StripState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase default schema name. */
	defaultSchema: string;
	resolve: ResolveColumnInSource;
	changed: boolean;
}

/**
 * Strip table-qualified self-references in a schema-authored ROW expression —
 * a `CHECK` constraint or a `GENERATED ALWAYS AS` body — down to the
 * unqualified form: `check (t.qty > 0)` (or `main.t.qty`) becomes
 * `check (qty > 0)` so the row-context scope those expressions are compiled
 * against — which registers bare / `NEW.` (/ `OLD.` for a CHECK) column names
 * only — can resolve it. Callers: `planner/building/constraint-builder.ts` and
 * `planner/building/generated-column-scope.ts`.
 *
 * Deliberately NOT done by seeding `<table>.<col>` keys into that row scope:
 * the scope is an ancestor of every subquery planned inside the expression,
 * and a join peer's parent-chain fallback (`MultiScope` first-match
 * on qualified names) would resolve an inner relation's qualified columns
 * against the outer row context (observed with lens view expansions).
 *
 * The walk mirrors SQL shadowing rules: a qualifier rebound by an inner
 * FROM (same table re-selected, an alias, or a CTE) is left untouched. A
 * self-qualified ref inside a subquery is stripped only when no
 * intervening FROM frame could capture the resulting unqualified name —
 * real-table sources are asked via `resolveColumnInSource`; subquery /
 * function / CTE sources are unanalyzable and conservatively block the
 * strip (the ref then stays qualified and fails to resolve exactly as it
 * did before this rewrite existed). CTE and derived-table bodies cannot
 * correlate to the written row, so stripping is suppressed inside them.
 * The traversal and its frame model live in `../expr-scope/` (`walk.ts` and
 * `frame.ts`), shared with the generated-column reference collector; this file
 * supplies only the per-column action.
 *
 * Mutates `expr` in place (callers pass a clone of the stored expression,
 * never the schema's own AST) and returns whether anything was rewritten.
 */
export function stripSelfQualifierInSchemaExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	defaultSchemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	const state: StripState = {
		tableName: tableName.toLowerCase(),
		defaultSchema: defaultSchemaName.toLowerCase(),
		resolve: resolveColumnInSource,
		changed: false,
	};
	walkSchemaExpressionScope(
		expr,
		{ defaultSchema: state.defaultSchema, seedBindings: [state.tableName] },
		{ onColumn: (col, stack) => stripColumnQualifier(col, stack, state) },
	);
	return state.changed;
}

/** `stack[0]` is the walk's seed frame; every loop here deliberately skips it. */
function stripColumnQualifier(
	col: AST.ColumnExpr,
	stack: ReadonlyArray<ScopeFrame>,
	state: StripState,
): void {
	// View write-through metadata (`with inverse (…)` / `with defaults (…)`) resolves
	// against the written view row, not this expression's scope — never rewrite there.
	if (hasSealedFrame(stack)) return;
	if (!col.table) return;
	const qualifier = col.table.toLowerCase();
	// Innermost-first: a qualifier rebound by any inner FROM resolves there.
	for (let i = stack.length - 1; i >= 1; i--) {
		if (stack[i].bound.has(qualifier)) return;
	}
	if (qualifier !== state.tableName) return;
	// A qualified self-reference must name the OWNING table's schema exactly —
	// `defaultSchema` here is the expression's owning schema (the caller passes
	// `tableSchema.schemaName`), so no path resolution applies: `main.t.qty` in
	// an expression on `temp.t` is not a self-reference.
	if (!(col.schema === undefined || eq(col.schema, state.defaultSchema))) return;
	// Strip only when no intervening frame could capture the unqualified name.
	const colLower = col.name.toLowerCase();
	for (let i = 1; i < stack.length; i++) {
		const frame = stack[i];
		if (frame.hasOpaque) return;
		for (const src of frame.realSources) {
			if (state.resolve(src.schema, src.name, colLower)) return;
		}
	}
	col.table = undefined;
	col.schema = undefined;
	state.changed = true;
}

// ──────────────────────────────────────────────────────────────────────
// Own-row requalification (existing-row CHECK scans)
// ──────────────────────────────────────────────────────────────────────

/**
 * Rewrite every reference to the OWNING row in a schema-authored CHECK — the
 * `new.<col>` row-image spelling and the self-qualified `<table>.<col>` /
 * `<schema>.<table>.<col>` spellings — to `<alias>.<col>`, so the constraint can
 * be re-planned as an ordinary predicate over `from <table> as <alias>`.
 *
 * The mirror image of {@link stripSelfQualifierInSchemaExpression}: that one
 * folds to the BARE form the row-context scope registers; this one folds to an
 * alias, precisely because a bare name inside a subquery can be captured by the
 * subquery's own FROM sources while a qualified reference cannot — so no
 * catalog lookup (`ResolveColumnInSource`) is needed here. The alias must be one
 * no FROM source the user could write inside the CHECK would rebind. Used by the
 * existing-row CHECK scan (`validateChecksOverExistingRows` in
 * `../constraint-builder.ts`), the one CHECK path that re-prepares the
 * constraint as a whole statement instead of compiling it in a row scope, so
 * `new.` has no scope to resolve against there.
 *
 * Scope rules mirror the enforcement compile: a qualifier rebound by an inner
 * FROM / WITH is left alone (`new` is not a reserved word — `(select max("new".a)
 * from "new")` names a real table, and `from other as t` rebinds `t`), and nothing
 * under a sealed view write-through frame is touched. `old.<col>` is NOT rewritten
 * — the previous row image has no stored-row counterpart, so callers screen those
 * conjuncts out before reaching here (`storedRowPredicate`).
 *
 * Mutates `expr` in place (pass a clone) and returns whether anything changed.
 */
export function requalifyOwnRowRefsInSchemaExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	defaultSchemaName: string,
	alias: string,
): boolean {
	if (!expr) return false;
	const state: RequalifyState = {
		tableName: tableName.toLowerCase(),
		defaultSchema: defaultSchemaName.toLowerCase(),
		alias,
		changed: false,
	};
	walkSchemaExpressionScope(
		expr,
		{ defaultSchema: state.defaultSchema, seedBindings: [state.tableName] },
		{ onColumn: (col, stack) => requalifyOwnRowRef(col, stack, state) },
	);
	return state.changed;
}

interface RequalifyState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase owning-schema name. */
	defaultSchema: string;
	/** The qualifier every own-row reference is rewritten to. */
	alias: string;
	changed: boolean;
}

/** `stack[0]` is the walk's seed frame; the rebind scan deliberately skips it. */
function requalifyOwnRowRef(
	col: AST.ColumnExpr,
	stack: ReadonlyArray<ScopeFrame>,
	state: RequalifyState,
): void {
	if (hasSealedFrame(stack)) return;
	if (!col.table) return;
	const qualifier = col.table.toLowerCase();
	// Innermost-first: a qualifier rebound by any inner FROM / WITH resolves there,
	// whether it is `new` (a real table of that name) or the owning table's own name
	// (a self-join alias).
	for (let i = stack.length - 1; i >= 1; i--) {
		if (stack[i].bound.has(qualifier)) return;
	}
	if (qualifier === 'new') {
		// A schema-qualified `main.new.a` is a three-part table reference, never a row
		// image — the same rule the rename walkers apply.
		if (col.schema !== undefined) return;
	} else {
		if (qualifier !== state.tableName) return;
		// A qualified self-reference must name the OWNING table's schema exactly
		// (see `stripColumnQualifier`).
		if (!(col.schema === undefined || eq(col.schema, state.defaultSchema))) return;
	}
	col.table = state.alias;
	col.schema = undefined;
	state.changed = true;
}
