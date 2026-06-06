import type { PlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';
import { type Scope, Ambiguous } from './scope.js';

/**
 * Scope that tracks references.
 */
export abstract class BaseScope implements Scope {
	abstract resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined;
}
