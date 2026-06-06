import { Ambiguous } from './scope.js';
import type { PlanNode } from '../nodes/plan-node.js';
import type { Scope } from './scope.js';
import { BaseScope } from './base.js';
import type * as AST from '../../parser/ast.js';

/**
 * A scope that resolves symbols by walking through a list of scopes in order.
 *
 * This is used to model SQL shadowing between nested scopes (e.g. local SELECT output
 * aliases vs input columns vs outer scopes).
 *
 * Unlike `MultiScope`, this does not attempt to detect ambiguity across scopes; the
 * first match wins.
 */
export class ShadowScope extends BaseScope {
	constructor(
		public readonly scopes: readonly Scope[]
	) {
		super();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		for (const scope of this.scopes) {
			const result = scope.resolveSymbol(symbolKey, expression);
			if (result === Ambiguous) {
				return Ambiguous;
			}
			if (result) {
				return result;
			}
		}
		return undefined;
	}
}

