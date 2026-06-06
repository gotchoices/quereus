import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import * as AST from '../../parser/ast.js';
import { astToString } from '../../emit/ast-stringify.js';

export interface TransactionNode extends VoidNode {
	nodeType: PlanNodeType.Transaction;
	operation: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release';
	savepoint?: string; // For ROLLBACK TO, SAVEPOINT, RELEASE
	statementAst: AST.BeginStmt | AST.CommitStmt | AST.RollbackStmt | AST.SavepointStmt | AST.ReleaseStmt;
}

export class TransactionPlanNode extends VoidNode implements TransactionNode {
	override readonly nodeType = PlanNodeType.Transaction;

	constructor(
		scope: Scope,
		public readonly operation: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release',
		public readonly statementAst: AST.BeginStmt | AST.CommitStmt | AST.RollbackStmt | AST.SavepointStmt | AST.ReleaseStmt,
		public readonly savepoint?: string
	) {
		super(scope, 1); // Transaction operations have low cost
	}

	override toString(): string {
		switch (this.operation) {
			case 'begin':
				return 'BEGIN';
			case 'commit':
				return 'COMMIT';
			case 'rollback':
				return this.savepoint ? `ROLLBACK TO ${this.savepoint}` : 'ROLLBACK';
			case 'savepoint':
				return `SAVEPOINT ${this.savepoint}`;
			case 'release':
				return `RELEASE ${this.savepoint}`;
			default:
				return `TRANSACTION ${this.operation}`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			operation: this.operation,
			statement: astToString(this.statementAst)
		};

		if (this.savepoint) {
			props.savepoint = this.savepoint;
		}

		return props;
	}
}
