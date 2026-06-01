import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { ViewMutationNode } from '../nodes/view-mutation-node.js';
import { propagate, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { collectMutationTags } from '../mutation/mutation-tags.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';

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
	const baseOps = propagate(ctx, view, withTags(req, tags));
	const children = baseOps.map(op => buildBaseOp(ctx, op));
	return new ViewMutationNode(ctx.scope, children);
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

/** Re-plan one base op through the matching base-table builder. */
function buildBaseOp(ctx: PlanningContext, op: BaseOp): PlanNode {
	switch (op.op) {
		case 'insert':
			return buildInsertStmt(ctx, op.statement as AST.InsertStmt);
		case 'update':
			return buildUpdateStmt(ctx, op.statement as AST.UpdateStmt);
		case 'delete':
			return buildDeleteStmt(ctx, op.statement as AST.DeleteStmt);
	}
}
