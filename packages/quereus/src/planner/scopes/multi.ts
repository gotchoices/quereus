import { Ambiguous } from "./scope.js";
import * as AST from "../../parser/ast.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { PlanNode } from "../nodes/plan-node.js";
import type { Scope } from "./scope.js";
import { BaseScope } from "./base.js";

/**
 * A Scope that contains multiple other scopes.
 *
 * This is used for combining peer scopes (e.g. JOIN left + right) where an
 * unqualified reference that exists in more than one peer is ambiguous.
 */
export class MultiScope extends BaseScope {
	constructor(
		public readonly scopes: Scope[]
	) {
		super();
	}

	registerSymbol(_symbolKey: string, _getReference: (expression: AST.Expression, currentScope: Scope) => PlanNode): void {
		throw new QuereusError('MultiScope does not support registering symbols.', StatusCode.ERROR);
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		const isQualified = symbolKey.includes('.');
		const isParameter = symbolKey === '?' || symbolKey.startsWith(':');
		const isFunction = symbolKey.includes('/');

		// For qualified names and non-column symbols, use first-match semantics.
		//
		// This avoids incorrectly treating shared outer-scope symbols (like parameters)
		// as ambiguous, and avoids double-resolving stateful symbols (like '?' params).
		if (isQualified || isParameter || isFunction) {
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

		// For unqualified column names across peer scopes, detect ambiguity.
		let found: PlanNode | undefined;
		for (const scope of this.scopes) {
			const result = scope.resolveSymbol(symbolKey, expression);
			if (result === Ambiguous) {
				return Ambiguous;
			}
			if (!result) {
				continue;
			}
			if (!found) {
				found = result;
				continue;
			}
			return Ambiguous;
		}
		return found;
	}
}

