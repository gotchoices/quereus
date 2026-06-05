import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlValue } from '../../common/types.js';

/** The tagged catalog object kinds addressable by `ALTER … SET TAGS`. */
export type SetObjectTagsKind = 'view' | 'materializedView' | 'index';

/**
 * Plan node for `ALTER VIEW / MATERIALIZED VIEW / INDEX … SET TAGS` — a
 * catalog-only whole-set replacement of an object's metadata tags (empty set
 * clears). No module / data round-trip: the emitter delegates to the matching
 * SchemaManager setter, which swaps the in-memory schema object and (for
 * indexes) fires `table_modified` on the owning table.
 */
export class SetObjectTagsNode extends VoidNode {
	override readonly nodeType = PlanNodeType.SetObjectTags;

	constructor(
		scope: Scope,
		public readonly objectKind: SetObjectTagsKind,
		public readonly schemaName: string,
		public readonly name: string,
		public readonly tags: Record<string, SqlValue>,
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const verb = this.objectKind === 'materializedView' ? 'MATERIALIZED VIEW' : this.objectKind.toUpperCase();
		return `ALTER ${verb} ${this.schemaName}.${this.name} SET TAGS`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			objectKind: this.objectKind,
			schemaName: this.schemaName,
			name: this.name,
			tags: this.tags,
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
