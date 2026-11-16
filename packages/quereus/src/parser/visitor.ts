import { createLogger } from '../common/logger.js';
import type * as AST from './ast.js';

const log = createLogger('parser:visitor'); // Create logger instance
const warnLog = log.extend('warn');


/**
 * Defines the callbacks for the AST visitor.
 * Functions can return false to stop traversal down that branch.
 */
export interface AstVisitorCallbacks {
	enterNode?: (node: AST.AstNode) => void | boolean;
	exitNode?: (node: AST.AstNode) => void;
	// Specific node type visitors (optional)
	visitSelect?: (node: AST.SelectStmt) => void | boolean;
	visitInsert?: (node: AST.InsertStmt) => void | boolean;
	visitUpdate?: (node: AST.UpdateStmt) => void | boolean;
	visitDelete?: (node: AST.DeleteStmt) => void | boolean;
	visitValues?: (node: AST.ValuesStmt) => void | boolean;
	visitTableSource?: (node: AST.TableSource) => void | boolean;
	visitJoin?: (node: AST.JoinClause) => void | boolean;
	visitFunctionSource?: (node: AST.FunctionSource) => void | boolean;
	visitSubquerySource?: (node: AST.SubquerySource) => void | boolean;
	visitBinaryExpr?: (node: AST.BinaryExpr) => void | boolean;
	visitUnaryExpr?: (node: AST.UnaryExpr) => void | boolean;
	visitCastExpr?: (node: AST.CastExpr) => void | boolean;
	visitCollateExpr?: (node: AST.CollateExpr) => void | boolean;
	visitFunctionExpr?: (node: AST.FunctionExpr) => void | boolean;
	visitSubqueryExpr?: (node: AST.SubqueryExpr) => void | boolean;
	visitWindowFunctionExpr?: (node: AST.WindowFunctionExpr) => void | boolean;
	visitWindowDefinition?: (node: AST.WindowDefinition) => void | boolean;
	visitLiteral?: (node: AST.LiteralExpr) => void;
	visitIdentifier?: (node: AST.IdentifierExpr) => void;
	visitColumn?: (node: AST.ColumnExpr) => void;
	visitParameter?: (node: AST.ParameterExpr) => void;
}
/**
 * Performs a depth-first traversal of the AST.
 *
 * NOTE: `schema/expr-scope/walk.ts` is a second traversal over these same node
 * kinds — scope-aware, and used only by the schema-time expression analyses
 * (the CHECK self-qualifier strip and the generated-column reference
 * collector). The two are deliberately NOT unified: its FROM-frame stack has
 * no place in a generic visitor. But a change to the AST node shapes has to be
 * reflected in both. Grep either file's `NOTE:` to find the other.
 *
 * The two have the same reach: every expression-bearing field of every node
 * kind below is descended (window frame bounds, `with defaults`, and a DML's
 * `returning` / upsert / `with context` included). `../schema/manager.ts`'s
 * declaration-time gates depend on that — a subtree skipped here is a place a
 * non-deterministic call or a bind parameter hides from `CREATE TABLE`. The
 * guards: the `switch` below is exhaustive over `AstNode['type']`, so a new node
 * kind does not compile until it is classified, and `test/visitor.spec.ts` holds
 * a per-field ledger of every AST shape that owns an expression, so a new field
 * does not compile until it is classified — and every field marked descended is
 * checked at runtime to actually be reached.
 *
 * @param node The starting AST node.
 * @param callbacks An object containing visitor functions for different node types.
 */
export function traverseAst(node: AST.AstNode | undefined, callbacks: AstVisitorCallbacks): void {
	if (!node) return;

	if (callbacks.enterNode) {
		const result = callbacks.enterNode(node);
		if (result === false) return; // Stop if enterNode returns false
	}

	// Call specific visitor if defined
	const specificVisitorKey = `visit${node.type.charAt(0).toUpperCase() + node.type.slice(1)}` as keyof AstVisitorCallbacks;
	if (callbacks[specificVisitorKey]) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const specificVisitor = callbacks[specificVisitorKey] as (n: any) => void | boolean;
		const result = specificVisitor(node);
		if (result === false) return; // Stop if specific visitor returns false
	}

	// Recursively traverse children based on node type
	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			traverseCteBodies(stmt.withClause, callbacks);
			traverseResultColumns(stmt.columns, callbacks);
			// View write-through metadata — inert inside a scalar subquery, but this is a
			// generic every-node traversal and does not encode evaluation semantics.
			stmt.defaults?.forEach(d => traverseAst(d.expr, callbacks));
			(stmt.from ?? []).forEach(f => traverseAst(f, callbacks));
			traverseAst(stmt.where, callbacks);
			(stmt.groupBy ?? []).forEach(g => traverseAst(g, callbacks));
			traverseAst(stmt.having, callbacks);
			(stmt.orderBy ?? []).forEach(o => traverseAst(o.expr, callbacks));
			traverseAst(stmt.limit, callbacks);
			traverseAst(stmt.offset, callbacks);
			// The parser never sets `union` (compounds land on `compound`); descended for
			// parity with the schema scope walk and the other readers of the field.
			traverseAst(stmt.union, callbacks);
			traverseAst(stmt.compound?.select, callbacks);
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			traverseCteBodies(stmt.withClause, callbacks);
			traverseAst(stmt.table, callbacks);
			traverseAst(stmt.source, callbacks);
			stmt.upsertClauses?.forEach(u => traverseAst(u, callbacks));
			traverseDmlOutputs(stmt, callbacks);
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			traverseCteBodies(stmt.withClause, callbacks);
			traverseAst(stmt.table, callbacks);
			// Inline subquery write target (`update (select …) as v …`): the real body
			// hangs off `targetSource`; `table` is only a synthetic alias placeholder.
			traverseAst(stmt.targetSource, callbacks);
			stmt.assignments.forEach(a => traverseAst(a.value, callbacks));
			traverseAst(stmt.where, callbacks);
			traverseDmlOutputs(stmt, callbacks);
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			traverseCteBodies(stmt.withClause, callbacks);
			traverseAst(stmt.table, callbacks);
			// See `update` above — the inline subquery write target's body is on `targetSource`.
			traverseAst(stmt.targetSource, callbacks);
			traverseAst(stmt.where, callbacks);
			traverseDmlOutputs(stmt, callbacks);
			break;
		}
		case 'upsert': {
			const upsert = node as AST.UpsertClause;
			upsert.assignments?.forEach(a => traverseAst(a.value, callbacks));
			traverseAst(upsert.where, callbacks);
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => traverseAst(v, callbacks)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			traverseAst(join.left, callbacks);
			traverseAst(join.right, callbacks);
			traverseAst(join.condition, callbacks);
			break;
		}
		case 'functionSource': {
			const funcSource = node as AST.FunctionSource;
			traverseAst(funcSource.name, callbacks);
			funcSource.args.forEach(a => traverseAst(a, callbacks));
			break;
		}
		case 'subquerySource': {
			const subqSource = node as AST.SubquerySource;
			traverseAst(subqSource.subquery, callbacks);
			break;
		}
		case 'binary': {
			const expr = node as AST.BinaryExpr;
			traverseAst(expr.left, callbacks);
			traverseAst(expr.right, callbacks);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate': {
			traverseAst((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, callbacks);
			break;
		}
		case 'function': {
			const func = node as AST.FunctionExpr;
			func.args.forEach(a => traverseAst(a, callbacks));
			break;
		}
		case 'subquery': {
			const subq = node as AST.SubqueryExpr;
			traverseAst(subq.query, callbacks);
			break;
		}
		case 'windowFunction': {
			const winFunc = node as AST.WindowFunctionExpr;
			traverseAst(winFunc.function, callbacks);
			traverseAst(winFunc.window, callbacks);
			break;
		}
		case 'windowDefinition': {
			const winDef = node as AST.WindowDefinition;
			(winDef.partitionBy ?? []).forEach(p => traverseAst(p, callbacks));
			(winDef.orderBy ?? []).forEach(o => traverseAst(o.expr, callbacks));
			traverseFrameBound(winDef.frame?.start, callbacks);
			traverseFrameBound(winDef.frame?.end, callbacks);
			break;
		}
		case 'case': {
			const caseExpr = node as AST.CaseExpr;
			traverseAst(caseExpr.baseExpr, callbacks);
			caseExpr.whenThenClauses.forEach(wt => {
				traverseAst(wt.when, callbacks);
				traverseAst(wt.then, callbacks);
			});
			traverseAst(caseExpr.elseExpr, callbacks);
			break;
		}
		case 'in': {
			const inExpr = node as AST.InExpr;
			traverseAst(inExpr.expr, callbacks);
			(inExpr.values ?? []).forEach(v => traverseAst(v, callbacks));
			traverseAst(inExpr.subquery, callbacks);
			break;
		}
		case 'exists': {
			const existsExpr = node as AST.ExistsExpr;
			traverseAst(existsExpr.subquery, callbacks);
			break;
		}
		case 'between': {
			const betweenExpr = node as AST.BetweenExpr;
			traverseAst(betweenExpr.expr, callbacks);
			traverseAst(betweenExpr.lower, callbacks);
			traverseAst(betweenExpr.upper, callbacks);
			break;
		}
		// Leaf nodes — handled by specific visitors or enterNode. `table` is a FROM
		// table source, whose only child is its name.
		case 'literal':
		case 'identifier':
		case 'column':
		case 'parameter':
		case 'table':
			break;
		// Reached through their parents, never entered as nodes: the `select` / DML
		// arms descend CTE bodies directly.
		case 'with':
		case 'commonTableExpr':
			break;
		// Not node shapes at all: a window frame and its bounds do not extend `AstNode`
		// (the `windowDefinition` arm descends the bounds), and the column / table
		// constraint kinds are reachable only under `createTable`.
		case 'windowFrame':
		case 'currentRow':
		case 'unboundedPreceding':
		case 'unboundedFollowing':
		case 'preceding':
		case 'following':
		case 'primaryKey':
		case 'notNull':
		case 'null':
		case 'unique':
		case 'check':
		case 'default':
		case 'foreignKey':
		case 'generated':
			break;
		// DDL, transaction-control and schema-management statements are not descended;
		// no caller walks one.
		case 'createTable':
		case 'createIndex':
		case 'createView':
		case 'createMaterializedView':
		case 'refreshMaterializedView':
		case 'createAssertion':
		case 'alterTable':
		case 'alterView':
		case 'alterMaterializedView':
		case 'alterIndex':
		case 'drop':
		case 'begin':
		case 'commit':
		case 'rollback':
		case 'savepoint':
		case 'release':
		case 'pragma':
		case 'analyze':
		case 'declareSchema':
		case 'declareLens':
		case 'diffSchema':
		case 'applySchema':
		case 'explainSchema':
		case 'declaredTable':
		case 'declaredIndex':
		case 'declaredView':
		case 'declaredMaterializedView':
		case 'declaredSeed':
		case 'declaredAssertion':
		case 'declareIgnored':
			break;
		default: {
			// Compile-time exhaustiveness: a new `AstNode['type']` member must be
			// classified above. The warn covers a malformed node at runtime.
			const unhandled: never = node.type;
			warnLog(`AST Visitor: Unhandled node type: ${String(unhandled)}`);
			break;
		}
	}

	if (callbacks.exitNode) {
		callbacks.exitNode(node);
	}
}

/** CTE bodies of a leading `with` clause; the `with` / CTE nodes themselves are not entered. */
function traverseCteBodies(withClause: AST.WithClause | undefined, callbacks: AstVisitorCallbacks): void {
	withClause?.ctes.forEach(cte => traverseAst(cte.query, callbacks));
}

/** Result columns of a select or of a DML `returning` list, including any `with inverse (…)` clause. */
function traverseResultColumns(columns: ReadonlyArray<AST.ResultColumn> | undefined, callbacks: AstVisitorCallbacks): void {
	columns?.forEach(c => {
		if (c.type !== 'column') return;
		traverseAst(c.expr, callbacks);
		c.inverse?.forEach(inv => traverseAst(inv.expr, callbacks));
	});
}

/** The clauses every DML statement shares: `returning` and `with context`. */
function traverseDmlOutputs(stmt: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt, callbacks: AstVisitorCallbacks): void {
	traverseResultColumns(stmt.returning, callbacks);
	stmt.contextValues?.forEach(cv => traverseAst(cv.value, callbacks));
}

/** A frame bound is not an `AstNode`; only `<expr> preceding` / `<expr> following` carry an expression. */
function traverseFrameBound(bound: AST.WindowFrameBound | null | undefined, callbacks: AstVisitorCallbacks): void {
	if (bound?.type === 'preceding' || bound?.type === 'following') traverseAst(bound.value, callbacks);
}
