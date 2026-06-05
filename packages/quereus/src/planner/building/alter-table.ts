import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { AddConstraintNode } from '../nodes/add-constraint-node.js';
import { AlterTableNode, type AddColumnBackfill } from '../nodes/alter-table-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { PlanNode, type VoidNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildRowDefaultScope } from './default-scope.js';
import { validateDeterministicDefault } from '../validation/determinism-validator.js';
import { tryFoldLiteral } from '../../parser/utils.js';
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

export function buildAlterTableStmt(
  ctx: PlanningContext,
  stmt: AST.AlterTableStmt,
): VoidNode {
  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, ctx);
  const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  switch (stmt.action.type) {
    case 'addConstraint': {
      // Convert RowOp[] (e.g., ['insert','update']) to bitmask understood by runtime.
      const operations = stmt.action.constraint.operations ?? ['insert','update'];

      const constraintWithBitmask = {
        ...stmt.action.constraint,
        operations
      };

      return new AddConstraintNode(
        ctx.scope,
        tableReference,
        constraintWithBitmask
      );
		}

    case 'renameTable':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameTable',
        newName: stmt.action.newName,
      });

    case 'renameColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameColumn',
        oldName: stmt.action.oldName,
        newName: stmt.action.newName,
      });

    case 'addColumn': {
      const column = stmt.action.column;
      // Validate the DEFAULT through the shared DDL validator (bind params / bare
      // columns / non-determinism rejected; `new.<column>` accepted with its build
      // deferred). This runs before building the backfill so a bare-column default
      // is rejected here rather than silently resolving against the existing columns
      // the backfill scope exposes.
      const defaultConstraint = column.constraints?.find(c => c.type === 'default');
      if (defaultConstraint?.expr) {
        const hasMutationContext = !!tableReference.tableSchema.mutationContext
          && tableReference.tableSchema.mutationContext.length > 0;
        ctx.schemaManager.validateAddColumnDefault(
          defaultConstraint.expr, column.name, tableReference.tableSchema.name, hasMutationContext,
        );
      }
      const backfill = buildAddColumnBackfill(ctx, tableReference, column);
      // A per-row (non-foldable) default that is backfilled is not yet enforced
      // against a CHECK on the new column: the post-backfill validation scan reads a
      // pre-backfill snapshot for the evaluator path (the literal-default path is
      // unaffected and still validated). Reject the combination at plan-build time
      // rather than silently admitting CHECK-violating rows. Tracked by fix ticket
      // `alter-add-column-backfill-check-enforcement`.
      if (backfill && column.constraints?.some(c => c.type === 'check')) {
        throw new QuereusError(
          `ALTER TABLE ADD COLUMN '${column.name}' with both a non-foldable DEFAULT (e.g. new.<column>) and a CHECK constraint is not yet supported — the per-row backfill is not validated against the CHECK. Add the column first, then add the CHECK separately, or use a literal DEFAULT.`,
          StatusCode.UNSUPPORTED,
        );
      }
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'addColumn',
        column,
        backfill,
      });
		}

    case 'dropColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropColumn',
        name: stmt.action.name,
      });

    case 'dropConstraint':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropConstraint',
        name: stmt.action.name,
      });

    case 'renameConstraint':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'renameConstraint',
        oldName: stmt.action.oldName,
        newName: stmt.action.newName,
      });

    case 'alterPrimaryKey':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'alterPrimaryKey',
        columns: stmt.action.columns,
      });

    case 'alterColumn':
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'alterColumn',
        columnName: stmt.action.columnName,
        setNotNull: stmt.action.setNotNull,
        setDataType: stmt.action.setDataType,
        setDefault: stmt.action.setDefault,
      });

    case 'setTags': {
      // Validate any reserved `quereus.*` tags at the matching site so a typo
      // (e.g. `quereus.update.taget`) fails loudly here rather than being stored.
      // The CREATE / declarative paths route tags through the same registry.
      const target = stmt.action.target;
      const site: TagSite =
        target.kind === 'column' ? 'physical-column'
        : target.kind === 'constraint' ? 'physical-constraint'
        : 'physical-table';
      raiseReservedTagDiagnostics(
        validateReservedTags(stmt.action.tags, site),
        { log: () => { /* warnings (e.g. empty ack rationale) never block */ } },
      );
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'setTags',
        target,
        tags: stmt.action.tags,
      });
    }

    default:
      throw new QuereusError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Unknown ALTER TABLE action: ${(stmt.action as any).type}`,
        StatusCode.INTERNAL
      );
  }
}

/**
 * Compile the per-row backfill of an ADD COLUMN whose DEFAULT does not fold to a
 * literal (e.g. `new.<col>`). Mirrors the single-source INSERT row-expansion and the
 * view-write key default: the default is built against the table's *existing* columns
 * as the "supplied" row, so `new.<col>` resolves to the existing row's sibling during
 * backfill. Returns `undefined` for a missing or literal-folding default (the module
 * bulk-writes those), so the common case allocates nothing.
 */
function buildAddColumnBackfill(
  ctx: PlanningContext,
  tableReference: TableReferenceNode,
  columnDef: AST.ColumnDef,
): AddColumnBackfill | undefined {
  const defaultExpr = columnDef.constraints?.find(c => c.type === 'default')?.expr;
  if (!defaultExpr) return undefined;
  // Literal / NULL defaults fold and are bulk-written by the module — no per-row node.
  if (tryFoldLiteral(defaultExpr) !== undefined) return undefined;

  const tableSchema = tableReference.tableSchema;
  // Fresh attributes for the existing columns, referenced only by this default's
  // `new.<col>` column refs and resolved at runtime via the row slot the emitter
  // installs over each existing row. Minting fresh (rather than reusing the table
  // reference's attributes) keeps the node self-contained so the optimizer can't
  // dangle it.
  const rowAttrs: Attribute[] = tableSchema.columns.map(column => ({
    id: PlanNode.nextAttrId(),
    name: column.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: column.logicalType,
      nullable: !column.notNull,
      isReadOnly: false,
      collationName: column.collation,
    },
    sourceRelation: 'add-column-backfill',
  }));
  const rowScope = buildRowDefaultScope(ctx.scope, tableSchema.columns, rowAttrs);
  const node = buildExpression({ ...ctx, scope: rowScope }, defaultExpr) as ScalarPlanNode;

  if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
    validateDeterministicDefault(node, columnDef.name, tableSchema.name);
  }

  const rowDescriptor: RowDescriptor = [];
  rowAttrs.forEach((attr, index) => { rowDescriptor[attr.id] = index; });
  return { node, rowDescriptor };
}
