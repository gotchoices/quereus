import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { astToString, expressionToString } from '../../emit/ast-stringify.js';

/**
 * Represents a CREATE INDEX statement in the logical query plan.
 */
export class CreateIndexNode extends VoidNode {
  override readonly nodeType = PlanNodeType.CreateIndex;

  constructor(
    scope: Scope,
    public readonly statementAst: AST.CreateIndexStmt,
  ) {
    super(scope);
  }

  override toString(): string {
    const uniquePrefix = this.statementAst.isUnique ? 'UNIQUE ' : '';
    return `CREATE ${uniquePrefix}INDEX ${this.statementAst.index.name} ON ${this.statementAst.table.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      index: this.statementAst.index.name,
      table: this.statementAst.table.name,
      schema: this.statementAst.table.schema,
      isUnique: this.statementAst.isUnique,
      ifNotExists: this.statementAst.ifNotExists,
      columns: this.statementAst.columns.map(col => col.name || expressionToString(col.expr!)),
      hasWhereClause: !!this.statementAst.where,
      statement: astToString(this.statementAst)
    };
  }

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
