import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { AddConstraintNode } from '../nodes/add-constraint-node.js';
import { AlterTableNode, type AddColumnBackfill, type AddColumnCheck } from '../nodes/alter-table-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { PlanNode, type VoidNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildRowDefaultScope } from './default-scope.js';
import { validateDeterministicDefault } from '../validation/determinism-validator.js';
import { tryFoldLiteral } from '../../parser/utils.js';
import { inferType } from '../../types/registry.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { columnTagDiagnostics, raiseStmtTagDiagnostics } from './tag-diagnostics.js';

export function buildAlterTableStmt(
  ctx: PlanningContext,
  stmt: AST.AlterTableStmt,
): VoidNode {
  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, ctx);
  const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  switch (stmt.action.type) {
    case 'addConstraint': {
      // Reject a typo'd / mis-sited reserved `quereus.*` tag on the constraint at
      // plan-build, mirroring CREATE TABLE's named-constraint leg and SET TAGS — a
      // bad tag can't be silently stored when introduced via ALTER ... ADD CONSTRAINT.
      raiseStmtTagDiagnostics(
        validateReservedTags(stmt.action.constraint.tags, 'physical-constraint'),
        stmt,
      );

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
      // Reject a typo'd / mis-sited reserved `quereus.*` tag on the new column or any
      // of its inline named constraints at plan-build, before any heavier backfill /
      // check compilation — shares CREATE TABLE's per-column accumulation
      // (`columnTagDiagnostics`) so the two authoring surfaces can't drift.
      raiseStmtTagDiagnostics(columnTagDiagnostics(column), stmt);
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
      // For the per-row (evaluator) default path, enforce any CHECK on the new column
      // against each backfilled row by compiling the predicates here and evaluating them
      // inside the per-row backfill hook (mirrors the NOT NULL per-row path) — a violating
      // row aborts the ALTER before any tree/batch swap. The literal-default path is left to
      // the post-backfill scan (`validateBackfillAgainstChecks`), so checks are only
      // compiled when a backfill is present.
      const checks = backfill ? buildAddColumnChecks(ctx, tableReference, column) : undefined;
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'addColumn',
        column,
        backfill,
        checks,
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
        setCollation: stmt.action.setCollation,
      });

    case 'setTags': {
      // Validate any reserved `quereus.*` tags at the matching site so a typo
      // (e.g. `quereus.expose_implicit_indx`) fails loudly here rather than being
      // stored. The CREATE / declarative paths route tags through the same registry.
      const target = stmt.action.target;
      const site: TagSite =
        target.kind === 'column' ? 'physical-column'
        : target.kind === 'constraint' ? 'physical-constraint'
        : 'physical-table';
      // Routed through the shared helper (rather than the policy call inline) so every
      // plan-build tag surface raises through one site and a sited error here now
      // carries the statement's source location too.
      raiseStmtTagDiagnostics(validateReservedTags(stmt.action.tags, site), stmt);
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'setTags',
        target,
        mode: stmt.action.mode,
        tags: stmt.action.tags,
      });
    }

    case 'dropTags': {
      // DROP TAGS removes tags by key, so there is NO reserved-tag value
      // validation here (dropping a reserved key is legitimate — it removes an
      // override). Resolve the same target plumbing as setTags and let the
      // SchemaManager raise NOTFOUND atomically when a listed key is absent.
      return new AlterTableNode(ctx.scope, tableReference, {
        type: 'dropTags',
        target: stmt.action.target,
        keys: stmt.action.keys,
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

/**
 * Compile the column-level CHECK predicates of an ADD COLUMN whose DEFAULT does not fold
 * to a literal, so they can be enforced per backfilled row inside the backfill hook. Each
 * predicate is built against a row scope covering the table's *existing* columns plus the
 * *new* column, so a CHECK referencing the new column (bare `<col>` or `new.<col>`) and any
 * existing sibling resolves. The new column sits at position `existingColumns.length` in the
 * row descriptor; the emitter sets that slot to `[...existingRow, backfilledValue]` per row.
 * Returns `undefined` when the column carries no CHECK (the common case allocates nothing).
 */
function buildAddColumnChecks(
  ctx: PlanningContext,
  tableReference: TableReferenceNode,
  columnDef: AST.ColumnDef,
): AddColumnCheck | undefined {
  const checkConstraints = (columnDef.constraints ?? []).filter(c => c.type === 'check' && c.expr);
  if (checkConstraints.length === 0) return undefined;

  const tableSchema = tableReference.tableSchema;
  // Fresh attributes for the existing columns followed by the new column. The new column's
  // logical type / nullability come from the column def (same inference the schema builder
  // uses); refs in the CHECK resolve through the row slot the emitter installs per row.
  const existingAttrs: Attribute[] = tableSchema.columns.map(column => ({
    id: PlanNode.nextAttrId(),
    name: column.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: column.logicalType,
      nullable: !column.notNull,
      isReadOnly: false,
      collationName: column.collation,
    },
    sourceRelation: 'add-column-check',
  }));
  const newColNotNull = (columnDef.constraints ?? []).some(c => c.type === 'notNull');
  // Carry the new column's declared collation so a CHECK comparison over it (e.g.
  // `c = 'ABC'` on a `collate nocase` column) resolves the same collation at backfill
  // time as it would at write time.
  const newColCollation = columnDef.constraints?.find(c => c.type === 'collate')?.collation;
  const newColAttr: Attribute = {
    id: PlanNode.nextAttrId(),
    name: columnDef.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: inferType(columnDef.dataType),
      nullable: !newColNotNull,
      isReadOnly: false,
      collationName: newColCollation,
    },
    sourceRelation: 'add-column-check',
  };
  const rowAttrs = [...existingAttrs, newColAttr];
  const targetColumns = [...tableSchema.columns, { name: columnDef.name }];
  const rowScope = buildRowDefaultScope(ctx.scope, targetColumns, rowAttrs);

  const predicates = checkConstraints.map(con => ({
    node: buildExpression({ ...ctx, scope: rowScope }, con.expr!) as ScalarPlanNode,
    name: con.name,
    exprText: expressionToString(con.expr!),
  }));

  const rowDescriptor: RowDescriptor = [];
  rowAttrs.forEach((attr, index) => { rowDescriptor[attr.id] = index; });
  return { predicates, rowDescriptor };
}
