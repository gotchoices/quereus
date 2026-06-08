/**
 * Extract *guarded* FDs from partial UNIQUE constraints — those synthesized
 * from `CREATE UNIQUE INDEX (K) WHERE P`. Inside the partial scope `P`, the
 * columns `K` form a key, so `K → all_other_cols` holds; outside the scope
 * the FD does not hold. We encode this as a guarded FD whose guard is the
 * AND-conjunctive decomposition of `P` into clauses the FD-machinery can
 * activate (see `GuardClause` in plan-node.ts).
 *
 * `TableReferenceNode.computePhysical` calls this alongside CHECK-derived
 * FDs; Filter activation in `FilterNode` discharges the guard when a
 * surrounding predicate entails every clause.
 *
 * Soundness rule: every conjunct of `P` must map to a recognized clause. A
 * predicate with any unrecognized conjunct produces *no* FD — discharging on
 * a weaker partial predicate would falsely activate the FD for rows the
 * unrecognized conjunct excludes.
 *
 * Recognized conjunct shapes:
 *   col = literal              ⇒ eq-literal
 *   literal = col              ⇒ eq-literal (normalized)
 *   col1 = col2                ⇒ eq-column
 *   col IS NULL                ⇒ is-null (negated:false)
 *   col IS NOT NULL            ⇒ is-null (negated:true)
 *   NOT col  (NOT-NULL numeric col) ⇒ eq-literal { col, value: 0 }    (SQL false)
 *   col IN (lit, lit, …)       ⇒ or-of [eq-literal …] (singleton collapses)
 *   a OR b OR …                ⇒ or-of [recognize(a), recognize(b), …]
 *   col >  literal             ⇒ range { col, min: lit, minInc: false, maxInc: false }
 *   col >= literal             ⇒ range { col, min: lit, minInc: true,  maxInc: false }
 *   col <  literal             ⇒ range { col, max: lit, maxInc: false, minInc: false }
 *   col <= literal             ⇒ range { col, max: lit, maxInc: true,  minInc: false }
 *   literal op col             ⇒ flipped to col op' literal, then as above
 *   col BETWEEN lo AND hi      ⇒ range { col, min: lo, max: hi, minInc: true, maxInc: true }
 *
 * `NOT col` is rewritten to `col = 0` (SQLite encodes boolean FALSE as 0).
 * This excludes NULL rows semantically — but the NOT-NULL gate below is
 * syntactic, so `NOT col` on a nominally-nullable UC column is rejected to
 * avoid double-counting that exclusion across producer and consumer. The
 * rewrite is additionally gated on the column's logical type being numeric:
 * for TEXT/BLOB/BOOLEAN columns `col = 0` is not equivalent to `NOT col`
 * (TEXT `''` is falsy but is not equal-to-integer-0 under the strict
 * `sqlValueEquals` comparison used by the consumer), so the rewrite would
 * falsely activate a `col = 0` guard for rows the runtime UC never excluded.
 *
 * NOT-NULL gate: every UC column must be effectively non-NULL inside the
 * partial scope. A column qualifies if either (a) it is declared NOT NULL on
 * the table, or (b) the partial predicate has a matching `col IS NOT NULL`
 * conjunct. Case (b) is sound because the FD only activates when a
 * surrounding predicate entails every guard clause, including that
 * `IS NOT NULL` clause — so discharge cannot falsely activate the FD over
 * rows where the UC column could be NULL. A nullable UC column whose
 * `IS NOT NULL` is not in the predicate would allow multiple NULLs inside
 * scope, so `K → others` would not hold; those are rejected. Mirrors the
 * relation-level rule in `relationTypeFromTableSchema` (type-utils.ts),
 * relaxed for partial scopes that establish non-nullness themselves.
 *
 * Out-of-scope shapes (filed as backlog tickets in the implement ticket):
 *   - function-call / cast-wrapped column references in IN / NOT shapes
 *   - standalone `col` (truthy test) — only `NOT col` is recognized
 *   - IN / NOT / OR inside CHECK implication disjuncts
 *   - NOT BETWEEN (decomposes to a disjunction of two ranges)
 *   - symbolic/parameter range bounds (`age >= ?`)
 *   - per-column collation-aware text bound comparison
 */

import type { FunctionalDependency, GuardClause, GuardPredicate } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { columnIndexFromExpr, flattenDisjunction, flipComparison, literalValue } from './predicate-shape.js';

const cache = new WeakMap<TableSchema, ReadonlyArray<FunctionalDependency>>();

export function getPartialUniqueGuardedFds(
	tableSchema: TableSchema,
): ReadonlyArray<FunctionalDependency> {
	let cached = cache.get(tableSchema);
	if (!cached) {
		cached = extractPartialUniqueGuardedFds(tableSchema);
		cache.set(tableSchema, cached);
	}
	return cached;
}

export function extractPartialUniqueGuardedFds(
	tableSchema: TableSchema,
): FunctionalDependency[] {
	const out: FunctionalDependency[] = [];
	const ucs = tableSchema.uniqueConstraints;
	if (!ucs) return out;

	const colCount = tableSchema.columns.length;

	const isColumnNotNullDeclared = (col: number): boolean =>
		tableSchema.columns[col]?.notNull === true;

	const isColumnNumericDeclared = (col: number): boolean =>
		tableSchema.columns[col]?.logicalType?.isNumeric === true;

	for (const uc of ucs) {
		if (uc.predicate === undefined) continue;

		const clauses = recognizeGuardClauses(uc.predicate, tableSchema.columnIndexMap, isColumnNotNullDeclared, isColumnNumericDeclared);
		if (!clauses) continue;
		if (clauses.length === 0) continue;

		// NOT-NULL gate: each UC column must be effectively non-NULL inside the
		// partial scope — either declared NOT NULL, or forced so by an
		// `IS NOT NULL` conjunct of the partial predicate (which is one of the
		// guard clauses, so discharge will require it).
		const nonNullByPredicate = new Set<number>();
		for (const c of clauses) {
			if (c.kind === 'is-null' && c.negated === true) nonNullByPredicate.add(c.column);
		}
		const allUcColumnsNonNullable = uc.columns.every(idx =>
			tableSchema.columns[idx]?.notNull === true || nonNullByPredicate.has(idx),
		);
		if (!allUcColumnsNonNullable) continue;

		const det = Array.from(uc.columns);
		const detSet = new Set(det);
		const dep: number[] = [];
		for (let i = 0; i < colCount; i++) {
			if (!detSet.has(i)) dep.push(i);
		}
		if (dep.length === 0) continue;

		const guard: GuardPredicate = { clauses };
		out.push({ determinants: det, dependents: dep, guard });
	}

	return out;
}

/**
 * Decompose a partial-index predicate into AND-conjunctive guard clauses.
 *
 * Returns `undefined` (NOT `[]`) if any conjunct fails to map to a recognized
 * `GuardClause` — the entire FD must be skipped in that case. Returns `[]`
 * only for trivially empty inputs (which the caller treats as "no FD").
 */
function recognizeGuardClauses(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	isColumnNotNullDeclared: (col: number) => boolean,
	isColumnNumericDeclared: (col: number) => boolean,
): GuardClause[] | undefined {
	const conjuncts: AST.Expression[] = [];
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'AND') {
			const b = cur as AST.BinaryExpr;
			// Preserve textual order: push right then left so left is processed first.
			stack.push(b.right, b.left);
			continue;
		}
		conjuncts.push(cur);
	}

	const clauses: GuardClause[] = [];
	for (const conjunct of conjuncts) {
		const clause = recognizeClause(conjunct, columnIndexMap, isColumnNotNullDeclared, isColumnNumericDeclared);
		if (!clause) return undefined;
		clauses.push(clause);
	}
	return clauses;
}

/**
 * Recognize one conjunct (or disjunct, when called recursively from
 * `recognizeOr`) as a guard clause.
 *
 * Accepted shapes:
 *   col = literal       ⇒ eq-literal { column, value }
 *   literal = col       ⇒ eq-literal { column, value }     (normalized)
 *   col1 = col2         ⇒ eq-column  { left, right }
 *   col IS NULL         ⇒ is-null    { column, negated:false }
 *   col IS NOT NULL     ⇒ is-null    { column, negated:true }
 *   NOT col             ⇒ eq-literal { column, value: 0 }   (declared NOT NULL + numeric only)
 *   col IN (lit, …)     ⇒ or-of [eq-literal { col, lit_i } …]
 *   a OR b OR …         ⇒ or-of [recognize(a), recognize(b), …]
 *   col >  literal      ⇒ range { col, min: lit, minInc: false, maxInc: false }
 *   col >= literal      ⇒ range { col, min: lit, minInc: true,  maxInc: false }
 *   col <  literal      ⇒ range { col, max: lit, maxInc: false, minInc: false }
 *   col <= literal      ⇒ range { col, max: lit, maxInc: true,  minInc: false }
 *   literal op col      ⇒ flipped to col op' literal, then as above
 *   col BETWEEN lo AND hi ⇒ range { col, min: lo, max: hi, minInc: true, maxInc: true }
 *
 * `=` and `==` are interchangeable. NULL-literal bounds are rejected. Anything
 * else returns undefined — the whole predicate is then dropped on the floor
 * by the caller.
 *
 * For `NOT col`, only declared-NOT-NULL **and** declared-numeric columns are
 * accepted: the rewrite to `col = 0` implicitly excludes NULL rows, but the
 * NOT-NULL gate for the UC is syntactic. Rather than teach the gate about
 * `NOT col`, the simpler/sound choice is to reject `NOT col` on
 * nominally-nullable columns at the producer. The numeric gate is required
 * because `col = 0` (under strict `sqlValueEquals`) only matches numeric
 * zero — TEXT `''` and BOOLEAN `false` are falsy but compare unequal to
 * integer 0, so the rewrite would falsely activate the FD for rows the
 * runtime UC never excluded.
 */
function recognizeClause(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	isColumnNotNullDeclared: (col: number) => boolean,
	isColumnNumericDeclared: (col: number) => boolean,
): GuardClause | undefined {
	if (expr.type === 'unary') {
		const u = expr as AST.UnaryExpr;
		if (u.operator === 'IS NULL' || u.operator === 'IS NOT NULL') {
			const col = columnIndexFromExpr(u.expr, columnIndexMap);
			if (col === undefined) return undefined;
			return { kind: 'is-null', column: col, negated: u.operator === 'IS NOT NULL' };
		}
		if (u.operator === 'NOT') {
			const col = columnIndexFromExpr(u.expr, columnIndexMap);
			if (col === undefined) return undefined;
			if (!isColumnNotNullDeclared(col)) return undefined;
			if (!isColumnNumericDeclared(col)) return undefined;
			return { kind: 'eq-literal', column: col, value: 0 };
		}
		return undefined;
	}
	if (expr.type === 'in') {
		return recognizeIn(expr as AST.InExpr, columnIndexMap);
	}
	if (expr.type === 'between') {
		return recognizeBetween(expr as AST.BetweenExpr, columnIndexMap);
	}
	if (expr.type === 'binary') {
		const b = expr as AST.BinaryExpr;
		if (b.operator === 'OR') {
			return recognizeOr(b, columnIndexMap, isColumnNotNullDeclared, isColumnNumericDeclared);
		}
		if (b.operator === '=' || b.operator === '==') {
			const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
			const rIdx = columnIndexFromExpr(b.right, columnIndexMap);

			if (lIdx !== undefined && rIdx !== undefined) {
				if (lIdx === rIdx) return undefined;
				return { kind: 'eq-column', left: lIdx, right: rIdx };
			}
			if (lIdx !== undefined) {
				const lit = literalValue(b.right);
				if (lit === undefined) return undefined;
				return { kind: 'eq-literal', column: lIdx, value: lit };
			}
			if (rIdx !== undefined) {
				const lit = literalValue(b.left);
				if (lit === undefined) return undefined;
				return { kind: 'eq-literal', column: rIdx, value: lit };
			}
			return undefined;
		}
		if (b.operator === '<' || b.operator === '<=' || b.operator === '>' || b.operator === '>=') {
			return recognizeRange(b, columnIndexMap);
		}
		return undefined;
	}
	return undefined;
}

/**
 * Recognize `col op literal` (or operand-flipped `literal op col`) as a range
 * guard. NULL literal bounds are rejected.
 */
function recognizeRange(
	b: AST.BinaryExpr,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause | undefined {
	const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
	const rIdx = columnIndexFromExpr(b.right, columnIndexMap);
	let colIdx: number | undefined;
	let lit: ReturnType<typeof literalValue>;
	let op: string;
	if (lIdx !== undefined) {
		lit = literalValue(b.right);
		colIdx = lIdx;
		op = b.operator;
	} else if (rIdx !== undefined) {
		lit = literalValue(b.left);
		colIdx = rIdx;
		op = flipComparison(b.operator);
	} else {
		return undefined;
	}
	if (lit === undefined || lit === null || colIdx === undefined) return undefined;
	switch (op) {
		case '>':
			return { kind: 'range', column: colIdx, min: lit, minInclusive: false, maxInclusive: false };
		case '>=':
			return { kind: 'range', column: colIdx, min: lit, minInclusive: true, maxInclusive: false };
		case '<':
			return { kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: false };
		case '<=':
			return { kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: true };
	}
	return undefined;
}

/**
 * Recognize `col BETWEEN literal AND literal` as a closed-interval range
 * guard. `NOT BETWEEN` is rejected (decomposes to a disjunction of two range
 * halves which doesn't fit a single range clause).
 */
function recognizeBetween(
	expr: AST.BetweenExpr,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause | undefined {
	if (expr.not === true) return undefined;
	const colIdx = columnIndexFromExpr(expr.expr, columnIndexMap);
	if (colIdx === undefined) return undefined;
	const lo = literalValue(expr.lower);
	const hi = literalValue(expr.upper);
	if (lo === undefined || lo === null) return undefined;
	if (hi === undefined || hi === null) return undefined;
	return { kind: 'range', column: colIdx, min: lo, max: hi, minInclusive: true, maxInclusive: true };
}

/**
 * Recognize `col IN (lit, lit, …)` as an `or-of` of `eq-literal` clauses.
 * IN-with-subquery, non-literal values, or any other shape returns undefined.
 * A singleton list collapses to a bare `eq-literal`.
 */
function recognizeIn(
	expr: AST.InExpr,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause | undefined {
	if (expr.subquery !== undefined) return undefined;
	if (!expr.values || expr.values.length === 0) return undefined;
	const col = columnIndexFromExpr(expr.expr, columnIndexMap);
	if (col === undefined) return undefined;
	const subs: GuardClause[] = [];
	for (const v of expr.values) {
		const lit = literalValue(v);
		if (lit === undefined) return undefined;
		subs.push({ kind: 'eq-literal', column: col, value: lit });
	}
	if (subs.length === 1) return subs[0];
	return { kind: 'or-of', clauses: subs };
}

/**
 * Recognize a top-level `OR` chain as a flat `or-of`. Each disjunct must
 * itself be a recognized clause. Nested `or-of` clauses are inlined so the
 * result is single-level. A singleton (degenerate) collapses to the
 * underlying clause.
 */
function recognizeOr(
	expr: AST.BinaryExpr,
	columnIndexMap: ReadonlyMap<string, number>,
	isColumnNotNullDeclared: (col: number) => boolean,
	isColumnNumericDeclared: (col: number) => boolean,
): GuardClause | undefined {
	const disjuncts = flattenDisjunction(expr);
	if (disjuncts.length === 0) return undefined;
	const subs: GuardClause[] = [];
	for (const d of disjuncts) {
		const sub = recognizeClause(d, columnIndexMap, isColumnNotNullDeclared, isColumnNumericDeclared);
		if (!sub) return undefined;
		if (sub.kind === 'or-of') {
			for (const s of sub.clauses) subs.push(s);
		} else {
			subs.push(sub);
		}
	}
	if (subs.length === 1) return subs[0];
	return { kind: 'or-of', clauses: subs };
}
