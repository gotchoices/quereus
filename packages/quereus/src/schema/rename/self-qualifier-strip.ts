import type * as AST from '../../parser/ast.js';
import { eq, type ResolveColumnInSource } from './shared.js';
import { hasBarrierFrame, hasSealedFrame, type ScopeFrame } from '../expr-scope/frame.js';
import { walkSchemaExpressionScope } from '../expr-scope/walk.js';

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (schema-authored row expressions)
// ──────────────────────────────────────────────────────────────────────

/**
 * The qualifier a CHECK's scope registers a shadowed column under: one whose name a
 * mutation-context variable also claims, so the bare name is the variable's. The strip
 * folds `<table>.<name>` to it. Spelled to be implausible as a FROM alias, and lowercase
 * because scope keys are.
 *
 * NOTE: nothing refuses a user alias of this spelling, and one inside a CHECK subquery
 * captures the fold, so the CHECK compares that source's column with itself. If aliases
 * ever get a reserved prefix, include this one.
 */
export const OWN_ROW_QUALIFIER = '__quereus_own_row__';

interface StripState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase default schema name. */
	defaultSchema: string;
	resolve: ResolveColumnInSource;
	shadowedColumns?: ReadonlySet<string>;
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
 * `shadowedColumns` holds the lowercase names of columns a mutation-context variable
 * shares a name with, for a CHECK. The bare form of such a name is the variable, so
 * `<table>.<name>` folds to {@link OWN_ROW_QUALIFIER} instead, which the CHECK's scope
 * registers against the row the operation judges. That target is qualified, so no
 * subquery source can capture it, and it keeps `from "new" where "new".who = t.who`
 * from comparing the subquery's column with itself, as folding to `new.` would.
 *
 * Mutates `expr` in place (callers pass a clone of the stored expression,
 * never the schema's own AST) and returns whether anything was rewritten.
 */
export function stripSelfQualifierInSchemaExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	defaultSchemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
	shadowedColumns?: ReadonlySet<string>,
): boolean {
	if (!expr) return false;
	const state: StripState = {
		tableName: tableName.toLowerCase(),
		defaultSchema: defaultSchemaName.toLowerCase(),
		resolve: resolveColumnInSource,
		shadowedColumns,
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
	const colLower = col.name.toLowerCase();
	if (state.shadowedColumns?.has(colLower)) {
		// `context.<name>` with no schema always reaches the variable, including on a table
		// literally named `context`.
		if (qualifier === 'context' && col.schema === undefined) return;
		// Left qualified to fail as an unshadowed name does: such a body cannot correlate to
		// the written row, since a materialized CTE keeps one buffer per execution.
		if (hasBarrierFrame(stack)) return;
		col.table = OWN_ROW_QUALIFIER;
		col.schema = undefined;
		state.changed = true;
		return;
	}
	// Strip only when no intervening frame could capture the unqualified name.
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
 * `contextVariables` is passed for a table that declares mutation context — see
 * {@link OwnRowContextVariables} for what it changes.
 *
 * Mutates `expr` in place (pass a clone) and returns whether anything changed.
 */
export function requalifyOwnRowRefsInSchemaExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	defaultSchemaName: string,
	alias: string,
	contextVariables?: OwnRowContextVariables,
): boolean {
	if (!expr) return false;
	const state: RequalifyState = {
		tableName: tableName.toLowerCase(),
		defaultSchema: defaultSchemaName.toLowerCase(),
		alias,
		contextVariables,
		changed: false,
	};
	walkSchemaExpressionScope(
		expr,
		{ defaultSchema: state.defaultSchema, seedBindings: [state.tableName] },
		{ onColumn: (col, stack) => requalifyOwnRowRef(col, stack, state) },
	);
	return state.changed;
}

/**
 * What a table's declared mutation-context variables change about the own-row spellings.
 *
 * `new.<name>` and `<table>.<name>` reach a same-named column, under the name the scan's
 * source exposes it by. A `<table>.<name>` of a variable that is no column reads the
 * variable, as does `context.<name>` with no schema on a table literally named `context`.
 * On a write, {@link stripSelfQualifierInSchemaExpression} folds the former to the bare form
 * the variable captures. Here both become `context.<name>` rather than the bare form,
 * because a subquery's own source could capture a bare name.
 *
 * NOTE: where a subquery source has a column named like a variable that is no column of this
 * table, the write path keeps the qualifier and every write fails with `<table>.<name> isn't
 * a column`, so this scan accepts a CHECK that no write can plan, as CREATE TABLE does. The
 * same holds for a self-qualified name inside a CTE or derived-table body. If ALTER should
 * refuse these, this is the site that would ask the catalog, as {@link stripColumnQualifier} does.
 */
export interface OwnRowContextVariables {
	/** Lowercase names of the declared variables. */
	readonly names: ReadonlySet<string>;
	/** Lowercase name of each column a variable shares its name with → the name the scan's source exposes that column under. */
	readonly shadowedColumns: ReadonlyMap<string, string>;
}

interface RequalifyState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase owning-schema name. */
	defaultSchema: string;
	/** The qualifier every own-row reference is rewritten to. */
	alias: string;
	contextVariables?: OwnRowContextVariables;
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
	// A qualified self-reference must name the OWNING table's schema exactly
	// (see `stripColumnQualifier`).
	const selfQualified = qualifier === state.tableName
		&& (col.schema === undefined || eq(col.schema, state.defaultSchema));
	// A schema-qualified `main.new.a` is a three-part table reference, never a row
	// image — the same rule the rename walkers apply.
	const rowImage = qualifier === 'new' && col.schema === undefined;
	if (!selfQualified && !rowImage) return;
	if (selfQualified && selfQualifiedNameIsVariable(col, qualifier, state.contextVariables)) {
		col.table = 'context';
		col.schema = undefined;
		state.changed = true;
		return;
	}
	col.table = state.alias;
	col.name = state.contextVariables?.shadowedColumns.get(col.name.toLowerCase()) ?? col.name;
	col.schema = undefined;
	state.changed = true;
}

/** Whether a self-qualified own-row spelling reads a variable rather than a column. See {@link OwnRowContextVariables}. */
function selfQualifiedNameIsVariable(
	col: AST.ColumnExpr,
	qualifier: string,
	contextVariables: OwnRowContextVariables | undefined,
): boolean {
	const nameLower = col.name.toLowerCase();
	if (!contextVariables?.names.has(nameLower)) return false;
	return !contextVariables.shadowedColumns.has(nameLower) || (qualifier === 'context' && col.schema === undefined);
}
