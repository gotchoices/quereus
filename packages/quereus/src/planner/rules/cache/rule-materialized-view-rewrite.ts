/**
 * Rule: Materialized-view query rewrite (read side)
 *
 * The read-side dual of the covering-structure enforcement path. Recognizes that
 * an *arbitrary* scan-projection-filter query — one that never names a
 * materialized view — is **answered from** a covering MV, and rewrites it to scan
 * the MV's backing table with a residual projection / filter instead of
 * recomputing the body against the base tables.
 *
 *     create materialized view recent as
 *       select id, customer_id, amt from sales where amt > 0;
 *
 *     -- never names `recent`, but the optimizer answers from it:
 *     select customer_id, amt from sales where amt > 0 and customer_id = 7;
 *     --   → scan _mv_recent, residual filter (customer_id = 7), residual project
 *
 * **Placement.** Logical→logical, in the Structural `rewrite` pass, at a priority
 * *below* `grow-retrieve` / `predicate-pushdown` so the fragment is still the
 * pristine `Project(Filter?(Retrieve(TableReference)))` when the matcher reads its
 * WHERE off the live plan (see `query-rewrite-matcher.ts` § pristine-fragment
 * requirement). The substituted backing `TableReference` then flows through the
 * normal Physical-pass access-path selection — so `query_plan()` shows an ordinary
 * `_mv_<name>` scan for free.
 *
 * **`sideEffectMode: 'safe'`.** The matcher admits only a read-only
 * `Project(Filter?(scan(TableReference)))` fragment (recognized conjunctive
 * predicates, no subqueries), so the dropped base-scan subtree is provably pure.
 * The replacement re-emits the fragment's identical output attribute ids, so the
 * parent splice that references them stays valid — mirroring the
 * attribute-id-preservation discipline of `rule-join-elimination`.
 *
 * Soundness lives in the matcher; this rule only adds the cost gate and the node
 * construction. The cost gate is a pure optimization decision — declining it (or
 * the matcher returning NotMatch) leaves the correct recompute-over-base plan.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { TableReferenceNode, ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { requireVtabModule } from '../../../schema/table.js';
import { FunctionFlags } from '../../../common/constants.js';
import { seqScanCost, filterCost, projectCost } from '../../cost/index.js';
import {
	analyzeQueryFragment,
	matchFragmentToMv,
	type RewriteMatch,
	type DeterminismProbe,
} from '../../analysis/query-rewrite-matcher.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:materialized-view-rewrite');

/** Nominal cardinality when stats report nothing (memory tables expose no row
 *  count to the StatsProvider). Matches NaiveStatsProvider's default. */
const DEFAULT_ROWS = 1000;
/** Row-reduction discount applied to a backing scan whose MV carries a WHERE when
 *  stats don't reflect the materialized subset. Matches FilterNode's own default. */
const MV_WHERE_SELECTIVITY = 0.5;

export function ruleMaterializedViewRewrite(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const sm = context.db.schemaManager;
	// Never rewrite while planning an MV's own body to (re)compute or maintain its
	// backing — that would read the snapshot being populated. See SchemaManager
	// § mvRewriteSuppressed.
	if (sm.isMaterializedViewRewriteSuppressed()) return null;
	const mvs = sm.getAllMaterializedViews();
	if (mvs.length === 0) return null;

	const frag = analyzeQueryFragment(node);
	if (!frag.ok) return null;
	const shape = frag.shape;
	const baseQualified = `${shape.baseTable.schemaName}.${shape.baseTable.name}`.toLowerCase();

	// Mirror the create-time determinism gate: consult the function registry's
	// DETERMINISTIC flag (a registered MV is already deterministic, so this is
	// defense in depth). Unknown functions are treated as deterministic, matching
	// `validateCheckConstraintDeterminism`.
	const isDeterministic: DeterminismProbe = (name, argc) => {
		const fn = sm.findFunction(name, argc) ?? sm.findFunction(name, -1);
		return fn ? (fn.flags & FunctionFlags.DETERMINISTIC) !== 0 : true;
	};

	// Enumerate candidate MVs single-sourced over this base table, then match.
	const matches: RewriteMatch[] = [];
	for (const mv of mvs) {
		if (mv.sourceTables.length !== 1 || mv.sourceTables[0] !== baseQualified) continue;
		const backing = sm.getTable(mv.schemaName, mv.backingTableName);
		const res = matchFragmentToMv(shape, mv, backing, isDeterministic);
		if (res.match) matches.push(res.match);
	}
	if (matches.length === 0) return null;

	// Cost gate: keep only strictly-cheaper matches; cheapest wins, stable name
	// tiebreak so plans are deterministic when several MVs match.
	const baseRows = estRows(context.stats.tableRows(shape.baseTable));
	const baseCost = recomputeCost(baseRows, shape.conjuncts.length > 0, shape.outputs.length);

	let best: { match: RewriteMatch; cost: number } | undefined;
	for (const m of matches) {
		const mvHasWhere = m.mv.selectAst.type === 'select' && m.mv.selectAst.where !== undefined;
		const backingRows = backingCardinality(context.stats.tableRows(m.backing), baseRows, mvHasWhere);
		const cost = scanCost(backingRows, m.residualConjuncts.length > 0, m.outputColumnMap.length);
		if (cost >= baseCost) continue; // not strictly cheaper → decline this match
		if (!best
			|| cost < best.cost
			|| (cost === best.cost && m.mv.name.toLowerCase() < best.match.mv.name.toLowerCase())) {
			best = { match: m, cost };
		}
	}
	if (!best) return null;

	const replacement = buildReplacement(node, best.match, context);
	if (replacement) {
		log('Rewrote scan-project-filter over %s to backing %s', baseQualified, best.match.backing.name);
	}
	return replacement;
}

/** Cost of recomputing the fragment against the base table. */
function recomputeCost(rows: number, hasFilter: boolean, outCount: number): number {
	return seqScanCost(rows) + (hasFilter ? filterCost(rows) : 0) + projectCost(rows, outCount);
}

/** Cost of answering from the MV backing scan + residual. */
function scanCost(rows: number, hasResidual: boolean, outCount: number): number {
	return seqScanCost(rows) + (hasResidual ? filterCost(rows) : 0) + projectCost(rows, outCount);
}

function estRows(rows: number | undefined): number {
	return rows === undefined || rows <= 0 ? DEFAULT_ROWS : rows;
}

/**
 * Effective backing cardinality. Prefer a real backing stat when it reflects the
 * materialized subset (strictly fewer rows than the base); otherwise, when the MV
 * carries a WHERE, model the pre-filter as a selectivity discount so the
 * row-reduction win is captured even when stats are absent (memory tables).
 */
function backingCardinality(backingStat: number | undefined, baseRows: number, mvHasWhere: boolean): number {
	if (backingStat !== undefined && backingStat > 0 && backingStat < baseRows) return backingStat;
	return mvHasWhere ? Math.max(1, Math.round(baseRows * MV_WHERE_SELECTIVITY)) : baseRows;
}

/**
 * Build the replacement subtree: a backing-table scan, the residual `Filter`
 * (kept fragment conjuncts re-bound onto the backing columns), and a `Project`
 * that re-emits the fragment's identical output attribute ids from the backing
 * columns. Returns null if any residual conjunct cannot be re-bound (defensive —
 * the matcher already proved every residual column is a backing column).
 */
function buildReplacement(project: ProjectNode, match: RewriteMatch, context: OptContext): PlanNode | null {
	const scope = project.scope;
	const backing = match.backing;
	const backingRef = new TableReferenceNode(
		scope,
		backing,
		requireVtabModule(backing),
		backing.vtabAuxData,
		undefined,
		false,
		context.db.schemaManager,
	);
	const backingAttrs = backingRef.getAttributes();
	let source: RelationalPlanNode = new RetrieveNode(scope, backingRef, backingRef);

	// Residual filter: re-bind the kept fragment conjuncts onto the backing scan.
	if (match.residualConjuncts.length > 0) {
		const remapped: ScalarPlanNode[] = [];
		for (const conjunct of match.residualConjuncts) {
			const r = remapToBacking(conjunct, match.backingColOfBaseCol, backingAttrs, scope);
			if (!r) return null;
			remapped.push(r);
		}
		source = new FilterNode(scope, source, andAll(remapped, scope));
	}

	// Residual project: re-emit the fragment's output attributes from the backing
	// columns, preserving the fragment's attribute ids (the parent splice needs them).
	const fragAttrs = project.getAttributes();
	const projections = match.outputColumnMap.map((entry, i) => {
		const bAttr = backingAttrs[entry.backingCol];
		const colRef = new ColumnReferenceNode(
			scope,
			{ type: 'column', name: bAttr.name } as AST.ColumnExpr,
			bAttr.type,
			bAttr.id,
			entry.backingCol,
		);
		return { node: colRef, alias: fragAttrs[i].name, attributeId: fragAttrs[i].id };
	});

	return new ProjectNode(scope, source, projections, undefined, fragAttrs as Attribute[], false);
}

/**
 * Re-bind a residual conjunct's column references from the fragment's base table
 * onto the backing scan: every `ColumnReferenceNode` (whose `columnIndex` is a
 * base-table column) is replaced with a reference to the backing column that holds
 * it. Other scalar nodes are rebuilt structurally. Returns undefined when a column
 * is not a backing column (the matcher prevents this; the guard is defensive).
 */
function remapToBacking(
	node: ScalarPlanNode,
	backingColOfBaseCol: ReadonlyMap<number, number>,
	backingAttrs: readonly Attribute[],
	scope: ProjectNode['scope'],
): ScalarPlanNode | undefined {
	if (node instanceof ColumnReferenceNode) {
		const backingCol = backingColOfBaseCol.get(node.columnIndex);
		if (backingCol === undefined) return undefined;
		const bAttr = backingAttrs[backingCol];
		return new ColumnReferenceNode(scope, node.expression, bAttr.type, bAttr.id, backingCol);
	}
	const children = node.getChildren();
	if (children.length === 0) return node;
	const newChildren: PlanNode[] = [];
	for (const child of children) {
		const r = remapToBacking(child as ScalarPlanNode, backingColOfBaseCol, backingAttrs, scope);
		if (!r) return undefined;
		newChildren.push(r);
	}
	return node.withChildren(newChildren) as ScalarPlanNode;
}

/** AND-fold a non-empty list of predicate conjuncts into one scalar predicate. */
function andAll(nodes: readonly ScalarPlanNode[], scope: ProjectNode['scope']): ScalarPlanNode {
	let acc = nodes[0];
	for (let i = 1; i < nodes.length; i++) {
		const ast: AST.BinaryExpr = {
			type: 'binary',
			operator: 'AND',
			left: exprOf(acc),
			right: exprOf(nodes[i]),
		};
		acc = new BinaryOpNode(scope, ast, acc, nodes[i]);
	}
	return acc;
}

/** The originating AST of a scalar node, or a literal-true placeholder. */
function exprOf(node: ScalarPlanNode): AST.Expression {
	const expr = (node as { expression?: AST.Expression }).expression;
	return expr ?? { type: 'literal', value: 1n } as AST.LiteralExpr;
}
