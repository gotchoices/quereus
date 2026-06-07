/**
 * Rule: Semi/Anti-Join Existence-Flag Recovery (demand-SHAPE gated)
 *
 * The complement of `join-existence-pruning`. That rule drops an `exists … as`
 * flag only when **nothing** demands its attr id (a demand-PRESENCE prune). This
 * rule handles the opposite shape: the flag **is** demanded, but **only** as a
 * pure boolean existence probe at the top level
 * (`where <flag>` / `where not <flag>`). That is exactly a semi / anti-join, and
 * rewriting it as one re-opens the access-path choice the live flag forfeits
 * (`join-physical-selection`) and threads into the IND-folding cascade
 * (`semi-join-fk-trivial` / `anti-join-fk-empty`).
 *
 *   select c.* from child c left join parent p on p.pk = c.fk exists right as h
 *     where h;        -- ⇒ SemiJoin(child, parent, p.pk = c.fk)   (rows WITH a match)
 *     where not h;    -- ⇒ AntiJoin(child, parent, p.pk = c.fk)   (rows with NO match)
 *
 * This is a **pure optimization**: the nested-loop+flag plan is already correct,
 * just slower than the semi/anti shape. The deliverable is byte-identical rows
 * plus a re-enabled physical/IND cascade.
 *
 * ## Q1 — Anchor: `ProjectNode`, not `FilterNode`
 *
 * A `FilterNode` anchor (mirroring `ruleSubqueryDecorrelation`) would be UNSOUND
 * here. Decorrelation is output-preserving at the Filter level
 * (`Filter[EXISTS](outer)` and `SemiJoin(outer,inner)` both expose *outer*'s
 * columns), so it never has to look above the Filter. Our probe Filter sits above
 * a `left join` whose output is `[left…, right…, flag]` and passes all of it
 * through; rewriting the join to semi changes the Filter's output to `[left…]` —
 * dropping the right columns and the flag. Soundness therefore REQUIRES proving
 * that nothing above the Filter references a right-side column or the flag (except
 * the probe we strip), and a rule only sees its own subtree. `ProjectNode` is the
 * correct anchor for the same reason `join-existence-pruning` uses it: a Project's
 * output is exactly one attribute per projection, so collecting demand from the
 * projections bounds everything any ancestor can reference. The probe Filter is
 * reached via the same whitelisted pass-through chain (`walkChain`) and rewritten
 * in place during chain reconstruction.
 *
 * ## Q2 — Demand-SHAPE proof ("used ONLY as a boolean probe")
 *
 * Let `J` be the flag-bearing `JoinNode` reached by the chain walk, with sole
 * existence spec `f` (`flagId = f.attrId`). The rewrite is legal iff:
 *
 *  1. **Sole probe conjunct.** Across all chain `FilterNode`s, split each
 *     predicate with `splitConjuncts`. Exactly **one** conjunct references
 *     `flagId`, and it is in an accepted probe normal form (below). Any other
 *     reference to `flagId` anywhere disqualifies.
 *  2. **Flag absent from the residual demand set.** `demanded` is built from the
 *     anchor Project's projections, every chain Filter's **non-probe** conjuncts,
 *     and every chain Sort's keys (Limit/Distinct/Alias contribute nothing).
 *     Require `!demanded.has(flagId)` — this catches a flag selected or sorted on.
 *  3. **No right-side column demanded.** The semi/anti output is left columns
 *     only, so `demanded ∩ {J.right attr ids} === ∅`. (`select *` / `select c.*,
 *     p.col … where f` land here and abstain — that is the deferred
 *     outer→inner-conversion case, NOT a semi-join shape.)
 *
 * **Accepted probe normal forms** (each conjunct normalized with
 * `normalizePredicate` first — collapses `not not f`, pushes NOT down):
 *
 *  | Form              | Node shape after normalize                          | Polarity |
 *  |-------------------|-----------------------------------------------------|----------|
 *  | `f`               | `ColumnReferenceNode`, `attributeId === flagId`     | semi     |
 *  | `not f`           | `UnaryOpNode` NOT over that colref                  | anti     |
 *  | `f = true`        | `BinaryOpNode` `=`, flag colref vs boolean `true`   | semi     |
 *  | `f = false`       | `BinaryOpNode` `=`, flag colref vs boolean `false`  | anti     |
 *
 * `IS [NOT] TRUE/FALSE` and `case`-wrapped forms are deferred to the
 * `existence-probe-richer-forms` backlog ticket.
 *
 * ## Q3 — left/right/inner → semi/anti mapping (settled by reachability)
 *
 * The parser (`resolveExistenceSide`) rejects `exists … as` on inner/cross joins,
 * and the runtime (`emitLoopJoin`) throws on RIGHT/FULL. So the ONLY executable
 * flag-bearing shape is `left join … exists right as`, giving the complete table:
 *
 *  | Join type | spec.side | probe         | rewrite               | rows kept           |
 *  |-----------|-----------|---------------|-----------------------|---------------------|
 *  | `left`    | `right`   | `where f`     | `semi(L, R, cond)`    | L rows WITH a match |
 *  | `left`    | `right`   | `where not f` | `anti(L, R, cond)`    | L rows with NO match |
 *
 * The rule is guarded by `joinType === 'left' && spec.side === 'right'`; right /
 * full origins and inner flags are unreachable today and explicitly out of scope.
 * The semi/anti node takes the LEFT side's attributes only (the flag column
 * disappears), which the Q2 checks guarantee the consuming Project tolerates.
 *
 * ## Q4 — Multi-flag joins: only fire when the probe is the SOLE existence spec
 *
 * A semi/anti join collapses the right side and cannot also emit other flags, so a
 * mixed join (one probe flag + other selected flags) cannot be split. We require
 * `J.existence.length === 1`. When other flags are merely *undemanded*, the base
 * `join-existence-pruning` rule (runs first) drops them, leaving a sole flag this
 * rule then recovers in a later `applyRules` iteration. The genuinely-mixed case
 * (≥2 demanded flags) is left unoptimized.
 *
 * ## Q5 — Residual ON-condition + non-equi predicates (sound; carry verbatim)
 *
 * `left join … where f` keeps exactly the L rows for which ∃ an R row satisfying
 * the FULL join condition — precisely `semi(L, R, condition)` for an arbitrary
 * `condition` (equi + residual + non-equi). So the constructed join carries
 * `J.condition` UNCHANGED. The downstream IND folders gate on
 * `isAndOfColumnEqualities(normalizePredicate(condition))` and abstain on any
 * residual, leaving a plain semi/anti join (hash semi-join still beats
 * nested-loop+flag). This rule does NOT itself require AND-of-equalities.
 *
 * ## Q6 — Outer-side preservation / NULL semantics (clean partition)
 *
 * The flag is `{true,false}` and never NULL (`EXISTENCE_FLAG_TYPE.nullable ===
 * false`; `emitLoopJoin` pre-computes matched=`true` / unmatched=`false` for an
 * `exists right as` spec). So `where f` and `where not f` partition the L rows
 * into exact complements — the textbook semi / anti split, no NULL edge.
 *
 * ## Q7 — Write-half safety (excluded by construction) + impure-R guard
 *
 * A flag writable through a view is always SELECTed by that view's routing
 * Project, so it lands in `demanded` and Q2's "flag absent from demanded" check
 * abstains — the write path can never reach this rewrite. (Mirrors
 * `join-existence-pruning`'s by-construction argument.) Separately, a semi join
 * short-circuits the R scan at the first match, changing R's *execution count*, so
 * we guard impure R with `subtreeHasSideEffects(J.right)` and register the rule
 * `sideEffectMode: 'aware'` (mirroring `subquery-decorrelation`, which likewise
 * refuses an impure inner). The flag-drop itself is read-only; the guard is purely
 * about R's iteration count.
 *
 * **Termination.** The output is a semi/anti join with no existence spec, so
 * re-running the rule no-ops (the anchor requires a flag-bearing `left` join
 * below). No rewrite loop.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode, type JoinType } from '../../nodes/join-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { UnaryOpNode, BinaryOpNode, LiteralNode } from '../../nodes/scalar.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import {
	collectAttrIds,
	walkChain,
	rebuildChain,
	rebuildProject,
	type ChainEntry,
} from './rule-join-elimination.js';

const log = createLogger('optimizer:rule:semijoin-existence-recovery');

/** The single probe conjunct located across the chain's FilterNodes. */
interface ProbeMatch {
	/** Index into `chain` of the FilterNode that holds the probe conjunct. */
	chainIndex: number;
	/** That filter. */
	filter: FilterNode;
	/** The filter's NON-probe conjuncts (already folded into `demanded`). */
	residualConjuncts: ScalarPlanNode[];
	/** `semi` for a `where f` probe, `anti` for `where not f`. */
	polarity: 'semi' | 'anti';
}

export function ruleSemijoinExistenceRecovery(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	// `walkChain` mutates its `demanded` set; we ignore it (a throwaway here) and
	// recompute demand conjunct-by-conjunct below so the probe can be excluded.
	const walk = walkChain(node.source, new Set<number>());
	if (!walk) return null;

	const { join, chain } = walk;

	// Only the reachable flag-bearing shape: a `left join … exists right as` with
	// a SOLE existence spec (Q3 / Q4). A mixed join cannot be split into a semi.
	if (join.joinType !== 'left') return null;
	if (!join.hasExistenceColumns) return null;
	const existence = join.existence!;
	if (existence.length !== 1) return null;
	const spec = existence[0];
	if (spec.side !== 'right') return null;
	if (!join.condition) return null;
	const flagId = spec.attrId;

	// Demand-SHAPE analysis: build `demanded` excluding the sole probe conjunct,
	// and classify the probe's polarity (Q2).
	const analysis = analyzeChain(node, chain, flagId);
	if (!analysis) return null;
	const { demanded, probe } = analysis;

	// The flag must not be demanded anywhere but the stripped probe (a flag that is
	// selected or sorted on lands in `demanded` via projections / sort keys).
	if (demanded.has(flagId)) return null;

	// The semi/anti output is left columns only — abstain if any right column is
	// demanded (that is the deferred outer→inner conversion, not a semi-join).
	const rightAttrIds = join.right.getAttributes().map(a => a.id);
	for (const id of rightAttrIds) {
		if (demanded.has(id)) return null;
	}

	// A semi join short-circuits the R scan at the first match — refuse to change
	// R's execution count when R carries a write (Q7).
	if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('Recovery skipped: right side has side effects');
		return null;
	}

	const newJoinType: JoinType = probe.polarity;
	const semiAnti = new JoinNode(
		join.scope,
		join.left,
		join.right,
		newJoinType,
		join.condition, // carry the full ON condition verbatim (Q5)
		// no usingColumns, no existence — the flag column disappears.
	);

	log('Recovered %s join from probe-only existence flag %s', newJoinType, spec.name);

	const newSource = rebuildChainStrippingProbe(chain, probe, semiAnti);
	return rebuildProject(node, newSource);
}

/**
 * Build the residual demand set (everything any ancestor of the Project can
 * reference EXCEPT the single stripped probe conjunct) and locate the sole probe.
 *
 * Returns null when the demand SHAPE disqualifies the rewrite: no probe found,
 * the flag referenced in more than one conjunct, or the flag inside a non-probe
 * conjunct shape (`f or x`, `f(x)`, …).
 */
function analyzeChain(
	project: ProjectNode,
	chain: ReadonlyArray<ChainEntry>,
	flagId: number,
): { demanded: Set<number>; probe: ProbeMatch } | null {
	const demanded = new Set<number>();
	for (const proj of project.projections) {
		collectAttrIds(proj.node, demanded);
	}

	let probe: ProbeMatch | null = null;

	for (let i = 0; i < chain.length; i++) {
		const entry = chain[i];
		switch (entry.kind) {
			case 'filter': {
				const conjuncts = splitConjuncts(entry.node.predicate);
				const flagConjuncts: ScalarPlanNode[] = [];
				const nonFlagConjuncts: ScalarPlanNode[] = [];
				for (const conj of conjuncts) {
					if (referencesAttr(conj, flagId)) {
						flagConjuncts.push(conj);
					} else {
						nonFlagConjuncts.push(conj);
						collectAttrIds(conj, demanded);
					}
				}
				if (flagConjuncts.length > 0) {
					// More than one flag reference (here or already seen) ⇒ not a sole probe.
					if (flagConjuncts.length > 1 || probe !== null) return null;
					const polarity = classifyProbe(flagConjuncts[0], flagId);
					if (!polarity) return null; // flag in a non-probe conjunct shape
					probe = {
						chainIndex: i,
						filter: entry.node,
						residualConjuncts: nonFlagConjuncts,
						polarity,
					};
				}
				break;
			}
			case 'sort': {
				for (const k of entry.node.sortKeys) {
					collectAttrIds(k.expression, demanded);
				}
				break;
			}
			// LimitOffset / Distinct / Alias demand nothing.
		}
	}

	if (!probe) return null;
	return { demanded, probe };
}

/**
 * Classify a flag-referencing conjunct as a probe normal form (Q2). The conjunct
 * is normalized first so `not not f` collapses and NOT pushes down. Returns the
 * resulting join polarity, or null when the shape is not a pure probe.
 */
function classifyProbe(conj: ScalarPlanNode, flagId: number): 'semi' | 'anti' | null {
	const n = normalizePredicate(conj);

	// `f` — bare boolean colref.
	if (n instanceof ColumnReferenceNode) {
		return n.attributeId === flagId ? 'semi' : null;
	}

	// `not f` — NOT over the flag colref.
	if (n instanceof UnaryOpNode && n.expression.operator === 'NOT') {
		if (n.operand instanceof ColumnReferenceNode && n.operand.attributeId === flagId) {
			return 'anti';
		}
		return null;
	}

	// `f = true` / `true = f` (semi) and `f = false` / `false = f` (anti).
	if (n instanceof BinaryOpNode && n.expression.operator === '=') {
		const flagSide = isFlagColRef(n.left, flagId) ? n.left
			: isFlagColRef(n.right, flagId) ? n.right
			: null;
		if (!flagSide) return null;
		const other = flagSide === n.left ? n.right : n.left;
		const bool = booleanLiteralValue(other);
		if (bool === true) return 'semi';
		if (bool === false) return 'anti';
	}

	return null;
}

function isFlagColRef(node: ScalarPlanNode, flagId: number): boolean {
	return node instanceof ColumnReferenceNode && node.attributeId === flagId;
}

/** The boolean value of a boolean `LiteralNode`, or undefined for anything else. */
function booleanLiteralValue(node: ScalarPlanNode): boolean | undefined {
	if (node instanceof LiteralNode && typeof node.expression.value === 'boolean') {
		return node.expression.value;
	}
	return undefined;
}

/** True iff `attrId` is referenced by any `ColumnReferenceNode` in the subtree. */
function referencesAttr(node: PlanNode, attrId: number): boolean {
	if (node instanceof ColumnReferenceNode) {
		return node.attributeId === attrId;
	}
	for (const child of node.getChildren()) {
		if (referencesAttr(child, attrId)) return true;
	}
	return false;
}

/**
 * Rebuild the pass-through chain on top of the recovered semi/anti join, stripping
 * the sole probe conjunct from its FilterNode (omitting the Filter entirely when
 * no residual conjunct remains). Reuses `rebuildChain` for the entries below and
 * above the probe filter; only the probe filter itself is special-cased.
 */
function rebuildChainStrippingProbe(
	chain: ReadonlyArray<ChainEntry>,
	probe: ProbeMatch,
	semiAnti: RelationalPlanNode,
): RelationalPlanNode {
	// Chain is collected top→bottom; entries AFTER the probe are closer to the join.
	const below = chain.slice(probe.chainIndex + 1);
	const above = chain.slice(0, probe.chainIndex);

	let current = rebuildChain(below, semiAnti);

	const residualPred = combineConjuncts(probe.residualConjuncts);
	if (residualPred !== null) {
		current = new FilterNode(probe.filter.scope, current, residualPred);
	}
	// else: the probe was the filter's only conjunct — omit the Filter.

	return rebuildChain(above, current);
}
