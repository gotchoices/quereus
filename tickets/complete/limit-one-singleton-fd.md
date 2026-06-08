description: LIMIT 1 singleton-FD emission in LimitOffsetNode.computePhysical (+ constant-limit estimatedRows) and the correlation guard added to join-greedy-commute that the new singleton FD exposed. Reviewed and completed.
files: packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## What shipped

1. **Constant-LIMIT singleton FD + exact `estimatedRows`** in
   `LimitOffsetNode` (`limit-offset.ts`). A `constantLimit()` helper peels
   `CastNode`/`CollateNode` to a `LiteralNode` and `Number()`-coerces it
   (mirroring the emitter). When the constant is `≤ 1` (incl. `LIMIT 0`,
   offset-agnostic), `computePhysical` merges `singletonFd(colCount)`
   (`∅ → all_cols`) onto the source FDs. `estimatedRows` returns
   `min(sourceRows, L)` for any constant `L ≥ 0`.

2. **Correlation guard in `ruleJoinGreedyCommute`**: bail when either join input
   `isCorrelatedSubquery(...)`. The new singleton FD made a correlated `LIMIT 1`
   LATERAL advertise itself as a ≤1-row "preferred driver", so the commute swap
   moved it to the outer position and broke its correlation
   (*"No row context found for column …"*). A latent bug the singleton exposed.

3. Docs row in `docs/optimizer.md` FD-propagation table.

## Review findings

Reviewed the implement diff (`c103ed81`) with fresh eyes against the source it
touches and the source it *should* touch, from SPP / DRY / soundness / type
safety / resource / error-handling angles.

### Soundness — checked, no issues found
- **Singleton emission.** `LIMIT 0`/`LIMIT 1` ⇒ ≤1 row: sound. Offset only
  removes rows, so ignoring it is sound. Negative finite literal (`LIMIT -5`)
  ⇒ `<= 1` true ⇒ singleton emitted; emitter floors negatives to 0 rows, so
  still sound (its `estimatedRows` falls to the `min(sourceRows,100)` branch —
  a cosmetic estimate quirk for a pathological input, not unsound).
- **`CastNode`/`CollateNode` peeling vs emitter.** The planner peels and ignores
  the cast type; the emitter applies the cast then `Number()`-coerces. Walked
  the boundary cases (`CAST(1.9 AS INTEGER)`, `CAST('1' AS INTEGER)`,
  booleans, fractional limits): peeling can only ever *miss* a real singleton
  (conservative/incomplete), never falsely emit one — I could not construct a
  raw-literal-≤1 / cast-result->1 case. Confirmed sound.
- **Singleton FD propagating up a join.** When one join input is ≤1-row, its
  single row repeats across the other side, so `∅ → {that side's cols}` stays
  true on the join output. (This is the empty-key-join-coverage machinery from
  the prior ticket; re-verified it composes correctly with the LIMIT source.)
- **Commute guard.** `isCorrelatedSubquery` walks the subtree for external refs.
  Guarding *both* sides is conservative (a left-correlated-against-right shape
  isn't built today; correlation against a grandparent only forgoes an
  optimization). No regression to ordinary inner/cross joins (neither side
  correlated ⇒ commute still fires) — confirmed by the property-planner and the
  full suite.

### Test quality — one **minor** finding, fixed inline
- The implementer's `DISTINCT eliminated over a LIMIT 1 source` test used
  `SELECT DISTINCT * FROM t LIMIT 1`. Empirically (via `query_plan`) that plan
  is `Limit(Distinct(Scan t))` — the `Distinct` sits **below** the `Limit`, so
  the new singleton FD is irrelevant; the `Distinct` is dropped purely because
  `t` has a PK (`isSet`). The test passed for the wrong reason and did not
  exercise the shipped behavior.
  **Fix:** replaced it with the discriminating shape
  `SELECT DISTINCT * FROM (SELECT v FROM t LIMIT 1) s` (subquery projects away
  the PK ⇒ a bag; `LIMIT 1` makes it ≤1-row ⇒ singleton FD drives the outer
  `DISTINCT` drop), **plus a control** asserting that without the `LIMIT` the
  `DISTINCT` is retained — proving the singleton FD is the cause. Verified both
  branches against real plans before/after.

### Minor observations — noted, not actioned (no soundness impact)
- **FD cap interaction.** `mergeFds(source, [singleton])` runs `enforceCap`
  (`MAX_FDS_PER_NODE = 64`). With no `keyHints`, the empty-determinant singleton
  is classified "other" and is the last-added FD, so on a pathological source
  already carrying 64 FDs it would be the one truncated. Completeness-only loss
  in a degenerate case; not worth special-casing.
- **Fractional constant limits** (`LIMIT 1.5`) yield a fractional
  `estimatedRows` that slightly under-counts the emitter's actual 2 rows. Purely
  cosmetic for the cost model.

### Other angles — checked, empty
- **DRY/SPP:** `constantLimit()` is a small single-purpose helper; peeling logic
  intentionally mirrors `literalSqlValueOf` (documented in the doc-comment).
- **Type safety / error handling / resource cleanup:** no `any`, no swallowed
  exceptions, no resources to release; nothing to flag.
- **No new major/blocking issues** ⇒ no follow-up `fix/`/`plan/`/`backlog/`
  tickets filed.

### Validation
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn lint` (packages/quereus) — clean.
- Full suite `node test-runner.mjs` — **3629 passing, 9 pending** (unchanged;
  includes the strengthened DISTINCT test). `test:store`/`test:full` not run
  (memory-backed default, per agent guidance).
