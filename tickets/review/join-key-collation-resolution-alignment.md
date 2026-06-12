description: Review — pairwise join-key collation resolution (USING/merge/bloom/asof) now routes through the shared provenance-ranked comparison-collation resolver; plan-time USING conflict validation added; MV backing-column collationExplicit threaded from output collation provenance.
files:
  - packages/quereus/src/runtime/emit/merge-join.ts                  # key collations → effectiveCollationOfTypes (loud-throw backstop)
  - packages/quereus/src/runtime/emit/bloom-join.ts                  # key normalizers → effectiveCollationOfTypes
  - packages/quereus/src/runtime/emit/asof-scan.ts                   # match + partition collations → effectiveCollationOfTypes
  - packages/quereus/src/runtime/emit/join.ts                        # USING comparator — ALREADY landed by prereq (verified only)
  - packages/quereus/src/planner/building/select.ts                  # NEW validateUsingCollations at join build
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # gate kept conservative; docstring corrected
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # deriveBackingShape → collationExplicit from collationSource
  - packages/quereus/src/planner/analysis/comparison-collation.ts    # the shared resolver (prereq; unchanged)
  - packages/quereus/test/logic/11.1-join-using.sqllogic             # USING precedence both spellings + conflict + ON uniformity
  - packages/quereus/test/logic/82-bloom-join.sqllogic               # asymmetric (mirror) correctness
  - packages/quereus/test/logic/83-merge-join.sqllogic               # asymmetric + REAL MergeJoin over NOCASE text PK
  - packages/quereus/test/logic/84-asof-scan.sqllogic                # asymmetric (right-only NOCASE) partition — the live `??` fix
  - packages/quereus/test/logic/51.5-materialized-views-coarsened-key.sqllogic  # explicit-BINARY MV PK survives store reconcile
  - docs/optimizer.md                                                # bloom/merge collation bullets
  - docs/schema.md                                                   # MV backing-column collationExplicit note
----

# Review: join-key collation resolution alignment

The four pairwise comparison sites the prereq (`comparison-collation-provenance-and-precedence`,
now in complete/) left on ad-hoc per-emitter rules now resolve through the
shared `resolveComparisonCollation`/`effectiveCollationOfTypes` lattice
(explicit > declared > default > BINARY, **symmetric**, plan-time error on
same-rank explicit/declared conflicts). Plus plan-time USING conflict
validation and MV backing-column `collationExplicit` threading.

## What landed (and what was already done)

- **merge-join / bloom-join / asof-scan emitters** — each pairwise key
  collation now = `effectiveCollationOfTypes(leftType, rightType)`, replacing
  `left || right` (merge/bloom) and `left ?? right` (asof). The resolver throws
  `QuereusError` on a same-rank explicit/declared conflict — a **loud backstop**
  mirroring `effectiveComparisonCollation`. `BINARY_COLLATION` fallback imports
  dropped (the resolver always returns a name; `ctx.resolveCollation('BINARY')`
  yields the binary fn).
- **join.ts USING comparator** — **already routed through the resolver by the
  prereq** (`join.ts:47`). Verified, not modified. Listed in the ticket TODO but
  pre-done; the prereq's module docstring lists "the USING-join comparator" as a
  caller.
- **Plan-time USING validation** — NEW `validateUsingCollations` in
  `select.ts buildJoin`. USING pairs never become `BinaryOpNode`s, so
  `BinaryOpNode.generateType`'s lattice check (which covers ON equi-joins) never
  sees them; this runs `resolveComparisonCollation` over each paired attribute
  and throws the **same** `collationConflictError` a spelled-out `l.c = r.c`
  would — at plan time, not just as the emitter backstop.
- **equi-pair-extractor gate** — **NOT loosened** (deliberate). Docstring
  corrected: it previously claimed the emitters used "left-operand precedence" /
  "right-first" resolution, now obsolete.
- **MV backing columns** — `deriveBackingShape` sets `collationExplicit: true`
  iff the body output column's `collationSource` is `explicit`/`declared`; left
  unset for `default`/absent (matching `ColumnSchema`'s "absent ⇒ implicit").

## The lockstep conclusion (please sanity-check this reasoning)

The ticket's flagged "real risk" was the planner-side merge-join ordering
mirror. **Finding:** `PhysicalProperties.ordering` is `{column, desc}[]` —
**collation-blind**, no place to "route the resolver." A column's advertised
ordering is implicitly under its own declared collation. Merge correctness
(both inputs sorted under the key's comparison collation) is preserved **by the
`equi-pair-extractor` matched-collation gate**, not by an ordering-property
change: the gate requires `operandCollation(left) === operandCollation(right)`,
so the resolved key collation always equals each input's declared sort
collation. That is why the gate is kept conservative — loosening it (admitting
e.g. declared-NOCASE vs defaulted-BINARY → resolves NOCASE) would compare under
NOCASE a side sorted under BINARY and silently break the merge. Documented at
both ends (emitter comments + gate docstring + `docs/optimizer.md`).

**Reviewer ask:** confirm there is no *other* collation-carrying ordering
surface I missed — e.g. how `SortNode` / access-path `getOrdering()` relate the
advertised ordering to the underlying column collation. I checked
`isOrderedOnEquiPairs` / `reorderEquiPairsForMerge` (column+desc only) and the
`PhysicalProperties.ordering` type; both are collation-blind.

## Behavioral surface (where this actually changes results)

Because the gate keeps asymmetric/conflicting pairs OUT of merge/bloom (they
demote to the nested-loop residual), the merge/bloom emitter changes are
effectively **no-ops for currently-admitted pairs** (matched collation → both
`left || right` and the resolver yield the same name); their value is the loud
backstop + symmetric robustness if the gate is ever loosened or a synthesized
pair bypasses it. The genuine result-affecting fixes are:
1. **asof partition collation** — asof has **no equi-pair gate**, so the
   `?? `→resolver change is *live*: a partition column declared NOCASE on the
   **right** side only (left defaulted BINARY) now folds case (old left-first
   `??` picked BINARY). Covered by the new `asof_*_mix` case in 84.
2. **USING comparator both spellings** — left-only→symmetric (prereq code; new
   tests pin the mirror spelling in 11.1).
3. **new plan-time USING conflict error** (11.1).
4. **MV explicit-collation backing PK** under the store reconcile (51.5 §9).

## Test coverage (the floor — extend as you see fit)

All green: `yarn build`, `yarn test` (5977 passing), streamed `yarn test:store`
(5973 passing), `yarn lint`. Targeted files pass memory + store.

- **11.1** — USING precedence both spellings (BINARY→0 / NOCASE→3 rows pins the
  collation); conflict (declared NOCASE vs RTRIM) → plan-time `ambiguous
  collation` error for USING **and** the equivalent ON (uniformity); explicit
  `collate nocase` clears the conflict and matches.
- **83** — asymmetric mirror (nested-loop demotion, NOCASE result); **real
  MergeJoin over NOCASE text PK** (`mj_ci_pk_*`, asserts `node_type=MergeJoin`
  + case-folded results) — the actual merge-emitter NOCASE path (the older
  `mj_nocase` ON-name join is a hash join since `name` isn't ordered).
- **82** — asymmetric mirror correctness (existing `bj_nocase` line ~96 is a
  real hash join over NOCASE).
- **84** — right-only-NOCASE partition (`asof_*_mix`) — the live `??` fix.
- **51.5 §9** — MV publishing explicit `collate binary` key over `'Bob'`/`'bob'`
  (distinct under BINARY, colliding under the store's NOCASE default) keeps both
  rows under `test:store`; a plain-column MV keeps historic behavior. This is the
  load-bearing proof of the `collationExplicit` thread — it would fail under
  store WITHOUT the change (NOCASE re-key → collision/"not a set").

## Known gaps / honest flags (treat my tests as a floor)

- **asof has no plan-time USING-style validation.** A genuinely-conflicting
  asof (both match/partition sides carrying *different explicit* collations)
  surfaces the emitter's loud backstop at *emit* time, not plan time —
  asymmetric vs USING/ON. Judged acceptable (asof match/partition attrs are
  almost always the same source column), but if you want plan-time parity, the
  asof-building rule is the site. Not currently tested (no fixture builds such a
  conflict).
- **MV reopen round-trip not directly tested.** 51.5 §9 exercises the store
  **create/fill reconcile** (where `collationExplicit` is consumed). A full
  close-and-reopen DDL round-trip of an explicit-collation MV goes through the
  store rehydrate path (reads persisted DDL; `generateTableDDL` already emits
  non-BINARY collations explicitly). Not separately asserted here — a dedicated
  `quereus-store` reopen spec would close it.
- **`collationExplicit: false` vs unset.** I leave the field unset for
  default/implicit columns (per the field's "absent ⇒ implicit" contract) rather
  than writing `false`. Confirm no consumer distinguishes `=== undefined` from
  `=== false` (store check is `if (col.collationExplicit)` — both fall through
  identically; verified at `store-module.ts:2466`).
- **NATURAL join** is not parsed at all (`parser.ts` joinType has no `natural`).
  The USING validation would apply for free if NATURAL is ever added (it
  desugars to USING pairs). No test, nothing to test today.
- **Merge/bloom no-op caveat** (above): because the gate is conservative, the
  merge/bloom emitter diffs don't change any *current* result; their tests
  assert no-regression + the real-MergeJoin-NOCASE path. If a reviewer loosens
  the gate later, the emitter resolver + the documented lockstep must be
  re-validated together.

## Suggested adversarial angles

- Force a synthesized equi-pair (decorrelation/quickpick) with mismatched
  declared collations and confirm it either never reaches merge/bloom or trips
  the loud backstop (the ticket's "if it trips the backstop, the gate is the
  bug" invariant).
- A 3-way join mixing a NOCASE-PK merge level with a BINARY level — confirm each
  level resolves independently and orderings don't cross-contaminate.
- MV over a body whose key column is a *defaulted* non-BINARY session collation
  (`default_collation = nocase`) — `collationSource` should be `default` →
  `collationExplicit` unset → historic store reconcile (verify this is intended;
  the ticket says leave unset for 'default').
