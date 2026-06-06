import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { astToString } from '../../emit/ast-stringify.js';

/**
 * Represents a CREATE TABLE statement in the logical query plan.
 */
export class CreateTableNode extends VoidNode {
  override readonly nodeType = PlanNodeType.CreateTable;

  constructor(
    scope: Scope,
		public readonly statementAst: AST.CreateTableStmt,
  ) {
    super(scope);
  }

  override toString(): string {
    return `CREATE TABLE ${this.statementAst.table.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      table: this.statementAst.table.name,
      schema: this.statementAst.table.schema,
      statement: astToString(this.statementAst)
    };
  }

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
