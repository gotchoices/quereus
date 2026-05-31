description: Review the regression coverage that locks in the `'prefix-delete'` lateral-TVF fan-out maintenance arm under a NON-binary (NOCASE) base primary key, plus the newly-enforced plan-build invariant (backing base-PK collation == source PK collation). The arm's `delete-by-prefix` early-terminates its prefix scan on a BINARY compare while the btree orders by declared collation; this was reasoned-sound but previously untested. This ticket added layer-level unit cases, a NOCASE-base-PK equivalence suite, a sqllogic section, a defensive plan-build assertion, and a docs note.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md
----

# Review: NOCASE base-PK regression coverage for the prefix-delete arm

## What this implements

The `'prefix-delete'` lateral-TVF fan-out maintenance arm deletes a changed base row's
whole backing fan-out slice via the `delete-by-prefix` `MaintenanceOp`. That op's prefix
scan early-terminates on a **binary** value compare (`scan-layer.ts` line ~102 and
`plan-filter.ts` line ~23 — both `compareSqlValues(...)` with **no** collation argument),
while the backing btree orders the base-PK prefix by the column's **declared collation**.

Review of the original arm concluded this is sound for the MV path even under a non-binary
base PK, because:
1. the backing base-PK column **inherits** the source PK collation (verified empirically:
   for `id text collate NOCASE primary key`, the backing `_mv_*` PK column 0 carries
   `NOCASE`), so the btree orders the prefix exactly as the value the delete is built from; and
2. source-PK **uniqueness** under that collation collapses each collation class to one binary
   value, so a base row's fan-out rows are binary-homogeneous and contiguous; no
   collation-equal/binary-different base rows can interleave.

That reasoning was **untested** (the prior harness used integer/binary PKs only). This ticket
adds the missing coverage and promotes assumption (1) to an enforced invariant.

### Changes

- **Layer-level unit cases** — `test/vtab/maintenance-prefix-delete.spec.ts`, new describe
  block `…delete-by-prefix (NOCASE leading base-PK)` (6 cases). Composite PK
  `(a text collate NOCASE, b integer)`, leading column NOCASE. Slices are binary-homogeneous
  but their NOCASE order (`apple < Banana < cherry`) **differs from** their binary order
  (`Banana=0x42 < apple=0x61 < cherry`), so both the NOCASE-ordered btree walk and the binary
  early-termination are genuinely exercised. Asserts: NOCASE-ordered walk; removes exactly the
  leading slice / an interior slice; **binary-prefix contract** (a case-only-different prefix
  value `'APPLE'` matches nothing — documents that the MV path stays sound by always supplying
  the exact stored bytes); no-op on no match; secondary-index bookkeeping.
- **Equivalence suite** — `test/incremental/maintenance-equivalence.spec.ts`, new describe
  `…lateral-TVF fan-out, NOCASE base PK` (2 cases). Source `t (id text collate NOCASE primary
  key, n integer)`, body `select t.id, f.value from t cross join lateral generate_series(1,
  t.n) f`. Random mutations over a both-cases id space (`a`/`A`, `b`/`B`, …) so they routinely
  collide under NOCASE (PK-uniqueness collapse → tolerated CONSTRAINT), rewrite the PK
  case-only (same PK under NOCASE, but moves the stored bytes), move the whole prefix, and
  grow/shrink/empty the fan-out (`n` straddles 0). Asserts `read(MV) == evaluate(body)`
  in-txn (reads-own-writes) and post-rollback (`numRuns: 60`), plus a focused case-only-rewrite
  test (`'apple' → 'APPLE'` re-keys the slice to the new bytes; old lowercase gone).
- **sqllogic** — `test/logic/53-materialized-views-rowtime.sqllogic` §23.5: create + baseline,
  insert (new slice whose binary value sorts before an existing NOCASE-earlier slice),
  grow/shrink, **case-only PK rewrite**, NOCASE-matched delete, mid-txn + rollback.
- **Enforced invariant** — `src/core/database-materialized-views.ts`,
  `buildLateralTvfPrefixDeletePlan`: for each leading base-prefix backing-PK column, assert
  `normalizeCollation(backingPk.collation) === normalizeCollation(sourcePk.collation)`,
  throwing `INTERNAL` on mismatch. This makes soundness fact (1) a fail-loud precondition
  rather than an assumption. New module helper `normalizeCollation`. Also `residualRowMatchesBasePrefix`
  already compares with `d.collation` (collation-aware), unchanged.
- **Docs** — `docs/incremental-maintenance.md`: a "Non-binary base-PK collation soundness"
  paragraph under the prefix-delete arm, including the contrast with
  `lookupCoveringConflicts`/`tryBuildCoveringPrefix` (which DOES gate off non-binary collation,
  because it keys off a UNIQUE constraint that can hold collation-equal/binary-different rows).

## How to validate

- `yarn workspace @quereus/quereus run test` — full suite green (4122 passing, 9 pending, 0
  failing) with these additions.
- Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts"
  "packages/quereus/test/incremental/maintenance-equivalence.spec.ts" --colors`
- sqllogic: same runner over `"packages/quereus/test/logic.spec.ts" --grep
  "53-materialized-views-rowtime"`.
- `yarn workspace @quereus/quereus run typecheck` / `… run lint` / `… run build` — all clean.

## Honest gaps / where to push (the reviewer should treat tests as a floor)

- **The interleaving hazard is NOT directly tested — it is structurally unconstructable here.**
  A layer-level test can only confirm the *safe* (binary-homogeneous) case: under a real NOCASE
  base PK, two collation-equal/binary-different leading values would be the *same* PK, so they
  cannot coexist. The hazard could only manifest if a backing base-PK column's collation were
  MORE permissive than the source's — which the type derivation is believed to prevent and the
  new plan-build assertion now enforces. So the hazard is guarded by the *assertion*, not by a
  positive test that exercises mis-deletion.
- **The new assertion is verified only in the non-firing direction.** All paths confirm it does
  NOT spuriously fire (integer PKs → BINARY==BINARY; NOCASE source → NOCASE==NOCASE). There is
  **no** test that forces the assertion to FIRE: doing so would require a backing whose
  collation diverges from its source, which the normal `deriveBackingShape` path never produces,
  and the assertion runs at `create materialized view` (build time) before the plan is
  registered, so it is awkward to provoke without monkey-patching the derivation. Consider
  whether a white-box test (stub a divergent backing collation and assert the `INTERNAL` throw +
  message) is worth adding, or whether the non-firing coverage + the loud guard suffices.
- **Equivalence is probabilistic** (`numRuns: 60`, id space of 7 letters, ≤12 mutations/run).
  It is a property floor, not an exhaustive proof. The reviewer may bump `numRuns` or widen the
  id/`n` space to fish for edge cases (e.g. multi-column base PKs with a NOCASE leading column —
  only the single-column NOCASE PK is exercised end-to-end; the layer test covers a *composite*
  `(NOCASE, int)` PK directly but not through the MV path).
- **Store module not run.** Validated under the default memory backing only (`yarn test`), not
  `yarn test:store`. The MV backing table is always a `memory` table regardless of the source's
  module, so store mode is not expected to alter the prefix-delete path — but this was not
  executed.
- **RTRIM / other non-binary collations not covered.** Only NOCASE is exercised. The invariant
  and reasoning are collation-agnostic, but only NOCASE has a test.
