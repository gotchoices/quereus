import type { Scope } from '../scopes/scope.js';
import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type * as AST from '../../parser/ast.js';
import { expressionToString } from '../../emit/ast-stringify.js';

/**
 * Represents a DROP TABLE statement in the logical query plan.
 */
export class DropTableNode extends VoidNode {
  override readonly nodeType = PlanNodeType.DropTable;

  constructor(
    scope: Scope,
    public readonly statementAst: AST.DropStmt,
  ) {
    super(scope);
  }

  override toString(): string {
    return `DROP TABLE ${this.statementAst.name.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      table: this.statementAst.name.name,
      schema: this.statementAst.name.schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statement: expressionToString(this.statementAst as any)
    };
  }

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
