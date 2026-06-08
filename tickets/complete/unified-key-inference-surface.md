description: Unified uniqueness read surface (keysOf/isUnique) reconciling RelationType.keys, PhysicalProperties.fds and RelationType.isSet; consumer migration (distinct/orderby/groupby); per-operator soundness fixes (combineJoinKeys inner/cross, set-operation keys, project isSet); Tier-1 key-soundness property harness. Reviewed and accepted.
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts, packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/optimizer/keysof-isunique.spec.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts, packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, docs/architecture.md
----

## Summary

A single uniqueness read surface (`keysOf` / `isUnique` in `planner/util/fd-utils.ts`)
that reconciles the three places a uniqueness fact can live (`RelationType.keys`,
`PhysicalProperties.fds`, `RelationType.isSet`), the migration of the audited
consumers (distinct/orderby/groupby rules) onto it, two soundness fixes surfaced
by the new Tier-1 key-soundness harness (join key over-claim in `combineJoinKeys`
inner/cross; set-operation key over-claim), a project-node `isSet` soundness fix,
and the corresponding docs.

Implemented in commit `12d9f03f`. Reviewed here and **accepted** — no inline
changes were required and no new follow-up tickets were filed (the two deferrals
below pre-date this work and are tracked separately).

## Review findings

### What was checked

- **`keysOf` / `isUnique` soundness (`fd-utils.ts`).** Walked the helper chain
  (`computeClosure`, `isSuperkey`, `deriveKeysFromFds`, `hasSingletonFd`,
  `normalizeKeys`, `superkeyToFd`). Confirmed:
  - `computeClosure` skips guarded FDs (`fd.guard !== undefined`), so the closure
    branch of `isUnique` cannot be fooled by a conditional FD.
  - The proper-subset guard in `isUnique` (`colSet.size < columnCount`) is the
    soundness crux and is correct: it blocks the all-columns tautology (closure of
    all columns trivially covers all columns) from reporting a bag's full-row set
    as unique. The all-columns case is instead handled soundly by the `keysOf`
    branch, which gates the all-columns fallback on `isSet`.
  - `[] ⟺ bag`, empty-key subsumption, and superset dropping all hold (verified by
    the new unit spec `keysof-isunique.spec.ts`).

- **`combineJoinKeys` inner/cross fix (`key-utils.ts`).** The coverage gating
  (left keys survive iff equi-pairs cover a right key; symmetric for right) is
  sound and mirrors `analyzeJoinKeyCoverage`'s `preservedKeys` path. Critically
  confirmed why only the *keys* path needed gating and the physical-FD union
  path did **not**: a per-side FD `K_l → (left_cols \ K_l)` survives a cross/inner
  join unchanged (it determines only the left columns and `K_l` identifies one
  left row regardless of right-row duplication), and `deriveKeysFromFds` requires
  full-column closure — so `K_l` is correctly never reconstructed as a join key.
  The bug was strictly in `combineJoinKeys` building full keys directly.

- **`set-operation-node.ts` key fix.** `intersect`/`except` keep left keys
  (result ⊆ left rows ⇒ left key still holds); `union`/`unionAll` drop them
  (right side can reintroduce a left-key value; UNION ALL also duplicates). Sound.
  `isSet = op !== 'unionAll'` is correct (UNION/INTERSECT/EXCEPT all dedupe).

- **`project-node.ts` `isSet` fix.** `isSet` is true iff a declared source key
  survives the projection, or the source is a set and every source column
  survives (`map.size === sourceType.columns.length`). Verified `map` counts
  distinct surviving source columns (bare + injective-derived), so a row-injective
  projection of a set is correctly still a set and a key-dropping projection is
  correctly a bag. Conservative (loses completeness, never soundness).

- **Migrated rules.** distinct-elimination (`keysOf(source).length > 0`),
  orderby-fd-pruning (whole-tail prune once leading bare-column keys are
  `isUnique`), groupby-fd-simplification (lift source keys into the cover via
  `superkeyToFd`) all read through the unified surface and are sound. The
  groupby lift is sound because a mapped source key makes each group a single
  source row, so MIN recovers every functionally-determined column.

- **Remaining `isSet` writers (audited by inspection + reasoning).**
  `aggregate-node` (`isSet=true`): sound — group-by columns are *always*
  materialized in the AggregateNode output, so groups are distinct on the full
  output even when the user later projects the group column away (handled by the
  now-sound project `isSet`). `values-node`: sound (`isSet=false` for the row
  case; `true` only for 0-row). `recursive-cte-node` (`isSet=!isUnionAll`): sound
  — UNION-DISTINCT recursive CTEs dedupe the result set. `cte`/`cte-reference`:
  sound forwarding of the underlying query type. `join-utils` cross/inner
  `isSet = left.isSet && right.isSet`: sound (Cartesian product of two sets is a
  set). `async-gather` `concatColumns` (`isSet=every branch set`): positional
  column-zip, pre-existing, outside this diff — left as-is.

- **Tests / lint / docs.** Ran the new unit spec, the migrated specs, the Tier-1
  property harness, and the full optimizer+planner suite. Confirmed the two
  *modified* tests were strengthened (not weakened) to reflect now-sound pruning,
  with the limit-pushdown change isolating the multi-key bail by disabling
  `orderby-fd-pruning` (legitimate test isolation). Read `docs/optimizer.md` and
  `docs/architecture.md` changes against the code — accurate, including the
  SetOperationNode key table row, ProjectNode `isSet` note, `combineJoinKeys`
  gating, and the new `keysOf`/`isUnique` section.

### Validation run during review

- `keysof-isunique.spec.ts`, `keys-propagation.spec.ts`,
  `rule-orderby-fd-pruning.spec.ts`, `monotonic-limit-pushdown.spec.ts`: **75 passing**.
- `property.spec.ts` "Key Soundness": **2 passing**, re-run 5× for stability
  (probabilistic, numRuns=50) — green every time.
- Full optimizer + planner directories: **1729 passing**, 0 failing.
- `yarn lint` (quereus): clean.
- (Implementer previously reported the full suite at 3605 passing / 9 pending,
  `yarn typecheck` clean, `yarn build` clean.)

### Findings disposition

- **Minor (noted, not fixed — completeness only, no soundness impact):**
  `joinPairsCoverKey` requires `k.length > 0`, so an empty key (`[]`, ≤1-row) on
  the opposite side of a join is not recognized as coverage — a join against a
  provably ≤1-row side will not preserve the other side's keys. Also,
  `combineJoinKeys` (logical-keys path) lacks the FD-superkey coverage branch that
  `analyzeJoinKeyCoverage` (physical path) has. Both are completeness gaps, not
  soundness gaps, and align with the ticket's explicit "completeness is bounded"
  stance. No fix applied; no ticket filed.

- **Noted assumption (pre-existing, not introduced here):** the whole-tail
  ORDER BY pruning and DISTINCT elimination treat a declared key as truly unique.
  If a nullable column participated in a declared key under NULL-distinct UNIQUE
  semantics, two NULL-keyed rows could be treated as a single key value. This
  assumption already governed the *old* orderby rule (which dropped a trailing
  bare column determined by a leading key's `K → col` FD) and the old
  distinct-elimination (`keys.length > 0`), so it is pre-existing and consistent —
  not a regression. No action taken.

- **Major:** none.

### Deferrals carried forward (from the implement handoff, unchanged)

- **Join FK→PK at-most-one recognition via `isUnique`** was deferred. The FK→PK
  paths (`rule-join-elimination`, `rule-fanout-lookup-join`,
  `rule-semi-join-fk-trivial`) remain structural (`checkFkPkAlignment` /
  `lookupCoveringFK`) and were already sound — the acceptance criterion
  ("no false at-most-one") holds. Optional completeness enhancement only.
- **Tier-2 key-soundness harness** (isolated per-node materialization) is tracked
  in `tickets/backlog/key-soundness-harness-tier2.md`. Tier 1 is the soundness
  floor and already caught the two real over-claims fixed here.
