/**
 * Plan node for the ANALYZE statement.
 * When executed, collects table statistics and caches them on TableSchema.
 */

import type * as AST from '../../parser/ast.js';
import { Attribute, type RelationalPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { PlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { TEXT_TYPE, INTEGER_TYPE } from '../../types/builtin-types.js';
import { Cached } from '../../util/cached.js';

export class AnalyzePlanNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.Analyze;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.AnalyzeStmt,
		public readonly targetTableName?: string,
		public readonly targetSchemaName?: string,
	) {
		super(scope, 1);
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: 'table',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				},
				{
					name: 'rows',
					type: {
						typeClass: 'scalar',
						logicalType: INTEGER_TYPE,
						nullable: false,
					},
					generated: true,
				},
			],
			keys: [[]],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return this.targetTableName ? 1 : 10; // 1 for single table, ~10 for all tables
	}

	private buildAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		} satisfies Attribute));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new AnalyzePlanNode(this.scope, this.statementAst, this.targetTableName, this.targetSchemaName);
	}

	override toString(): string {
		if (this.targetSchemaName && this.targetTableName) {
			return `ANALYZE ${this.targetSchemaName}.${this.targetTableName}`;
		}
		if (this.targetTableName) {
			return `ANALYZE ${this.targetTableName}`;
		}
		if (this.targetSchemaName) {
			return `ANALYZE ${this.targetSchemaName}.*`;
		}
		return 'ANALYZE';
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'analyze',
			tableName: this.targetTableName,
			schemaName: this.targetSchemaName,
		};
	}
}
