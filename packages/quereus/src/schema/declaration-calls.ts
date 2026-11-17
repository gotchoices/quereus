import type * as AST from '../parser/ast.js';
import { traverseAst } from '../parser/visitor.js';
import { isAggregateFunctionSchema, type FunctionSchema } from './function.js';
import { resolveWindowFunction } from './window-function.js';

/** The registry lookup the gates resolve against — `SchemaManager.findFunction`. */
export type FindFunction = (name: string, nArg: number) => FunctionSchema | undefined;

/** A call in a declaration body that the write-time build is certain to refuse. */
export interface UnbuildableCall {
	node: AST.FunctionExpr;
	/** Worded as the builder words the same refusal, so both surfaces read alike. */
	reason: string;
}

/**
 * True for a node that opens its own query scope — a subquery or a nested DML
 * statement. Column references and aggregate calls beneath one belong to that
 * query, not to the row the enclosing schema expression is evaluated against.
 */
export function isQueryBoundary(node: AST.AstNode): boolean {
	return node.type === 'select' || node.type === 'subquery' || node.type === 'exists'
		|| node.type === 'insert' || node.type === 'update' || node.type === 'delete';
}

/**
 * The registry entry a plain function call binds to — exact argument count first,
 * then a variadic (`-1`) registration. Mirrors `resolveFunctionSchema` in
 * `planner/building/schema-resolution.ts`, which the write-time build uses.
 */
export function resolveCallSchema(findFunction: FindFunction, call: AST.FunctionExpr): FunctionSchema | undefined {
	return findFunction(call.name, call.args.length) ?? findFunction(call.name, -1);
}

/**
 * The first call under a CHECK / GENERATED body that the write-time build would
 * refuse no matter what row is written:
 *
 * - a plain call the registry cannot resolve by name and argument count;
 * - a window call naming no registered window function (window calls resolve
 *   against their own registry, so their inner call is not looked up as a plain one);
 * - an aggregate call outside every subquery — the body is evaluated per row, so
 *   the build refuses it there, while `(select count(*) from …)` is legitimate.
 *
 * Purely a resolution check — it walks the AST because the body's own column
 * references have no scope yet, and it never inspects table references, so a
 * subquery naming a table created later is still accepted.
 */
export function findUnbuildableCall(expr: AST.AstNode, findFunction: FindFunction): UnbuildableCall | undefined {
	let found: UnbuildableCall | undefined;
	let subqueryDepth = 0;
	const windowCalls = new Set<AST.FunctionExpr>();
	traverseAst(expr, {
		enterNode: (node: AST.AstNode) => {
			if (found) return false;
			if (node.type === 'windowFunction') {
				const call = (node as AST.WindowFunctionExpr).function;
				windowCalls.add(call);
				if (!resolveWindowFunction(call.name)) {
					found = { node: call, reason: `Unknown window function: ${call.name}` };
					return false;
				}
			} else if (node.type === 'function' && !windowCalls.has(node as AST.FunctionExpr)) {
				found = checkPlainCall(node as AST.FunctionExpr, findFunction, subqueryDepth === 0);
				if (found) return false;
			}
			if (isQueryBoundary(node)) subqueryDepth += 1;
		},
		exitNode: (node: AST.AstNode) => {
			if (isQueryBoundary(node)) subqueryDepth -= 1;
		},
	});
	return found;
}

function checkPlainCall(call: AST.FunctionExpr, findFunction: FindFunction, atRowLevel: boolean): UnbuildableCall | undefined {
	const schema = resolveCallSchema(findFunction, call);
	if (!schema) {
		return { node: call, reason: `Function not found: ${call.name}/${call.args.length}` };
	}
	if (atRowLevel && isAggregateFunctionSchema(schema)) {
		return { node: call, reason: `Aggregate function ${call.name} not allowed in this context` };
	}
	return undefined;
}
