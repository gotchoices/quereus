import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Plan node for DROP INDEX statements.
 * Removes a secondary index from its owning table.
 */
export class DropIndexNode extends VoidNode {
	readonly nodeType = PlanNodeType.DropIndex;

	constructor(
		scope: Scope,
		public readonly indexName: string,
		public readonly schemaName: string,
		public readonly ifExists: boolean
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const ifExistsClause = this.ifExists ? 'IF EXISTS ' : '';
		return `DROP INDEX ${ifExistsClause}${this.schemaName}.${this.indexName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			indexName: this.indexName,
			schemaName: this.schemaName,
			ifExists: this.ifExists
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
