import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { buildTableReference } from '../building/table.js';
import type { MutationDiagnosticReason } from './mutation-diagnostic.js';
import { rewriteViewInsert, rewriteViewUpdate, rewriteViewDelete, type MutableViewLike } from './single-source.js';
import { isJoinBody, propagateMultiSource } from './multi-source.js';
import { propagateDecomposition } from './decomposition.js';
import type { StorageShape } from '../../vtab/mapping-advertisement.js';
import type { ReservedTagMap } from './mutation-tags.js';

export type { MutableViewLike } from './single-source.js';

/**
 * Mutation propagation classifier — the dual of `binding-extractor` /
 * `change-scope`, walking a planned view body from the user-visible relation
 * down to base-table references to decide whether a deterministic decomposition
 * exists at plan time (see `docs/view-updateability.md` § Mutation Propagation).
 *
 * **Phase 1 scope.** Only the *single-source projection-and-filter* shape is
 * decomposable: the relational spine from the body root to a base table may
 * contain only pass-through operators (Project / Filter / Sort / Limit /
 * Distinct / Alias / Retrieve) and must terminate at exactly one
 * `TableReferenceNode`. Joins, aggregates, set-ops, windows, recursive CTEs and
 * VALUES bodies are rejected with a structured reason; the broader FD/EC-driven
 * fan-out is Phase 2+.
 *
 * `Sort` / `Limit` / `Distinct` are tolerated *here* only so the walk can reach
 * the base table through them; the single-source rewrite layer
 * (`mutation/single-source.ts`) separately rejects `LIMIT`/`OFFSET`/`DISTINCT`
 * bodies, since a predicate-conjoin cannot faithfully reproduce a row-count
 * window or duplicate-collapse (a mutation would otherwise escape the window).
 *
 * The walk descends only *relational* children (`getRelations()`), so scalar
 * subqueries embedded in predicates/projections never pollute the base-table
 * count.
 */

/** Pass-through relational operators that a phase-1 decomposition tolerates. */
const PASSTHROUGH_NODES: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Retrieve,
	PlanNodeType.Filter,
	PlanNodeType.Project,
	PlanNodeType.Distinct,
	PlanNodeType.Sort,
	PlanNodeType.LimitOffset,
	PlanNodeType.Alias,
]);

export interface SingleSourceDecomposition {
	readonly kind: 'single-source';
	/** The single base table all mutations decompose onto. */
	readonly baseTable: TableReferenceNode;
}

export interface RejectedDecomposition {
	readonly kind: 'rejected';
	readonly reason: MutationDiagnosticReason;
	readonly detail: string;
}

export type ViewBodyClassification = SingleSourceDecomposition | RejectedDecomposition;

/** Map a disallowed body operator to a structured rejection reason. */
function reasonForOperator(nodeType: PlanNodeType): MutationDiagnosticReason {
	switch (nodeType) {
		case PlanNodeType.Join:
		case PlanNodeType.NestedLoopJoin:
		case PlanNodeType.HashJoin:
		case PlanNodeType.MergeJoin:
		case PlanNodeType.AsofScan:
		case PlanNodeType.FanOutLookupJoin:
			return 'unsupported-join';
		case PlanNodeType.Aggregate:
		case PlanNodeType.StreamAggregate:
		case PlanNodeType.HashAggregate:
			return 'unsupported-aggregate';
		case PlanNodeType.SetOperation:
			return 'unsupported-set-op';
		case PlanNodeType.Window:
			return 'unsupported-window';
		case PlanNodeType.RecursiveCTE:
		case PlanNodeType.InternalRecursiveCTERef:
			return 'recursive-cte';
		default:
			return 'no-base-lineage';
	}
}

/**
 * Classify a planned view body for phase-1 mutability. Returns the single base
 * table when the body is a single-source projection-and-filter, or a structured
 * rejection naming the obstructing operator.
 */
export function classifyViewBody(body: RelationalPlanNode): ViewBodyClassification {
	const tableRefs: TableReferenceNode[] = [];
	let rejection: RejectedDecomposition | undefined;

	const visit = (node: PlanNode): void => {
		if (rejection) return;

		if (node instanceof TableReferenceNode) {
			tableRefs.push(node);
			return;
		}

		if (isRelationalNode(node) && !PASSTHROUGH_NODES.has(node.nodeType)) {
			rejection = {
				kind: 'rejected',
				reason: reasonForOperator(node.nodeType),
				detail: `view body operator '${node.nodeType}' is not updateable in phase 1`,
			};
			return;
		}

		for (const child of node.getRelations()) {
			visit(child);
		}
	};

	visit(body);

	if (rejection) return rejection;

	if (tableRefs.length === 0) {
		return {
			kind: 'rejected',
			reason: 'no-base-lineage',
			detail: 'view body reaches no base table (e.g. a VALUES body); no recoverable base operation',
		};
	}

	if (tableRefs.length > 1) {
		return {
			kind: 'rejected',
			reason: 'unsupported-join',
			detail: `view body references ${tableRefs.length} base tables; multi-source decomposition is phase 2`,
		};
	}

	return { kind: 'single-source', baseTable: tableRefs[0] };
}

/**
 * A single resolved base-table operation a view/MV mutation decomposes into.
 *
 * For the single-source spine, `propagate` emits exactly one of these whose
 * `.statement` is the base-table DML the retired AST rewrite used to re-plan.
 * The builder (`building/view-mutation-builder.ts`) re-plans each `.statement`
 * through the ordinary base-table builder and wraps the results in a
 * `ViewMutationNode`. Multi-source fan-out (more than one base op, FK-ordered)
 * is the next phase and rides this same list.
 */
export interface BaseOp {
	/** The resolved base table this op targets. */
	readonly table: TableReferenceNode;
	readonly op: 'insert' | 'update' | 'delete';
	/** Base-table DML to build (already rewritten out of view terms). */
	readonly statement: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt;
}

/**
 * The view-mediated mutation to decompose. `tags` carries the merged, already
 * site-validated reserved `quereus.update.*` override surface (view-level tags
 * with statement-level tags layered on top — see `mutation-tags.ts`). It is
 * populated by `building/view-mutation-builder.ts` before propagation; the
 * decomposers consume it to narrow the base set / supply insert defaults / pick
 * a deletion side / apply the strict-vs-lenient policy.
 */
export type MutationRequest =
	| { readonly op: 'insert'; readonly stmt: AST.InsertStmt; readonly tags?: ReservedTagMap }
	| { readonly op: 'update'; readonly stmt: AST.UpdateStmt; readonly tags?: ReservedTagMap }
	| { readonly op: 'delete'; readonly stmt: AST.DeleteStmt; readonly tags?: ReservedTagMap };

/**
 * The decomposition storage shape to fan a mutation out across, or `undefined`
 * when the target is not a decomposition-backed logical table.
 *
 * Gated to the **synthesized** get body: a `primary-storage` advertisement with
 * no `declare lens` override means the registered body is exactly the
 * `compileDecompositionBody` join (`schema/lens-compiler.ts`), so the
 * advertisement faithfully describes its members. A plain view / MV / name-match
 * lens has no slot or no storage advertisement ⇒ `undefined` (unchanged path); an
 * overridden lens carries a hand-authored body the advertisement does not
 * describe, so it stays on the generic path too.
 */
function decompositionStorage(ctx: PlanningContext, view: MutableViewLike): StorageShape | undefined {
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	if (!slot || slot.override || slot.advertisement?.role !== 'primary-storage') return undefined;
	return slot.advertisement.storage;
}

/** Resolve the base table named by a rewritten base-table DML statement. */
function resolveBaseTable(
	ctx: PlanningContext,
	statement: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt,
): TableReferenceNode {
	return buildTableReference({ type: 'table', table: statement.table }, ctx).tableRef;
}

/**
 * Decompose a view-/MV-mediated mutation into an ordered list of base-table
 * operations — the single propagation path for all view mutations.
 *
 * - A **single-source** projection-and-filter spine reuses the relocated rewrite
 *   (`single-source.ts`) to produce exactly one `BaseOp`.
 * - A **two-table key-preserving inner join** body routes to the planned-body
 *   walk (`multi-source.ts`), which reads `updateLineage` to emit an ordered
 *   multi-element `BaseOp[]` for `update` / `delete` (insert is a later phase).
 *
 * Broader shapes (outer joins, set-ops, aggregates, > 2 tables) stay
 * diagnosed-and-rejected with a structured reason.
 */
export function propagate(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): BaseOp[] {
	// A logical table backed by a decomposition advertisement is registered as a
	// view whose body is the synthesized `anchor ⋈ members` join. Routing it
	// through the generic two-table join path below would be unsound (that path
	// picks a single delete side, caps at two tables, and rejects the outer joins
	// optional members ride). Intercept it and fan out off the advertisement.
	const storage = decompositionStorage(ctx, view);
	if (storage) {
		return propagateDecomposition(ctx, view, storage, req);
	}

	// A join body decomposes through the multi-source planned-body walk; a
	// single-table body through the single-source spine. The peek is a cheap AST
	// check that builds no plan, so the single-source path is unchanged in cost.
	if (isJoinBody(view.selectAst)) {
		return propagateMultiSource(ctx, view, req);
	}

	switch (req.op) {
		case 'insert': {
			const statement = rewriteViewInsert(ctx, req.stmt, view, req.tags);
			return [{ table: resolveBaseTable(ctx, statement), op: 'insert', statement }];
		}
		case 'update': {
			const statement = rewriteViewUpdate(ctx, req.stmt, view);
			return [{ table: resolveBaseTable(ctx, statement), op: 'update', statement }];
		}
		case 'delete': {
			const statement = rewriteViewDelete(ctx, req.stmt, view);
			return [{ table: resolveBaseTable(ctx, statement), op: 'delete', statement }];
		}
	}
}
