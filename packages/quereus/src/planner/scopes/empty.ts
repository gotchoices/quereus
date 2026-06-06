import * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { type Scope, Ambiguous } from './scope.js';

/** Scope that contains no symbols.  */
export class EmptyScope implements Scope {
	resolveSymbol(_symbolKey: string, _expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		return undefined;
	}

	static readonly instance = new EmptyScope();
}
