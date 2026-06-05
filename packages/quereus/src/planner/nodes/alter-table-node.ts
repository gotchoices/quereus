import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties, type ScalarPlanNode, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';

/**
 * The per-row backfill of an ADD COLUMN whose DEFAULT does not fold to a literal
 * (e.g. `new.<col>`). `node` is the default compiled against the table's existing
 * columns as the "supplied" row; `rowDescriptor` maps those fresh attribute ids to
 * existing-row positions. The emitter installs a row slot over each existing row and
 * evaluates `node` to produce that row's value for the new column. A literal default
 * folds and is bulk-written by the module instead, so it carries no backfill node.
 */
export interface AddColumnBackfill {
	readonly node: ScalarPlanNode;
	readonly rowDescriptor: RowDescriptor;
}

/**
 * Discriminated union of ALTER TABLE actions handled by AlterTableNode.
 * addConstraint is handled separately by AddConstraintNode.
 */
export type AlterTableAction =
	| { type: 'renameTable'; newName: string }
	| { type: 'renameColumn'; oldName: string; newName: string }
	| { type: 'addColumn'; column: AST.ColumnDef; backfill?: AddColumnBackfill }
	| { type: 'dropColumn'; name: string }
	| { type: 'alterPrimaryKey'; columns: Array<{ name: string; direction?: 'asc' | 'desc' }> }
	| {
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: AST.Expression | null;
	}
	| {
		/**
		 * SET TAGS — catalog-only whole-set replacement of metadata tags on the
		 * table, a column, or a named table-level constraint. `tags` is the complete
		 * desired set (empty = clear). No module round-trip (see runtime emitter).
		 */
		type: 'setTags';
		target:
			| { kind: 'table' }
			| { kind: 'column'; columnName: string }
			| { kind: 'constraint'; constraintName: string };
		tags: Record<string, SqlValue>;
	};

/**
 * Plan node for ALTER TABLE operations (rename table/column, add/drop column).
 * Constraint additions are handled by the separate AddConstraintNode.
 */
export class AlterTableNode extends VoidNode {
	override readonly nodeType = PlanNodeType.AlterTable;

	constructor(
		scope: Scope,
		public readonly table: TableReferenceNode,
		public readonly action: AlterTableAction,
	) {
		super(scope);
	}

	override getRelations(): readonly [TableReferenceNode] {
		return [this.table];
	}

	override toString(): string {
		switch (this.action.type) {
			case 'renameTable':
				return `ALTER TABLE RENAME TO ${this.action.newName}`;
			case 'renameColumn':
				return `ALTER TABLE RENAME COLUMN ${this.action.oldName} TO ${this.action.newName}`;
			case 'addColumn':
				return `ALTER TABLE ADD COLUMN ${this.action.column.name}`;
			case 'dropColumn':
				return `ALTER TABLE DROP COLUMN ${this.action.name}`;
			case 'alterPrimaryKey':
				return `ALTER TABLE ALTER PRIMARY KEY (${this.action.columns.map(c => c.name).join(', ')})`;
			case 'alterColumn':
				return `ALTER TABLE ALTER COLUMN ${this.action.columnName}`;
			case 'setTags': {
				const target = this.action.target;
				if (target.kind === 'column') return `ALTER TABLE ALTER COLUMN ${target.columnName} SET TAGS`;
				if (target.kind === 'constraint') return `ALTER TABLE ALTER CONSTRAINT ${target.constraintName} SET TAGS`;
				return `ALTER TABLE SET TAGS`;
			}
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			table: this.table.tableSchema.name,
			schema: this.table.tableSchema.schemaName,
			actionType: this.action.type,
			...this.action,
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
