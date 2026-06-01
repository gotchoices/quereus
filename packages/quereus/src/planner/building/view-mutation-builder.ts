import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { ViewMutationNode, type MutationEnvelope } from '../nodes/view-mutation-node.js';
import { propagate, decompositionStorage, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { analyzeMultiSourceInsert, isJoinBody } from '../mutation/multi-source.js';
import { collectMutationTags } from '../mutation/mutation-tags.js';
import { collectLensRowLocalConstraints } from '../mutation/lens-enforcement.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { buildExpression } from './expression.js';
import { EnvelopeScanNode } from '../nodes/envelope-scan-node.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { parseExpressionString } from '../../parser/index.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { raiseMutationDiagnostic } from '../mutation/mutation-diagnostic.js';

/**
 * Build the view-mutation substrate for a view-/materialized-view-mediated DML.
 *
 * `propagate` decomposes the view mutation into an ordered list of base-table
 * operations (one for the single-source spine); each is re-planned through the
 * ordinary base-table builder — so every constraint / conflict / FK /
 * mutation-context / RETURNING-rejection rule is reused verbatim — and the
 * results are sequenced in a `ViewMutationNode`. For the single-source case the
 * wrapped subtree is byte-identical to what the retired AST rewrite re-planned.
 */
export function buildViewMutation(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): PlanNode {
	// Collect, site-validate, and merge the view-level + statement-level reserved
	// `quereus.update.*` override tags (a sited error is raised here, before any
	// base op is built — atomic). The decomposers read the merged map off the req.
	const tags = collectMutationTags(view, req.stmt);

	// Multi-source inner-join INSERT needs the plan-level shared-surrogate envelope
	// (a materialized augmented source the sibling base inserts fan out from), which
	// the AST-level `BaseOp[]` model cannot express — build it directly. A
	// decomposition-backed logical table keeps its own (still-deferred) fan-out path.
	if (req.op === 'insert' && !decompositionStorage(ctx, view) && isJoinBody(view.selectAst)) {
		return buildMultiSourceInsert(ctx, view, req.stmt);
	}

	const baseOps = propagate(ctx, view, withTags(req, tags));
	// Lens row-local enforcement: when the target is a lens-backed logical table,
	// its prover-classified `enforced-row-local` CHECK obligations (rewritten to
	// basis terms) ride the basis write's per-row check pipeline, so they fire on
	// the write through the lens even when the basis carries no such check. A
	// plain view / MV has no lens slot ⇒ no extras (unchanged behavior). DELETE
	// writes no NEW row, so a CHECK is moot there.
	const extraConstraints = req.op === 'delete' ? [] : lensRowLocalConstraints(ctx, view);
	const children = baseOps.map(op => buildBaseOp(ctx, op, extraConstraints));

	// RETURNING-through-view. Single-source already embedded the (rewritten)
	// RETURNING onto its base op (it now plans to a relational ReturningNode the
	// substrate surfaces), so nothing more is needed there. A **multi-source**
	// update/delete cannot recover the view row from its per-side base ops, so the
	// rows come from a re-query of the view restricted to the mutation's predicate
	// (built below); a delete captures it *before* the base ops fire (its rows are
	// about to vanish), an update *after* (the post-mutation image).
	const { returning, returningTiming } = buildMultiSourceReturning(ctx, view, req);
	return new ViewMutationNode(ctx.scope, children, returning, undefined, returningTiming);
}

/**
 * Build the separate RETURNING relation for a **multi-source** update/delete (the
 * only path where the view row is not recoverable from the base ops). It is a
 * re-query of the view restricted to the user predicate — `select <returning>
 * from <view> [where <user where>]` — so the projected columns resolve naturally
 * against the view (computed columns re-evaluated against the post-mutation base
 * state). Returns `{}` (no returning) for the absent-clause case, for single-
 * source (handled by the embedded base-op RETURNING), and for decomposition-
 * backed logical tables (whose RETURNING stays rejected by `propagate`).
 *
 * Timing fragility: the post-mutation update re-query matches by the user
 * predicate, so an update that *changes* a predicate column will not recapture
 * that row (a per-row capture would be needed). The single-source path is robust
 * (it reads NEW/OLD); the multi-source re-query is the documented v1 shape.
 */
function buildMultiSourceReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	req: MutationRequest,
): { returning?: RelationalPlanNode; returningTiming?: 'pre' | 'post' } {
	const returningCols = req.stmt.returning;
	if (!returningCols || returningCols.length === 0) return {};
	if (req.op === 'insert') return {}; // single-source insert embeds; multi-source insert is rejected upstream
	if (!isJoinBody(view.selectAst) || decompositionStorage(ctx, view)) return {};

	const selectAst: AST.SelectStmt = {
		type: 'select',
		columns: [...returningCols],
		from: [{ type: 'table', table: { type: 'identifier', name: view.name, schema: view.schemaName } }],
		where: req.stmt.where,
		loc: req.stmt.loc,
	};
	const node = buildSelectStmt(ctx, selectAst);
	if (!isRelationalNode(node)) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot project RETURNING through view '${view.name}': the re-query did not produce a relation`,
		});
	}
	return { returning: node, returningTiming: req.op === 'delete' ? 'pre' : 'post' };
}

/**
 * The lens row-local CHECK constraints for a view-mediated write, or `[]` when the
 * target is not a lens-backed logical table (a plain view / MV) or the lens has no
 * row-local obligations. The lens slot is resolved the same way the single-source
 * rewrite resolves the read-only gate — only a logical schema carries one.
 */
function lensRowLocalConstraints(ctx: PlanningContext, view: MutableViewLike): RowConstraintSchema[] {
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	return slot ? collectLensRowLocalConstraints(slot) : [];
}

/** Attach the merged override tags to the request (discriminant preserved). */
function withTags(req: MutationRequest, tags: MutationRequest['tags']): MutationRequest {
	if (tags === undefined) return req;
	switch (req.op) {
		case 'insert': return { op: 'insert', stmt: req.stmt, tags };
		case 'update': return { op: 'update', stmt: req.stmt, tags };
		case 'delete': return { op: 'delete', stmt: req.stmt, tags };
	}
}

/**
 * Build the shared-surrogate envelope substrate for a multi-source inner-join
 * INSERT (docs/view-updateability.md § Inner Join — Inserts, § Mutation Context).
 *
 * The decomposition (`analyzeMultiSourceInsert`) yields the per-side base inserts
 * plus the envelope shape. We build:
 *   - the **envelope source** — the user's VALUES/SELECT, whose columns are the
 *     supplied view columns. The `ViewMutation` emitter materializes it once,
 *     appends the minted shared key (if any) per row, and stashes the rows in
 *     context;
 *   - one **base insert per side**, each sourcing from a projection over an
 *     `EnvelopeScanNode` that reads those shared rows back (key first, then the
 *     view columns that side owns). Re-planned through the ordinary base-table
 *     builder, so every constraint / conflict / FK / default rule is reused; and
 *   - the **surrogate seed** (`max(anchor.key)`), evaluated once before fan-out.
 *
 * The sides are already FK-parent-before-FK-child ordered; the emitter drives them
 * in that order. Every side reads the same materialized envelope, so a generated
 * shared key is minted exactly once per produced row and threaded identically.
 */
function buildMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const plan = analyzeMultiSourceInsert(ctx, view, stmt);

	// Envelope leading columns = the supplied view columns (positional with the
	// user source). A minted surrogate is appended as one more column.
	const envelopeAttrs: Attribute[] = plan.suppliedColumns.map(col => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: col.type,
		sourceRelation: 'envelope',
	}));
	if (plan.mint) {
		envelopeAttrs.push({
			id: PlanNode.nextAttrId(),
			name: '__shared_key',
			type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false },
			sourceRelation: 'envelope',
		});
	}
	const envelopeType: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false,
		columns: envelopeAttrs.map(a => ({ name: a.name, type: a.type })),
		keys: [],
		rowConstraints: [],
	};

	// The shared descriptor stitches each base op's EnvelopeScanNode to the rows the
	// ViewMutation emitter materializes.
	const descriptor: TableDescriptor = {};

	const baseOps = plan.orderedSides.map(side => {
		const scan = new EnvelopeScanNode(ctx.scope, descriptor, envelopeAttrs, envelopeType);
		const projections: Projection[] = side.targetColumns.map((baseColumn, k) => {
			const envIdx = side.envelopeIndices[k];
			const attr = envelopeAttrs[envIdx];
			const ref = new ColumnReferenceNode(
				ctx.scope,
				{ type: 'column', name: attr.name },
				attr.type,
				attr.id,
				envIdx,
			);
			return { node: ref, alias: baseColumn };
		});
		// preserveInputColumns=false → output is exactly the picked columns, fresh
		// attribute ids, positionally aligned to the base op's target columns.
		const source = new ProjectNode(ctx.scope, scan, projections, undefined, undefined, false);

		const sideInsert: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: side.schema.name, schema: side.schema.schemaName },
			columns: [...side.targetColumns],
			source: { type: 'values', values: [] }, // placeholder — ignored when preBuiltSource is set
			onConflict: stmt.onConflict,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		return buildInsertStmt(ctx, sideInsert, [], source);
	});

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);

	let mint: MutationEnvelope['mint'] | undefined;
	if (plan.mint) {
		const seedExpr = parseExpressionString(
			`coalesce((select max(${quoteIdent(plan.mint.seedColumn)}) from ${qualifiedTable(plan.mint.seedTable.tableSchema.schemaName, plan.mint.seedTable.tableSchema.name)}), 0)`,
		);
		mint = { seed: buildExpression(ctx, seedExpr) as ScalarPlanNode };
	}

	return new ViewMutationNode(ctx.scope, baseOps, undefined, { source: envelopeSource, descriptor, mint });
}

/**
 * Build the envelope source — the user's INSERT source (VALUES / SELECT), whose
 * output columns are the supplied view columns in order. The emitter materializes
 * it once; downstream the `EnvelopeScanNode` reads those rows back (plus the
 * appended minted key) for every base side.
 */
function buildEnvelopeSource(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.InsertStmt,
	suppliedCount: number,
): RelationalPlanNode {
	switch (stmt.source.type) {
		case 'values': {
			const node = buildValuesStmt(ctx, stmt.source);
			assertSourceArity(view, node.getType().columns.length, suppliedCount);
			return node;
		}
		case 'select': {
			const node = buildSelectStmt(ctx, stmt.source);
			if (!isRelationalNode(node)) {
				raiseMutationDiagnostic({ reason: 'no-base-lineage', table: view.name, message: `cannot insert through view '${view.name}': the SELECT source did not produce a relation` });
			}
			assertSourceArity(view, node.getType().columns.length, suppliedCount);
			return node;
		}
		default:
			raiseMutationDiagnostic({
				reason: 'unsupported-source',
				table: view.name,
				message: `cannot insert through view '${view.name}': a multi-source (join) insert supports a VALUES or SELECT source (DML-as-source is a later phase)`,
			});
	}
}

function assertSourceArity(view: MutableViewLike, got: number, expected: number): void {
	if (got !== expected) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot insert through view '${view.name}': the source supplies ${got} value(s) but ${expected} view column(s) are targeted`,
		});
	}
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTable(schema: string, table: string): string {
	return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Re-plan one base op through the matching base-table builder. `extraConstraints`
 * carries the lens row-local CHECKs (basis terms) to merge into the insert/update
 * pipeline; a delete needs none. For the single-source spine there is exactly one
 * base op, so the constraints route unambiguously onto it; multi-source put
 * fan-out (which would route per member) is a later phase and is write-rejected
 * upstream, so the constraints never reach an ambiguous fan-out here.
 */
function buildBaseOp(ctx: PlanningContext, op: BaseOp, extraConstraints: ReadonlyArray<RowConstraintSchema>): PlanNode {
	switch (op.op) {
		case 'insert':
			return buildInsertStmt(ctx, op.statement as AST.InsertStmt, extraConstraints);
		case 'update':
			return buildUpdateStmt(ctx, op.statement as AST.UpdateStmt, extraConstraints);
		case 'delete':
			return buildDeleteStmt(ctx, op.statement as AST.DeleteStmt);
	}
}
