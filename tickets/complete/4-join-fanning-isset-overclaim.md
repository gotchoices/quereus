description: A fanning (non-1:1) inner/cross join no longer over-claims a unique key. `propagateJoinFds` drops a join side's KEY FDs (determinant is a superkey of that side) in the inner/cross arm when that side's unique key is not preserved by the join, so a downstream key-dropping projection can no longer re-derive a spurious all-columns key (a bag read as a set). Fix is at the producer (the join), not the reader (`keysOf`).
files: packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/fanning-join-fd-overclaim.spec.ts, docs/optimizer.md
----

## What shipped

`propagateJoinFds` (`join-utils.ts`, inner/cross arm only) now drops a side's KEY FDs when the join
fans that side out:

- New helper `dropSideKeyFds(fds, sideColumnCount)` filters out FDs whose determinant is an
  `isSuperkey` of the side; non-key (partial-determination) FDs and all guarded FDs are retained.
- A side is "preserved" iff some `preservedKeys` entry (join-output index space, from
  `analyzeJoinKeyCoverage`) lies entirely within that side's columns. A non-preserved side's FDs are
  run through `dropSideKeyFds` before the merge; preserved sides keep their FDs verbatim.
- `withKeyFds(preservedKeys)` still re-adds the genuinely-surviving keys (e.g. the composite product
  key of a bare cross join), so nothing sound is lost.

Why the producer, not the reader: `isSet` is a build-time logical flag that cannot see physical-only
keyed sets (a guarded-FD set has `isSet === false`), so gating `deriveKeysFromFds` on it would
regress real keys. Fan-out is known only at the join.

Behavioral effect (all verified): the repro MV `select g.id, g.v from g join g2 on g.k = g2.w` now
rejects with "no provable unique key"; DISTINCT over a fanning join is retained; GROUP BY over a
fanning join is not collapsed; pk=pk (≤1:1) joins are unaffected; the email physical-only-set case
(`lens-fd-contribution.spec.ts`) is unregressed.

## Review findings

**Diff reviewed first, fresh, before the handoff.** Implement commit `20b3ee73`. Read
`propagateJoinFds` in full, `dropSideKeyFds`, `analyzeJoinKeyCoverage`/`combineJoinKeys`
(`key-utils.ts`), and `isSuperkey`/`deriveKeysFromFds`/`superkeyToFd` (`fd-utils.ts`).

### Correctness of the implemented fix — CONFIRMED SOUND
- **Drop logic vs. fan-out direction.** Traced both arms: `rightKeyCovered` ⟹ each left row matches
  ≤1 right row ⟹ left is preserved (not duplicated) and right fans; the fix keeps left's key FDs and
  drops right's. Symmetric for `leftKeyCovered`. The dropped side is always the genuinely-fanning
  side, and `withKeyFds` re-adds the genuinely-surviving keys. The bare-cross "composite product key"
  case (`[leftPick, rightPick]`) spans both sides, so neither side is "preserved" → both sides' key
  FDs dropped, composite re-added. Correct.
- **Determination-chain re-derivation is blocked.** Checked that a preserved side's key FD plus an
  equi-pair FD `{L}→{R'}` cannot resurrect the *dropped* side's columns: the dropped side's key FD
  was the only small-determinant cover of its columns, so closure no longer reaches them. No spurious
  all-columns key survives a key-dropping projection.
- **Empty key `[]`.** Pushed only when *both* sides are ≤1-row (`leftIsSingleton && rightIsSingleton`)
  ⟹ no fan-out; `[].every(...)` vacuously marks both sides preserved → nothing dropped. Confirmed no
  path where `[]` coexists with a genuine fan-out (`selectLexMinKey` skips empty keys, so a singleton
  side never produces a composite product key).
- **`dropSideKeyFds` index scope.** `isSuperkey(det, fds, sideColumnCount)` is called with the side's
  own unshifted FD list and side-local column count — correct; shifting happens at the `mergeFds`
  line, after the drop. `rightColumnCount = totalColumnCount - leftColumnCount` is right.

### Adversarial probes run (then removed)
- **3-way fanning join** (`g ⋈ g2 ⋈ g3` on non-unique `k`): DISTINCT correctly retained, GROUP BY
  returns `c = 4` (2×2 fan-out counted). The fix generalizes across join frames. **Added a permanent
  regression** for this to `fanning-join-fd-overclaim.spec.ts` (the implementer's spec covered
  single-join only).
- **Guarded-FD-over-fanout** (the one path the fix retains unconditionally): probed two realistic
  reachable sources — a base-table nullable `unique` column and an `is not null`-filtered subquery —
  feeding a fanning join with a key-dropping DISTINCT projection. Both correctly **retain** DISTINCT
  (a base-table nullable unique emits a *non-guarded* key FD, which `dropSideKeyFds` drops). The
  genuine guarded-key source is the lens/MV row-time path; I could not construct a reachable repro
  through it. Residual theoretical concern (a lens row-time guarded key feeding a fanning inner join)
  is the same class as the sibling ticket and is noted there, not separately filed.

### Major finding filed (pre-existing, NOT a regression of this fix)
- **Equi-pair bidirectional FD over-claim.** `select distinct g.k, g2.w from g join g2 on g.k = g2.w`
  returns **2 identical rows** `[(100,100),(100,100)]` — DISTINCT is wrongly eliminated. Cause: the
  equi-pair FDs `{g.k}↔{g2.w}` that `propagateJoinFds` adds *after* `dropSideKeyFds`; projecting to
  exactly the two equi-columns makes a direction all-covering, so `deriveKeysFromFds` reads the bag as
  a set. **Confirmed pre-existing** by reverting `join-utils.ts` to the implement-commit parent
  (`d739abf0`) — reproduces identically. This is the same root class as the sibling ticket
  `fd-derived-key-bag-overclaim` but a *different* FD source it did not enumerate. **Folded into that
  ticket** (added the equi-pair row to its source table, a confirmed-pre-existing subsection with the
  repro, and a TODO for the deterministic regression). This ticket is correctly scoped to side-*key*
  FDs and intentionally does not touch equi-pair FDs.

### Scope deferral confirmed
- **LEFT/RIGHT-outer fanning analogue** (the outer arms still `withKeyFds(leftFds.slice())`
  unconditionally) is genuinely covered by sibling ticket `fd-derived-key-bag-overclaim` (its lines
  48–50, 87). Inner/cross-only scope for this ticket is correct.

### Docs
- `docs/optimizer.md` join key-coverage section (INNER/CROSS bullet) updated to document the new
  fanning-side key-FD drop (it previously described only preserved-key emission and was silent on the
  unpreserved side's FDs). Other join-FD doc lines (1979 summary, LEFT/RIGHT/FULL bullets) remain
  accurate and were left as-is.

### Validation gate — re-run during review
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full `node packages/quereus/test-runner.mjs` — **5474 passing, 9 pending, 0 failing** (includes
  plan goldens; the regenerated `joins/simple-join.plan.json` and `aggregates/group-by.plan.json`
  pass with no further drift). Updated `fanning-join-fd-overclaim.spec.ts` (now 4 cases) green.
- The intermittent fuzz differential (`Optimizer Equivalence › distinct elimination`) did not surface
  this run; it is seed-dependent and tracked by `fd-derived-key-bag-overclaim`. No
  `.pre-existing-error.md` written (no suite failure surfaced).

## Disposition
- **Minor (fixed inline):** added 3-way fanning-join regression; updated `optimizer.md`.
- **Major (filed):** equi-pair FD over-claim folded into existing sibling ticket
  `fd-derived-key-bag-overclaim` (no new ticket — same class, augmented scope).
