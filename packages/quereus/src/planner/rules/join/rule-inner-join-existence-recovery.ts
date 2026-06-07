/**
 * Rule: Inner-Join Existence-Flag Recovery (demand-SHAPE gated)
 *
 * The demand-SHAPE **complement** of `rule-semijoin-existence-recovery`. The semi
 * rule recovers a semi/anti join from a probe-only `exists … as` flag, but
 * abstains the moment a right-side column is demanded above the join (a semi join
 * exposes left columns only, so it would drop the very right columns the caller
 * needs). This rule handles exactly that abstention point: a **positive** probe
 * (`where flag` ⇒ `semi` polarity) **with ≥1 right-side column demanded** rewrites
 * the flag-bearing `left join` to a plain **inner join** — dropping the flag,
 * keeping both sides.
 *
 *   select c.cc, p.pv
 *     from exc c left join exp p on p.pp = c.pr exists right as hasP
 *     where hasP;        -- ⇒ inner join (matched rows only; p.pv is needed → keep R)
 *
 * Like the sibling, this is a **pure optimization** — byte-identical rows to the
 * flag-bearing nested-loop baseline — that re-opens inner-join physical selection
 * (`join-physical-selection` → hash/merge join), non-nullable right-column typing,
 * and the FK/IND reasoning the live flag pinned shut (the five flag-guarded join
 * rules re-enable once `hasExistenceColumns` flips false).
 *
 * ## Why this is sound (and SIMPLER than the semi rule)
 *
 * `emitLoopJoin` drives a `left join … exists right as` exactly like a normal left
 * join with one appended flag bit (`runtime/emit/join.ts` `driveFromLeft`):
 *
 *  - a matched left row with **K** matching right rows → **K** output rows, each
 *    `flag = true`;
 *  - an unmatched left row → **1** null-extended row, `flag = false`.
 *
 * A positive probe `where flag` keeps exactly the K matched rows per left row and
 * drops the unmatched. An **inner join** on the same condition yields exactly K
 * rows per matched left row and drops the unmatched. **Identical, row-for-row, for
 * ANY condition.** Three consequences distinguish this rule from the semi rule:
 *
 *  - **No fan-out guard.** The semi rule needs `rightMatchesAtMostOne` because a
 *    semi join collapses K→1; an inner join does not collapse, so K matches stay
 *    K. We do NOT import the uniqueness / `isUnique` machinery.
 *  - **No condition-shape restriction.** Unlike `join-elimination` (AND-of-
 *    equalities + FK→PK), the inner conversion replays the flag's exact per-pair
 *    match, so non-equi / residual ON conditions are fine — carry `join.condition`
 *    verbatim.
 *  - **No NOT-NULL FK requirement.** A `NULL` FK never satisfies `p.pp = c.pr`, so
 *    it is unmatched under both the flag (`false`, dropped by `where flag`) and the
 *    inner join (no match). No NULL-FK row leaks.
 *
 * ## Attribute-id / nullability preservation
 *
 * `buildJoinAttributes` emits `[left…, right…]` for both `left` and `inner`, taking
 * right attribute ids **verbatim** from `rightAttrs`; the only difference is that
 * `left` marks the right columns `nullable: true` while `inner` keeps their
 * declared nullability. So the consuming Project/Filter resolves right columns by
 * attribute id (key-based addressing) and finds them at the same ids — no rebinding
 * needed — and dropping the flag (appended *after* both sides) shifts nothing. The
 * inner join's non-nullable right typing is a sound **strengthening**: after
 * `where flag` only matched rows survive, on which the right side is fully present.
 * That is the property that re-enables downstream FD/key reasoning.
 *
 * ## Soundness of dropping the flag + stripping the probe
 *
 * The demand-SHAPE proof (reused verbatim from the sibling's `analyzeChain`)
 * guarantees the flag is referenced **only** in the single probe conjunct. After
 * `left → inner` the probe `where flag` is subsumed by the inner join (which keeps
 * only matched rows where the flag would be `true`), so the probe conjunct is
 * stripped via `rebuildChainStrippingProbe` (Filter omitted if it was the sole
 * conjunct). Any flag reference outside the probe lands in `demanded`, and the
 * `!demanded.has(flagId)` check abstains.
 *
 * ## Relationship to `semijoin-existence-recovery` (disjoint by construction)
 *
 *  | Probe              | Right col demanded? | Fires                          | Result        |
 *  |--------------------|---------------------|--------------------------------|---------------|
 *  | `where flag` (semi)| NO                  | `semijoin-existence-recovery`  | `semi(L,R,c)` |
 *  | `where not f` (anti)| NO                 | `semijoin-existence-recovery`  | `anti(L,R,c)` |
 *  | `where flag` (semi)| **YES**             | **this rule**                  | `inner join`  |
 *  | `where not f` (anti)| YES                | *neither*                      | stays `left`  |
 *
 * The two recovery rules partition the positive-probe space by the
 * right-column-demanded predicate, so they never both fire on one node. The
 * negative-probe + right-col case stays a `left` join: an anti row has the right
 * side all-NULL, so an inner join would be wrong (guarded by `polarity === 'semi'`).
 * Registered AFTER the semi rule (so semi wins its no-right-col half) and BEFORE
 * `join-elimination` / the IND folders (so the recovered inner join threads into
 * them in the same `applyRules` loop).
 *
 * ## `sideEffectMode: 'aware'` + impure-R guard
 *
 * Registered `'aware'` with a `subtreeHasSideEffects(join.right)` refusal. Although
 * the *logical* inner join scans R the same number of times as the flag-bearing
 * left join (both full-scan R per left row in `driveFromLeft`, neither short-
 * circuits), dropping the flag **re-enables `join-physical-selection`**, which can
 * pick a hash join that scans R **once** total — changing an impure R's execution
 * count. Guarding at the recovery site (rather than trusting every re-enabled
 * downstream rule) mirrors the sibling's impure-R guard and
 * `subquery-decorrelation`'s impure-inner refusal. The write-half is otherwise
 * safe by construction: a flag writable through a view is always SELECTed by its
 * routing Project, so it lands in `demanded` and `!demanded.has(flagId)` abstains.
 *
 * **Termination.** The output is an inner join with no existence spec, so re-running
 * the rule sees `joinType !== 'left'` and no-ops. No rewrite loop.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { walkChain, rebuildProject } from './rule-join-elimination.js';
import { analyzeChain, rebuildChainStrippingProbe } from './rule-semijoin-existence-recovery.js';

const log = createLogger('optimizer:rule:inner-join-existence-recovery');

export function ruleInnerJoinExistenceRecovery(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	// `walkChain` mutates its `demanded` set; we ignore it (a throwaway) and
	// recompute demand conjunct-by-conjunct in `analyzeChain` so the probe is
	// excluded — identical to the sibling rule.
	const walk = walkChain(node.source, new Set<number>());
	if (!walk) return null;

	const { join, chain } = walk;

	// Only the reachable flag-bearing shape: a `left join … exists right as` with
	// a SOLE existence spec. A mixed join cannot be converted (other flags would be
	// dropped); `join-existence-pruning` strips an undemanded sibling first.
	if (join.joinType !== 'left') return null;
	if (!join.hasExistenceColumns) return null;
	const existence = join.existence!;
	if (existence.length !== 1) return null;
	const spec = existence[0];
	if (spec.side !== 'right') return null;
	if (!join.condition) return null;
	const flagId = spec.attrId;

	// Demand-SHAPE analysis (shared with the semi rule): build `demanded` excluding
	// the sole probe conjunct, and classify the probe's polarity.
	const analysis = analyzeChain(node, chain, flagId);
	if (!analysis) return null;
	const { demanded, probe } = analysis;

	// POSITIVE probe only. A negative probe (`where not flag`, anti polarity) with a
	// right column demanded must stay a `left` join: an anti row has the right side
	// all-NULL, so an inner join would be wrong (it drops the very rows anti keeps).
	if (probe.polarity !== 'semi') return null;

	// The flag must not be demanded anywhere but the stripped probe (a flag that is
	// selected or sorted on lands in `demanded` via projections / sort keys).
	if (demanded.has(flagId)) return null;

	// The complement gate: ≥1 right-side column demanded. Without a right column
	// this defers to `semijoin-existence-recovery` (its semi half), which produces
	// the leaner semi join. With one, only the inner conversion preserves it.
	const rightAttrIds = join.right.getAttributes().map(a => a.id);
	if (!rightAttrIds.some(id => demanded.has(id))) return null;

	// Dropping the flag re-enables `join-physical-selection`, which can pick a hash
	// join that scans R once total — refuse to change an impure R's execution count.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('Inner recovery skipped: right side has side effects');
		return null;
	}

	// Replay the flag's exact per-pair match as an inner join — full ON condition
	// carried verbatim (no condition-shape restriction; see the soundness note).
	const innerJoin = new JoinNode(
		join.scope,
		join.left,
		join.right,
		'inner',
		join.condition,
		// no usingColumns, no existence — the flag column disappears.
	);

	log('Recovered inner join from positive probe-only existence flag %s', spec.name);

	const newSource = rebuildChainStrippingProbe(chain, probe, innerJoin);
	return rebuildProject(node, newSource);
}
