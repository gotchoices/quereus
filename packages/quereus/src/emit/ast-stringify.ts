/**
 * Functions to convert DDL AST nodes back into SQL strings.
 *
 * Round-trip policy: the emitter is round-trip-faithful by default. Every
 * semantically meaningful AST field MUST survive `parse(astToString(ast))` —
 * a field that re-parses to a different value (or vanishes) is a bug, enforced
 * structurally by `test/emit-roundtrip-property.spec.ts`. The only fields the
 * emitter is permitted to drop are non-semantic metadata (`loc`, `comments`,
 * conditionally-filled `lexeme`) and clauses that are *exactly equivalent* to a
 * documented parser default (see below); each such omission is mirrored by an
 * entry in `test/emit-roundtrip-comparator.ts` so the drop stays intentional.
 *
 * Formatting Notes:
 * - Emits lowercase SQL keywords.
 * - Quotes identifiers (table/column names) using double quotes.
 * - String literals are escaped.
 * - Omits clauses that represent the default SQLite behavior:
 *   - `ON CONFLICT ABORT`
 *   - `ASC` direction for primary keys
 *   - `VIRTUAL` storage for generated columns
 */
import type * as AST from '../parser/ast.js';
import { ConflictResolution } from '../common/constants.js';
import { KEYWORDS } from '../parser/lexer.js';
import { uint8ArrayToHex } from '../util/serialization.js';
import type { SqlValue } from '../common/types.js';

// --- Identifier Quoting Logic ---

// Basic check for valid SQL identifiers (adjust regex as needed)
const isValidIdentifier = (name: string): boolean => {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
};

/**
 * Quotes an identifier (table, column, etc.) with double quotes if necessary.
 * Quoting is needed if the identifier:
 * - Is a reserved keyword (case-insensitive).
 * - Does not match the valid identifier pattern (starts with letter/_, contains letters/numbers/_).
 */
export function quoteIdentifier(name: string): string {
	if (Object.hasOwn(KEYWORDS, name.toLowerCase()) || !isValidIdentifier(name)) {
		return `"${name.replace(/"/g, '""')}"`; // Escape internal quotes
	}
	return name;
}


// Main function to convert any AST node to SQL string
export function astToString(node: AST.AstNode): string {
	switch (node.type) {
		// Expression types
		case 'literal':
		case 'identifier':
		case 'column':
		case 'binary':
		case 'unary':
		case 'function':
		case 'cast':
		case 'parameter':
		case 'subquery':
		case 'collate':
		case 'case':
		case 'exists':
		case 'in':
		case 'between':
		case 'windowFunction':
			return expressionToString(node as AST.Expression);

		// Statement types
		case 'select':
			return selectToString(node as AST.SelectStmt);
		case 'insert':
			return insertToString(node as AST.InsertStmt);
		case 'update':
			return updateToString(node as AST.UpdateStmt);
		case 'delete':
			return deleteToString(node as AST.DeleteStmt);
		case 'values':
			return valuesToString(node as AST.ValuesStmt);
		case 'createTable':
			return createTableToString(node as AST.CreateTableStmt);
		case 'createIndex':
			return createIndexToString(node as AST.CreateIndexStmt);
		case 'createView':
			return createViewToString(node as AST.CreateViewStmt);
		case 'createMaterializedView':
			return createMaterializedViewToString(node as AST.CreateMaterializedViewStmt);
		case 'refreshMaterializedView':
			return refreshMaterializedViewToString(node as AST.RefreshMaterializedViewStmt);
		case 'createAssertion':
			return createAssertionToString(node as AST.CreateAssertionStmt);
		case 'alterTable':
			return alterTableToString(node as AST.AlterTableStmt);
		case 'analyze':
			return analyzeToString(node as AST.AnalyzeStmt);
		case 'drop':
			return dropToString(node as AST.DropStmt);
		case 'begin':
			return beginToString(node as AST.BeginStmt);
		case 'commit':
			return 'commit';
		case 'rollback':
			return rollbackToString(node as AST.RollbackStmt);
		case 'savepoint':
			return savepointToString(node as AST.SavepointStmt);
		case 'release':
			return releaseToString(node as AST.ReleaseStmt);
		case 'pragma':
			return pragmaToString(node as AST.PragmaStmt);
		case 'declareSchema':
			return declareSchemaToString(node as unknown as AST.DeclareSchemaStmt);
		case 'declareLens':
			return declareLensToString(node as unknown as AST.DeclareLensStmt);
		case 'diffSchema':
			return `diff schema ${(node as unknown as AST.DiffSchemaStmt).schemaName || 'main'}`;
		case 'applySchema': {
			const n = node as unknown as AST.ApplySchemaStmt;
			let s = `apply schema ${n.schemaName || 'main'}`;
			if (n.toVersion) s += ` to version '${n.toVersion}'`;
			if (n.withSeed) s += ' with seed';
			if (n.options) {
				s += ' options (';
				const parts: string[] = [];
				if (n.options.dryRun !== undefined) parts.push(`dry_run = ${n.options.dryRun ? 'true' : 'false'}`);
				if (n.options.validateOnly !== undefined) parts.push(`validate_only = ${n.options.validateOnly ? 'true' : 'false'}`);
				if (n.options.allowDestructive !== undefined) parts.push(`allow_destructive = ${n.options.allowDestructive ? 'true' : 'false'}`);
				if (n.options.renamePolicy) parts.push(`rename_policy = '${n.options.renamePolicy}'`);
				s += parts.join(', ') + ')';
			}
			return s;
		}
		case 'explainSchema':
			return `explain schema ${(node as unknown as AST.ExplainSchemaStmt).schemaName || 'main'}`;

		default:
			return `[${node.type}]`; // Fallback for unknown node types
	}
}

// Helper to stringify expressions (extended from original)
export function expressionToString(expr: AST.Expression): string {
	switch (expr.type) {
		case 'literal': {
			// Prefer original lexeme for numbers if available and different
			if ((typeof expr.value === 'number' || typeof expr.value === 'bigint') && expr.lexeme && expr.lexeme !== String(expr.value)) {
				return expr.lexeme;
			}
			// Prefer original lexeme for NULL if available
			if (expr.value === null) return expr.lexeme?.toLowerCase() || 'null';
			if (typeof expr.value === 'string') return `'${expr.value.replace(/'/g, "''")}'`; // Escape single quotes
			if (typeof expr.value === 'number') return expr.value.toString();
			if (expr.value instanceof Uint8Array) {
				const hex = uint8ArrayToHex(expr.value);
				return `x'${hex}'`;
			}
			// JSON objects/arrays — render as quoted JSON string
			if (typeof expr.value === 'object' && expr.value !== null) {
				const jsonStr = JSON.stringify(expr.value);
				return `'${jsonStr.replace(/'/g, "''")}'`;
			}
			return String(expr.value);
		}

		case 'identifier': {
			let identStr = quoteIdentifier(expr.name);
			if (expr.schema) {
				identStr = `${quoteIdentifier(expr.schema)}.${identStr}`;
			}
			return identStr;
		}

		case 'column': {
			let colStr = quoteIdentifier(expr.name);
			if (expr.table) {
				colStr = `${quoteIdentifier(expr.table)}.${colStr}`;
				if (expr.schema) {
					colStr = `${quoteIdentifier(expr.schema)}.${colStr}`;
				}
			}
			return colStr;
		}

		case 'binary': {
			const leftStr = needsParens(expr.left, expr.operator, 'left')
				? `(${expressionToString(expr.left)})`
				: expressionToString(expr.left);
			const rightStr = needsParens(expr.right, expr.operator, 'right')
				? `(${expressionToString(expr.right)})`
				: expressionToString(expr.right);
			return `${leftStr} ${expr.operator.toLowerCase()} ${rightStr}`;
		}

		case 'unary': {
			const exprStr = unaryBodyNeedsParens(expr)
				? `(${expressionToString(expr.expr)})`
				: expressionToString(expr.expr);
			// Handle postfix operators like IS NULL, IS NOT NULL
			if (expr.operator === 'IS NULL' || expr.operator === 'IS NOT NULL') {
				return `${exprStr} ${expr.operator.toLowerCase()}`;
			} else if (expr.operator.toUpperCase() === 'NOT') {
				return `not ${exprStr}`;
			}
			return `${expr.operator.toLowerCase()}${exprStr}`;
		}

		case 'function': {
			if (expr.name.toLowerCase() === 'count' && expr.args.length === 0) {
				return 'count(*)';
			}
			const argsStr = expr.args.map(arg => expressionToString(arg)).join(', ');
			const distinctStr = expr.distinct ? 'distinct ' : '';
			return `${expr.name.toLowerCase()}(${distinctStr}${argsStr})`;
		}

		case 'cast':
			return `cast(${expressionToString(expr.expr)} as ${expr.targetType.toLowerCase()})`;

		case 'parameter': {
			if (expr.index !== undefined) {
				return '?';
			} else if (expr.name) {
				return expr.name.startsWith(':') || expr.name.startsWith('$')
					? expr.name
					: `:${expr.name}`;
			}
			return '?';
		}

		case 'subquery':
			return `(${astToString(expr.query)})`;

		case 'exists':
			return `exists (${astToString((expr as AST.ExistsExpr).subquery)})`;

		case 'in': {
			const inExpr = expr as AST.InExpr;
			let result = expressionToString(inExpr.expr) + ' in ';
			if (inExpr.values) {
				result += `(${inExpr.values.map(expressionToString).join(', ')})`;
			} else if (inExpr.subquery) {
				result += `(${astToString(inExpr.subquery)})`;
			}
			return result;
		}

		case 'between': {
			const betweenExpr = expr as AST.BetweenExpr;
			const exprStr = expressionToString(betweenExpr.expr);
			const lowerStr = expressionToString(betweenExpr.lower);
			const upperStr = expressionToString(betweenExpr.upper);
			const notStr = betweenExpr.not ? 'not ' : '';
			return `${exprStr} ${notStr}between ${lowerStr} and ${upperStr}`;
		}

		case 'collate':
			return `${expressionToString(expr.expr)} collate ${expr.collation.toLowerCase()}`;

		case 'case': {
			// TODO: preserve and emit with original case
			let caseStr = 'case';
			if (expr.baseExpr) {
				caseStr += ` ${expressionToString(expr.baseExpr)}`;
			}
			for (const clause of expr.whenThenClauses) {
				caseStr += ` when ${expressionToString(clause.when)} then ${expressionToString(clause.then)}`;
			}
			if (expr.elseExpr) {
				caseStr += ` else ${expressionToString(expr.elseExpr)}`;
			}
			caseStr += ' end';
			return caseStr;
		}

		case 'windowFunction': {
			let winStr = expressionToString(expr.function);
			if (expr.window) {
				winStr += ` over (${windowDefinitionToString(expr.window)})`;
			}
			return winStr;
		}

		default:
			return '[unknown_expr]';
	}
}

// Determines whether the body of a unary expression must be parenthesised so
// the emitted SQL re-parses to the same AST. With prefix NOT bound above all
// predicates (IS [NOT] NULL, IN, BETWEEN, LIKE, comparison), most inner shapes
// round-trip cleanly without parens — only a `binary` body could re-associate
// (e.g. `not a and b` would be read as `(not a) and b`).
function unaryBodyNeedsParens(expr: AST.UnaryExpr): boolean {
	return expr.expr.type === 'binary';
}

// Helper to determine if parentheses are needed for binary operations
function needsParens(expr: AST.Expression, parentOp: string, side: 'left' | 'right'): boolean {
	if (expr.type !== 'binary') return false;

	const precedence: Record<string, number> = {
		'OR': 1, 'XOR': 1,
		'AND': 2,
		'=': 3, '==': 3, '!=': 3,
		'<': 4, '<=': 4, '>': 4, '>=': 4, 'LIKE': 4, 'GLOB': 4, 'MATCH': 4, 'REGEXP': 4,
		'+': 5, '-': 5,
		'*': 6, '/': 6, '%': 6,
		'||': 7,
	};

	const parentPrec = precedence[parentOp.toUpperCase()] || 0;
	const childPrec = precedence[expr.operator.toUpperCase()] || 0;

	if (childPrec < parentPrec) return true;
	if (childPrec === parentPrec && side === 'right' && !isAssociative(parentOp)) return true;

	return false;
}

function isAssociative(op: string): boolean {
	const associativeOps = ['AND', 'OR', 'XOR', '+', '*', '||'];
	return associativeOps.includes(op.toUpperCase());
}

// Helper for window definitions
function windowDefinitionToString(win: AST.WindowDefinition): string {
	const parts: string[] = [];

	if (win.partitionBy && win.partitionBy.length > 0) {
		parts.push(`partition by ${win.partitionBy.map(expressionToString).join(', ')}`);
	}

	if (win.orderBy && win.orderBy.length > 0) {
		const orderParts = win.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls.toLowerCase()}`;
			return orderStr;
		});
		parts.push(`order by ${orderParts.join(', ')}`);
	}

	if (win.frame) {
		parts.push(windowFrameToString(win.frame));
	}

	return parts.join(' ');
}

function windowFrameToString(frame: AST.WindowFrame): string {
	let frameStr = frame.type.toLowerCase(); // 'rows' or 'range'

	if (frame.end) {
		frameStr += ` between ${windowFrameBoundToString(frame.start)} and ${windowFrameBoundToString(frame.end)}`;
	} else {
		frameStr += ` ${windowFrameBoundToString(frame.start)}`;
	}

	if (frame.exclusion) {
		frameStr += ` exclude ${frame.exclusion.toLowerCase()}`;
	}

	return frameStr;
}

function windowFrameBoundToString(bound: AST.WindowFrameBound): string {
	switch (bound.type) {
		case 'currentRow': return 'current row';
		case 'unboundedPreceding': return 'unbounded preceding';
		case 'unboundedFollowing': return 'unbounded following';
		case 'preceding': return `${expressionToString(bound.value)} preceding`;
		case 'following': return `${expressionToString(bound.value)} following`;
		default: return '[unknown_bound]';
	}
}

// Statement stringify functions
export function selectToString(stmt: AST.SelectStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('select');

	if (stmt.distinct) parts.push('distinct');
	if (stmt.all) parts.push('all');

	const columns = stmt.columns.map(col => {
		if (col.type === 'all') {
			return col.table ? `${quoteIdentifier(col.table)}.*` : '*';
		} else {
			let colStr = expressionToString(col.expr);
			if (col.alias) colStr += ` as ${quoteIdentifier(col.alias)}`;
			return colStr;
		}
	});
	parts.push(columns.join(', '));

	if (stmt.from && stmt.from.length > 0) {
		parts.push('from', stmt.from.map(fromClauseToString).join(', '));
	}

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.groupBy && stmt.groupBy.length > 0) {
		parts.push('group by', stmt.groupBy.map(expressionToString).join(', '));
	}

	if (stmt.having) {
		parts.push('having', expressionToString(stmt.having));
	}

	if (stmt.orderBy && stmt.orderBy.length > 0) {
		const orderParts = stmt.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls.toLowerCase()}`;
			return orderStr;
		});
		parts.push('order by', orderParts.join(', '));
	}

	if (stmt.limit) {
		parts.push('limit', expressionToString(stmt.limit));
	}

	if (stmt.offset) {
		parts.push('offset', expressionToString(stmt.offset));
	}

	let result = parts.join(' ');

	if (stmt.compound) {
		result += ` ${compoundOpToKeyword(stmt.compound.op)} `;
		// Compound leg is a QueryExpr; astToString dispatches on the discriminator.
		result += astToString(stmt.compound.select);
	}

	return result;
}

function compoundOpToKeyword(op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'): string {
	switch (op) {
		case 'union': return 'union';
		case 'unionAll': return 'union all';
		case 'intersect': return 'intersect';
		case 'except': return 'except';
		case 'diff': return 'diff';
	}
}

function materializationHintToKeyword(hint: AST.CommonTableExpr['materializationHint']): string | undefined {
	switch (hint) {
		case 'materialized': return 'materialized';
		case 'not_materialized': return 'not materialized';
		case undefined: return undefined;
	}
}

function withClauseToString(withClause: AST.WithClause): string {
	let result = 'with';
	if (withClause.recursive) result += ' recursive';

	const ctes = withClause.ctes.map(cte => {
		let cteStr = quoteIdentifier(cte.name);
		if (cte.columns && cte.columns.length > 0) {
			cteStr += ` (${cte.columns.map(quoteIdentifier).join(', ')})`;
		}
		cteStr += ' as';
		const hint = materializationHintToKeyword(cte.materializationHint);
		if (hint) cteStr += ` ${hint}`;
		cteStr += ` (${astToString(cte.query)})`;
		return cteStr;
	});

	result += ` ${ctes.join(', ')}`;

	// Add OPTION clause if present
	if (withClause.options?.maxRecursion !== undefined) {
		result += ` option (maxrecursion ${withClause.options.maxRecursion})`;
	}

	return result;
}

function fromClauseToString(from: AST.FromClause): string {
	switch (from.type) {
		case 'table': {
			let tableStr = quoteIdentifier(from.table.name);
			if (from.table.schema) {
				tableStr = `${quoteIdentifier(from.table.schema)}.${tableStr}`;
			}
			if (from.alias) tableStr += ` as ${quoteIdentifier(from.alias)}`;
			return tableStr;
		}

		case 'subquerySource': {
			// QueryExpr body: SELECT / VALUES / INSERT|UPDATE|DELETE w/ RETURNING.
			// astToString dispatches on the inner discriminator.
			const subqueryStr = astToString(from.subquery);

			let aliasStr = `as ${quoteIdentifier(from.alias)}`;
			if (from.columns && from.columns.length > 0) {
				aliasStr += ` (${from.columns.map(quoteIdentifier).join(', ')})`;
			}

			return `(${subqueryStr}) ${aliasStr}`;
		}

		case 'functionSource': {
			const args = from.args.map(expressionToString).join(', ');
			// Check if from.name is a function expression or identifier expression
			let funcName: string;
			if (from.name.type === 'identifier') {
				funcName = from.name.name.toLowerCase();
			} else if (from.name.type === 'function') {
				funcName = expressionToString(from.name);
			} else {
				funcName = expressionToString(from.name);
			}
			let funcStr = `${funcName}(${args})`;
			if (from.alias) funcStr += ` as ${quoteIdentifier(from.alias)}`;
			return funcStr;
		}

		case 'join': {
			const leftStr = fromClauseToString(from.left);
			const rightStr = fromClauseToString(from.right);
			// Preserve LATERAL so a correlated right side (e.g. a lateral TVF
			// `cross join lateral json_each(t.arr)`) round-trips — without it the
			// re-parsed body cannot resolve the correlation and fails to plan.
			const lateralStr = from.isLateral ? 'lateral ' : '';
			let joinStr = `${leftStr} ${from.joinType.toLowerCase()} join ${lateralStr}${rightStr}`;
			if (from.condition) {
				joinStr += ` on ${expressionToString(from.condition)}`;
			} else if (from.columns) {
				joinStr += ` using (${from.columns.map(quoteIdentifier).join(', ')})`;
			}
			return joinStr;
		}

		default:
			return '[unknown_from]';
	}
}

export function insertToString(stmt: AST.InsertStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('insert');
	if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
		parts.push('or', ConflictResolution[stmt.onConflict].toLowerCase());
	}
	parts.push('into', expressionToString(stmt.table));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	// Body is a QueryExpr — bare SELECT/VALUES at top-level of INSERT, or a
	// nested DML form (must carry RETURNING; outer INSERT is the consumer).
	// astToString dispatches on the discriminator.
	parts.push(astToString(stmt.source));

	// UPSERT clauses (ON CONFLICT DO ...)
	if (stmt.upsertClauses) {
		for (const upsert of stmt.upsertClauses) {
			parts.push(upsertClauseToString(upsert));
		}
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifier(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifier(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

/**
 * Convert an UPSERT clause to string.
 */
function upsertClauseToString(upsert: AST.UpsertClause): string {
	const parts: string[] = ['on conflict'];

	if (upsert.conflictTarget && upsert.conflictTarget.length > 0) {
		parts.push(`(${upsert.conflictTarget.map(quoteIdentifier).join(', ')})`);
	}

	if (upsert.action === 'nothing') {
		parts.push('do nothing');
	} else {
		parts.push('do update set');
		if (upsert.assignments) {
			const assigns = upsert.assignments.map(a =>
				`${quoteIdentifier(a.column)} = ${expressionToString(a.value)}`
			);
			parts.push(assigns.join(', '));
		}
		if (upsert.where) {
			parts.push('where', expressionToString(upsert.where));
		}
	}

	return parts.join(' ');
}

export function updateToString(stmt: AST.UpdateStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('update', expressionToString(stmt.table));
	// Synthesised internal correlation name (view-mutation single-source lowering) —
	// render it for plan/debug round-trip fidelity.
	if (stmt.alias) parts.push('as', quoteIdentifier(stmt.alias));

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	parts.push('set');

	const assignments = stmt.assignments.map(assign =>
		`${quoteIdentifier(assign.column)} = ${expressionToString(assign.value)}`
	);
	parts.push(assignments.join(', '));

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifier(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifier(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

export function deleteToString(stmt: AST.DeleteStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('delete from', expressionToString(stmt.table));
	// Synthesised internal correlation name (view-mutation single-source lowering) —
	// render it for plan/debug round-trip fidelity.
	if (stmt.alias) parts.push('as', quoteIdentifier(stmt.alias));

	if (stmt.contextValues && stmt.contextValues.length > 0) {
		const contextAssignments = stmt.contextValues.map(assign =>
			`${quoteIdentifier(assign.name)} = ${expressionToString(assign.value)}`
		);
		parts.push('with context', contextAssignments.join(', '));
	}

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.tags) {
		const tagsClause = tagsClauseToString(stmt.tags).trimStart();
		if (tagsClause) parts.push(tagsClause);
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifier(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifier(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

export function valuesToString(stmt: AST.ValuesStmt): string {
	const valueRows = stmt.values.map(row =>
		`(${row.map(expressionToString).join(', ')})`
	);
	return `values ${valueRows.join(', ')}`;
}

function indexedColumnsToString(cols: readonly AST.IndexedColumn[]): string {
	return cols.map(col => {
		if (col.name) {
			let colStr = quoteIdentifier(col.name);
			if (col.collation) colStr += ` collate ${col.collation.toLowerCase()}`;
			if (col.direction === 'desc') colStr += ' desc';
			return colStr;
		} else if (col.expr) {
			return expressionToString(col.expr);
		}
		return '';
	}).filter(s => s).join(', ');
}

export function createIndexToString(stmt: AST.CreateIndexStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.index), 'on', expressionToString(stmt.table));
	parts.push(`(${indexedColumnsToString(stmt.columns)})`);

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	const indexTagStr = tagsClauseToString(stmt.tags);
	if (indexTagStr) parts.push(indexTagStr.trimStart());

	return parts.join(' ');
}

export function createViewToString(stmt: AST.CreateViewStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isTemporary) parts.push('temp');
	parts.push('view');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.view));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	// View body is a QueryExpr — astToString dispatches on the discriminator.
	parts.push('as', astToString(stmt.select));

	const viewTagStr = tagsClauseToString(stmt.tags);
	if (viewTagStr) parts.push(viewTagStr.trimStart());

	return parts.join(' ');
}

export function createMaterializedViewToString(stmt: AST.CreateMaterializedViewStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isTemporary) parts.push('temp');
	parts.push('materialized', 'view');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.view));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	const usingClause = mvModuleClauseToString(stmt);
	if (usingClause) parts.push(usingClause);

	parts.push('as', astToString(stmt.select));

	const viewTagStr = tagsClauseToString(stmt.tags);
	if (viewTagStr) parts.push(viewTagStr.trimStart());

	return parts.join(' ');
}

/** `using <module>(args)` clause for a materialized view, or '' when absent. */
function mvModuleClauseToString(stmt: AST.CreateMaterializedViewStmt): string {
	if (!stmt.moduleName) return '';
	let s = `using ${stmt.moduleName}`;
	if (stmt.moduleArgs && Object.keys(stmt.moduleArgs).length > 0) {
		const args = Object.entries(stmt.moduleArgs).map(([k, v]) =>
			`${quoteIdentifier(k)} = ${JSON.stringify(v)}`
		);
		s += ` (${args.join(', ')})`;
	}
	return s;
}

export function refreshMaterializedViewToString(stmt: AST.RefreshMaterializedViewStmt): string {
	return `refresh materialized view ${expressionToString(stmt.name)}`;
}

export function createAssertionToString(stmt: AST.CreateAssertionStmt): string {
	return `create assertion ${quoteIdentifier(stmt.name)} check (${expressionToString(stmt.check)})`;
}

function alterTableToString(stmt: AST.AlterTableStmt): string {
	const table = expressionToString(stmt.table);
	switch (stmt.action.type) {
		case 'renameTable':
			return `alter table ${table} rename to ${quoteIdentifier(stmt.action.newName)}`;
		case 'renameColumn':
			return `alter table ${table} rename column ${quoteIdentifier(stmt.action.oldName)} to ${quoteIdentifier(stmt.action.newName)}`;
		case 'addColumn':
			return `alter table ${table} add column ${columnDefToString(stmt.action.column)}`;
		case 'dropColumn':
			return `alter table ${table} drop column ${quoteIdentifier(stmt.action.name)}`;
		case 'addConstraint':
			return `alter table ${table} add ${tableConstraintsToString([stmt.action.constraint])}`;
		case 'alterPrimaryKey': {
			const cols = stmt.action.columns
				.map(c => {
					let s = quoteIdentifier(c.name);
					if (c.direction === 'desc') s += ' desc';
					return s;
				})
				.join(', ');
			return `alter table ${table} alter primary key (${cols})`;
		}
		case 'alterColumn': {
			const colName = quoteIdentifier(stmt.action.columnName);
			const a = stmt.action;
			if (a.setDataType !== undefined) {
				return `alter table ${table} alter column ${colName} set data type ${a.setDataType}`;
			}
			if (a.setDefault !== undefined) {
				return a.setDefault === null
					? `alter table ${table} alter column ${colName} drop default`
					: `alter table ${table} alter column ${colName} set default ${expressionToString(a.setDefault)}`;
			}
			if (a.setNotNull !== undefined) {
				return a.setNotNull
					? `alter table ${table} alter column ${colName} set not null`
					: `alter table ${table} alter column ${colName} drop not null`;
			}
			return `alter table ${table} alter column ${colName}`;
		}
	}
}

function analyzeToString(stmt: AST.AnalyzeStmt): string {
	if (stmt.schemaName && stmt.tableName) return `analyze ${quoteIdentifier(stmt.schemaName)}.${quoteIdentifier(stmt.tableName)}`;
	if (stmt.tableName) return `analyze ${quoteIdentifier(stmt.tableName)}`;
	if (stmt.schemaName) return `analyze ${quoteIdentifier(stmt.schemaName)}.*`;
	return 'analyze';
}

function dropToString(stmt: AST.DropStmt): string {
	const objectKeyword = stmt.objectType === 'materializedView' ? 'materialized view' : stmt.objectType.toLowerCase();
	const parts: string[] = ['drop', objectKeyword];
	if (stmt.ifExists) parts.push('if exists');
	parts.push(expressionToString(stmt.name));
	return parts.join(' ');
}

function beginToString(_stmt: AST.BeginStmt): string {
	return 'begin transaction';
}

function rollbackToString(stmt: AST.RollbackStmt): string {
	let result = 'rollback';
	if (stmt.savepoint) {
		result += ` to ${stmt.savepoint}`;
	}
	return result;
}

function savepointToString(stmt: AST.SavepointStmt): string {
	return `savepoint ${stmt.name}`;
}

function releaseToString(stmt: AST.ReleaseStmt): string {
	let result = 'release';
	if (stmt.savepoint) {
		result += ` ${stmt.savepoint}`;
	}
	return result;
}

function pragmaToString(stmt: AST.PragmaStmt): string {
	let result = `pragma ${quoteIdentifier(stmt.name.toLowerCase())}`;
	if (stmt.value) {
		result += ` = ${expressionToString(stmt.value)}`;
	}
	return result;
}

function declareSchemaToString(stmt: AST.DeclareSchemaStmt): string {
	let s = `declare ${stmt.isLogical ? 'logical ' : ''}schema ${quoteIdentifier(stmt.schemaName || 'main')}`;
	if (stmt.version) s += ` version '${stmt.version}'`;
	if (stmt.using && (stmt.using.defaultVtabModule || stmt.using.defaultVtabArgs)) {
		const opts: string[] = [];
		if (stmt.using.defaultVtabModule) opts.push(`default_vtab_module = '${stmt.using.defaultVtabModule}'`);
		if (stmt.using.defaultVtabArgs) opts.push(`default_vtab_args = '${stmt.using.defaultVtabArgs}'`);
		s += ` using (${opts.join(', ')})`;
	}
	s += ' {';
	for (const it of stmt.items) {
		s += ' ' + declareItemToString(it) + ';';
	}
	s += ' }';
	return s;
}

function declareLensToString(stmt: AST.DeclareLensStmt): string {
	let s = `declare lens for ${quoteIdentifier(stmt.logicalSchema)} over ${quoteIdentifier(stmt.basisSchema)} {`;
	for (const ov of stmt.overrides) {
		s += ` view ${quoteIdentifier(ov.table)} as ${selectToString(ov.select)}`;
		if (ov.hiding && ov.hiding.length > 0) {
			s += ` hiding (${ov.hiding.map(quoteIdentifier).join(', ')})`;
		}
		s += ';';
	}
	s += ' }';
	return s;
}

function declareItemToString(it: AST.DeclareItem): string {
	switch (it.type) {
		case 'declaredTable': return declaredTableToString(it);
		case 'declaredIndex': return declaredIndexToString(it);
		case 'declaredView': return declaredViewToString(it);
		case 'declaredMaterializedView': return declaredMaterializedViewToString(it);
		case 'declaredSeed': return declaredSeedToString(it);
		case 'declaredAssertion': return declaredAssertionToString(it);
		case 'declareIgnored': return it.text || '-- ignored';
	}
}

function declaredTableToString(it: AST.DeclaredTable): string {
	const stmt = it.tableStmt;
	const parts: string[] = ['table', quoteIdentifier(stmt.table.name)];

	const using = moduleClauseToString(stmt);
	if (using) parts.push(using);

	parts.push(tableBodyDefsToString(stmt));

	const ctx = contextClauseToString(stmt);
	if (ctx) parts.push(ctx);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredIndexToString(it: AST.DeclaredIndex): string {
	const stmt = it.indexStmt;
	const parts: string[] = [];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index', quoteIdentifier(stmt.index.name));
	parts.push('on', quoteIdentifier(stmt.table.name));
	parts.push(`(${indexedColumnsToString(stmt.columns)})`);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredViewToString(it: AST.DeclaredView): string {
	const stmt = it.viewStmt;
	const parts: string[] = ['view', quoteIdentifier(stmt.view.name)];
	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}
	// View body is a QueryExpr — astToString dispatches on the discriminator.
	parts.push('as', astToString(stmt.select));

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredMaterializedViewToString(it: AST.DeclaredMaterializedView): string {
	const stmt = it.viewStmt;
	const parts: string[] = ['materialized', 'view', quoteIdentifier(stmt.view.name)];
	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifier).join(', ')})`);
	}

	const usingClause = mvModuleClauseToString(stmt);
	if (usingClause) parts.push(usingClause);

	parts.push('as', astToString(stmt.select));

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}

function declaredSeedToString(it: AST.DeclaredSeed): string {
	let s = `seed ${quoteIdentifier(it.tableName)}`;
	if (it.columns && it.columns.length > 0) {
		s += ` values (${it.columns.map(quoteIdentifier).join(', ')}) values`;
	}
	const rows = it.seedData?.map(r =>
		`(${r.map(sqlValueToSqlLiteral).join(', ')})`
	).join(', ') ?? '';
	s += ` (${rows})`;
	return s;
}

function declaredAssertionToString(it: AST.DeclaredAssertion): string {
	return `assertion ${quoteIdentifier(it.assertionStmt.name)} check (${expressionToString(it.assertionStmt.check)})`;
}

/** Renders an SqlValue as a SQL literal that re-parses to the same value. */
function sqlValueToSqlLiteral(value: SqlValue): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === 'number') return String(value);
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return `x'${uint8ArrayToHex(value)}'`;
	// JSON object/array — emit as a quoted JSON string (parser will see a STRING literal)
	if (typeof value === 'object') {
		const json = JSON.stringify(value);
		return `'${json.replace(/'/g, "''")}'`;
	}
	return String(value);
}

// Helper to stringify conflict clauses
function conflictToString(res: ConflictResolution | undefined): string {
	// ABORT is the default, so don't emit it
	if (!res || res === ConflictResolution.ABORT) return '';
	// Assuming ConflictResolution enum values are uppercase, convert them to lowercase
	return ` on conflict ${ConflictResolution[res].toLowerCase()}`;
}

// Helper to stringify column constraints
function columnConstraintsToString(constraints: AST.ColumnConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifier(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				s += 'primary key';
				// ASC is default, only specify DESC
				if (c.direction === 'desc') s += ` desc`;
				s += conflictToString(c.onConflict);
				break;
			case 'notNull':
				s += 'not null';
				s += conflictToString(c.onConflict);
				break;
			case 'null':
				s += 'null';
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += 'unique';
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += 'check';
				if (c.operations && c.operations.length > 0) {
					s += ` on ${c.operations.join(', ')}`;
				}
				s += ` (${expressionToString(c.expr!)})`;
				s += conflictToString(c.onConflict);
				break;
			case 'default':
				s += `default ${expressionToString(c.expr!)}`;
				break;
			case 'collate':
				s += `collate ${c.collation!.toLowerCase()}`;
				break;
			case 'foreignKey':
				if (c.foreignKey) {
					s += foreignKeyClauseTail(c.foreignKey);
				}
				break;
			case 'generated':
				s += `generated always as (${expressionToString(c.generated!.expr)})`;
				// VIRTUAL is default, only specify STORED
				if (c.generated!.stored) s += ' stored';
				break;
		}
		s += tagsClauseToString(c.tags);
		return s;
	}).filter(s => s.length > 0).join(' ');
}

// Helper to stringify table constraints
function tableConstraintsToString(constraints: AST.TableConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifier(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				// ASC is default, only specify DESC
				s += `primary key (${c.columns!.map(col => `${quoteIdentifier(col.name)}${col.direction === 'desc' ? ' desc' : ''}`).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += `unique (${c.columns!.map(col => quoteIdentifier(col.name)).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += 'check';
				if (c.operations && c.operations.length > 0) {
					s += ` on ${c.operations.join(', ')}`;
				}
				s += ` (${expressionToString(c.expr!)})`;
				s += conflictToString(c.onConflict);
				break;
			case 'foreignKey':
				if (c.foreignKey) {
					s += `foreign key (${c.columns!.map(col => quoteIdentifier(col.name)).join(', ')}) `;
					s += foreignKeyClauseTail(c.foreignKey);
				}
				break;
		}
		s += tagsClauseToString(c.tags);
		return s;
	}).filter(s => s.length > 0).join(', ');
}

function foreignKeyActionToString(action: AST.ForeignKeyAction): string {
	switch (action) {
		case 'setNull': return 'set null';
		case 'setDefault': return 'set default';
		case 'cascade': return 'cascade';
		case 'restrict': return 'restrict';
	}
}

/** Emits `references TBL(cols) [on delete …] [on update …] [[not] deferrable [initially …]]`. */
function foreignKeyClauseTail(fk: AST.ForeignKeyClause): string {
	let s = `references ${quoteIdentifier(fk.table)}`;
	if (fk.columns && fk.columns.length > 0) {
		s += `(${fk.columns.map(quoteIdentifier).join(', ')})`;
	}
	if (fk.onDelete) s += ` on delete ${foreignKeyActionToString(fk.onDelete)}`;
	if (fk.onUpdate) s += ` on update ${foreignKeyActionToString(fk.onUpdate)}`;
	if (fk.deferrable !== undefined) {
		s += fk.deferrable ? ' deferrable' : ' not deferrable';
		if (fk.initiallyDeferred !== undefined) {
			s += fk.initiallyDeferred ? ' initially deferred' : ' initially immediate';
		}
	}
	return s;
}

/** Formats a tag value as a SQL literal */
function tagValueToString(value: SqlValue): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	return String(value);
}

/** Formats a tags record as a WITH TAGS (...) clause */
function tagsClauseToString(tags: Record<string, SqlValue> | undefined): string {
	if (!tags || Object.keys(tags).length === 0) return '';
	const entries = Object.entries(tags)
		.map(([key, value]) => `${quoteIdentifier(key)} = ${tagValueToString(value)}`)
		.join(', ');
	return ` with tags (${entries})`;
}

export function columnDefToString(col: AST.ColumnDef): string {
	let colDef = quoteIdentifier(col.name);
	if (col.dataType) colDef += ` ${col.dataType}`;
	const constraints = columnConstraintsToString(col.constraints);
	if (constraints) colDef += ` ${constraints}`;
	colDef += tagsClauseToString(col.tags);
	return colDef;
}

function tableBodyDefsToString(stmt: AST.CreateTableStmt): string {
	const definitions: string[] = stmt.columns.map(columnDefToString);
	const tableConstraints = tableConstraintsToString(stmt.constraints);
	if (tableConstraints) definitions.push(tableConstraints);
	return `(${definitions.join(', ')})`;
}

function moduleClauseToString(stmt: AST.CreateTableStmt): string {
	if (!stmt.moduleName) return '';
	let s = `using ${stmt.moduleName}`;
	if (stmt.moduleArgs && Object.keys(stmt.moduleArgs).length > 0) {
		const args = Object.entries(stmt.moduleArgs).map(([key, value]) =>
			`${quoteIdentifier(key)} = ${JSON.stringify(value)}`
		).join(', ');
		s += ` (${args})`;
	}
	return s;
}

function contextClauseToString(stmt: AST.CreateTableStmt): string {
	if (!stmt.contextDefinitions || stmt.contextDefinitions.length === 0) return '';
	const contextVars = stmt.contextDefinitions.map(varDef => {
		let def = quoteIdentifier(varDef.name);
		if (varDef.dataType) def += ` ${varDef.dataType}`;
		if (varDef.notNull === false) def += ' NULL';
		return def;
	}).join(', ');
	return `with context (${contextVars})`;
}

export function createTableToString(stmt: AST.CreateTableStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isTemporary) parts.push('temp');
	parts.push('table');
	if (stmt.ifNotExists) parts.push('if not exists');
	// Handle schema.table quoting
	const tableName = quoteIdentifier(stmt.table.name);
	const schemaName = stmt.table.schema ? quoteIdentifier(stmt.table.schema) : undefined;
	parts.push(schemaName ? `${schemaName}.${tableName}` : tableName);

	parts.push(tableBodyDefsToString(stmt));

	const using = moduleClauseToString(stmt);
	if (using) parts.push(using);

	const ctx = contextClauseToString(stmt);
	if (ctx) parts.push(ctx);

	const tagStr = tagsClauseToString(stmt.tags);
	if (tagStr) parts.push(tagStr.trimStart());

	return parts.join(' ');
}
