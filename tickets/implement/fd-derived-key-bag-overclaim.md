description: `keysOf` reads a bag as a set because determination FDs (injective projections, join equi-pairs, fanned LEFT/RIGHT side keys, and filter `a=b` equalities) become all-columns-covering and `deriveKeysFromFds` then derives a spurious unique key. Fix at the producers, mirroring ticket `4-join-fanning-isset-overclaim`: a determination/equality FD must not contribute an all-covering key unless its determinant is a genuine superkey at that node. Four producer sites; `deriveKeysFromFds` (the reader) is intentionally left untouched so the lens physical-only-set case stays green.
prereq:
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/fanning-join-fd-overclaim.spec.ts, packages/quereus/test/lens-fd-contribution.spec.ts, packages/quereus/test/fuzz.spec.ts, docs/optimizer.md
----

## Problem (confirmed reproducing on clean HEAD)

`deriveKeysFromFds` (`fd-utils.ts` step 3) treats **any** FD whose determinant's
closure covers all output columns as proof the determinant is a unique key. That
inference is sound **only in a set** (`X → all_cols` proves rows agreeing on `X`
are identical, which bounds the relation to one row per `X` *iff there are no
full-duplicate rows*). Step 4 (the all-columns fallback) is gated on `isSet`;
step 3 is **not** — so a bag carrying an all-covering *determination* FD is read
as keyed, and `rule-distinct-elimination` (`keysOf(source).length > 0`) drops a
required DISTINCT.

An FD `K → (all_cols \ K)` is the canonical encoding of "K is a unique key", but
the same shape arises *incidentally* from determination/equality FDs over a
narrow relation — and the two are structurally indistinguishable in the FD set.
This is the identical root cause as ticket `4-join-fanning-isset-overclaim`,
which fixed it at the **producer** (the join, where fan-out is known) precisely
because the reader cannot tell a genuine key FD from an incidental one. We do the
same here for the remaining producer sites.

### Four confirmed producer sites

All four were reproduced on clean HEAD as `select distinct …` returning the
un-deduplicated row count with the `DistinctNode` eliminated:

| # | Site | Repro (DISTINCT wrongly eliminated) | Expected / Actual rows |
|---|------|--------------------------------------|------------------------|
| 1 | `ProjectNode` injective bidirectional FD | `select distinct -t1.c_real1, t1.c_real1 from t1` (`c_real1` non-unique) | 2 / **3** |
| 2 | join equi-pair bidirectional FD (inner/cross) | `select distinct g.k, g2.w from g join g2 on g.k = g2.w` | 1 / **2** |
| 3 | LEFT/RIGHT-outer side-key FD survives fan-out | `select distinct l.id, l.k from l left join r on l.k = r.w` | 1 / **2** |
| 4 | filter `a = b` equality bidirectional FD (`extractEqualityFds`) | `select distinct a, b from t where a = b` (a,b non-unique) | 2 / **3** |

Sites 1–3 are the ones named in the fix ticket. **Site 4 was discovered during
this fix** (`filter.ts` feeds `extractEqualityFds`, which emits `{a}→{b}` /
`{b}→{a}` for each `col = col` conjunct — the same bidirectional-determination
shape). It is in scope: same root cause, same fix shape.

## Design decision: producer-side, not reader-side

The clean-looking reader fix (gate `deriveKeysFromFds` step 3 on set-ness) is
**unsound to apply blindly**: `RelationType.isSet` is a logical, build-time flag
that cannot see *physical-only* keyed sets. `lens-fd-contribution.spec.ts`'s
end-to-end probe relies on `select distinct email, label from x.u where email is
not null` being recognised as a set purely from an *activated physical guarded
key FD* (its `getType().isSet` is `false`). Gating step 3 on `isSet` drops that
**real** key and wrongly retains the DISTINCT.

A *properly* gated reader fix would require tagging every genuine key-FD producer
(table / project / join / filter / aggregate / set-ops / values / lens …) with a
"this is a uniqueness assertion" bit and preserving it through `projectFds` /
`shiftFds` / `addFd`, then gating both `deriveKeysFromFds` **and**
`isUnique`'s closure branch (line ~840 — it over-claims on the same bags) on it.
That fixes the whole class at once but is a core-type change with an under-claim
regression for every producer that is missed, and it must keep the email case +
all existing FD tests green. **Deferred** — documented here as the alternative,
not the chosen path.

Chosen path = **producer-side**, mirroring ticket 4 (proven, local, sound; the
reader and the email-sensitive path are left untouched). The failure mode of an
over-conservative producer gate is **under-claim** (a DISTINCT retained that
*could* have been eliminated) — sound, and invisible to the fuzz differential
(which only fires on wrong *results*, i.e. over-claims). Existing deterministic
plan/optimizer goldens catch any *legitimate* elimination we regress.

### Two fix patterns

**Pattern A — `dropSideKeyFds` (site 3, identical to ticket 4).** A side whose
unique key is not *preserved* (no preserved key lies entirely within that side's
columns) has been fanned out; its KEY FDs are still true determinations but no
longer encode uniqueness. Drop them via the existing
`dropSideKeyFds(fds, sideColumnCount)` helper (`join-utils.ts:191`). Ticket 4
already applies this on the inner/cross arm; the LEFT/RIGHT arms still do
`withKeyFds(leftFds.slice())` / `shiftFds(rightFds, …)` **unconditionally**.

**Pattern B — gate the bidirectional/equality determination FD (sites 1, 2, 4).**
A determination FD `{x} ↔ {y}` (injective projection, equi-pair, or `a = b`
filter equality) must contribute an all-covering key **only when its determinant
is a genuine superkey at that node**. Concrete, sound rule that preserves every
legitimate case:

> Emit the determination pair `{x}→{y}` and `{y}→{x}` **only if `x` *or* `y` is a
> superkey of the node's real keys** (the keys available *independent of* these
> determination FDs). Otherwise emit neither.

Soundness: these FDs are bijective (injective projection) or value-equalities
(equi-pair / `a=b`), so if one endpoint is unique the other is unique too — both
directions then derive correct keys. If neither endpoint is a real superkey,
neither column is unique, so no key may be derived. "Real keys" per site:

- **Site 1 (project):** the `projectedKeys` already computed in
  `computePhysical` (`project-node.ts:201-226`) — built from surviving + injective
  source keys. Build key FDs via `superkeyToFd(k, outputColCount)` and test
  `isSuperkey({bareOut}, keyFds, outputColCount)` (and the reverse). When the
  source column is part of a surviving key the injective derived column is
  *already* added as a key variant (lines 216-237) — so the gated emission is
  redundant-for-keys but preserves the determination link; when it is not, the
  pair is dropped and the spurious key vanishes.
- **Site 2 (join inner/cross):** `preservedKeys` (passed into `propagateJoinFds`).
  Build key FDs via `superkeyToFd(k, totalColumnCount)` and test
  `isSuperkey({p.left}, keyFds, total)` / `isSuperkey({rShifted}, keyFds, total)`.
  Keep the `addEquivalence(...)` EC merge **unconditional** (ECs are value
  equalities, sound, and carry constant-propagation). Only gate the two
  `addFd(...)` equi-pair calls (`join-utils.ts:286-287`).
- **Site 4 (filter):** the filter's **input** FDs (`childrenPhysical[0].fds`) —
  the genuine keys present before the equality FDs are added. Test
  `isSuperkey({a}, inputFds, colCount)` / `isSuperkey({b}, inputFds, colCount)`.
  `extractEqualityFds` is shared (also used by `rule-predicate-inference-
  equivalence`), so gate at the **filter `computePhysical` consumption site**, not
  inside `extractEqualityFds` — do not change the extractor's contract.

`preservedKeys` is the correct fan-out-aware signal for sites 2 and 3:
`analyzeJoinKeyCoverage` (`key-utils.ts:436-481`) only pushes a side's keys into
`preservedKeys` when the *other* side's key is covered (i.e. that side does not
fan), and pushes the composite product key otherwise. Verified against all repros.

## TODO

### Regressions first (pin the flaky fuzz seed deterministically)
- Extend `packages/quereus/test/fanning-join-fd-overclaim.spec.ts` (or a sibling
  spec) with deterministic cases for all four sites: assert the `DistinctNode`
  **survives** (`findNodes(plan, DistinctNode).length > 0`) **and** the query
  returns the correctly-deduplicated row count:
  - Site 1: `t1 (c_text0 text not null primary key, c_real1 real)`, rows
    `('a',1.5),('b',1.5),('c',2.0)`; `select distinct -t1.c_real1, t1.c_real1 from t1` ⇒ 2 rows.
  - Site 2: the `g`/`g2` setup already in that spec; `select distinct g.k, g2.w from g join g2 on g.k = g2.w` ⇒ 1 row.
  - Site 3: `l (id integer primary key, k integer)`, `r (id integer primary key, w integer)`,
    `l=(1,100)`, `r=(10,100),(11,100)`; `select distinct l.id, l.k from l left join r on l.k = r.w` ⇒ 1 row.
  - Site 4: `t (id integer primary key, a integer, b integer)`, rows
    `(1,1,1),(2,1,1),(3,2,2)`; `select distinct a, b from t where a = b` ⇒ 2 rows.
  - Add a **control** per pattern that must stay eliminated: e.g. site-1
    `select distinct -t.c0, t.c0 from t` where `c0` is the PK (injective over a
    unique col ⇒ still a set, DISTINCT eliminated); site-4 `select distinct a, b
    from t where a = b` where `a` is the PK.

### Fix site 3 — LEFT/RIGHT-outer fan-out (Pattern A)
- In `propagateJoinFds` (`join-utils.ts`), `case 'left'`: compute
  `leftPreserved = preservedKeys.some(k => k.every(i => i < leftColumnCount))` and
  use `leftPreserved ? leftFds : dropSideKeyFds(leftFds, leftColumnCount)` before
  `withKeyFds`. Mirror in `case 'right'`: `rightPreserved = preservedKeys.some(k =>
  k.every(i => i >= leftColumnCount))`, apply `dropSideKeyFds(rightFds,
  totalColumnCount - leftColumnCount)` (in right's own indices) **before**
  `shiftFds`. Leave `semi`/`anti` unchanged (left rows are filtered, never
  duplicated ⇒ keys genuinely preserved).

### Fix site 2 — join equi-pair determination FDs (Pattern B)
- In `propagateJoinFds` inner/cross arm, build `keyFds` from `preservedKeys`
  (`superkeyToFd(k, totalColumnCount)`) once, then for each equi-pair only
  `addFd` the `{p.left}→{rShifted}` / `{rShifted}→{p.left}` FDs when `p.left` or
  `rShifted` is `isSuperkey(…, keyFds, totalColumnCount)`. Keep `addEquivalence`
  unconditional. (Build `keyFds` from `preservedKeys` *before* the equi-pair loop
  mutates `fds`, to avoid using the equi-pair FDs as their own justification.)

### Fix site 1 — ProjectNode injective determination FDs (Pattern B)
- In `project-node.ts` `computePhysical`, gate the injective bidirectional
  `addFd` calls (lines ~238-243): build `keyFds` from `projectedKeys`
  (`superkeyToFd(k, outputColCount)`) and emit the pair only when `bareOut` or
  `outIdx` is `isSuperkey(…, keyFds, outputColCount)`. The key-variant logic at
  lines 216-237 (which routes genuine keys through `superkeyToFd`) is unchanged.

### Fix site 4 — filter `a = b` equality determination FDs (Pattern B)
- In `filter.ts` `computePhysical`, after `extractEqualityFds`, filter the
  returned `col→col` FDs so a pair `{a}↔{b}` survives only when `a` or `b` is
  `isSuperkey(…, inputFds, colCount)` against the filter's **input** FDs. The
  `∅→col` constant FDs and `constantBindings`/`equivPairs` are unaffected — only
  the two-column determination FDs are gated. Do **not** edit `extractEqualityFds`
  (shared with `rule-predicate-inference-equivalence`).

### Validate
- `deriveKeysFromFds` (`fd-utils.ts`) stays **untouched** — this is the explicit
  decision that keeps `lens-fd-contribution.spec.ts`'s physical-only-set DISTINCT
  elimination green. Re-run that spec specifically.
- Run `packages/quereus/test/optimizer/fd-*.spec.ts` and the plan goldens —
  Pattern B at sites 2/4 is the most likely to regress a *legitimate* elimination
  (under-claim). If one regresses, confirm the eliminated DISTINCT was genuinely
  sound there and widen the gate (e.g. include the determinant's closure under the
  real key FDs), rather than weakening soundness.
- Full `yarn test` from repo root, streaming: `yarn test 2>&1 | tee /tmp/t.log;
  tail -n 80 /tmp/t.log`. The fuzz differential `Optimizer Equivalence › distinct
  elimination produces identical results` (`test/fuzz.spec.ts`, observed flaky
  seed `608451939`) must stop intermittently failing.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- Update `docs/optimizer.md` § Functional Dependency Tracking: note that
  determination/equality FDs (injective projections, equi-pairs, `a=b` filters)
  are emitted as all-covering keys only when an endpoint is a genuine superkey,
  and that fanned LEFT/RIGHT side keys are dropped (extending the ticket-4 note).
