description: `keysOf` was reading a bag as a set because determination/equality FDs (injective projections, join equi-pairs, fanned LEFT/RIGHT side keys, filter `a=b` equalities) became all-columns-covering and `deriveKeysFromFds` then derived a spurious unique key, dropping a required DISTINCT. Fixed at the four producers (mirroring ticket `join-fanning-isset-overclaim`): a determination/equality FD contributes an all-covering key only when an endpoint is a genuine superkey at that node; a fanned LEFT/RIGHT side's KEY FDs are dropped. `deriveKeysFromFds` (the reader) is intentionally left untouched so the lens physical-only-set case stays green.
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/fd-propagation.spec.ts, packages/quereus/test/plan/aggregates/group-by.plan.json, packages/quereus/test/plan/joins/simple-join.plan.json, docs/optimizer.md
----

## What shipped

Producer-side gating at all four sites enumerated in the fix ticket (the reader
`deriveKeysFromFds` is **untouched** — see "Design decision" below). Two patterns:

**Pattern B — gate the bidirectional determination FD** (sites 1, 2, 4). A
determination pair `{x}↔{y}` (injective projection, equi-pair, or `a=b` filter
equality) is emitted **only when `x` or `y` is a genuine superkey of the node's
real keys** (the keys available *independent of* these determination FDs). The
EC/value-equality merge stays **unconditional** (sound, carries constant
propagation, and ECs are not read by `keysOf`). Soundness: these FDs are
bijective / value-equalities, so if one endpoint is unique the other is too (both
directions then derive a correct synonym key); if neither endpoint is a real
superkey, neither column is unique, so no key may be derived.

- **Site 1 — `ProjectNode` injective FD** (`project-node.ts` `computePhysical`,
  ~lines 234-260): probe set = `projectedKeyFds` built from `projectedKeys` via
  `superkeyToFd(k, outputColCount)`. The injective `{bareOut}↔{outIdx}` pair is
  emitted only when `bareOut` or `outIdx` is `isSuperkey(…, projectedKeyFds,
  outputColCount)`. The genuine key-variant copy onto the derived column (the
  `projectedKeyFds` layering) is unchanged.
- **Site 2 — join equi-pair FD** (`join-utils.ts` `propagateJoinFds`, inner/cross
  arm, ~lines 284-308): probe set = `equiKeyFds` built from `preservedKeys` via
  `superkeyToFd(k, totalColumnCount)` **before** the equi-pair loop mutates `fds`
  (so an equi-pair can never justify itself). The two `addFd` equi-pair calls are
  gated on `isSuperkey({p.left}|{rShifted}, equiKeyFds, total)`; `addEquivalence`
  stays unconditional.
- **Site 4 — filter `a=b` equality FD** (`filter.ts` `computePhysical`, ~lines
  103-124): the two-column determination FDs returned by `extractEqualityFds` are
  gated on `isSuperkey({a}|{b}, inputFds, colCount)` against the filter's **input**
  FDs (`sourcePhysical.fds`). The `∅→col` constant FDs / `constantBindings` /
  `equivPairs` are unaffected. `extractEqualityFds` itself is **not** edited (it is
  shared with `rule-predicate-inference-equivalence`); the gate lives at the
  filter's consumption site.

**Pattern A — `dropSideKeyFds` for fanned LEFT/RIGHT side keys** (site 3,
`join-utils.ts` `propagateJoinFds`, `case 'left'` / `case 'right'`): a side whose
unique key is not in `preservedKeys` has been fanned out; its KEY FDs are still
true determinations but no longer encode uniqueness, so they are dropped via the
existing `dropSideKeyFds(fds, sideColumnCount)` helper before `withKeyFds` /
`shiftFds` — extending the inner/cross fix from ticket 4 to the outer arms.
`leftPreserved = preservedKeys.some(k => k.every(i => i < leftColumnCount))`;
RIGHT mirrors with `i >= leftColumnCount` and drops in right's own indices BEFORE
the shift. `semi`/`anti` left unchanged (left rows filtered, never duplicated).

### Design decision (load-bearing — please scrutinize, not re-litigate)

The clean reader-side fix (gate `deriveKeysFromFds` step 3 on `RelationType.isSet`)
is **unsound**: `isSet` is a build-time logical flag blind to *physical-only*
keyed sets. `lens-fd-contribution.spec.ts`'s end-to-end probe relies on a query
with `getType().isSet === false` being recognised as a set purely from an
*activated physical guarded key FD* — gating step 3 on `isSet` drops that **real**
key and wrongly retains the DISTINCT. So the fix is producer-side, where fan-out /
real-key-ness is known. The over-conservative-gate failure mode is **under-claim**
(a DISTINCT retained that could have been eliminated) — sound, and invisible to
the fuzz differential (which only fires on wrong *results*). Deterministic plan/FD
goldens catch any *legitimate* elimination regressed.

## How to validate / use cases

New spec `test/fd-derived-key-bag-overclaim.spec.ts` — 8 cases, all green. Each
site has a **repro** (DISTINCT must survive + return the deduplicated row count)
and a **control** (genuine unique endpoint ⇒ DISTINCT still eliminated):

| Site | Repro (DISTINCT must SURVIVE) | rows | Control (DISTINCT ELIMINATED) |
|---|---|---|---|
| 1 project | `select distinct -t1.c_real1, t1.c_real1 from t1` (`c_real1` non-unique) | 2 | `select distinct -tpk.c0, tpk.c0 from tpk` (`c0` is PK) |
| 2 inner join | `select distinct g.k, g2.w from g join g2 on g.k = g2.w` | 1 | `select distinct h.id, h2.z from h join h2 on h.id = h2.id` (pk=pk) |
| 3 left join | `select distinct l.id, l.k from l left join r on l.k = r.w` | 1 | `… left join r2 on l.k = r2.id` (covers r2 PK ⇒ no fan-out) |
| 4 filter | `select distinct a, b from tab where a = b` (a/b non-unique) | 2 | `select distinct a, b from tpk2 where a = b` (`a` is PK) |

Asserts both `findNodes(plan, DistinctNode).length > 0` (survival) AND the
correct deduplicated count via `db.eval`.

`test/optimizer/fd-propagation.spec.ts` updated to assert the **gated** behavior:
- "Filter: col1 = col2 over a keyless relation yields the EC but GATES the
  determination FDs" — `fdHas([0],[1]) === false`, EC `{0,1}` present.
- "Inner JOIN: a fanning equi-pair merges the EC but GATES the determination FDs".
- "LEFT outer JOIN: … a FANNED left key FD is dropped too" + a new positive
  "key-covered (non-fanning) left key FD survives" companion.

Plan goldens `joins/simple-join.plan.json` and `aggregates/group-by.plan.json`
regenerated — the only drift is removal of the gated `{3}↔{4}` equi-pair
determination FDs (the genuine preserved-key FDs remain). Confirm the drift is
exactly that and nothing else.

### Validation run during implement
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Targeted: `fd-derived-key-bag-overclaim` (8) + `fanning-join-fd-overclaim` (4) +
  `lens-fd-contribution` (all, incl. the physical-only-set DISTINCT-elimination
  probe — still green) + `optimizer/fd-propagation` (16) — **68 passing**.
- Plan goldens (`test/plan/**`) — **102 passing**.
- Full quereus suite (`node test-runner.mjs`) — **5511 passing, 9 pending, 0 failing**.
- Fuzz differential `Optimizer Equivalence › distinct elimination produces
  identical results` ran **4× total** (once in-suite + 3 standalone with fresh
  random seeds, ~100 schemas/queries) — all green. The intermittently-failing
  behavior (observed flaky seed `608451939`) did not surface.

## Known gaps / where to push (reviewer: treat tests as a floor)

- **The flaky fuzz seed was NOT pinned literally.** `fuzz.spec.ts` uses
  fast-check with random seeds and no fixed-seed hook; instead the four root-cause
  repros are pinned as the deterministic spec. This is a deliberate substitution,
  not a literal `608451939` regression guard. If you want belt-and-suspenders, a
  fixed-seed harness for the distinct path would be a separate small task.
- **Pattern B under-claim risk.** The "endpoint is a genuine superkey" gate could
  in principle retain a DISTINCT that *was* soundly eliminable in some plan the
  goldens don't cover. The fd-propagation + plan goldens caught the expected
  removals only; a reviewer should probe whether any *legitimate* elimination
  regressed (e.g. multi-equi-pair joins where a composite of equi columns is a
  real key — does the single-endpoint superkey test miss it?). If one regresses,
  the ticket's guidance is to widen the gate (include the determinant's closure
  under the real key FDs), not weaken soundness.
- **Site 4 keyed-endpoint *survival* path is not unit-tested in
  fd-propagation.spec.ts** — a keyed `a=b` equality gets pushed into the access
  path, leaving no FILTER node to inspect, so it's only covered end-to-end by the
  site-4 control. Worth confirming the keyed branch (`isSuperkey` true ⇒ FDs kept)
  is genuinely exercised somewhere, not dead.
- **`yarn test:store` (LevelDB path) and the full multi-workspace root `yarn test`
  were NOT run.** All changes are within `packages/quereus`'s planner FD logic
  (no storage/runtime surface), so other workspaces are unaffected — but I did not
  execute them. The store path in particular is pure-planner-orthogonal here.
- **Adversarial fan-out shapes worth a reviewer probe** (ticket 4's reviewer did
  this for the inner arm): RIGHT-outer fan-out (mirror of site 3) has no dedicated
  repro in the new spec — only LEFT is pinned; the RIGHT arm is covered only by
  fd-propagation unit symmetry. A `right join` DISTINCT repro would close that.
  Also: a guarded-key (lens/MV row-time) source feeding a fanning LEFT join — the
  one FD class `dropSideKeyFds` retains unconditionally — was not constructed
  (same residual concern flagged in ticket 4).

## Pointers
- Fan-out signal: `analyzeJoinKeyCoverage` (`key-utils.ts:436-481`) only pushes a
  side's keys into `preservedKeys` when the other side's key is covered, else the
  composite product key — this is the correct fan-out-aware probe for sites 2/3.
- `deriveKeysFromFds` is `fd-utils.ts` step 3; `isUnique`'s closure branch
  (~line 840) over-claims on the same bags but is **not** consulted by the DISTINCT
  path (`keysOf` → `deriveKeysFromFds`) for these repros — left untouched. A
  reviewer auditing the whole class may want to confirm no other consumer reaches
  `isUnique`'s closure branch on a bag carrying a surviving (non-gated) determination FD.
