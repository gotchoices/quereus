import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';

/**
 * Plan node for DROP VIEW statements.
 * Removes a view definition from the schema.
 */
export class DropViewNode extends VoidNode {
	readonly nodeType = PlanNodeType.DropView;

	constructor(
		scope: Scope,
		public readonly viewName: string,
		public readonly schemaName: string,
		public readonly ifExists: boolean
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const ifExistsClause = this.ifExists ? 'IF EXISTS ' : '';
		return `DROP VIEW ${ifExistsClause}${this.schemaName}.${this.viewName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			viewName: this.viewName,
			schemaName: this.schemaName,
			ifExists: this.ifExists
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
