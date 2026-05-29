/**
 * Coverage prover — recognizes when an explicit materialized view *covers* a
 * UNIQUE constraint, i.e. its materialized row set is observation-equivalent to
 * the set of rows the constraint governs, keyed so a point lookup answers the
 * uniqueness question. Pure analysis: it records a constraint↔structure link
 * (see `runtime/emit/materialized-view.ts`); **nothing enforces through the MV's
 * backing table in this ticket** (that needs row-time write-through maintenance
 * — see `docs/materialized-views.md` § Covering structures, the soundness note).
 *
 * Shape — the body, after optimization, walks down to a single constrained base
 * table `T` through a chain of:
 *
 *     TableReference(T) → optional Filter(P) → Project(...) → optional Sort
 *
 * (physical access nodes such as IndexScan / SeqScan are transparent links in
 * the chain). A binary **join** is admitted when `T` provably contributes
 * *exactly one* MV row per governed `T` row — see the 1:1 decomposition below.
 * Aggregation, DISTINCT, set operations, `FanOutLookupJoin`, and `AsofScan` are
 * always `NotCovers('shape')`.
 *
 * Soundness is paramount: a false `Covers` would (once the lens layer routes
 * enforcement through the structure) silently miss conflicts. Every check is
 * conservative — a false `NotCovers` only forgoes an optimization.
 *
 * ---
 *
 * **The 1:1 join decomposition.** "Exactly one MV row per governed `T` row"
 * splits into two independent obligations, each proven by a distinct surface:
 *
 *  - **No row loss (≥1).** Proven one of two ways during the plan walk:
 *
 *      1. *Row preservation* — `T` sits on the row-*preserving* side of the join:
 *         a `left` join with `T` in the left subtree, or a `right` join with `T`
 *         in the right subtree.
 *      2. *Referential integrity* — an `inner`/`cross` join whose equi-pairs are
 *         a **NOT-NULL foreign key from `T` to the lookup table's primary key**,
 *         over a lookup side that exposes the parent's *full* row set
 *         (`innerJoinRetainsConstrainedTable`). Enforced RI then makes every `T`
 *         row match exactly one lookup row, so the inner join loses nothing. This
 *         leans on the engine treating declared FKs as inclusion dependencies —
 *         see the RI soundness note below.
 *
 *    Every other join type/position (`inner`/`cross` *without* a covering FK;
 *    `semi`/`anti` filter; `full` injects lookup-only rows; `T` on the dropping
 *    side) is rejected as `shape`. FDs encode uniqueness, not existence, so
 *    obligation (1) cannot be FD-derived; obligation (2) reads the FK schema +
 *    the lookup-side plan shape directly.
 *
 *  - **No fan-out (≤1).** `T`'s primary key must be a unique key of the
 *    **topmost join's output relation**, read through `isUnique`. The optimizer
 *    propagates join key-preservation into the join's `physical.fds`
 *    (`analyzeJoinKeyCoverage` → `propagateJoinFds`): for `T LEFT JOIN L on
 *    T.fk = L.ukey` it emits `T.pk → all_join_cols` *iff* the equi-pairs cover a
 *    unique key of `L`, i.e. iff each `T` row matches ≤1 `L` row. The moment the
 *    lookup side can multiply a `T` row, no preserved-key FD is emitted and
 *    `T.pk` is not a superkey of the join output ⇒ `NotCovers('fanout')`.
 *
 *    **Why the join frame, not the projected `root`.** The check is deliberately
 *    against the topmost join node, where the lookup columns are still present.
 *    A fanning `left` join still carries `T`'s own PK FD `T.pk → T-cols` (from
 *    the left input's `physical.fds`); once the lookup columns are *projected
 *    away* in `root`, that FD would make `T.pk` a derived key of the narrowed
 *    relation and silently mask the fan-out (the duplicate `T` rows survive
 *    projection without `DISTINCT`). At the join frame the retained lookup
 *    columns witness the fan-out, so `isUnique` is faithful regardless of what
 *    the projection keeps.
 *
 * Both obligations are required and neither implies the other: a `left` join to
 * a *non-unique* lookup key is row-preserving but fans out (caught by the fan-out
 * gate); an `inner` join to a unique *non-FK* (or nullable-FK) lookup key does
 * not fan out but can lose `T` rows (caught by the no-row-loss gate). A NOT-NULL
 * FK→PK inner join satisfies both at once: the FK target is the PK, so it is
 * unique (no fan-out) *and* every `T` row matches (no row loss).
 *
 * **Referential-integrity soundness (load-bearing).** Obligation (2) is sound
 * only because Quereus *enforces* referential integrity: `pragma foreign_keys`
 * defaults on, and the optimizer treats every declared FK as a hard inclusion
 * dependency (`child.fk ⊆ parent.pk` — see `util/ind-utils.ts`). The INNER
 * branch of `rule-join-elimination` already relies on exactly this invariant to
 * drop an FK→PK join, so admitting the same shape here introduces no *new*
 * assumption. If FKs were advisory — or RI is disabled and orphan child rows are
 * inserted — both this admit path *and* inner join elimination would be unsound
 * together; that is a global optimizer assumption, not one this prover owns.
 *
 * **NOT the `extractBindings` `'row'` classification.** A tempting-but-wrong
 * signal is the binding extractor's `'row'` class (`binding-extractor.ts`,
 * `analyzeRowSpecific`). That is *equality-pinned* — it fires only when equality
 * constraints cover `T`'s key at the reference, and reports a bare join scan as
 * `'global'`. The sound realization of "exactly one MV row per source row" is
 * `T`'s primary key being preserved as a key of the join output — the FD-surface
 * fact `isUnique` already consumes — so `binding-extractor.ts` needs no change.
 *
 * The v1 projection / ordering / predicate checks are frame-correct for a join
 * body: the covering columns all belong to `T` (UC + PK), the lookup-side
 * attributes simply are not in `baseAttrToCol` and are ignored, and the join `ON`
 * lives in the AST `from` clause (not `WHERE`). The AST `ORDER BY` / `WHERE`
 * column resolution is **qualifier-aware** (`makeBodyColumnResolver`): `alias.col`
 * resolves to a `T` column only when `alias` denotes `T`'s reference, and a bare
 * `col` only when unambiguous across the join's sources. A term on a lookup-side
 * column therefore fails on its own terms (`ordering-mismatch` for an `ORDER BY`,
 * `predicate-entailment` for a `WHERE`) rather than mis-mapping onto a same-named
 * `T` column — so a 1:1 join whose lookup key shares a UC column name (e.g.
 * `line_items ⋈ products on l.sku = p.sku`) now covers, instead of being rejected
 * by the former bare-name collision guard.
 *
 * **Join elimination, not handled here.** When the optimizer eliminates a
 * key-preserving lookup join (lookup columns unprojected + FK→PK alignment, see
 * `rule-join-elimination.ts`) the body collapses to a single-source chain and the
 * v1 path covers it with no join-specific code. This module handles the residual
 * cases where the join survives the optimizer but is still provably 1:1.
 *
 * Inner/cross covering via enforced referential integrity is handled (obligation
 * (2) above). Full-outer covering remains deferred (it injects lookup-only rows
 * that have no governed `T` row).
 *
 * ---
 *
 * Two different "coverage" questions live in this module; keep them apart:
 *
 *  1. **Base-table covering** (`proveCoverage`, above) — does an explicit MV's
 *     materialized row set cover a `unique` constraint on a *base table* `T`,
 *     keyed so a point lookup answers the uniqueness question and the base PK is
 *     reconstructible so a conflicting row can be identified? Requires literal
 *     projection of every UC column + the source PK, an `order by` permutation of
 *     the UC columns, and predicate/NULL-skip alignment.
 *
 *  2. **Output-relation effective key** (`proveEffectiveKeyUnique`, below) — is
 *     the body's *own output relation* provably unique on the declared key
 *     columns, via its effective key (declared keys, FD-closure-derived keys, or
 *     the all-columns/set fallback, all read through the unified `isUnique`
 *     surface)? This is the obligation primitive the lens prover consumes for its
 *     `obligation: proved` class — e.g. a `group by x, y` body whose output is
 *     intrinsically one row per `(x, y)` vacuously satisfies a logical
 *     `unique(x, y)`, so no runtime enforcement structure is needed.
 *
 * **Why (2) is NOT folded into (1).** An FD-derived output key cannot prove a
 * *base-table* constraint, and folding it in would be unsound. A `group by x`
 * body's output is *always* unique on `x` — whether or not `T` satisfies
 * `unique(x)` — because grouping collapses base-row duplicates: two base rows
 * with `x = 5` (a base-constraint violation) still yield exactly one output row
 * for `x = 5`. Output-key uniqueness is therefore silent about base duplicates;
 * that masking is the whole problem. Aggregating bodies also drop the base PK, so
 * the "identify the conflicting base row" half of the v1 covering contract (for
 * REPLACE / IGNORE conflict resolution) is unrecoverable. (2) is thus a proof
 * about the *derived (output) relation's own* constraint, deliberately kept out
 * of `proveCoverage` to preserve the v1 soundness boundary and leave the
 * eager-link path (`linkCoveredUniqueConstraints`) untouched. Whether a covering
 * *enforcement* structure can ever be FD-derived (detection-only, ABORT) is a
 * separate concern of the row-time-enforcement / lens tickets, not this one.
 */

import type { RelationalPlanNode, ScalarPlanNode, GuardClause } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { FilterNode } from '../nodes/filter.js';
import { JoinNode, extractEquiPairsFromCondition } from '../nodes/join-node.js';
import { BloomJoinNode } from '../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../nodes/merge-join-node.js';
import { SeqScanNode, IndexScanNode } from '../nodes/table-access-nodes.js';
import { AliasNode } from '../nodes/alias-node.js';
import { SortNode } from '../nodes/sort.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import type { EquiJoinPair } from '../nodes/join-utils.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { MaterializedViewSchema } from '../../schema/view.js';
import type { TableSchema, UniqueConstraintSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { recognizeConjunctiveClauses, guardClausesEntail } from './partial-unique-extraction.js';
import type { ColumnIndexResolver } from './predicate-shape.js';
import { normalizePredicate } from './predicate-normalizer.js';
import { isUnique } from '../util/fd-utils.js';
import { lookupCoveringFK } from '../util/ind-utils.js';

export type CoverageFailureReason =
	| 'shape'
	| 'fanout'
	| 'missing-uc-column'
	| 'missing-pk-column'
	| 'ordering-mismatch'
	| 'predicate-entailment'
	| 'missing-null-skip';

export type CoverageResult =
	| { covers: true }
	| { covers: false; reason: CoverageFailureReason };

const COVERS: CoverageResult = { covers: true };
function notCovers(reason: CoverageFailureReason): CoverageResult {
	return { covers: false, reason };
}

/** Shared empty lookup-name set for single-source bodies (no join frame). */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * Outcome of `proveEffectiveKeyUnique`. `not-a-key` means the body's effective
 * key does not subsume `keyColumns`; `out-of-frame` means an index fell outside
 * the body's output columns.
 */
export type EffectiveKeyResult =
	| { proved: true }
	| { proved: false; reason: 'not-a-key' | 'out-of-frame' };

/**
 * Row-preserving / single-source pass-through node types that may appear between
 * the projection and the table reference after optimization. They neither change
 * which base rows are present (Filter is handled separately — its predicate is
 * captured) nor split into multiple sources.
 *
 * Row-*dropping* nodes are deliberately excluded — notably `OrdinalSlice` (a
 * pushed-down LIMIT/OFFSET) and `LimitOffset` itself, which materialize only a
 * prefix of the governed rows and so can never cover. A row cap is rejected up
 * front from the AST (see `proveCoverage`); the exclusion here is the structural
 * backstop should the cap ever reach the plan walk by another path.
 */
const PASS_THROUGH: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Sort,
	PlanNodeType.Project,
	PlanNodeType.Retrieve,
	PlanNodeType.Alias,
	PlanNodeType.SeqScan,
	PlanNodeType.IndexScan,
	PlanNodeType.IndexSeek,
	PlanNodeType.TableSeek,
]);

/**
 * Binary (left/right/inner/cross/semi/anti) join node types the shape walk may
 * descend through. These all implement `JoinCapable` (logical `JoinNode`,
 * `BloomJoinNode` = `HashJoin`, `MergeJoinNode`), so `CapabilityDetectors.isJoin`
 * exposes `getJoinType` / `getLeftSource` / `getRightSource`. `FanOutLookupJoin`
 * and `AsofScan` are deliberately absent — they are not `JoinCapable` and fall
 * through to the walk's `shape` rejection.
 */
const BINARY_JOIN_TYPES: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Join,
	PlanNodeType.NestedLoopJoin,
	PlanNodeType.HashJoin,
	PlanNodeType.MergeJoin,
]);

/**
 * Decides whether `mv` covers `uc` on `baseTable`. `root` is the optimized body
 * relation (`db.getPlan(body).getRelations()[0]`); the body's declared `order by`
 * comes from `mv.selectAst`. See the module doc for the recognition rules.
 */
export function proveCoverage(
	root: RelationalPlanNode,
	mv: MaterializedViewSchema,
	uc: UniqueConstraintSchema,
	baseTable: TableSchema,
): CoverageResult {
	// ---- Row cap: a LIMIT/OFFSET body materializes only a prefix of the
	//      governed rows, so it can never be observation-equivalent. Read from the
	//      AST (the faithful source): the optimizer may push the cap into an
	//      `OrdinalSlice` over an ordinal-seek-capable leaf, which the shape walk
	//      would otherwise traverse as a transparent link. ----
	if (mv.selectAst.type === 'select' && (mv.selectAst.limit !== undefined || mv.selectAst.offset !== undefined)) {
		return notCovers('shape');
	}

	// ---- Shape: walk down to the constrained base table `T`. Single-source
	//      pass-throughs (Filter + physical access nodes) are transparent links;
	//      a binary join is descended into `T`'s side iff `T` is on the join's
	//      row-preserving side (the no-row-loss obligation). Reject aggregation,
	//      DISTINCT, set operations, FanOutLookupJoin, AsofScan, … as `shape`.
	//      The *predicate* is taken from the AST below (the optimizer may absorb
	//      a WHERE into an index range seek and drop the FilterNode, so the plan
	//      is not a faithful predicate source). The topmost join (if any) is
	//      captured for the fan-out gate — see `proveJoinNoFanout`. ----
	let tableRef: TableReferenceNode | undefined;
	let topJoin: RelationalPlanNode | undefined;
	let node: RelationalPlanNode | undefined = root;
	while (node) {
		if (node instanceof TableReferenceNode) {
			tableRef = node;
			break;
		}
		if (BINARY_JOIN_TYPES.has(node.nodeType) && CapabilityDetectors.isJoin(node)) {
			const left: RelationalPlanNode = node.getLeftSource();
			const right: RelationalPlanNode = node.getRightSource();
			const joinType = node.getJoinType();
			const leftHasT = subtreeContainsConstrainedTable(left, baseTable);
			const rightHasT = subtreeContainsConstrainedTable(right, baseTable);
			// `T` on both sides (self-join) or neither ⇒ ambiguous / not our table.
			if (leftHasT === rightHasT) return notCovers('shape');
			const tSide: RelationalPlanNode = leftHasT ? left : right;
			const lookupSide: RelationalPlanNode = leftHasT ? right : left;
			// No row loss: `T` must keep every governed row. Two sound paths:
			//  - row-preservation — `T` on the preserving side of an outer join
			//    (`left`→left subtree, `right`→right subtree); or
			//  - referential integrity — an `inner`/`cross` join whose equi-pairs are
			//    a NOT-NULL FK from `T` to the lookup table's PK, so enforced RI makes
			//    every `T` row match exactly one lookup row (`innerJoinRetainsConstrainedTable`).
			// Every other join type/position drops or duplicates governed `T` rows.
			const rowPreserving = (leftHasT && joinType === 'left') || (rightHasT && joinType === 'right');
			if (!rowPreserving) {
				const fkRetained = (joinType === 'inner' || joinType === 'cross')
					&& innerJoinRetainsConstrainedTable(node, tSide, lookupSide, baseTable);
				if (!fkRetained) return notCovers('shape');
			}
			if (topJoin === undefined) topJoin = node;
			node = tSide;
			continue;
		}
		if (node instanceof FilterNode || PASS_THROUGH.has(node.nodeType)) {
			const relations: readonly RelationalPlanNode[] = node.getRelations();
			if (relations.length !== 1) return notCovers('shape');
			node = relations[0];
			continue;
		}
		return notCovers('shape');
	}
	if (!tableRef) return notCovers('shape');
	if (tableRef.tableSchema.name.toLowerCase() !== baseTable.name.toLowerCase()
		|| tableRef.tableSchema.schemaName.toLowerCase() !== baseTable.schemaName.toLowerCase()) {
		return notCovers('shape');
	}

	// ---- Projection coverage: map output attributes back to base columns via
	//      stable attribute IDs (a bare column reference preserves the source
	//      attribute's id through Project/Sort/scan nodes). ----
	const baseAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((attr, i) => baseAttrToCol.set(attr.id, i));

	const coveredBaseCols = new Set<number>();
	for (const attr of root.getAttributes()) {
		const col = baseAttrToCol.get(attr.id);
		if (col !== undefined) coveredBaseCols.add(col);
	}

	for (const col of uc.columns) {
		if (!coveredBaseCols.has(col)) return notCovers('missing-uc-column');
	}
	for (const pk of baseTable.primaryKeyDefinition) {
		if (!coveredBaseCols.has(pk.index)) return notCovers('missing-pk-column');
	}

	// ---- Lookup-side column names in the join's output frame (a `T` attribute is
	//      one whose id is a key of `baseAttrToCol`); empty for a single-source
	//      body. Feeds the qualifier-aware AST resolver's unqualified-name
	//      ambiguity check below. ----
	const lookupNames = topJoin !== undefined ? lookupColumnNames(topJoin, baseAttrToCol) : EMPTY_NAMES;

	// ---- Multi-source (join body) no-fan-out gate: `T`'s primary key must remain
	//      a unique key of the topmost join's output. Vacuous — and v1 behavior
	//      unchanged — for a single-source chain (`topJoin` absent). ----
	if (topJoin !== undefined) {
		const noFanout = proveJoinNoFanout(topJoin, tableRef, baseTable);
		if (!noFanout.covers) return noFanout;
	}

	// ---- Qualifier-aware AST column resolution. An ORDER BY / WHERE term
	//      `alias.col` resolves to a base-table `T` column only when `alias`
	//      denotes `T`'s reference; an unqualified `col` only when `T` has it and
	//      no lookup-side column shares the name. A term resolving to a lookup
	//      column is then handled on its own terms below (ORDER BY ⇒
	//      `ordering-mismatch`, WHERE ⇒ `predicate-entailment`), never mis-mapped
	//      onto `T`. For a single-source body this is plain bare-name resolution. ----
	const resolveBodyColumn = makeBodyColumnResolver(mv.selectAst, baseTable, lookupNames);

	// ---- Ordering: the body's declared ORDER BY columns must be a permutation of
	//      the UC columns. The prover never invents an ordering — a missing one
	//      fails. Read from the body AST rather than `mv.ordering`: the optimizer
	//      drops the Sort (leaving `physical.ordering` empty) whenever an index
	//      scan already supplies the order, so the AST is the faithful source. ----
	const orderingBaseCols = bodyOrderByColumns(mv.selectAst, resolveBodyColumn);
	if (orderingBaseCols === undefined) return notCovers('ordering-mismatch');
	if (!isPermutation(orderingBaseCols, uc.columns)) return notCovers('ordering-mismatch');

	// ---- Predicate alignment: the materialized set (rows where the body's WHERE
	//      holds) must equal the governed set (rows where uc.predicate holds,
	//      NULL-excluded). The WHERE is read from the AST (see shape note). ----
	const bodyWhere = mv.selectAst.type === 'select' ? mv.selectAst.where : undefined;
	return provePredicateAlignment(bodyWhere, uc, baseTable, resolveBodyColumn);
}

/**
 * "Body proves it": true iff the body's output relation is provably unique on
 * `keyColumns` (output-column indices) via its effective key — declared keys,
 * FD-closure-derived keys, or the set/all-columns fallback, all read through the
 * unified `isUnique` surface. This is the obligation primitive the lens prover
 * consumes for its `obligation: proved` class (e.g. a `group by x, y` body
 * proving a logical `unique(x, y)`).
 *
 * `root` MUST be the optimized body relation (the same node `proveCoverage`
 * receives: `db.getPlan(body).getRelations()[0]`), so `physical.fds` is
 * populated — the group-key FD (`propagateAggregateFds`) and projected
 * source-key FDs live there.
 *
 * Soundness notes (why the v1 base-table covering checks do NOT apply here):
 *  - Ordering: irrelevant — a proof of intrinsic uniqueness needs no ordered
 *    point-lookup path, so the canonical `group by` body (no ORDER BY) qualifies.
 *  - PK reconstructibility / observation-equivalence: irrelevant — there is no
 *    enforcement and no base row to identify; the constraint is on the output.
 *  - NULL-skip: composes trivially by subsumption. `isUnique` proves *strict*
 *    key-uniqueness (NULL treated as a value); SQL `unique` is NULL-permissive
 *    (weaker), so strict-unique ⟹ `unique` holds. No extra NULL handling.
 *  - Superkey semantics are correct: if the body's real key is a subset of
 *    `keyColumns`, the (stronger) constraint on the smaller set still implies the
 *    declared one — `isUnique` already returns true for any superset of a key.
 *
 * `keyColumns` are **body-output** column indices; the lens prover owns the
 * logical-column → output-column mapping (this primitive does no base-table
 * attribute-id translation — that was a v1 mechanism for the base frame and does
 * not apply to the output frame). Delegates uniqueness entirely to `isUnique`
 * (DRY); the value this adds is the named obligation seam, the diagnostic result
 * shape, and the load-bearing soundness documentation above.
 */
export function proveEffectiveKeyUnique(
	root: RelationalPlanNode,
	keyColumns: readonly number[],
): EffectiveKeyResult {
	const columnCount = root.getType().columns.length;
	for (const c of keyColumns) {
		if (c < 0 || c >= columnCount) return { proved: false, reason: 'out-of-frame' };
	}
	return isUnique(keyColumns, root) ? { proved: true } : { proved: false, reason: 'not-a-key' };
}

/**
 * Verifies the body predicate `P` is observation-equivalent (over the governed
 * rows) to the constraint's scope:
 *
 *   - soundness  — `P` entails every required clause (`uc.predicate` clauses
 *     plus an `is not null` per nullable UC column), so the materialized set is
 *     contained in the governed set; and
 *   - completeness — `P` adds no restriction beyond those clauses (a NOT-NULL on
 *     any UC column is always allowed, since UNIQUE already ignores NULL rows),
 *     so the materialized set is not a strict subset that would miss conflicts.
 *
 * `resolveBodyColumn` resolves the body WHERE's column references (qualifier-aware
 * for join bodies). `uc.predicate` is a constraint on `T`, so it always resolves
 * by bare name against `baseTable` (the default).
 */
function provePredicateAlignment(
	bodyWhere: AST.Expression | undefined,
	uc: UniqueConstraintSchema,
	baseTable: TableSchema,
	resolveBodyColumn: ColumnIndexResolver,
): CoverageResult {
	// Required clauses (the governed scope).
	const requiredClauses: GuardClause[] = [];
	if (uc.predicate) {
		const ucClauses = recognizeConjunctiveClauses(uc.predicate, baseTable);
		if (ucClauses === undefined) return notCovers('predicate-entailment');
		requiredClauses.push(...ucClauses);
	}
	const nullableUcCols = uc.columns.filter(c => baseTable.columns[c]?.notNull !== true);
	for (const c of nullableUcCols) {
		requiredClauses.push({ kind: 'is-null', column: c, negated: true });
	}

	// Recognize P. An unrecognized conjunct makes the materialized set unbounded
	// from the prover's view — reject (we can prove neither containment direction).
	// A WHERE term on a lookup column resolves to `undefined` via the qualifier-
	// aware resolver ⇒ unrecognized ⇒ this same rejection path (predicate-entailment).
	let pClauses: GuardClause[] = [];
	if (bodyWhere) {
		const clauses = recognizeConjunctiveClauses(bodyWhere, baseTable, resolveBodyColumn);
		if (clauses === undefined) {
			return notCovers(uc.predicate || nullableUcCols.length === 0 ? 'predicate-entailment' : 'missing-null-skip');
		}
		pClauses = clauses;
	}

	// Soundness: P entails every required clause (per-clause for a precise reason).
	for (const rc of requiredClauses) {
		if (!guardClausesEntail(pClauses, [rc])) {
			return notCovers(rc.kind === 'is-null' && rc.negated ? 'missing-null-skip' : 'predicate-entailment');
		}
	}

	// Completeness: every clause of P is allowed (entailed by the required scope,
	// widened by a permissible NOT-NULL on any UC column). A restriction beyond
	// that would drop governed rows and miss conflicts.
	const allowedForCompleteness: GuardClause[] = [...requiredClauses];
	for (const c of uc.columns) {
		allowedForCompleteness.push({ kind: 'is-null', column: c, negated: true });
	}
	if (!guardClausesEntail(allowedForCompleteness, pClauses)) {
		return notCovers('predicate-entailment');
	}

	return COVERS;
}

/**
 * True iff `node`'s subtree contains a `TableReferenceNode` over `baseTable`
 * (matched by lowercased schema + name). Walks `getRelations()` recursively, so
 * it descends through physical access / Retrieve wrappers and nested joins. A
 * self-join of `T` makes *both* of a join's subtrees report true — the walk
 * treats that as ambiguous (`shape`).
 */
function subtreeContainsConstrainedTable(node: RelationalPlanNode, baseTable: TableSchema): boolean {
	if (node instanceof TableReferenceNode) {
		return node.tableSchema.name.toLowerCase() === baseTable.name.toLowerCase()
			&& node.tableSchema.schemaName.toLowerCase() === baseTable.schemaName.toLowerCase();
	}
	for (const rel of node.getRelations()) {
		if (subtreeContainsConstrainedTable(rel, baseTable)) return true;
	}
	return false;
}

/**
 * The `TableReferenceNode` over `baseTable` somewhere in `node`'s subtree, or
 * `undefined`. Like `subtreeContainsConstrainedTable` but returns the node so
 * `T`'s stable attribute ids can be mapped to its base column indices. (A
 * self-join is already rejected upstream, so the first match is unambiguous.)
 */
function findConstrainedTableRef(node: RelationalPlanNode, baseTable: TableSchema): TableReferenceNode | undefined {
	if (node instanceof TableReferenceNode) {
		return node.tableSchema.name.toLowerCase() === baseTable.name.toLowerCase()
			&& node.tableSchema.schemaName.toLowerCase() === baseTable.schemaName.toLowerCase()
			? node : undefined;
	}
	for (const rel of node.getRelations()) {
		const found = findConstrainedTableRef(rel, baseTable);
		if (found) return found;
	}
	return undefined;
}

/**
 * The leaf `TableReferenceNode` of `node` **iff** the path down to it exposes the
 * table's *full* row set — nothing filters, seeks, limits, or deduplicates rows.
 * Returns `undefined` otherwise.
 *
 * This is the optimized-plan analogue of `ind-utils.ts`'s
 * `isRowPreservingPathToTable` (which recognizes the *logical*-plan shape:
 * bare TableReference / Retrieve-of-bare-table / Alias / Sort). After physical
 * access selection a full scan is a `SeqScan`/`IndexScan` over the table — so we
 * additionally admit those, but only when **not range-bounded** (`rangeBoundedOn`
 * unset; a bounded scan drops rows). `IndexSeek`/`TableSeek` (row-reducing
 * seeks), `Filter`, `LimitOffset`, `Distinct`, `Project`, joins, aggregates, …
 * all disqualify by falling through to `undefined`.
 *
 * Required for the inner-join FK admit path: the lookup (parent) side must
 * produce the parent's full row set, else a `T` row whose parent was filtered
 * out would be dropped despite the FK guarantee — re-introducing row loss.
 */
function resolveFullScanTableRef(node: RelationalPlanNode): TableReferenceNode | undefined {
	let n: RelationalPlanNode = node;
	for (;;) {
		if (n instanceof TableReferenceNode) return n;
		if (n instanceof SeqScanNode || n instanceof IndexScanNode) {
			if (n.rangeBoundedOn) return undefined;
			n = n.source;
			continue;
		}
		if (n instanceof AliasNode || n instanceof SortNode || n instanceof RetrieveNode) {
			const rels = n.getRelations();
			if (rels.length !== 1) return undefined;
			n = rels[0];
			continue;
		}
		return undefined;
	}
}

/**
 * The count of column-to-column equality conjuncts in `cond` (after
 * normalization) when `cond` is a pure conjunction of them — `a.x = b.y AND …`
 * with no other operator and no non-column operand — or `undefined` otherwise.
 * The inner-join no-row-loss proof needs this: a residual non-equi conjunct (or
 * an equality to a literal/expression) can drop `T` rows the FK→PK guarantee
 * assumes survive, so any such condition disqualifies. The count lets the caller
 * confirm every conjunct produced a cross-side equi-pair (see
 * `pureJoinEquiAttrPairs`): a column equality whose operands sit on the *same*
 * side is a single-relation filter that `extractEquiPairsFromCondition` silently
 * drops yet still restricts the join's row set.
 */
function pureColumnEquiConjunctCount(cond: ScalarPlanNode): number | undefined {
	const stack: ScalarPlanNode[] = [normalizePredicate(cond)];
	let count = 0;
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode) {
			const op = n.expression.operator;
			if (op === 'AND') { stack.push(n.left, n.right); continue; }
			if (op === '=' && n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode) { count++; continue; }
		}
		return undefined;
	}
	return count;
}

/**
 * Equi-pairs of a binary join in attribute-id form, or `undefined` when the join
 * carries anything beyond an equi-only condition (which could drop `T` rows and
 * so breaks the no-row-loss proof). Physical joins (`BloomJoin`/`MergeJoin`)
 * pre-extract their equi-pairs and stash any remainder in `residualCondition`; a
 * logical `JoinNode` carries a single `condition` that must be a pure
 * AND-of-column-equalities *every one of which crosses the two join sides*. A
 * same-side column equality (e.g. `c.x = c.y`) passes the pure-equi shape but is
 * a single-relation filter `extractEquiPairsFromCondition` drops — so we reject
 * unless the extracted cross-side pair count matches the conjunct count, rather
 * than leaning on predicate pushdown to have hoisted it below the join. A bare
 * cross join (no condition / no equi-pairs) yields an empty list, which the
 * caller treats as "no FK to align".
 */
function pureJoinEquiAttrPairs(join: RelationalPlanNode): readonly EquiJoinPair[] | undefined {
	if (join instanceof BloomJoinNode || join instanceof MergeJoinNode) {
		return join.residualCondition === undefined ? join.equiPairs : undefined;
	}
	if (join instanceof JoinNode) {
		if (!join.condition) return [];
		const conjunctCount = pureColumnEquiConjunctCount(join.condition);
		if (conjunctCount === undefined) return undefined;
		const leftAttrs = join.left.getAttributes();
		const rightAttrs = join.right.getAttributes();
		const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs)
			.map(p => ({ leftAttrId: leftAttrs[p.left].id, rightAttrId: rightAttrs[p.right].id }));
		// A conjunct that produced no cross-side pair is a same-side filter that
		// restricts rows without aligning `T` to the lookup — disqualify.
		if (pairs.length !== conjunctCount) return undefined;
		return pairs;
	}
	return undefined;
}

/**
 * No-row-loss proof for an `inner`/`cross` join: every governed `T` row is
 * retained because the join's equi-pairs are a **NOT-NULL foreign key from `T`
 * to the lookup table's primary key**, and Quereus enforces referential
 * integrity (declared FKs are treated as inclusion dependencies — the same
 * `lookupCoveringFK` + full-parent-row-set discipline the INNER branch of
 * `rule-join-elimination` relies on; see the module doc's soundness note).
 *
 * Each obligation closes a distinct row-loss gap:
 *  - **equi-only join** (`pureJoinEquiAttrPairs`) — a residual/non-equi conjunct
 *    could fail for the FK-matched lookup row and drop the `T` row.
 *  - **full parent row set** (`resolveFullScanTableRef` on the lookup side) — a
 *    filtered/seeked lookup side could omit the parent row a `T` row references.
 *  - **NOT-NULL FK to the PK** (`lookupCoveringFK`, `!match.nullable`) — a NULL
 *    FK value has no parent (MATCH SIMPLE), so a nullable FK can drop `T` rows;
 *    a non-FK or non-PK equi-join carries no inclusion guarantee at all.
 *
 * The complementary no-fan-out (≤1) obligation is unchanged — it is the join-
 * frame `isUnique(T.pk)` gate in `proveJoinNoFanout`, which a FK→PK join also
 * satisfies (the PK side's key is covered by the equi-pairs).
 */
function innerJoinRetainsConstrainedTable(
	join: RelationalPlanNode,
	tSide: RelationalPlanNode,
	lookupSide: RelationalPlanNode,
	baseTable: TableSchema,
): boolean {
	const equiPairs = pureJoinEquiAttrPairs(join);
	if (!equiPairs || equiPairs.length === 0) return false;

	const tRef = findConstrainedTableRef(tSide, baseTable);
	if (!tRef) return false;
	const lookupRef = resolveFullScanTableRef(lookupSide);
	if (!lookupRef) return false;

	// Stable attribute id → base column index on each side.
	const tAttrToCol = new Map<number, number>();
	tRef.getAttributes().forEach((a, i) => tAttrToCol.set(a.id, i));
	const lookupAttrToCol = new Map<number, number>();
	lookupRef.getAttributes().forEach((a, i) => lookupAttrToCol.set(a.id, i));

	// Split every equi-pair into (T-FK column, lookup-PK column). A pair that does
	// not connect `T` to the lookup table cleanly (e.g. references a third source)
	// is unprovable ⇒ reject.
	const fkCols: number[] = [];
	const pkCols: number[] = [];
	for (const p of equiPairs) {
		let fkCol = tAttrToCol.get(p.leftAttrId);
		let pkCol = lookupAttrToCol.get(p.rightAttrId);
		if (fkCol === undefined || pkCol === undefined) {
			fkCol = tAttrToCol.get(p.rightAttrId);
			pkCol = lookupAttrToCol.get(p.leftAttrId);
		}
		if (fkCol === undefined || pkCol === undefined) return false;
		fkCols.push(fkCol);
		pkCols.push(pkCol);
	}

	const match = lookupCoveringFK(baseTable, lookupRef.tableSchema, fkCols, pkCols);
	return match !== undefined && !match.nullable;
}

/**
 * Lowercased names of the lookup-side columns in `topJoin`'s output frame — a
 * `T` attribute is exactly one whose id is a key of `baseAttrToCol`, so every
 * other join-output attribute belongs to a lookup side. Feeds the qualifier-aware
 * resolver's unqualified-name ambiguity check.
 */
function lookupColumnNames(
	topJoin: RelationalPlanNode,
	baseAttrToCol: ReadonlyMap<number, number>,
): Set<string> {
	const names = new Set<string>();
	for (const attr of topJoin.getAttributes()) {
		if (!baseAttrToCol.has(attr.id)) names.add(attr.name.toLowerCase());
	}
	return names;
}

/**
 * No-fan-out (≤1) gate for a join body: `T`'s primary key must be a unique key of
 * `topJoin`'s output relation (`isUnique`), mapped into the join output frame via
 * stable attribute ids. Checked at the join frame rather than the projected
 * `root` — see the module doc ("Why the join frame, not the projected root").
 *
 * The complementary no-row-loss (≥1) obligation is the structural side/type gate
 * in the shape walk; name-resolution safety is now the qualifier-aware resolver
 * (`makeBodyColumnResolver`), which made the former bare-name collision guard
 * unnecessary.
 */
function proveJoinNoFanout(
	topJoin: RelationalPlanNode,
	tableRef: TableReferenceNode,
	baseTable: TableSchema,
): CoverageResult {
	const joinAttrToIndex = new Map<number, number>();
	topJoin.getAttributes().forEach((a, i) => joinAttrToIndex.set(a.id, i));
	const tAttrs = tableRef.getAttributes();
	const pkInJoinFrame: number[] = [];
	for (const pk of baseTable.primaryKeyDefinition) {
		const attrId = tAttrs[pk.index]?.id;
		const joinIdx = attrId !== undefined ? joinAttrToIndex.get(attrId) : undefined;
		if (joinIdx === undefined) return notCovers('fanout');
		pkInJoinFrame.push(joinIdx);
	}
	if (!isUnique(pkInJoinFrame, topJoin)) return notCovers('fanout');

	return COVERS;
}

/**
 * Builds the qualifier-aware {@link ColumnIndexResolver} the AST ORDER BY / WHERE
 * checks use to map a column reference to a base-table `T` column index:
 *
 *  - **Qualified** (`alias.col` / `table.col`) — a `T` column only when the
 *    qualifier denotes `T`'s reference (its alias, or its table name when
 *    unaliased, collected from the body FROM clause). A qualifier denoting a
 *    lookup source (or any unknown qualifier) yields `undefined`.
 *  - **Unqualified** (`col`) — a `T` column only when `T` has it *and* no
 *    lookup-side column shares the name (`lookupNames`). An ambiguous bare name
 *    would be a plan-time error for a real body, but resolving to `undefined`
 *    here is the sound fallback regardless.
 *
 * `undefined` means "not a (resolvable) `T` column", which the ORDER BY check
 * turns into `ordering-mismatch` and the WHERE recognizer turns into an
 * unrecognized conjunct (⇒ `predicate-entailment`). For a single-source body
 * `lookupNames` is empty and `T`'s sole qualifier is in the set, so this reduces
 * to bare-name resolution — v1 behavior unchanged.
 */
function makeBodyColumnResolver(
	selectAst: AST.QueryExpr,
	baseTable: TableSchema,
	lookupNames: ReadonlySet<string>,
): ColumnIndexResolver {
	const tQualifiers = collectBaseTableQualifiers(selectAst, baseTable);
	return (expr) => {
		const ref = columnRefParts(expr);
		if (ref === undefined) return undefined;
		if (ref.qualifier !== undefined) {
			return tQualifiers.has(ref.qualifier) ? baseTable.columnIndexMap.get(ref.name) : undefined;
		}
		if (lookupNames.has(ref.name)) return undefined;
		return baseTable.columnIndexMap.get(ref.name);
	};
}

/**
 * The `(qualifier?, name)` of a column reference (both lowercased), or `undefined`
 * when `expr` is not a column reference the prover resolves. A `ColumnExpr`
 * carries an optional `table` qualifier; a bare `IdentifierExpr` has none, and a
 * schema-qualified identifier is rejected (matches `columnIndexFromExpr`).
 */
function columnRefParts(expr: AST.Expression): { qualifier?: string; name: string } | undefined {
	if (expr.type === 'column') {
		const c = expr as AST.ColumnExpr;
		return { qualifier: c.table?.toLowerCase(), name: c.name.toLowerCase() };
	}
	if (expr.type === 'identifier') {
		const id = expr as AST.IdentifierExpr;
		if (id.schema) return undefined;
		return { name: id.name.toLowerCase() };
	}
	return undefined;
}

/**
 * The set of lowercased FROM-clause qualifiers (alias, or table name when
 * unaliased) that denote the base table `T`. Walks the body FROM clause through
 * nested joins. Subquery / function sources cannot be `T` (the shape walk binds
 * `T` to a `TableReferenceNode`), so their alias is intentionally absent — a
 * reference qualified by it resolves to `undefined` (a lookup/derived column).
 */
function collectBaseTableQualifiers(selectAst: AST.QueryExpr, baseTable: TableSchema): Set<string> {
	const out = new Set<string>();
	if (selectAst.type !== 'select' || !selectAst.from) return out;
	const stack: AST.FromClause[] = [...selectAst.from];
	while (stack.length > 0) {
		const f = stack.pop()!;
		if (f.type === 'join') {
			stack.push(f.left, f.right);
			continue;
		}
		if (f.type === 'table') {
			const ts = f as AST.TableSource;
			const denotesT = ts.table.name.toLowerCase() === baseTable.name.toLowerCase()
				&& (ts.table.schema === undefined || ts.table.schema.toLowerCase() === baseTable.schemaName.toLowerCase());
			if (denotesT) out.add((ts.alias ?? ts.table.name).toLowerCase());
		}
	}
	return out;
}

/**
 * Base-table column indices named by the body's `ORDER BY`, in order, or
 * `undefined` when there is no `ORDER BY`, the body is not a plain SELECT, or any
 * ordering term does not resolve to a `T` column via `resolve` (the prover never
 * invents an ordering). `resolve` is qualifier-aware for join bodies, so an
 * `ORDER BY` on a *lookup*-side column yields `undefined` here ⇒ the caller
 * reports `ordering-mismatch`, the correct reason (it is not a `T` ordering).
 */
function bodyOrderByColumns(selectAst: AST.QueryExpr, resolve: ColumnIndexResolver): number[] | undefined {
	if (selectAst.type !== 'select') return undefined;
	const orderBy = selectAst.orderBy;
	if (!orderBy || orderBy.length === 0) return undefined;
	const cols: number[] = [];
	for (const term of orderBy) {
		const col = resolve(term.expr);
		if (col === undefined) return undefined;
		cols.push(col);
	}
	return cols;
}

/** True when `a` and `b` contain the same column indices (order-insensitive, distinct). */
function isPermutation(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
	if (a.length !== b.length) return false;
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size !== a.length || setB.size !== b.length) return false;
	for (const x of setA) if (!setB.has(x)) return false;
	return true;
}
