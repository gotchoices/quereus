import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { PlanNode } from '../nodes/plan-node.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { ViewMutationNode } from '../nodes/view-mutation-node.js';
import { propagate, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { collectMutationTags } from '../mutation/mutation-tags.js';
import { collectLensRowLocalConstraints } from '../mutation/lens-enforcement.js';
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
	// Lens row-local enforcement: when the target is a lens-backed logical table,
	// its prover-classified `enforced-row-local` CHECK obligations (rewritten to
	// basis terms) ride the basis write's per-row check pipeline, so they fire on
	// the write through the lens even when the basis carries no such check. A
	// plain view / MV has no lens slot ⇒ no extras (unchanged behavior). DELETE
	// writes no NEW row, so a CHECK is moot there.
	const extraConstraints = req.op === 'delete' ? [] : lensRowLocalConstraints(ctx, view);
	const children = baseOps.map(op => buildBaseOp(ctx, op, extraConstraints));
	return new ViewMutationNode(ctx.scope, children);
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
