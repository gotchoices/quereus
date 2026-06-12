description: Multi-source view UPDATE now resolves an UNQUALIFIED body-projection column reference to its owning join side by unique column ownership inside `stripSideQualifier`, so a cross-source SET value (or an authored-inverse `new.<x>` forward read) reading a partner column projected bare rides the existing captured-read machinery instead of failing at base build with the generic `Column not found`. Review the soundness of the new unqualified leaf branch, the `routePartnerRead` factoring, the signature change, and the flagged test gaps.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # THE FIX: stripSideQualifier unqualified branch + routePartnerRead helper (~2447); signature `others`→`allSides`; caller lowerValueOntoSide (~1533/1565)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # NEW unqualified-projection cases uq-1..uq-8 (inserted after the multi-hop reject, ~718)
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` (~149) — unqualified-projection paragraph
  - packages/quereus/src/planner/mutation/multi-source.ts        # reference: resolveColumnSide (~2790, unchanged), capturedValueSubquery, gateCrossSourceReads/Cardinality, registerCrossSource
difficulty: medium
----

# Review: cross-source reads through unqualified body projections

## What was implemented

The single mis-routing site identified in the plan — `stripSideQualifier`'s leaf
`substitute` — now handles an **unqualified** base-term column reference instead of
blindly returning `undefined` (the old behavior, which implicitly assumed every bare
column belonged to the owning side).

**`stripSideQualifier` leaf (`!col.table`) branch** (`multi-source.ts` ~2496):
resolves the side via `resolveColumnSide(col, allSides)` against the **full**
index-aligned sides array:
- **owning side, OR unresolvable (`undefined`)** → return `undefined` (leave the ref
  exactly as before): an owning-side bare column resolves in the lowered single-table
  UPDATE; a genuinely-unresolvable name (correlated outer ref, name on no side) keeps
  its pass-through, so nothing that worked before regresses.
- **partner side** → qualify with that side's `alias` (`{ ...col, table: allSides[i].alias }`)
  and route through the **same** path the qualified `otherQuals` branch uses.

**`routePartnerRead(col)` helper** factors the cross-source route both the
qualified-other branch and the unqualified-partner branch now share:
`gateCrossSourceCardinality?.(col)` → `registerCrossSource(col)` →
`capturedValueSubquery(srcAlias, owningSideIndex, owningPk)`, or the
`cross-source-assignment` reject when `registerCrossSource` is absent (legacy
non-build path). `owningPk` lazy resolution stays shared (closed over). Qualifying
**before** `registerCrossSource` makes the capture projection byte-identical to the
qualified case and keeps the `srcN` dedup key (`<table>.<col>`) consistent, so a body
mixing `a.av` and bare `av` mints one capture column.

**Signature change**: `stripSideQualifier` now takes `allSides: readonly JoinSide[]`
(the full array, needed by `resolveColumnSide` to return an index comparable to
`owningSideIndex`) in place of `others`; `otherQuals` is derived internally by skipping
`owningSideIndex`. The **sole** caller `lowerValueOntoSide` (~1533) dropped its
`const others = …filter(…)` line and passes `analysis.sides`. `stripSideQualifier` is
module-internal — no public surface changed (the substrate / property specs that depend
on the module are unaffected).

**Preference 2 (structured ambiguity diagnostic) intentionally omitted** — documented
inline (~2507): `resolveColumnSide` returns `undefined` for a name owned by two+ sides,
but such a body projection is already rejected as ambiguous at body planning
(`analyzeJoinView` → `analyzeBodyLineage` → `buildSelectStmt`) before decomposition ever
reaches the leaf, so the branch would be unreachable dead code; the remaining `undefined`
case (name on no side) is not a side-ambiguity and must keep its bare pass-through.

The up-front gates needed no change (confirmed): `gateCrossSourceReads` walks the
pre-substitution **view term** (sees the view column regardless of qualification),
`gateCrossSourceCardinality` and `viewColumnReadSides` both already resolve unqualified
refs via `resolveColumnSide`.

## Soundness notes worth a reviewer's eye

- **No re-route of the generated subquery.** `transformExpr`'s `column` case returns
  `cloneExpr(replacement)` *without* recursing into it, so the `capturedValueSubquery`
  this branch emits (whose internal unqualified `<pk>` refs name the owning side's PK)
  is never re-processed by `substitute`. Even if it were: the owning PK column lives on
  the owning table by definition, so `resolveColumnSide(pk)` is always owning-or-ambiguous
  → `undefined`/owning → never mis-routed to a partner. Confirm this reasoning holds.
- **Self-joins are unaffected by the new branch.** A *plain* bare base column in a
  self-join is owned by both aliases → `resolveColumnSide` returns `undefined`
  (ambiguous) — and body planning already rejects it before the leaf. A self-join
  rename projection that exposes one side's column carries a **qualified** base term
  (`m.sal`), so it takes the unchanged qualified path. The existing `ax_xs_self` /
  `ax_self` tests cover self-joins; no new unqualified self-join shape exists.

## Validation performed

- **Targeted**: `yarn workspace @quereus/quereus test --grep "93.4-view-mutation"` → 1 passing.
- **Full package suite**: `yarn workspace @quereus/quereus test` → **5938 passing, 9
  pending, 0 failing** (memory vtab). Includes `view-mutation-substrate.spec.ts` and the
  property specs the ticket called out (the `[property-planner] Rule … never fired` lines
  are informational, not failures).
- **Lint**: `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- **Build**: `yarn workspace @quereus/quereus run build` → exit 0.
- `yarn test:store` (LevelDB path) was **NOT** run — the agent default is memory-backed
  and this change is purely planner-side AST lowering (vtab-agnostic). A store spot-check
  is cheap if the reviewer wants belt-and-suspenders.

### New sqllogic cases — `93.4-view-mutation.sqllogic` (uq-1..uq-8, all green)

Treat these as the **floor**, not the ceiling:
- **uq-1** (headline): partner `pv` projected BARE, `set cval = pv` → child cval=200 for
  the joined parent, other child untouched, parent base unchanged (unqualified analogue
  of `ax_jv_x`).
- **uq-2**: owning-side bare read (`set cval2 = cval`, both on owning side) → plain strip,
  lands locally. *Asserted behaviorally* (correct value, no error) — see gap (a).
- **uq-3**: composite-PK owning side, bare partner read → read-back conjoins per-PK-column
  equalities (mirrors `ax_xscpk_v`).
- **uq-4**: partner join column UNIQUE-not-PK, bare read → accepted via the unique branch
  (mirrors `xs1u_v`).
- **uq-5**: same partner column read once qualified (`pvq`←p.pv) and once unqualified
  (`pvu`←bare pv) in one statement → both resolve to 200. *Asserted behaviorally* — see
  gap (b).
- **uq-6**: authored-inverse put writing `bv` reads `new.av` where `av` is projected BARE
  off the partner side → routes onto the put's side via capture (`bv2='y'` ⇒ `bv='y+a'`;
  unqualified analogue of `mj_v` in `93.5-authored-inverse.sqllogic`).
- **uq-7**: 1:many direction with bare partner read → `-- error: assigned side joins more
  than one` (plan-time reject; base unchanged). Mirrors `xs1n_v`.
- **uq-8**: computed (non-base) partner column read bare → `-- error: cannot write through`
  (`no-inverse`). Mirrors `ax_jv_xc`.

## Known gaps / where a reviewer should push

- **(a) "no capture minted" not directly asserted (uq-2).** The owning-side bare read is
  validated by *result correctness + absence of error*, not by inspecting the lowered plan
  for the absence of a `srcN` column. No `query_plan(...)` precedent exists in this file
  for the capture columns. A reviewer wanting a stronger guarantee could add a
  `query_plan` assertion that no `__vmupd_keys` `srcN` projection is minted.
- **(b) `srcN` dedup count not asserted (uq-5).** Whether the mixed qualified/unqualified
  reads mint one or two `srcN` columns is **value-equivalent** at runtime, so the test can
  only prove both routes resolve consistently — not the dedup count itself. The dedup is
  argued by construction (qualify-before-register → identical `<table>.<col>` key). Same
  `query_plan` route as (a) would let a reviewer assert exactly one capture column.
- **(c) Nested value-subquery unqualified read has no dedicated test.** The branch is
  applied via the same `substitute` closure threaded through `mapQueryExprUniform` at every
  nesting depth, so a partner ref nested in a value subquery routes identically to the
  qualified nested path (which is exercised today). No standalone nested-unqualified case
  was added — a reviewer could add one for completeness.
- **(d) Body-planning ambiguity rejection (the preference-2 unreachability claim) has no
  test.** The "name on both sides → rejected at body planning" behavior is pre-existing and
  documented inline, but not pinned by a new test here (the create-view-vs-first-use timing
  of the `ambiguous column name` error was not verified). A reviewer could add a case
  (`select id, dup from a join b …` with `dup` on both sides) and confirm where the
  `ambiguous column name` error fires.
- **(e) Legacy non-build path** (`propagateMultiSource`, no `registerCrossSource`) rejecting
  an unqualified partner read with `cross-source-assignment` is covered *by construction*
  (same `routePartnerRead` guard as the qualified case) but is unreachable from build, so
  it has no test — identical to the pre-existing qualified legacy path.
