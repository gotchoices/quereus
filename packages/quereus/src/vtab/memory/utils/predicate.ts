import type { Expression } from '../../../parser/ast.js';
import type { ColumnSchema } from '../../../schema/column.js';
import type { Row, SqlValue } from '../../../common/types.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';

/**
 * Compiled partial-index predicate. Walks a Row, returning SQL three-valued
 * boolean (true, false, or null = unknown).
 *
 * Only true means the row participates in the index (matching SQLite partial-index
 * semantics: false and unknown both exclude the row).
 */
export interface CompiledPredicate {
	evaluate: (row: Row) => boolean | null;
	/** Column indices the predicate references — used by the UPDATE path to decide
	 *  whether re-checking uniqueness is necessary. */
	referencedColumns: ReadonlySet<number>;
}

type Evaluator = (row: Row) => SqlValue;

/**
 * Compile a partial-index predicate AST into a row evaluator. Supports the
 * expression forms ordinarily found in partial-index WHERE clauses: literals,
 * column references, comparison operators, AND/OR/NOT, IS [NOT] NULL, and
 * literal-only IN-lists.
 *
 * Throws QuereusError on unsupported expression forms or unknown column
 * references so failures surface at index-creation time rather than producing
 * wrong runtime answers.
 */
export function compilePredicate(
	expr: Expression,
	columns: ReadonlyArray<ColumnSchema>,
): CompiledPredicate {
	const columnIndexMap = new Map<string, number>();
	columns.forEach((col, idx) => columnIndexMap.set(col.name.toLowerCase(), idx));

	const referencedColumns = new Set<number>();
	const evaluator = compileExpression(expr, columnIndexMap, referencedColumns);

	const evaluate = (row: Row): boolean | null => {
		const v = evaluator(row);
		if (v === null) return null;
		// SQL truthiness: false / 0 / '' / 0n -> false; anything else -> true.
		if (v === false || v === 0 || v === 0n || v === '') return false;
		return true;
	};

	return { evaluate, referencedColumns };
}

function compileExpression(
	expr: Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
): Evaluator {
	switch (expr.type) {
		case 'literal': {
			const value = expr.value;
			if (value && typeof value === 'object' && 'then' in value) {
				throw new QuereusError(
					'Partial-index predicates may not contain async/promise literals',
					StatusCode.ERROR,
				);
			}
			return () => value as SqlValue;
		}
		case 'column':
		case 'identifier': {
			const ref = expr;
			if (ref.type === 'column' && ref.schema) {
				throw new QuereusError(
					`Partial-index predicate cannot reference schema-qualified column '${ref.schema}.${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			if (ref.type === 'identifier' && ref.schema) {
				throw new QuereusError(
					`Partial-index predicate cannot reference schema-qualified identifier '${ref.schema}.${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			const colIdx = columnIndexMap.get(ref.name.toLowerCase());
			if (colIdx === undefined) {
				throw new QuereusError(
					`Partial-index predicate references unknown column '${ref.name}'`,
					StatusCode.ERROR,
				);
			}
			referencedColumns.add(colIdx);
			return (row: Row) => row[colIdx];
		}
		case 'unary':
			return compileUnary(expr, columnIndexMap, referencedColumns);
		case 'binary':
			return compileBinary(expr, columnIndexMap, referencedColumns);
		case 'in':
			return compileIn(expr, columnIndexMap, referencedColumns);
		default:
			throw new QuereusError(
				`Unsupported expression in partial-index predicate: ${expr.type}`,
				StatusCode.ERROR,
			);
	}
}

function compileIn(
	expr: Extract<Expression, { type: 'in' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
): Evaluator {
	if (expr.subquery) {
		throw new QuereusError(
			'Partial-index predicate may not contain IN subqueries',
			StatusCode.ERROR,
		);
	}
	if (!expr.values || expr.values.length === 0) {
		// `col IN ()` is always false (SQLite semantics).
		return () => false;
	}
	const inputEval = compileExpression(expr.expr, columnIndexMap, referencedColumns);
	const valueEvals = expr.values.map(v => compileExpression(v, columnIndexMap, referencedColumns));
	return (row) => {
		const a = inputEval(row);
		if (a === null) return null;
		let sawNull = false;
		for (const ve of valueEvals) {
			const b = ve(row);
			if (b === null) { sawNull = true; continue; }
			if (compareSqlValues(a, b) === 0) return true;
		}
		// Three-valued IN: no match plus a NULL ⇒ unknown; otherwise false.
		return sawNull ? null : false;
	};
}

function compileUnary(
	expr: Extract<Expression, { type: 'unary' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
): Evaluator {
	const op = expr.operator.toUpperCase();
	const operand = compileExpression(expr.expr, columnIndexMap, referencedColumns);

	switch (op) {
		case 'IS NULL':
			return (row) => operand(row) === null;
		case 'IS NOT NULL':
			return (row) => operand(row) !== null;
		case 'NOT':
			return (row) => {
				const v = operand(row);
				if (v === null) return null;
				if (v === false || v === 0 || v === 0n || v === '') return true;
				return false;
			};
		case '+':
			return (row) => {
				const v = operand(row);
				if (v === null) return null;
				if (typeof v === 'number' || typeof v === 'bigint') return v;
				const n = Number(v);
				return Number.isNaN(n) ? null : n;
			};
		case '-':
			return (row) => {
				const v = operand(row);
				if (v === null) return null;
				if (typeof v === 'number') return -v;
				if (typeof v === 'bigint') return -v;
				const n = Number(v);
				return Number.isNaN(n) ? null : -n;
			};
		default:
			throw new QuereusError(
				`Unsupported unary operator in partial-index predicate: ${expr.operator}`,
				StatusCode.ERROR,
			);
	}
}

function compileBinary(
	expr: Extract<Expression, { type: 'binary' }>,
	columnIndexMap: ReadonlyMap<string, number>,
	referencedColumns: Set<number>,
): Evaluator {
	const op = expr.operator.toUpperCase();
	const left = compileExpression(expr.left, columnIndexMap, referencedColumns);
	const right = compileExpression(expr.right, columnIndexMap, referencedColumns);

	switch (op) {
		case 'AND':
			return (row) => {
				const a = left(row);
				if (a === false || a === 0 || a === 0n || a === '') return false;
				const b = right(row);
				if (b === false || b === 0 || b === 0n || b === '') return false;
				if (a === null || b === null) return null;
				return true;
			};
		case 'OR':
			return (row) => {
				const a = left(row);
				if (a !== null && a !== false && a !== 0 && a !== 0n && a !== '') return true;
				const b = right(row);
				if (b !== null && b !== false && b !== 0 && b !== 0n && b !== '') return true;
				if (a === null || b === null) return null;
				return false;
			};
		case '=':
		case '==':
			return makeCompare(left, right, (cmp) => cmp === 0);
		case '<>':
		case '!=':
			return makeCompare(left, right, (cmp) => cmp !== 0);
		case '<':
			return makeCompare(left, right, (cmp) => cmp < 0);
		case '<=':
			return makeCompare(left, right, (cmp) => cmp <= 0);
		case '>':
			return makeCompare(left, right, (cmp) => cmp > 0);
		case '>=':
			return makeCompare(left, right, (cmp) => cmp >= 0);
		case 'IS':
			// `a IS b` is total equality including NULL.
			return (row) => {
				const a = left(row);
				const b = right(row);
				if (a === null && b === null) return true;
				if (a === null || b === null) return false;
				return compareSqlValues(a, b) === 0;
			};
		case 'IS NOT':
			return (row) => {
				const a = left(row);
				const b = right(row);
				if (a === null && b === null) return false;
				if (a === null || b === null) return true;
				return compareSqlValues(a, b) !== 0;
			};
		default:
			throw new QuereusError(
				`Unsupported binary operator in partial-index predicate: ${expr.operator}`,
				StatusCode.ERROR,
			);
	}
}

function makeCompare(left: Evaluator, right: Evaluator, predicate: (cmp: number) => boolean): Evaluator {
	return (row) => {
		const a = left(row);
		const b = right(row);
		if (a === null || b === null) return null;
		return predicate(compareSqlValues(a, b));
	};
}
