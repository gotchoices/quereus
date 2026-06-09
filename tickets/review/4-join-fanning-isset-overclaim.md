description: Review the fanning-join FD over-claim fix — `propagateJoinFds` now drops a join side's KEY FDs (determinant is a superkey of that side) in the inner/cross arm when that side's unique key is not preserved by the join, so a downstream key-dropping projection can no longer re-derive a spurious all-columns key (a bag read as a set). Fix is at the producer (the join, where fan-out is known), not the reader (`keysOf`).
prereq:
files: packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/fanning-join-fd-overclaim.spec.ts, packages/quereus/test/plan/joins/simple-join.plan.json, packages/quereus/test/plan/aggregates/group-by.plan.json
----

## What changed (the implemented fix)

A fanning (non-1:1) inner/cross join duplicates the rows of a side whose unique key is **not
preserved** by the join. That side's key-encoding FDs (`X → …` where `X`'s closure covers all the
side's columns) remain true as *determinations* under fan-out but no longer encode *uniqueness* in
the product. Carried through unchanged, a downstream projection that drops the **other** side's
distinguishing columns lets `keysOf` (`fd-utils.ts` step 3, `deriveKeysFromFds`) re-read the
surviving side-key FD as an all-columns key — a bag silently read as a set. Every uniqueness
consumer then trusts a key that does not hold: `rule-distinct-elimination` drops a required DISTINCT,
`rule-groupby-fd-simplification` simplifies on the phantom key, and the MV full-rebuild floor's bag
reject is bypassed.

The fix, in `propagateJoinFds` (`join-utils.ts`), inner/cross arm only:

- New helper `dropSideKeyFds(fds, sideColumnCount)` filters out a side's **key** FDs (determinant is
  an `isSuperkey` of that side), retaining non-key (partial-determination) FDs and all guarded FDs.
- A side is "preserved" iff some `preservedKeys` entry (already in join-output index space, from
  `analyzeJoinKeyCoverage`) lies entirely within that side's columns. When a side is not preserved,
  its FDs are run through `dropSideKeyFds` before the merge; preserved sides keep their FDs verbatim.
- `withKeyFds(preservedKeys)` still re-adds the genuinely-surviving keys (e.g. the composite product
  key of a bare cross-join), so nothing sound is lost.

`isSuperkey` was added to the `fd-utils.js` import. No signature changes (`preservedKeys`,
`leftColumnCount`, `totalColumnCount` were already parameters).

**Why the producer, not the reader.** Gating `deriveKeysFromFds` on `getType().isSet` was rejected:
`isSet` is a logical build-time flag that cannot see *physical-only* keyed sets (a `select distinct
email, label from u where email is not null` projection is genuinely a set via a physical guarded FD
yet has `isSet === false`). Gating there breaks `lens-fd-contribution.spec.ts`. The fan-out is only
known at the join, so the fix belongs there.

## Use cases / validation to confirm

Run these from repo root with the project register:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js <spec>`

1. **Repro MV now rejects (the headline behavior).**
   `materialized-view-diagnostics.spec.ts` — new `rejectCases` row
   `select g.id, g.v from g join g2 on g.k = g2.w` must fail create with
   `cannot be materialized` + `no provable unique key`. (30 passing.)
2. **No-fan-out accepts unchanged.** Same spec's `acceptCases` `pk=pk inner join` (`g.id = g2.id`)
   and `self-join keyed on the driving PK` still CREATE — they are ≤1:1 (set), keys preserved.
3. **FD-rule blast radius** (`fanning-join-fd-overclaim.spec.ts`, new, 3 cases):
   - DISTINCT over `g ⋈ g2 on g.k = g2.w` is **retained** (projected body is a bag).
   - Control: DISTINCT over `g ⋈ g2 on g.id = g2.id` (≤1:1) is still **eliminated**.
   - `select g.id, g.v, count(*) c … group by g.id, g.v` over the fanning join returns `c = 2`
     (the group is not collapsed by a phantom `{g.id}` key).
4. **Email physical-only set unregressed.** `lens-fd-contribution.spec.ts` green (DISTINCT
   elimination under the IS-NOT-NULL guarded FD still fires).
5. **Goldens.** `joins/simple-join.plan.json` and `aggregates/group-by.plan.json` regenerated; the
   diff is **FD-only** — removal of the lookup-side (departments) PK FD `{4} → {5,6}` at two join
   frames, no structural plan change. Both queries are `users JOIN departments ON u.dept_id = d.id`,
   where departments fans out across users, so dropping departments' PK FD is the correct behavior.
   (`basic/simple-select.plan.json` listed in the original ticket did **not** change — UPDATE_PLANS
   rewrote it identically; only 2 goldens have real deltas.)

## Validation gate — results

- `yarn workspace @quereus/quereus run build` — clean.
- Full `node packages/quereus/test-runner.mjs` — **5474 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` (`tsc --noEmit`) — clean.

## Honest gaps / where the reviewer should push (tests are a floor, not a ceiling)

- **Pre-existing intermittent fuzz failure did NOT surface this run.** The ticket warned about
  `Optimizer Equivalence › distinct elimination produces identical results` (`fuzz.spec.ts`), an
  injective-projection sibling of this root cause, present on clean HEAD and seed-dependent. It did
  not fire in my full run (no `.pre-existing-error.md` written). It is **out of scope** here and is
  filed as `tickets/fix/fd-derived-key-bag-overclaim.md`. If a reviewer's run hits it, that is the
  pre-existing failure — NOT a regression of this fix (it involves no join). Any *join*-involving
  DISTINCT mismatch would be a real regression of this change and worth chasing.
- **LEFT/RIGHT-outer fanning analogue is intentionally NOT fixed here.** The `'left'`/`'right'` arms
  of `propagateJoinFds` still `withKeyFds(leftFds.slice())`, unconditionally keeping the preserved
  side's key FDs even when an outer join fans that side. This is the same class of bug via a
  different arm; it is folded into `fd-derived-key-bag-overclaim` (see its lines 48–50, 87). I did
  not touch the outer arms — confirm the reviewer agrees the inner/cross-only scope is right and the
  outer gap is genuinely covered by the sibling ticket.
- **`dropSideKeyFds` superkey test scope.** It calls `isSuperkey(det, fds, sideColumnCount)` with the
  side's *own* (unshifted) FD list and side-local column count — correct because `leftFds` are in
  left-local indices and `rightFds` are pre-shift. Worth a second look that no caller passes already
  shifted FDs into the inner/cross arm (they don't — shifting happens at the `mergeFds` line, after
  the drop).
- **Empty preserved key `[]`.** `[].every(...)` is vacuously true, so a `[]` in `preservedKeys`
  (≤1-row join) marks both sides preserved → nothing dropped. Intended (no fan-out), but a reviewer
  should confirm there is no path where `[]` coexists with a genuine fan-out.
- **Adversarial angle:** construct a 3-way join or a join whose fanning side carries a *non-key*
  all-covering FD (e.g. via an equi-chain) and check it is not wrongly dropped or wrongly kept.
  The regression spec covers single-join DISTINCT/GROUP-BY only.
