description: A fanning (non-1:1) inner/cross join lets a downstream key-dropping projection re-derive a spurious unique key, so the optimizer reads a bag as a set — DISTINCT-over-fanning-join is eliminated, GROUP-BY simplified, and the MV full-rebuild floor accepts a body whose all-columns backing key silently collapses the duplicates. Fix: stop a fanning join from propagating a side's key-encoding FDs when that side's unique key is not preserved by the join.
files: packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/plan/joins/simple-join.plan.json, packages/quereus/test/plan/aggregates/group-by.plan.json, packages/quereus/test/plan/basic/simple-select.plan.json
----

## What this actually is (the fix-stage diagnosis CORRECTS the original hypothesis)

The original ticket hypothesised the bug lives in `buildJoinRelationType`'s `isSet`
(`join-utils.ts:118`) over-claiming an inner/cross join of two sets to be a set. **That
hypothesis is wrong, and the prescribed `isSet` fix does NOT fix the repro.** Reproduced and
confirmed empirically:

- For the repro `select g.id, g.v from g join g2 on g.k = g2.w`, the optimized body root is a
  `Project`, and `root.getType().isSet` is **already `false`** and `root.getType().keys` is
  **already `[]`**. The join's `isSet` plays no part — the over-claim surfaces one level up,
  inside `keysOf`.
- An inner/cross join of two sets **is** genuinely a set on its *full* column list (every
  `(left-row, right-row)` matching pair appears exactly once; a subset of a cross product of two
  sets is a set). The fanning join's `isSet = true` is **correct**, and its logical `keys` is a
  correct composite product key `(g.id, g2.id)`. The duplication only appears *after a projection
  drops the distinguishing columns* (here `g2.id`/`g2.w`), and `Project.isSet` already computes
  `false` for that case.

The real mechanism:

1. `g`'s PK seeds the FD `{g.id} → {g.k, g.v}`. `propagateJoinFds` (inner/cross) merges it into
   the join output unchanged (`mergeFds(leftFds, …)`). At the **join** frame this FD is harmless:
   its closure `{g.id, g.k, g.v}` does **not** cover the join's `g2` columns, so
   `deriveKeysFromFds` does not treat `g.id` as a key (correct — `g.id` fans out across `g2`).
2. The projection to `(g.id, g.v)` drops every column the FD did **not** determine. `projectFds`
   carries the FD through as `{0} → {1}` — which now covers **all** surviving output columns.
3. `keysOf` step 3 (`deriveKeysFromFds`, `fd-utils.ts:798`) reads "an FD whose determinant's
   closure covers all columns" as "the determinant is a unique key" and returns `[[0]]`. This
   inference is sound **only in a set** (`X → all_cols` proves `X` unique iff there are no
   duplicate rows). The projected relation is a bag, so the derived key is spurious.
4. Every `keysOf`/`isUnique` consumer then trusts a key that does not hold:
   `rule-distinct-elimination` drops the DISTINCT; `rule-orderby-fd-pruning` /
   `rule-groupby-fd-simplification` prune/simplify on the phantom key; and the MV full-rebuild
   floor's bag reject (`keysOf(root).length === 0`) is bypassed, so the fanning body is accepted
   and its all-columns backing key collapses the duplicates (`select id,v from bj` → 1 row vs the
   plain view's 2).

## The fix (validated end-to-end)

The spurious FD is a **side key FD** that survived a join which did not preserve that side's
uniqueness. The join already computes exactly which sides it preserves: `analyzeJoinKeyCoverage`
returns `preservedKeys`, and a side's key is preserved iff some preserved key lies entirely within
that side's columns. So: **in the inner/cross arm of `propagateJoinFds`, drop a side's key-encoding
FDs (determinant is a superkey of that side) when that side is not preserved.** The FDs are still
true as *determinations* under fan-out, but they no longer encode uniqueness, and dropping them is
exactly what stops the downstream projection from resurrecting the side key as an all-columns key.

This is the same "no fan-out" property the MV join-residual arm proves via `proveJoinOneToOne`
(`coverage-prover.ts`), expressed at the FD-propagation layer where key/FD soundness belongs —
the two rest on the same fact and cannot disagree on whether a side fans out.

Prototyped against the tree and validated: the repro MV now **rejects** at create with the exact
`no provable unique key … must be a set` bag diagnostic; the email lens DISTINCT-elimination and
all `1:1`/`pk=pk` cases keep their set/keyed status; **full `yarn test` is green except** (a) three
golden plan snapshots that lose exactly the dropped lookup-side PK FD (regenerate them), and (b) a
**pre-existing, unrelated** fuzz failure — see the warning below.

### Exact patch

`packages/quereus/src/planner/nodes/join-utils.ts` — import `isSuperkey` from `../util/fd-utils.js`
(alongside the existing `superkeyToFd` etc.), add the helper, and gate the side-FD merge:

```ts
/**
 * Drop the KEY FDs of one join side — those whose determinant is a superkey of
 * that side (its closure covers all `sideColumnCount` of the side's columns).
 * Used when a fanning inner/cross join does not preserve the side's unique key:
 * the determination still holds but is no longer a uniqueness claim, and keeping
 * it lets a downstream projection re-derive a spurious all-columns key. Non-key
 * (partial-determination) FDs are retained — they stay true under fan-out.
 */
function dropSideKeyFds(
	fds: ReadonlyArray<FunctionalDependency>,
	sideColumnCount: number,
): ReadonlyArray<FunctionalDependency> {
	return fds.filter(fd =>
		fd.guard !== undefined ||
		!isSuperkey(new Set(fd.determinants), fds, sideColumnCount),
	);
}
```

In the `case 'inner': case 'cross':` branch, replace the leading
`let fds = mergeFds(leftFds, shiftFds(rightFds, leftColumnCount), opts);` with:

```ts
// A fanning (non-1:1) join duplicates the rows of a side whose unique key is not
// preserved (no preserved key lies entirely within that side's columns). Such a
// side's KEY FDs remain true as determinations but no longer encode uniqueness in
// the product; carried through unchanged they let a downstream projection that drops
// the other side's columns spuriously re-derive the side key as an all-columns key
// (a bag read as a set). Drop those side-key FDs here when the side is not preserved.
const rightColumnCount = totalColumnCount - leftColumnCount;
const leftPreserved = preservedKeys.some(k => k.every(i => i < leftColumnCount));
const rightPreserved = preservedKeys.some(k => k.every(i => i >= leftColumnCount));
const keptLeftFds = leftPreserved ? leftFds : dropSideKeyFds(leftFds, leftColumnCount);
const keptRightFds = rightPreserved ? rightFds : dropSideKeyFds(rightFds, rightColumnCount);
let fds: ReadonlyArray<FunctionalDependency> = mergeFds(keptLeftFds, shiftFds(keptRightFds, leftColumnCount), opts);
```

Notes for the implementer:
- `preservedKeys` and `leftColumnCount`/`totalColumnCount` are already parameters of
  `propagateJoinFds`; no signature change is needed. An empty preserved key `[]` makes
  `[].every(...)` vacuously true → both sides "preserved" → nothing dropped (correct: a ≤1-row
  join has no fan-out). A bare cross-join of two multi-row keyed sets yields only the composite
  product key (neither pure-left nor pure-right), so both sides' individual key FDs are dropped —
  correct, since neither side's key is unique in the product, and `withKeyFds(preservedKeys)` still
  re-adds the composite product key.
- Guarded FDs are retained (conditional, never a clean key claim) — keep the `fd.guard !== undefined`
  short-circuit.
- This arm is inner/cross only, matching the ticket scope. The LEFT/RIGHT-outer analogue (the
  `'left'`/`'right'` cases do `withKeyFds(leftFds.slice())`, unconditionally keeping the preserved
  side's key FDs even when an outer join fans that side) is a real sibling and is **out of scope**
  here — capture it in the new fix ticket `fd-derived-key-bag-overclaim` (created alongside this).

### Why not gate `keysOf`/`deriveKeysFromFds` on `isSet` instead

Tempting (step 4, the all-columns fallback, is already `isSet`-gated) but **wrong**: it breaks the
`lens FD contribution: end-to-end optimizer behavior` test. A `select distinct email, label from u
where email is not null` projection is *genuinely a set* (email is unique under the discharged
IS-NOT-NULL guard) yet its logical `getType().isSet` is `false` (the uniqueness lives only in a
physical guarded FD). Gating step 3 on `isSet` would drop email's real key. `isSet` is a logical,
build-time flag and cannot see physical-only keyed sets, so it is the wrong gate. The fix must act
where the *fan-out* is known — the join — not where the key is *read*.

## Test changes

- **Move the fanning join to the reject spec.** In
  `packages/quereus/test/materialized-view-diagnostics.spec.ts`, the `describe('… per-reason tails')`
  block already builds tables `g (id pk, k, v)` / `g2 (id pk, w)`. Add a `rejectCases` row:
  `['fanning (non-1:1) inner join (bag)', 'select g.id, g.v from g join g2 on g.k = g2.w', 'no provable unique key']`.
  Leave the existing `acceptCases` `pk=pk inner join` (`g.id = g2.id`) and `self-join keyed on the
  driving PK` rows as-is — they are no-fan-out (set) and must stay accepted.
- **Lock the FD-rule blast radius.** Add a focused optimizer spec (a `getPlan` + `findNodes`
  assertion, mirroring `lens-fd-contribution.spec.ts`) that over the fanning join `g ⋈ g2 on
  g.k = g2.w`: (a) `select distinct g.id, g.v …` **retains** its `DistinctNode`, and as a control
  (b) `select distinct g.id, g.v from g join g2 on g.id = g2.id` (1:1) **eliminates** it; and a
  result-level check that `select g.id, g.v, count(*) c … group by g.id, g.v` keeps `c = 2` (the
  group key is not collapsed to `{g.id}`). These were all confirmed green with the patch.
- **Regenerate the three golden plans.** `UPDATE_PLANS=true` over
  `test/plan/golden-plans.spec.ts` updates `joins/simple-join.plan.json`,
  `aggregates/group-by.plan.json`, and `basic/simple-select.plan.json`. The only delta is the
  removal of the dropped lookup-side PK FD (`{4} → {5,6}`) — verify the diff is FD-only with no
  structural plan change before committing.

## ⚠ Pre-existing, unrelated test failure — do NOT chase it

`yarn test` includes a fast-check differential, **`Optimizer Equivalence › distinct elimination
produces identical results`** (`test/fuzz.spec.ts`), which **intermittently** (random seed) fails
with e.g.:

```
Row count mismatch: 3 (full) vs 2 (restricted) when disabling rules [distinct-elimination]
SQL: select distinct (- t1.c_real1) as col0, t1.c_real1 as col1 from t1
```

This is a **sibling of the same root cause via a different FD source** (an *injective-projection*
bidirectional FD `{-c_real1} ↔ {c_real1}` becoming an all-columns key over a non-set), **confirmed
present on clean `HEAD`** (no join involved — this ticket's join fix does not touch it). It is filed
separately as the fix ticket `fd-derived-key-bag-overclaim`. If this exact failure surfaces during
implementation, it is **pre-existing and not yours** — write `tickets/.pre-existing-error.md` per
the stage rules (command, the `distinct elimination` test name, the `t1.c_real1` SQL, and "fails on
clean HEAD, single-table, no join") and finish this ticket normally. Any *other* `distinct
elimination` mismatch that involves a join would be a real regression of this fix.

## Validation gate (run before handoff to review)

- The repro MV rejects at create with the `no provable unique key … must be a set` bag diagnostic.
- `materialized-view-diagnostics.spec.ts` green (new fanning reject + unchanged pk=pk/self-join accepts).
- `lens-fd-contribution.spec.ts` green (email DISTINCT-elimination unregressed).
- Full `yarn test` green except the regenerated goldens and the pre-existing injective fuzz failure above.
- `yarn workspace @quereus/quereus run lint` and `tsc --noEmit` clean.

## TODO

- [ ] Add `isSuperkey` to the `fd-utils.js` import in `join-utils.ts`; add the `dropSideKeyFds` helper.
- [ ] Gate the inner/cross side-FD merge in `propagateJoinFds` on `leftPreserved`/`rightPreserved`
      derived from `preservedKeys` (exact patch above).
- [ ] Add the fanning-join reject row to `materialized-view-diagnostics.spec.ts` `rejectCases`.
- [ ] Add the DISTINCT-retained / DISTINCT-still-eliminated (1:1) / GROUP-BY-not-collapsed optimizer
      regression spec.
- [ ] Regenerate the three golden `.plan.json` files (`UPDATE_PLANS=true`); confirm the diff is the
      FD-only removal.
- [ ] Run the validation gate; if the pre-existing injective fuzz failure appears, write
      `tickets/.pre-existing-error.md` and proceed.
- [ ] Hand off to review with an honest note on the two documented out-of-scope siblings
      (LEFT/RIGHT-outer fanning FD analogue; injective-projection key over-claim).
