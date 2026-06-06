import type { PlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';

// Create a javascript symbol that represents an ambiguous symbol.
export const Ambiguous = Symbol();

export type ReferenceCallback = (expression: AST.Expression, currentScope: Scope) => PlanNode;

/**
 * The Scope object provides context for symbol resolution during query planning.
 * It encapsulates the logic for looking up columns, parameters, functions, and CTEs
 * based on the current position in the PlanNode tree.
 */
export interface Scope {
	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined;
}
