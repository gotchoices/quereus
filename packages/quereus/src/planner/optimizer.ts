import { createLogger } from '../common/logger.js';
import { PlanNode } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';

// Re-export for convenience
export { DEFAULT_TUNING };

import { tracePhaseStart, tracePhaseEnd } from './framework/trace.js';
import { type StatsProvider } from './stats/index.js';
import { CatalogStatsProvider } from './stats/catalog-stats.js';
import { createOptContext } from './framework/context.js';
import type { OptimizerDiagnostics } from './framework/context.js';
import { PassManager, PassId } from './framework/pass.js';
// Phase 2 rules
import { ruleMaterializedViewRewrite } from './rules/cache/rule-materialized-view-rewrite.js';
// Phase 1.5 rules
import { ruleSelectAccessPath } from './rules/access/rule-select-access-path.js';
import { ruleLensAuxiliaryAccess } from './rules/access/rule-lens-auxiliary-access.js';
import { ruleMonotonicLimitPushdown } from './rules/access/rule-monotonic-limit-pushdown.js';
import { ruleMonotonicRangeAccess } from './rules/access/rule-monotonic-range-access.js';
import { ruleAsofStrategySelect } from './rules/access/rule-asof-strategy-select.js';
import { ruleGrowRetrieve } from './rules/retrieve/rule-grow-retrieve.js';
import { rulePredicatePushdown } from './rules/predicate/rule-predicate-pushdown.js';
import { ruleAggregatePredicatePushdown } from './rules/predicate/rule-aggregate-predicate-pushdown.js';
import { ruleFilterMerge } from './rules/predicate/rule-filter-merge.js';
import { rulePredicateInferenceEquivalence } from './rules/predicate/rule-predicate-inference-equivalence.js';
import { ruleSargableRangeRewrite } from './rules/predicate/rule-sargable-range-rewrite.js';
import { ruleJoinKeyInference } from './rules/join/rule-join-key-inference.js';
import { ruleJoinGreedyCommute } from './rules/join/rule-join-greedy-commute.js';
import { ruleJoinElimination, ruleJoinEliminationUnderAggregate } from './rules/join/rule-join-elimination.js';
import { ruleJoinExistencePruning, ruleJoinExistencePruningUnderAggregate } from './rules/join/rule-join-existence-pruning.js';
import { ruleSemijoinExistenceRecovery, ruleSemijoinExistenceRecoveryUnderAggregate } from './rules/join/rule-semijoin-existence-recovery.js';
import { ruleInnerJoinExistenceRecovery } from './rules/join/rule-inner-join-existence-recovery.js';
import { ruleFanOutLookupJoin } from './rules/join/rule-fanout-lookup-join.js';
import { ruleFanOutBatchedOuter } from './rules/join/rule-fanout-batched-outer.js';
import { ruleAsyncGatherUnionAll } from './rules/parallel/rule-async-gather-union-all.js';
import { ruleAsyncGatherZipByKey } from './rules/parallel/rule-async-gather-zip-by-key.js';
import { ruleEagerPrefetchProbe } from './rules/parallel/rule-eager-prefetch-probe.js';
// Predicate pushdown rules
// Core optimization rules
import { ruleAggregatePhysical } from './rules/aggregate/rule-aggregate-streaming.js';
import { ruleGroupByFdSimplification } from './rules/aggregate/rule-groupby-fd-simplification.js';
import { ruleOrderByFdPruning } from './rules/sort/rule-orderby-fd-pruning.js';
import { ruleQuickPickJoinEnumeration } from './rules/join/rule-quickpick-enumeration.js';
import { ruleJoinPhysicalSelection } from './rules/join/rule-join-physical-selection.js';
import { ruleMonotonicMergeJoin } from './rules/join/rule-monotonic-merge-join.js';
import { ruleLateralTop1Asof } from './rules/join/rule-lateral-top1-asof.js';
import { ruleMonotonicWindow } from './rules/window/rule-monotonic-window.js';
// Constraint rules removed - now handled in builders for correctness
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleMutatingSubqueryCache } from './rules/cache/rule-mutating-subquery-cache.js';
import { ruleInSubqueryCache } from './rules/cache/rule-in-subquery-cache.js';
import { ruleSubqueryDecorrelation } from './rules/subquery/rule-subquery-decorrelation.js';
import { ruleAntiJoinFkEmpty } from './rules/subquery/rule-anti-join-fk-empty.js';
import { ruleSemiJoinFkTrivial } from './rules/subquery/rule-semi-join-fk-trivial.js';
import {
	ruleFilterFoldEmpty,
	ruleProjectFoldEmpty,
	ruleSortFoldEmpty,
	ruleLimitOffsetFoldEmpty,
	ruleDistinctFoldEmpty,
	ruleJoinFoldEmpty,
} from './rules/predicate/rule-empty-relation-folding.js';
import { ruleFilterContradiction } from './rules/predicate/rule-filter-contradiction.js';
import { ruleDistinctElimination } from './rules/distinct/rule-distinct-elimination.js';
import { ruleProjectionPruning } from './rules/retrieve/rule-projection-pruning.js';
import { ruleScalarCSE } from './rules/cache/rule-scalar-cse.js';
// Phase 3 rules
import { validatePhysicalTree } from './validation/plan-validator.js';
import { Database } from '../core/database.js';

const log = createLogger('optimizer');

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;
	private readonly passManager: PassManager;
	private lastDiagnostics: OptimizerDiagnostics | null = null;
	public tuning: OptimizerTuning;

	constructor(
		tuning: OptimizerTuning = DEFAULT_TUNING,
		stats?: StatsProvider
	) {
		this.stats = stats ?? new CatalogStatsProvider();
		this.passManager = new PassManager();
		this.tuning = tuning;

		// Register rules to their appropriate passes only (no legacy globals)
		this.registerRulesToPasses();
	}

	updateTuning(tuning: OptimizerTuning): void {
		this.tuning = tuning;
	}

	/**
	 * Register rules with their appropriate passes
	 */
	private registerRulesToPasses(): void {
		// Materialized-view query rewrite (read side). Registered FIRST in the
		// Structural pass so it fires on the pristine `Project(Filter?(Retrieve(
		// TableReference)))` — before grow-retrieve / predicate-pushdown reposition
		// the Filter and before the Physical pass absorbs a predicate into a range
		// scan — where the matcher can read the fragment's WHERE off the live plan.
		// Pass rules fire in REGISTRATION order (not by `priority`), so placement here
		// is what guarantees first-fire. Logical→logical: the substituted maintained-table
		// TableReference then flows through normal physical access selection, so
		// `query_plan()` shows an ordinary scan of the MV's own table for free.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'materialized-view-rewrite',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleMaterializedViewRewrite,
			priority: 6,
			// Replaces a read-only scan-project-filter fragment with a provably
			// row-equivalent backing scan; the dropped base-scan subtree is pure (the
			// matcher admits only recognized predicates, no subqueries) and the
			// replacement re-emits the fragment's identical output attribute ids.
			sideEffectMode: 'safe',
		});
		// Aggregate arm of the same rewrite (`mv-query-rewrite-aggregate-rollup`):
		// recognizes a logical `Aggregate(Filter?(scan))` answered from a grouped MV
		// (exact-key direct scan or superset-key rollup re-aggregation). Registered as
		// a SECOND handle because pass rules fire only on their `nodeType` and are
		// deduped by id — so the aggregate arm needs the `Aggregate` node type and a
		// distinct id. It honors the canonical `materialized-view-rewrite` disable
		// switch internally (see the rule), so existing rule-disable controls turn off
		// both arms. Registered immediately after the Project arm so it likewise fires
		// on the pristine fragment, before grow-retrieve / predicate-pushdown.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'materialized-view-rewrite-aggregate',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleMaterializedViewRewrite,
			priority: 6,
			sideEffectMode: 'safe',
		});

		// Structural pass rules (top-down) - for operations that need parent context
		// Register grow-retrieve for ALL relational node types
		// The rule itself will determine if growth is possible
		const relationalNodeTypes = [
			PlanNodeType.Filter,
			PlanNodeType.Project,
			PlanNodeType.Sort,
			PlanNodeType.LimitOffset,
			PlanNodeType.Aggregate,
			PlanNodeType.Distinct,
			PlanNodeType.Join,
			PlanNodeType.Window,
			// Add any other relational node types as needed
		];

		for (const nodeType of relationalNodeTypes) {
			this.passManager.addRuleToPass(PassId.Structural, {
				id: `grow-retrieve-${nodeType}`,
				nodeType,
				phase: 'rewrite',
				fn: ruleGrowRetrieve,
				priority: 10,
				// Slides operators down into a Retrieve boundary, whose pipeline is
				// always a read by construction (RetrieveNode is the vtab read entry).
				sideEffectMode: 'safe',
			});
		}

		// Join key inference (structural/characteristic)
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-key-inference',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinKeyInference,
			priority: 15,
			// Diagnostic-only: never returns a transformed node.
			sideEffectMode: 'safe',
		});

		// Greedy join commute: place smaller input on the left to improve nested-loop-like costs
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-greedy-commute',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinGreedyCommute,
			priority: 16,
			// Swaps left/right of an inner join — would reorder side-effect
			// execution. The rule refuses when either side carries a write.
			sideEffectMode: 'aware',
		});

		// DISTINCT elimination: remove redundant DISTINCT when source already has unique keys
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'distinct-elimination',
			nodeType: PlanNodeType.Distinct,
			phase: 'rewrite',
			fn: ruleDistinctElimination,
			priority: 18,
			// Unwraps DISTINCT around its source; source survives verbatim and any
			// writes inside it still execute the same number of times.
			sideEffectMode: 'safe',
		});

		// Projection pruning: remove unused inner projections in Project-on-Project
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'projection-pruning',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleProjectionPruning,
			priority: 19,
			// Drops unreferenced inner projections — refuses to drop any whose
			// scalar expression carries a side effect.
			sideEffectMode: 'aware',
		});

		// Lens auxiliary-access routing: route an outer-query predicate over an
		// inlined lens view through an advertised auxiliary structure (nd-tree /
		// vector / full-text) — an auxiliary seek ⋈ logical-key semi-join — instead
		// of a residual filter over the full decomposition scan. Registered BEFORE
		// predicate-pushdown (priority 20) so the matched predicate is still directly
		// above the LensAuxiliaryAccess marker when this fires; within the top-down
		// Structural pass, rules run in registration order, so placing this block
		// ahead of pushdown is what guarantees first-fire on the Filter. No-ops on
		// any Filter whose subtree has no marker (every non-lens / non-routable-lens
		// view), so ordinary queries are untouched.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'lens-auxiliary-access',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleLensAuxiliaryAccess,
			priority: 17,
			// Replaces a Filter over the lens marker with a semi-join against an
			// auxiliary scan; the logical body (left) survives verbatim and the
			// auxiliary scan it adds is a fresh read-only table reference.
			sideEffectMode: 'safe',
		});

		// Sargable range rewrite: turn `f(col) = c` (for monotone-lossy `f` with
		// a bucketBounds-aware logical type) into `col >= L AND col < U` so the
		// subsequent pushdown wave can carry the bare `col op literal` shape into
		// Retrieve / access-path selection. Runs before aggregate-predicate-pushdown
		// (priority 19) and predicate-pushdown (priority 20) so the rewritten
		// conjuncts ride the same pushdown pass.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'sargable-range-rewrite',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleSargableRangeRewrite,
			priority: 18,
			// Rewrites a single scalar conjunct shape in place; no subtree moved.
			sideEffectMode: 'safe',
		});

		// Aggregate-aware predicate pushdown: splits a Filter above an aggregate so
		// conjuncts on GROUP-BY-determined columns land below the aggregate. Runs
		// before the cross-node predicate pushdown (priority 20) so anything we
		// push below the aggregate can propagate further via that rule.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'aggregate-predicate-pushdown',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleAggregatePredicatePushdown,
			priority: 19,
			// Moves Filter conjuncts below an Aggregate, changing which rows reach
			// the source subtree. Refuses when source has side effects.
			sideEffectMode: 'aware',
		});

		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'predicate-pushdown',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: rulePredicatePushdown,
			priority: 20,
			// Slides Filter past Sort/Distinct/Project/Alias/Retrieve, changing
			// which rows reach the layer below — refuses when the immediate child
			// subtree carries a write.
			sideEffectMode: 'aware',
		});

		// Filter merge: combine adjacent Filter nodes into one AND-combined Filter
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'filter-merge',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterMerge,
			priority: 21,
			// Merges two adjacent Filters into AND; the source subtree is untouched
			// and only the order of predicate-clause evaluation changes (predicates
			// are pure today; the audit gate that DML-in-expression-position needs
			// is on rules that move or drop SUBTREES, not predicate ASTs).
			sideEffectMode: 'safe',
		});

		// Scalar CSE: deduplicate common scalar expressions across Project + Filter + Sort chains
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'scalar-cse',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleScalarCSE,
			priority: 22,
			// Deduplicates scalar expressions — would silently collapse N copies of
			// a side-effect-bearing scalar into 1. The rule's collector skips any
			// non-deterministic or side-effect-bearing expression.
			sideEffectMode: 'aware',
		});

		// EC-driven predicate inference: materialize inferred equality predicates
		// from the cross of predicate-derived constant bindings and the source's
		// equivalence classes. Runs after predicate-pushdown (priority 20) and
		// filter-merge (priority 21) so the predicate is already consolidated and
		// pushdown won't immediately reabsorb the inferred conjuncts on this
		// iteration; the Structural pass's fixed-point loop then re-runs pushdown
		// on subsequent iterations so the new conjuncts can be carried to
		// branch-level Retrieve pipelines.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'predicate-inference-equivalence',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: rulePredicateInferenceEquivalence,
			priority: 22,
			// Materializes inferred equality conjuncts and optionally injects
			// branch filters above an inner/cross join's children — would change
			// which rows reach a side-effect-bearing branch. Refuses branch
			// injection when the target branch has side effects.
			sideEffectMode: 'aware',
		});

		// GROUP BY FD simplification: drop GROUP BY columns determined by other
		// GROUP BY columns under the aggregate's output FDs + ECs. Picker MIN()
		// aggregates re-emit the dropped columns so output attribute IDs survive.
		// Runs after aggregate-predicate-pushdown (priority 19) so filter-derived
		// ECs are already on the aggregate's source, and before
		// ruleAggregatePhysical (Physical pass) so the smaller GROUP BY feeds
		// the stream/hash decision.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'groupby-fd-simplification',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleGroupByFdSimplification,
			priority: 23,
			// Drops bare-column GROUP BY entries (re-emitting them as picker
			// aggregates). The dropped expressions are pure ColumnReferenceNodes
			// by construction, so no side-effect-bearing scalar can be lost.
			sideEffectMode: 'safe',
		});

		// Join existence-flag pruning (demand-gated): drop an `exists … as` match
		// flag from a JoinNode when no ancestor demands its output attribute id, so
		// `hasExistenceColumns` flips false on the last drop and the five
		// flag-guarded join rules re-enable. Registered AFTER projection-pruning
		// (19) / predicate-pushdown (20) / scalar-cse (22) so the demand set is
		// settled, and BEFORE fanout-lookup-join (23) and join-elimination (24) so
		// the freshly-pruned Project threads through them in the same applyRules
		// loop. The PostOptimization join rules (join-physical-selection,
		// monotonic-merge-join) and the Structural Join-typed lateral-top1-asof
		// (visited top-down after this ancestor Project) see the flag-free join
		// automatically.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-existence-pruning',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleJoinExistencePruning,
			priority: 22,
			// Drops only a derived, read-only `{true,false}` boolean column; both
			// join sides survive verbatim, so no write can be skipped or reordered.
			sideEffectMode: 'safe',
		});

		// Aggregate variant of existence-flag pruning: drop an `exists … as` match
		// flag from a JoinNode reachable through a pass-through chain under an
		// AggregateNode (the Project entrypoint never sees this shape). Priority 22
		// mirrors the Project entrypoint and places it BEFORE
		// join-elimination-aggregate (priority 26), so a freshly-pruned Aggregate
		// threads into that rule in the same applyRules loop — the aggregate-side
		// analogue of why join-existence-pruning (22) runs before
		// join-elimination (24).
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-existence-pruning-aggregate',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleJoinExistencePruningUnderAggregate,
			priority: 22,
			// Same as the Project entrypoint: drops only a derived, read-only
			// `{true,false}` boolean column; both join sides survive verbatim and
			// the Aggregate is reconstructed with identical groupBy / aggregates /
			// output attrs (a pure source swap), so no write can be skipped.
			sideEffectMode: 'safe',
		});

		// Semi/anti-join existence-flag recovery (demand-SHAPE gated): the complement
		// of `join-existence-pruning`. When the sole `exists … as` flag on a
		// `left join` is demanded ONLY as a top-level boolean probe
		// (`where flag` ⇒ semi, `where not flag` ⇒ anti), rewrite the JoinNode to the
		// equivalent semi/anti join — the same shape `subquery-decorrelation` emits —
		// re-opening physical join selection and the IND-folding cascade. Registered
		// AFTER `join-existence-pruning` (so an undemanded sibling flag is dropped
		// first, maximizing the sole-spec precondition) and BEFORE
		// `fanout-lookup-join` / `join-elimination` and the IND folders
		// `anti-join-fk-empty` / `semi-join-fk-trivial` (Join, registered below) so
		// the recovered semi/anti threads into them in the same applyRules loop —
		// exactly why `subquery-decorrelation` precedes those folders. Pass rules fire
		// in REGISTRATION order, so this placement (22 < priority 23 < 26) is what
		// realizes the ordering; the priority value is documentation.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'semijoin-existence-recovery',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleSemijoinExistenceRecovery,
			priority: 23,
			// Recovers a semi/anti join, which short-circuits the right side's scan at
			// the first match — changing R's execution count. Refuses when R carries a
			// write (mirrors subquery-decorrelation's impure-inner refusal).
			sideEffectMode: 'aware',
		});

		// Inner-join existence-flag recovery (demand-SHAPE gated): the fallback
		// complement of `semijoin-existence-recovery`. When the sole `exists … as`
		// flag on a `left join` is a POSITIVE top-level probe (`where flag`) AND
		// EITHER ≥1 right-side column is demanded above the join OR R fans out
		// (non-unique on the join column, where a semi join would unsoundly collapse
		// duplicates), rewrite the JoinNode to a plain `inner join` (drop the flag,
		// keep both sides) — re-opening physical join selection, non-nullable right
		// typing, and the FK/IND cascade the live flag pinned shut. The two recovery
		// rules consult the SAME `rightMatchesAtMostOne` and so are provably disjoint
		// on the positive-probe space INDEPENDENT of registration order (semi fires
		// iff !rightColDemanded && unique-R; inner iff rightColDemanded || !unique-R).
		// Registered (in registration order) BEFORE `fanout-lookup-join` /
		// `join-elimination` (24) / the Join-typed IND folders (26) so the recovered
		// inner join threads into them in the same applyRules loop.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'inner-join-existence-recovery',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleInnerJoinExistenceRecovery,
			priority: 23,
			// Logically scans R the same number of times as the flag-bearing left
			// join, but dropping the flag re-enables join-physical-selection, which can
			// pick a hash join that scans R once total — changing an impure R's
			// execution count. Refuses when R carries a write (mirrors the sibling).
			sideEffectMode: 'aware',
		});

		// Aggregate counterpart of `semijoin-existence-recovery`: the same probe-only
		// flag recovery anchored on an `AggregateNode` for the bare `count(*) … where
		// flag` / `group by` shape that plans with NO enclosing Project (the probe
		// Filter + flag-bearing join sit under the Aggregate, so the Project entrypoint
		// never fires). Registered (in registration order) AFTER
		// `join-existence-pruning-aggregate` (22, so an undemanded sibling flag is
		// dropped first, maximizing the sole-spec precondition) and BEFORE the
		// Join-typed IND folders `anti-join-fk-empty` / `semi-join-fk-trivial` and
		// `join-elimination-aggregate` (all 26), so the recovered semi/anti threads
		// into them in the same applyRules loop — the aggregate analogue of the Project
		// rule's placement. No nodeType collision with the Project `semijoin-existence-
		// recovery` (Project vs Aggregate). Unlike the Project anchor it has NO inner
		// fallback: a right-col-demanded / fan-out positive probe stays `left`.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'semijoin-existence-recovery-aggregate',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleSemijoinExistenceRecoveryUnderAggregate,
			priority: 23,
			// Recovers a semi/anti join under an Aggregate — short-circuits R's scan at
			// the first match (semi), changing R's execution count. Same impure-R refusal
			// as the Project entrypoint.
			sideEffectMode: 'aware',
		});

		// Fan-out lookup join (FK→PK): cluster N LEFT/INNER nested-loop joins from
		// a common outer into one parallel `FanOutLookupJoinNode` when the cost
		// gate (per-branch latency × (N - cap) > N × branchSetupCost) approves.
		// Runs *before* `join-elimination` (priority 24) so the rule sees the full
		// branch set; elimination would otherwise steal any single branch whose
		// non-preserved side isn't referenced upstream. The rule's cost gate is
		// inert when `expectedLatencyMs === 0`, so memory-vtab chains never
		// transform (single golden-plan sweep verified — see
		// test/optimizer/parallel-fanout.spec.ts).
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fanout-lookup-join',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleFanOutLookupJoin,
			priority: 23,
			// Clusters per-outer-row branches into a parallel fan-out — drives
			// branches concurrently. Refuses to cluster a branch whose subtree
			// carries a write.
			sideEffectMode: 'aware',
		});

		// Join elimination (FK→PK): drop LEFT/INNER joins whose non-preserved side
		// is never referenced above the join and is at-most-one-matching per a
		// declared FK→PK relationship. Runs after predicate-pushdown (priority 20)
		// so any pushed-up filter that *uses* the eliminable side has had a chance
		// to land below the join (and thereby protect itself from elimination).
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-elimination',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleJoinElimination,
			priority: 24,
			// Drops the non-preserved side of a join — refuses to drop a subtree
			// that carries a write.
			sideEffectMode: 'aware',
		});

		// Subquery decorrelation: transform correlated EXISTS/IN into semi/anti joins
		// Runs after predicate pushdown (priority 25 > 20) so inner predicates are already pushed
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'subquery-decorrelation',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleSubqueryDecorrelation,
			priority: 25,
			// Transforms EXISTS(correlated) / IN(correlated) into semi/anti
			// joins, changing how many times the inner subquery's subtree is
			// executed — refuses when the inner subtree carries a write.
			sideEffectMode: 'aware',
		});

		// IND-driven existence folding (priority 26 — runs after decorrelation has
		// materialized EXISTS / NOT EXISTS as semi/anti joins):
		//   - Anti-join over a covering non-null FK → Filter(L, false)
		//   - Semi-join over a covering FK → drop join (or Filter L on IS NOT NULL
		//     when the FK is nullable)
		// Both rules read `lookupCoveringFK` from `util/ind-utils.ts`.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'anti-join-fk-empty',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleAntiJoinFkEmpty,
			priority: 26,
			// Folds an anti-join to EmptyRelation, dropping both sides. Refuses
			// when either side carries a write.
			sideEffectMode: 'aware',
		});

		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'semi-join-fk-trivial',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleSemiJoinFkTrivial,
			priority: 26,
			// Drops the R side of a semi-join (replacing with a NOT NULL filter on
			// L). Refuses when R carries a write.
			sideEffectMode: 'aware',
		});

		// Aggregate variant of join-elimination: when an Aggregate sits over an
		// FK-covered left/right/inner join and only references the FK side (or `count(*)`),
		// drop the join. Shares chain-walking + FK-PK alignment with
		// ruleJoinElimination via the same module.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'join-elimination-aggregate',
			nodeType: PlanNodeType.Aggregate,
			phase: 'rewrite',
			fn: ruleJoinEliminationUnderAggregate,
			priority: 26,
			// Drops the non-preserved side of a left/right/inner join sitting under
			// an Aggregate — same guard as ruleJoinElimination.
			sideEffectMode: 'aware',
		});

		// ORDER BY FD pruning: drop trailing ORDER BY keys functionally determined
		// by the leading bare-column keys (under the source's FDs + ECs). Reduces
		// multi-key sorts to single-key sorts when a leading key (e.g. a primary
		// key) determines the rest, which in turn lets `monotonic-limit-pushdown`
		// (PostOptimization priority 8) fire. Structural runs before
		// PostOptimization, so the ordering is automatic. Priority 26 — independent
		// of `subquery-decorrelation` (25); the relative ordering across these
		// Structural priorities is not load-bearing for this rule.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'orderby-fd-pruning',
			nodeType: PlanNodeType.Sort,
			phase: 'rewrite',
			fn: ruleOrderByFdPruning,
			priority: 26,
			// Drops trailing ORDER BY keys (or the whole Sort) — the keys are
			// either bare ColumnReferenceNodes (pure) or kept opaque. The Sort's
			// source is preserved verbatim. Whole-Sort elimination is also safe:
			// it returns `node.source`, so every subtree below survives intact.
			sideEffectMode: 'safe',
		});

		// Predicate-contradiction folding (priority 27 — after IND rules at 26):
		// detect when (filter predicate ∧ source domainConstraints ∧ literal
		// constantBindings) is provably unsatisfiable, and emit EmptyRelationNode
		// carrying the Filter's own schema. Runs alongside the empty-relation
		// folding rules so its output cascades up the same pass.
		//
		// Inner-join `on`-clause contradiction is intentionally NOT registered
		// here. The filter rule already covers WHERE clauses pushed onto the
		// lowest Filter by `predicate-pushdown`; the join-on variant is tracked
		// as follow-up work — it requires deciding how to preserve the join's
		// post-rewrite output schema for parent operators that reference the
		// right side's attribute IDs.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'filter-contradiction',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterContradiction,
			priority: 27,
			// Replaces the Filter (and its source) with EmptyRelation — refuses
			// when the source subtree carries a write.
			sideEffectMode: 'aware',
		});

		// Empty-relation folding (priority 27 — after IND rules at 26): recognize
		// provably-empty subtrees (Filter on lit-false, or any host with an
		// EmptyRelation source under appropriate join semantics) and replace them
		// with EmptyRelationNode carrying the host's attribute IDs. Cascades to a
		// fixed point via the Structural pass loop.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-filter-empty',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleFilterFoldEmpty,
			priority: 27,
			// `Filter(x, lit-false)` drops `x` — refuses when `x` has side effects.
			sideEffectMode: 'aware',
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-project-empty',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleProjectFoldEmpty,
			priority: 27,
			// Fires only when source is already an EmptyRelation (a pure marker
			// with no children); side-effect-bearing subtree cannot reach this
			// fold without itself first being folded.
			sideEffectMode: 'safe',
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-sort-empty',
			nodeType: PlanNodeType.Sort,
			phase: 'rewrite',
			fn: ruleSortFoldEmpty,
			priority: 27,
			// Source is EmptyRelation; see fold-project-empty.
			sideEffectMode: 'safe',
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-limit-empty',
			nodeType: PlanNodeType.LimitOffset,
			phase: 'rewrite',
			fn: ruleLimitOffsetFoldEmpty,
			priority: 27,
			// Source is EmptyRelation; see fold-project-empty.
			sideEffectMode: 'safe',
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-distinct-empty',
			nodeType: PlanNodeType.Distinct,
			phase: 'rewrite',
			fn: ruleDistinctFoldEmpty,
			priority: 27,
			// Source is EmptyRelation; see fold-project-empty.
			sideEffectMode: 'safe',
		});
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'fold-join-empty',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleJoinFoldEmpty,
			priority: 27,
			// Folds an inner/cross/semi/anti join with an empty side to Empty,
			// dropping the *other* side — refuses when the dropped side carries
			// a write.
			sideEffectMode: 'aware',
		});

		// Physical pass rules (bottom-up) - for logical to physical transformations
		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'select-access-path',
			nodeType: PlanNodeType.Retrieve,
			phase: 'impl',
			fn: ruleSelectAccessPath,
			priority: 10,
			// Replaces a logical Retrieve with a physical access node over the
			// same TableReference — read-only by construction.
			sideEffectMode: 'safe',
		});

		// QuickPick join enumeration (optional via tuning)
		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'quickpick-join-enumeration',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleQuickPickJoinEnumeration,
			priority: 5,
			// Reorders inner-join trees by cost — would change side-effect
			// execution order. Refuses when any leaf relation has side effects.
			sideEffectMode: 'aware',
		});

		this.passManager.addRuleToPass(PassId.Physical, {
			id: 'aggregate-physical',
			nodeType: PlanNodeType.Aggregate,
			phase: 'impl',
			fn: ruleAggregatePhysical,
			priority: 20,
			// Selects Stream vs Hash aggregate; the source is preserved verbatim
			// (or wrapped in a Sort, which executes its source once).
			sideEffectMode: 'safe',
		});

		// Recognize lateral-top-1 asof. Runs in the Structural pass (before
		// predicate-pushdown at priority 20) so the lateral's Filter still
		// carries the asof predicate intact — predicate-pushdown would
		// otherwise consume it into the inner Retrieve pipeline.
		this.passManager.addRuleToPass(PassId.Structural, {
			id: 'lateral-top1-asof',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleLateralTop1Asof,
			priority: 5,
			// Recognizes a very narrow shape (Project/Limit/Sort/Filter chain
			// over a vtab leaf that advertises asofRight) — leaf must be a
			// physical TableReference, so all participating subtrees are
			// read-only by construction.
			sideEffectMode: 'safe',
		});

		// Post-optimization pass rules (bottom-up) - for cleanup and caching
		// Physical join selection runs here (after Physical pass) so QuickPick can
		// see the full logical join tree before any physical conversion happens.
		// Monotonic-aware merge-join recognition runs first (lower priority) so
		// it can recognise cases where both sides advertise MonotonicOn but
		// `physical.ordering` does not match positionally — once it converts a
		// Join into a MergeJoin, the ordering-based rule no-ops on it.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-merge-join',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleMonotonicMergeJoin,
			priority: 4,
			// Replaces a logical Join with a MergeJoin; both children survive
			// in their original positions (no swap).
			sideEffectMode: 'safe',
		});

		// Monotonic streaming-window recognition. Runs after monotonic-merge-join
		// (priority 4) so child joins have already become MergeJoins and
		// propagate their `monotonicOn`; runs before monotonic-limit-pushdown
		// (priority 8) but does not interact with it (different node type).
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-window',
			nodeType: PlanNodeType.Window,
			phase: 'impl',
			fn: ruleMonotonicWindow,
			priority: 6,
			// Tags the WindowNode with a streaming config in place; source and
			// functions are preserved verbatim.
			sideEffectMode: 'safe',
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'join-physical-selection',
			nodeType: PlanNodeType.Join,
			phase: 'impl',
			fn: ruleJoinPhysicalSelection,
			priority: 5,
			// May swap build/probe sides of an INNER hash join — would reorder
			// side-effect execution. Refuses when either side has side effects.
			sideEffectMode: 'aware',
		});

		// Monotonic LIMIT/OFFSET pushdown: replace LimitOffset[/Sort]/access-leaf
		// with OrdinalSlice when the leaf advertises supportsOrdinalSeek. Runs in
		// PostOptimization so the leaf already carries its physical capabilities.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-limit-pushdown',
			nodeType: PlanNodeType.LimitOffset,
			phase: 'impl',
			fn: ruleMonotonicLimitPushdown,
			priority: 8,
			// Slides LIMIT/OFFSET into a physical access leaf via OrdinalSlice;
			// only fires when the chain peels to a SeqScan/IndexScan/IndexSeek
			// (all read-only by construction).
			sideEffectMode: 'safe',
		});

		// Monotonic range-scan recognition. Runs on physical leaves to annotate
		// `rangeBoundedOn` when a handled range/equality bounds the monotonic
		// column. Also runs on Filter nodes for the defensive escalation: drop
		// `monotonicOn` from a leaf when an unhandled range predicate sits in a
		// directly-overhead Filter. Runs after the limit pushdown (priority 9)
		// so that an OrdinalSlice rewrite has already replaced any leaf it
		// would have annotated; ordering vs. join-physical-selection (priority 5)
		// is not load-bearing — `rangeBoundedOn` is a pure annotation today and
		// the defensive drop only matters for downstream rules that check
		// `physical.monotonicOn` (asof/merge-join/limit-pushdown), which run
		// later in the same pass or have already run.
		const rangeAccessLeafTypes = [
			PlanNodeType.IndexScan,
			PlanNodeType.IndexSeek,
			PlanNodeType.SeqScan,
		];
		for (const nodeType of rangeAccessLeafTypes) {
			this.passManager.addRuleToPass(PassId.PostOptimization, {
				id: `monotonic-range-access-${nodeType}`,
				nodeType,
				phase: 'rewrite',
				fn: ruleMonotonicRangeAccess,
				priority: 9,
				// Pure annotation of a physical access leaf (read-only).
				sideEffectMode: 'safe',
			});
		}
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'monotonic-range-access-filter',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: ruleMonotonicRangeAccess,
			priority: 9,
			// Defensive escalation: drops a leaf's monotonicOn advertisement;
			// the leaf and Filter source tree survive verbatim.
			sideEffectMode: 'safe',
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'mutating-subquery-cache',
			nodeType: PlanNodeType.Join,
			phase: 'rewrite',
			fn: ruleMutatingSubqueryCache,
			priority: 10,
			// Specifically *targets* side-effect-bearing right sides and wraps
			// them in a run-once CacheNode — the canonical aware rule.
			sideEffectMode: 'aware',
		});

		// AsofScan strategy selection (hash → merge). Runs after the leaves'
		// physical.ordering / monotonicOn are finalized (range-access at
		// priority 9) so the predicate-driven check can read them off.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'asof-strategy-select',
			nodeType: PlanNodeType.AsofScan,
			phase: 'impl',
			fn: ruleAsofStrategySelect,
			priority: 11,
			// Flips a strategy field on an existing AsofScan; children survive.
			sideEffectMode: 'safe',
		});

		// Async-gather UNION ALL fold: collapse a chain of
		// SetOperationNode(unionAll) into one N-ary AsyncGatherNode(unionAll)
		// when every flattened child clears `concurrencySafe` AND the slowest
		// child meets `tuning.parallel.gatherThresholdMs`. Runs after
		// `asof-strategy-select` (priority 11) — by which point physical-pass
		// selection has finalized `expectedLatencyMs` / `concurrencySafe` on
		// the leaves — and before `materialization-advisory` (priority 30) so
		// any cache the advisory introduces sits *inside* each gather branch
		// (preserving the parallel-drive overlap of high-latency I/O with
		// branch-local compute). The cost gate is inert on memory-vtab
		// plans (expectedLatencyMs=0), so the local-only golden-plan sweep
		// is unaffected.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'async-gather-union-all',
			nodeType: PlanNodeType.SetOperation,
			phase: 'rewrite',
			fn: ruleAsyncGatherUnionAll,
			priority: 17,
			// Drives N branches concurrently — would interleave writes from
			// side-effect-bearing branches in non-deterministic order. Refuses
			// when any branch carries a write.
			sideEffectMode: 'aware',
		});

		// Async-gather ZIP BY KEY fold: collapse a `Project` over a chain of
		// binary full-outer `JoinNode`s sharing a common key set into one N-ary
		// AsyncGatherNode(zipByKey). Same gates and placement rationale as
		// `async-gather-union-all` (concurrencySafe + gatherThresholdMs +
		// uncorrelated branches; inert on memory-vtab plans where
		// expectedLatencyMs=0). Matches `Project` rather than `SetOperation`;
		// the full-outer chain underneath has no other physical lowering, so it
		// survives untouched to this pass.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'async-gather-zip-by-key',
			nodeType: PlanNodeType.Project,
			phase: 'rewrite',
			fn: ruleAsyncGatherZipByKey,
			priority: 17,
			// Concurrent N-ary zip by key — same concern as union-all gather.
			sideEffectMode: 'aware',
		});

		// Eager-prefetch probe wrap: when a physical hash join's build (right)
		// side is high-latency, wrap the probe (left) side in an
		// `EagerPrefetchNode` so the buffered pump pipelines probe reads with
		// the parent emit's per-row work. Gated on
		// `right.physical.expectedLatencyMs >= prefetchProbeThresholdMs`, which
		// is 0 on memory-vtab leaves — so the rule is inert on local-only plans
		// (the golden-plan sweep is unaffected). Runs after `mutating-subquery-
		// cache` (priority 10) and `asof-strategy-select` (priority 11) — by
		// which point leaf physical properties incl. `expectedLatencyMs` are
		// finalized — and before `cte-optimization` (priority 20) and
		// `materialization-advisory` (priority 30), so the advisory sees the
		// prefetch-wrapped tree and does not re-wrap the probe in a Cache.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'eager-prefetch-probe',
			nodeType: PlanNodeType.HashJoin,
			phase: 'rewrite',
			fn: ruleEagerPrefetchProbe,
			priority: 15,
			// Wraps the probe side in a concurrent prefetch pump — iterates the
			// probe subtree concurrently with the build side, which would
			// interleave writes. Refuses when either side has side effects.
			sideEffectMode: 'aware',
		});

		// Fan-out batched-outer recognition: flip an already-formed
		// `FanOutLookupJoinNode` from serial to batched outer mode when the per-row
		// branch count under-saturates the global in-flight budget, the slowest
		// branch is high-latency, and the outer cardinality is large enough for
		// cross-row pipelining to pay off. Runs after physical selection (so leaf
		// expectedLatencyMs / estimatedRows / concurrencySafe are final) and before
		// `materialization-advisory` (priority 30) so the EagerPrefetch the rule
		// wraps the outer in is already in place when the advisory walks the tree.
		// Inert on memory-vtab plans (expectedLatencyMs = 0 AND estimatedRows = 0),
		// so the golden-plan sweep is unaffected.
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'fanout-batched-outer',
			nodeType: PlanNodeType.FanOutLookupJoin,
			phase: 'rewrite',
			fn: ruleFanOutBatchedOuter,
			priority: 16,
			// Flips fan-out outer pump to batched (concurrent) — interleaves
			// outer iteration with branch lookups. Refuses on side-effect outer.
			sideEffectMode: 'aware',
		});

		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'cte-optimization',
			nodeType: PlanNodeType.CTE,
			phase: 'rewrite',
			fn: ruleCteOptimization,
			priority: 20,
			// Wraps a CTE source in CacheNode. CacheNode materializes on first
			// read and replays on subsequent reads — a run-once fence over the
			// source, so a side-effect-bearing CTE that was previously rerun
			// per reference would now run once. That is sound but order-changing,
			// so the rule is aware of side effects.
			sideEffectMode: 'aware',
		});

		// IN-subquery caching: wrap uncorrelated IN subquery sources in CacheNode
		this.passManager.addRuleToPass(PassId.PostOptimization, {
			id: 'in-subquery-cache',
			nodeType: PlanNodeType.In,
			phase: 'rewrite',
			fn: ruleInSubqueryCache,
			priority: 25,
			// Already gates on `isFunctional(source)` (deterministic + read-only).
			sideEffectMode: 'aware',
		});

		// The materialization advisory no longer registers per-node-type rules
		// here. It runs once over the whole plan as a dedicated custom-execute
		// pass (`PassId.Materialization`, order 35 — after PostOptimization so it
		// observes the CacheNodes injected by `cte-optimization` /
		// `in-subquery-cache`). See `createMaterializationPass` in framework/pass.ts
		// for the single-walk rationale and the side-effect-soundness argument.

		log('Registered rules to optimization passes');
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode, db: Database): PlanNode {
		log('Starting optimization of plan', plan.nodeType);

		// Create optimization context
		const context = createOptContext(this, this.stats, this.tuning, db);

		tracePhaseStart('optimization');
		try {
			// Execute all optimization passes
			const optimizedPlan = this.passManager.execute(plan, context);

			// Capture diagnostics snapshot for external consumers
			this.lastDiagnostics = { ...context.diagnostics };

			// Final validation (if enabled)
			if (this.tuning.debug.validatePlan) {
				log('Running plan validation');
				try {
					validatePhysicalTree(optimizedPlan);
					log('Plan validation passed');
				} catch (error) {
					log('Plan validation failed: %s', error);
					throw error;
				}
			}

			return optimizedPlan;
		} finally {
			tracePhaseEnd('optimization');
		}
	}

	/**
	 * Run only non-physical passes to obtain a structurally rewritten logical plan
	 * suitable for pre-physical analysis (e.g., row-specific classification).
	 */
	optimizeForAnalysis(plan: PlanNode, db: Database): PlanNode {
		log('Starting pre-physical analysis optimization of plan', plan.nodeType);

		const context = createOptContext(this, this.stats, this.tuning, db);
		tracePhaseStart('pre-physical-analysis');
		try {
			// Execute constant folding + structural passes (PassManager runs constant folding as its first pass)
			const structuralOnly = this.passManager.executeUpTo(plan, context, PassId.Structural);
			this.lastDiagnostics = { ...context.diagnostics };
			return structuralOnly;
		} finally {
			tracePhaseEnd('pre-physical-analysis');
		}
	}

	/**
	 * Get the statistics provider
	 */
	getStats(): StatsProvider {
		return this.stats;
	}

	/** Get diagnostics from the last optimization run */
	getLastDiagnostics(): OptimizerDiagnostics | null {
		return this.lastDiagnostics;
	}
}
