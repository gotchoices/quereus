/**
 * Query-rewrite matcher — the read-side dual of the coverage prover. It
 * recognizes when an *arbitrary* scan-projection-filter query fragment (one that
 * never names a materialized view) is **answered from** a covering MV, so the
 * optimizer can scan the MV's backing table with a bounded residual instead of
 * recomputing the body against the base tables.
 *
 * Distinct from `coverage-prover.ts` (which proves a *base-table UNIQUE
 * constraint* is covered, on the write/enforcement path) but sharing its
 * entailment vocabulary: `recognizeConjunctiveClauses` / `guardClausesEntail`
 * (`partial-unique-extraction.ts`). The question answered here is **output-relation
 * subsumption**: does the MV's stored output relation contain a superset (re-
 * coverable via a bounded residual) of the rows the fragment produces, keyed so
 * the residual recovers exactly the fragment's output?
 *
 * Soundness contract (mirrors the coverage prover exactly): **a false NotMatch
 * only forgoes a speedup; a false Match returns wrong rows.** Every check forgoes
 * the rewrite on doubt. The pre-existing recompute-over-base path is correct by
 * construction; the rule only ever replaces it with a provably row-equivalent
 * plan, so the rewrite is non-regressing.
 *
 * This phase delivers the **projection + filter subsumption** shape only.
 * Aggregate rollup (`mv-query-rewrite-aggregate-rollup`) and join subsumption
 * (`mv-query-rewrite-join-subsumption`) are pure additions to this matcher.
 *
 * ## Where the predicates come from (the pristine-fragment requirement)
 *
 * The fragment's WHERE is read from the live plan's `FilterNode` predicate (its
 * `.expression` AST), and the MV's WHERE from `mv.selectAst.where`. Reading the
 * fragment WHERE from the plan is only sound while the predicate is still an
 * explicit `FilterNode` above the table access — *before* predicate-pushdown
 * absorbs it into a range-bounded scan (where the matcher could no longer see it
 * and would falsely treat the fragment as unfiltered). The rule that drives this
 * matcher therefore fires in the **Structural rewrite pass, before grow-retrieve /
 * predicate-pushdown**, where the fragment is the pristine
 * `Project(Filter?(Retrieve(TableReference)))`. The shape walk additionally
 * rejects any range-bounded physical scan (`SeqScan`/`IndexScan` with
 * `rangeBoundedOn`, or an `IndexSeek`/`TableSeek`) as `'shape'` — defense in depth
 * should an absorbed predicate ever reach the walk by another path.
 *
 * ## Why `.expression` recognition is sound under constant folding
 *
 * A scalar plan node retains its originating AST in `.expression`. Constant
 * folding (which runs before the Structural pass) may make the *plan* more
 * specific than its `.expression` (e.g. folding `1+1` → `2` while `.expression`
 * still reads `amt > 1+1`). Such a divergence only ever makes a clause
 * *unrecognized* (`literalValue` of a non-literal AST returns undefined), which is
 * a conservative NotMatch — it never fabricates a recognized clause weaker than
 * what the plan computes, so it cannot produce a false Match.
 */

import type { RelationalPlanNode, ScalarPlanNode, GuardClause } from '../nodes/plan-node.js';
import { ProjectNode } from '../nodes/project-node.js';
import { FilterNode } from '../nodes/filter.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { AliasNode } from '../nodes/alias-node.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { SeqScanNode, IndexScanNode } from '../nodes/table-access-nodes.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import type { MaterializedViewSchema } from '../../schema/view.js';
import type { TableSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { recognizeConjunctiveClauses, guardClausesEntail } from './partial-unique-extraction.js';
import { containsNonDeterministicCall } from './check-extraction.js';

export type RewriteFailureReason =
	| 'no-candidate'           // no non-stale/deterministic MV (with a backing table) reads these sources
	| 'shape'                  // fragment or MV body is not a single-source scan-project-filter chain
	| 'source-mismatch'        // MV reads different base table(s) than the fragment
	| 'predicate-not-entailed' // fragment WHERE not entailed by MV WHERE (would read rows the MV dropped)
	| 'missing-column'         // fragment needs an output/residual column the MV does not project
	| 'cost-declined';         // matched, but the MV scan is not cheaper (set by the rule, not the matcher)

export interface RewriteMatch {
	readonly mv: MaterializedViewSchema;
	readonly backing: TableSchema;
	/**
	 * The recognized clauses of {@link residualConjuncts} — the extra predicate the
	 * fragment imposes beyond the MV's WHERE, in **base-table column-index** space.
	 * Empty ⇒ no residual filter. Exposed for diagnostics / unit tests; the rule
	 * builds the residual `Filter` from {@link residualConjuncts}, not from these.
	 */
	readonly residualClauses: readonly GuardClause[];
	/**
	 * The fragment's own WHERE conjunct plan nodes that are NOT already entailed by
	 * the MV's WHERE — the residual `Filter` to apply on top of the backing scan.
	 * Still reference the fragment's base-table attributes; the rule re-binds their
	 * column references onto the backing scan (via {@link backingColOfBaseCol}).
	 * Empty ⇒ no residual filter.
	 */
	readonly residualConjuncts: readonly ScalarPlanNode[];
	/**
	 * For each fragment output attribute (in output order), the backing-table column
	 * index that supplies it (a bare passthrough) — drives the residual `Project`.
	 */
	readonly outputColumnMap: ReadonlyArray<{ attrId: number; backingCol: number }>;
	/**
	 * Base-table column index → backing-table column index. The rule uses this to
	 * re-bind both the residual conjuncts' and the output projections' column
	 * references onto the backing scan.
	 */
	readonly backingColOfBaseCol: ReadonlyMap<number, number>;
}

export type RewriteResult =
	| { match: RewriteMatch }
	| { match: undefined; reason: RewriteFailureReason };

/** A predicate over the named function is deterministic iff this returns true. */
export type DeterminismProbe = (fnName: string, argc: number) => boolean;

function fail(reason: RewriteFailureReason): RewriteResult {
	return { match: undefined, reason };
}

/**
 * The recognized scan-project-filter shape of a query fragment: its single base
 * table, the bare-column output mapping, and the WHERE conjuncts. Shared so the
 * rule can analyze the fragment once (to enumerate candidate MVs by base table)
 * and reuse the result across every candidate match.
 */
export interface FragmentShape {
	readonly project: ProjectNode;
	readonly tableRef: TableReferenceNode;
	readonly baseTable: TableSchema;
	/** One per fragment output column, in order. `baseCol` is the base-table column
	 *  the bare-column projection passes through, or `undefined` for a computed
	 *  output (v1 cannot recover it from the backing — a `missing-column` NotMatch). */
	readonly outputs: ReadonlyArray<{ attrId: number; baseCol: number | undefined }>;
	/** Top-level AND-split conjuncts of the fragment WHERE (empty ⇒ no filter). */
	readonly conjuncts: readonly ScalarPlanNode[];
}

export type FragmentResult =
	| { ok: true; shape: FragmentShape }
	| { ok: false; reason: RewriteFailureReason };

/**
 * Recognize a query fragment rooted at a `ProjectNode` as a single-source
 * scan-project-filter chain. Walks `Project → Filter? → {Retrieve|Alias|full
 * SeqScan/IndexScan}* → TableReference`. Any other node (Sort/Limit/Distinct/
 * Aggregate/Join/SetOp, or a row-reducing seek / range-bounded scan) ⇒ `'shape'`.
 */
export function analyzeQueryFragment(root: RelationalPlanNode): FragmentResult {
	if (!(root instanceof ProjectNode)) return { ok: false, reason: 'shape' };

	// Descend the source chain, collecting WHERE conjuncts, down to the base table.
	const conjuncts: ScalarPlanNode[] = [];
	let node: RelationalPlanNode | undefined = root.source;
	let tableRef: TableReferenceNode | undefined;
	while (node) {
		if (node instanceof TableReferenceNode) {
			tableRef = node;
			break;
		}
		if (node instanceof FilterNode) {
			splitConjuncts(node.predicate, conjuncts);
			node = node.source;
			continue;
		}
		if (node instanceof RetrieveNode || node instanceof AliasNode) {
			node = singleRelation(node);
			if (!node) return { ok: false, reason: 'shape' };
			continue;
		}
		// A full (non-range-bounded) physical scan is a row-preserving pass-through;
		// a range-bounded scan has absorbed a predicate we can no longer see (sound
		// only because the rule fires before access selection — this is defensive).
		if (node instanceof SeqScanNode || node instanceof IndexScanNode) {
			if (node.rangeBoundedOn) return { ok: false, reason: 'shape' };
			node = node.source;
			continue;
		}
		return { ok: false, reason: 'shape' };
	}
	if (!tableRef) return { ok: false, reason: 'shape' };

	// Each output column must be a bare column reference into the base table; a
	// computed output is unrecoverable from the backing in v1 (missing-column).
	const outputs = root.projections.map((proj, i) => ({
		attrId: root.getAttributes()[i].id,
		baseCol: proj.node instanceof ColumnReferenceNode ? proj.node.columnIndex : undefined,
	}));

	return {
		ok: true,
		shape: { project: root, tableRef, baseTable: tableRef.tableSchema, outputs, conjuncts },
	};
}

/**
 * Decide whether `mv` (backed by `backing`) answers the fragment `shape`. See the
 * module doc for the soundness contract. `isDeterministic` probes the function
 * registry for the determinism gate (a registered MV is already deterministic by
 * construction — the create gate rejects non-deterministic bodies — so this is
 * defense in depth).
 */
export function matchFragmentToMv(
	shape: FragmentShape,
	mv: MaterializedViewSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	const baseTable = shape.baseTable;

	// ---- Candidate gates (a false-positive here only forgoes a speedup). ----
	// Stale: the backing is an unmaintained snapshot — never read it.
	if (mv.stale === true) return fail('no-candidate');
	// Registered + has a live backing table.
	if (!backing) return fail('no-candidate');
	// Deterministic body: a random()/now()/volatile-UDF body cannot substitute for
	// live recomputation. Reuses the function-registry determinism metadata.
	if (mvBodyHasNonDeterminism(mv.selectAst, isDeterministic)) return fail('no-candidate');

	// Source-schema sanity: the MV must read exactly the one base table the
	// fragment reads (single-source v1). `sourceTables` dedups, so a self-join
	// collapses to one entry — the AST single-`table` FROM check below rejects it.
	const qualified = `${baseTable.schemaName}.${baseTable.name}`.toLowerCase();
	if (mv.sourceTables.length !== 1 || mv.sourceTables[0] !== qualified) {
		return fail('source-mismatch');
	}

	// ---- MV body shape (AST): single-source projection + optional filter. ----
	if (mv.selectAst.type !== 'select') return fail('shape');
	const sel = mv.selectAst;
	if ((sel.groupBy && sel.groupBy.length > 0) || sel.having || sel.distinct
		|| sel.limit !== undefined || sel.offset !== undefined
		|| sel.union || sel.compound) {
		return fail('shape');
	}
	if (!sel.from || sel.from.length !== 1 || sel.from[0].type !== 'table') return fail('shape');

	// ---- MV projection → base-column mapping (which backing column holds which
	//      base column). A computed select item leaves that backing column unmapped
	//      (it cannot answer a passthrough need). ----
	const baseColOfBackingCol = mvProjectionBaseCols(sel.columns, baseTable);
	if (!baseColOfBackingCol) return fail('shape');
	const backingColOfBaseCol = new Map<number, number>();
	baseColOfBackingCol.forEach((baseCol, backingCol) => {
		if (baseCol !== undefined && !backingColOfBaseCol.has(baseCol)) {
			backingColOfBaseCol.set(baseCol, backingCol);
		}
	});

	// ---- Predicate entailment (containment): the fragment's row set must be a
	//      subset of the MV's, i.e. the MV's WHERE `P_mv` is entailed by the
	//      fragment's WHERE `P_q` (every MV-required clause is implied by the
	//      query). The residual is the conjunction of `P_q` clauses not already
	//      entailed by `P_mv`. ----
	const mvClauses = sel.where ? recognizeConjunctiveClauses(sel.where, baseTable) : [];
	if (mvClauses === undefined) return fail('predicate-not-entailed');

	const queryClauses: GuardClause[] = [];
	const residualConjuncts: ScalarPlanNode[] = [];
	const residualClauses: GuardClause[] = [];
	for (const conjunct of shape.conjuncts) {
		const expr = conjunctExpression(conjunct);
		const clauses = expr ? recognizeConjunctiveClauses(expr, baseTable) : undefined;
		if (!clauses) return fail('predicate-not-entailed');
		queryClauses.push(...clauses);
		// A conjunct already entailed by `P_mv` holds for every backing row, so it
		// is dropped from the residual; the rest become the residual filter.
		if (!guardClausesEntail(mvClauses, clauses)) {
			residualConjuncts.push(conjunct);
			residualClauses.push(...clauses);
		}
	}
	if (!guardClausesEntail(queryClauses, mvClauses)) return fail('predicate-not-entailed');

	// ---- Projection coverage: every fragment output column must be a base column
	//      the MV projects. ----
	const outputColumnMap: { attrId: number; backingCol: number }[] = [];
	for (const out of shape.outputs) {
		if (out.baseCol === undefined) return fail('missing-column');
		const backingCol = backingColOfBaseCol.get(out.baseCol);
		if (backingCol === undefined) return fail('missing-column');
		outputColumnMap.push({ attrId: out.attrId, backingCol });
	}

	// ---- Residual coverage: every base column the residual references must also be
	//      a backing column (so the residual filter can be applied on the scan). ----
	for (const clause of residualClauses) {
		for (const col of clauseColumns(clause)) {
			if (!backingColOfBaseCol.has(col)) return fail('missing-column');
		}
	}

	return {
		match: {
			mv,
			backing,
			residualClauses,
			residualConjuncts,
			outputColumnMap,
			backingColOfBaseCol,
		},
	};
}

/**
 * Convenience entry point (used by the unit tests): analyze `root` as a fragment
 * and, on success, match it against `mv`. Returns the fragment-analysis failure
 * reason when `root` is not a recognizable scan-project-filter chain.
 */
export function matchMaterializedViewRewrite(
	root: RelationalPlanNode,
	mv: MaterializedViewSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	const frag = analyzeQueryFragment(root);
	if (!frag.ok) return fail(frag.reason);
	return matchFragmentToMv(frag.shape, mv, backing, isDeterministic);
}

/** The sole relational child of a single-source pass-through, or undefined. */
function singleRelation(node: RelationalPlanNode): RelationalPlanNode | undefined {
	const rels = node.getRelations();
	return rels.length === 1 ? rels[0] : undefined;
}

/** Flatten a predicate into its top-level AND conjuncts (plan-node level). */
function splitConjuncts(predicate: ScalarPlanNode, out: ScalarPlanNode[]): void {
	if (predicate instanceof BinaryOpNode && predicate.expression.operator === 'AND') {
		splitConjuncts(predicate.left, out);
		splitConjuncts(predicate.right, out);
		return;
	}
	out.push(predicate);
}

/** The originating AST of a scalar plan node, or undefined when it has none. */
function conjunctExpression(node: ScalarPlanNode): AST.Expression | undefined {
	const expr = (node as { expression?: unknown }).expression;
	return expr && typeof expr === 'object' && 'type' in (expr as object)
		? expr as AST.Expression
		: undefined;
}

/**
 * Map each MV backing column (by output position) to the base-table column it
 * passes through, reading the MV's select list. A `*` expands to every base
 * column in order; a bare column resolves by name; a computed item leaves that
 * position `undefined` (unmapped). Returns undefined when a `table.*` form names a
 * table other than the base (cannot happen for a single-source body, but rejected
 * defensively).
 */
function mvProjectionBaseCols(
	columns: readonly AST.ResultColumn[],
	baseTable: TableSchema,
): Array<number | undefined> | undefined {
	const out: Array<number | undefined> = [];
	for (const col of columns) {
		if (col.type === 'all') {
			if (col.table && col.table.toLowerCase() !== baseTable.name.toLowerCase()) return undefined;
			for (let i = 0; i < baseTable.columns.length; i++) out.push(i);
			continue;
		}
		out.push(baseColumnOfExpr(col.expr, baseTable));
	}
	return out;
}

/** Resolve a bare column / identifier expression to a base-table column index. */
function baseColumnOfExpr(expr: AST.Expression, baseTable: TableSchema): number | undefined {
	if (expr.type === 'column') {
		return baseTable.columnIndexMap.get((expr as AST.ColumnExpr).name.toLowerCase());
	}
	if (expr.type === 'identifier') {
		const id = expr as AST.IdentifierExpr;
		if (id.schema) return undefined;
		return baseTable.columnIndexMap.get(id.name.toLowerCase());
	}
	return undefined;
}

/** The base-table column indices a recognized guard clause references. */
function clauseColumns(clause: GuardClause): number[] {
	switch (clause.kind) {
		case 'eq-literal': return [clause.column];
		case 'eq-column': return [clause.left, clause.right];
		case 'is-null': return [clause.column];
		case 'range': return [clause.column];
		case 'or-of': return clause.clauses.flatMap(clauseColumns);
		default: return [];
	}
}

/** True when the MV body's WHERE or any projection expression calls a
 *  non-deterministic function (or embeds a subquery). */
function mvBodyHasNonDeterminism(
	selectAst: AST.QueryExpr,
	isDeterministic: DeterminismProbe,
): boolean {
	if (selectAst.type !== 'select') return false;
	if (selectAst.where && containsNonDeterministicCall(selectAst.where, isDeterministic)) return true;
	for (const col of selectAst.columns) {
		if (col.type === 'column' && containsNonDeterministicCall(col.expr, isDeterministic)) return true;
	}
	return false;
}
