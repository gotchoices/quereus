import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { buildSelectStmt } from '../building/select.js';
import { resolveBaseSite } from '../analysis/update-lineage.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { MutableViewLike } from './single-source.js';

/**
 * The **one** plan-node backward-walk consumer the multi-source join walk and the
 * decomposition fan-out share (docs/view-updateability.md § Round-Trip Laws and the
 * Derived Backward Walk). It plans a view body **once** and reads the
 * `PhysicalProperties.updateLineage` the forward pass already threaded, routing
 * each output column back to its owning base relation — instead of each caller
 * re-deriving column→base lineage from the body's projection AST.
 *
 * It is source-count-agnostic: a single base table (a value-only EAV anchor), a
 * two-table inner join (the multi-source acceptance shape), or an n-way
 * anchor-rooted decomposition join (mandatory inner + optional outer members) all
 * funnel through the same read. Multi-source layers its `JoinNode` / side mapping
 * on top of {@link BodyBackwardLineage}; the decomposition fan-out layers its
 * member routing / anchor-only predicate gate on top. Neither re-walks the body's
 * projection AST for routing.
 */

/** One output column of a planned view body, by backward lineage. */
export interface BackwardColumn {
	/** Output (view/logical) column name, lowercased. */
	readonly name: string;
	/** Output column name in its original display spelling. */
	readonly displayName: string;
	/**
	 * Owning base relation's `TableReferenceNode` plan-node id (a `base` or — with
	 * {@link nullExtended} — outer-join-`null-extended` site). `undefined` for a
	 * `computed` output (e.g. an EAV correlated subquery, a non-invertible expr).
	 */
	readonly baseTableId?: number;
	/** Owning base column name (present whenever {@link baseTableId} is). */
	readonly baseColumn?: string;
	/**
	 * True for an identity-or-inverse `base` site that is NOT null-extended — the
	 * site is value-writable (an `inverse` is applied by the consumer; identity
	 * otherwise). A `computed` / `null-extended` site is read-only here.
	 */
	readonly writable: boolean;
	/** True when the owning site is potentially null-extended by an outer join (optional member). */
	readonly nullExtended: boolean;
	/** Backward inverse closure for a non-identity invertible base site (absent for identity). */
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	/** Domain restriction an `inverse` profile carries (conjoined into the identifying predicate). */
	readonly domain?: AST.Expression;
	/** The projection's source expression (already in base terms) — the substitution target for a user predicate / assigned value over this column. */
	readonly baseTermExpr: AST.Expression;
}

export interface BodyBackwardLineage {
	readonly sel: AST.SelectStmt;
	/** The planned view body (the source of `updateLineage`); reused by callers, not re-planned. */
	readonly root: RelationalPlanNode;
	/** Every `TableReferenceNode` in the planned body's relational spine, by plan-node id. */
	readonly tableRefsById: Map<number, TableReferenceNode>;
	/** Output (view) column name (lowercased) → its base-term replacement expression. */
	readonly viewColToBaseRef: Map<string, AST.Expression>;
	/** Per output column, in projection order. */
	readonly columns: BackwardColumn[];
}

/** Collect every `TableReferenceNode` in a planned body's relational spine, indexed by plan-node id. */
export function collectTableRefs(root: PlanNode): Map<number, TableReferenceNode> {
	const out = new Map<number, TableReferenceNode>();
	const visit = (n: PlanNode): void => {
		if (n instanceof TableReferenceNode) {
			out.set(Number(n.id), n);
			return;
		}
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return out;
}

/**
 * Plan a view body once and read its threaded `updateLineage` into a per-column
 * backward map. The caller must already have rejected any structural shape it does
 * not accept (the multi-source walk rejects `select *` / non-inner joins up front;
 * the decomposition body is synthesized with an explicit projection list). A
 * remaining `select *` projection or projection/attribute arity mismatch surfaces
 * a structured `no-base-lineage` diagnostic here.
 */
export function analyzeBodyLineage(ctx: PlanningContext, view: MutableViewLike): BodyBackwardLineage {
	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	const bodyPlan = buildSelectStmt(ctx, sel);
	if (!isRelationalNode(bodyPlan)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' body did not produce a relation`,
		});
	}
	const root = bodyPlan as RelationalPlanNode;
	const tableRefsById = collectTableRefs(root);

	const attrs = root.getAttributes();
	const lineage = root.physical.updateLineage;
	const projections = sel.columns;
	if (projections.length !== attrs.length) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': projection/attribute arity mismatch (${projections.length} vs ${attrs.length})`,
		});
	}

	const viewColToBaseRef = new Map<string, AST.Expression>();
	const columns: BackwardColumn[] = [];
	projections.forEach((rc, i) => {
		const attr = attrs[i];
		const displayName = view.columns?.[i] ?? attr.name;
		const name = displayName.toLowerCase();
		if (rc.type === 'all') {
			// Defensive: callers reject `select *` first (it has no 1:1 projection→base
			// routing). Reaching here is a caller bug, not a user shape.
			raiseMutationDiagnostic({
				reason: 'no-base-lineage',
				table: view.name,
				message: `cannot write through view '${view.name}': a 'select *' body has no per-column base lineage`,
			});
		}
		// The projection's source expression is already in base terms (it lives in the
		// body's own FROM scope), so it is the substitution target for user
		// predicates / assignments written against this output column.
		const baseTermExpr = (rc as AST.ResultColumnExpr).expr;
		viewColToBaseRef.set(name, baseTermExpr);

		const resolved = resolveBaseSite(lineage?.get(attr.id));
		columns.push({
			name,
			displayName,
			baseTableId: resolved.table,
			baseColumn: resolved.baseColumn,
			writable: resolved.writable,
			nullExtended: resolved.nullExtended,
			...(resolved.inverse ? { inverse: resolved.inverse } : {}),
			...(resolved.domain ? { domain: resolved.domain } : {}),
			baseTermExpr,
		});
	});

	return { sel, root, tableRefsById, viewColToBaseRef, columns };
}
