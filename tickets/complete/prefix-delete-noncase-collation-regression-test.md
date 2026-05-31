description: NOCASE base-PK regression coverage for the lateral-TVF fan-out `'prefix-delete'` maintenance arm, plus a plan-build invariant (backing base-PK collation == source PK collation). Locks in that the arm's BINARY-compare prefix-scan early-termination stays sound under a non-binary (NOCASE) base primary key. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, packages/quereus/src/schema/table.ts
----

# Complete: NOCASE base-PK regression coverage for the prefix-delete arm

## What landed

The `'prefix-delete'` lateral-TVF fan-out maintenance arm deletes a changed base row's
whole backing fan-out slice via the `delete-by-prefix` op. That op early-terminates its
prefix scan on a **binary** value compare (`scan-layer.ts` ~line 102, `plan-filter.ts`
line 23 — both `compareSqlValues(...)` with no collation arg), while the backing btree
orders the base-PK prefix by the column's **declared collation**. This is sound under a
non-binary base PK because (1) the backing base-PK column inherits the source PK
collation, so the btree orders the prefix exactly as the value the delete is built from,
and (2) source-PK uniqueness under that collation collapses each collation class to one
binary value, so a base row's fan-out rows are binary-homogeneous and contiguous.

This ticket added the previously-missing coverage and promoted assumption (1) to an
enforced plan-build invariant:

- **Layer-level unit cases** (`test/vtab/maintenance-prefix-delete.spec.ts`) — composite
  PK `(a text collate NOCASE, b integer)` whose NOCASE order differs from binary order, so
  both the NOCASE-ordered walk and the binary early-termination are genuinely exercised.
- **NOCASE-base-PK equivalence suite** (`test/incremental/maintenance-equivalence.spec.ts`)
  — `read(MV) == evaluate(body)` over random mutations (`numRuns: 60`) plus a focused
  case-only-rewrite test.
- **sqllogic §23.5** (`test/logic/53-materialized-views-rowtime.sqllogic`).
- **Plan-build invariant** (`database-materialized-views.ts`, `buildLateralTvfPrefixDeletePlan`)
  — asserts backing base-PK collation == source PK collation, throwing `INTERNAL` on
  mismatch; new `normalizeCollation` helper.
- **Docs** (`docs/incremental-maintenance.md`) — "Non-binary base-PK collation soundness"
  paragraph including the contrast with `tryBuildCoveringPrefix` (which DOES gate off
  non-binary collation, keying off a UNIQUE constraint that can hold
  collation-equal/binary-different rows).

## Review findings

Adversarial pass over the implement diff (`d4a33bcf`), read before the handoff summary.

### Verified correct (no action)

- **The plan-build assertion is precisely correct, not just approximately.** The implement
  handoff did not flag it, but I scrutinized the choice to compare the backing PK-*definition*
  collation (`d.collation`, what the btree orders by) against the source *column* collation
  (`sourceSchema.columns[sc].collation`) rather than the source PK-*definition* collation —
  the soundness argument's uniqueness-collapse half technically depends on the latter. Traced
  the schema builder (`src/schema/table.ts`): both the table-level PK path (`findConstraintPKDefinition`,
  ~line 583) and the column-level PK path (`findColumnPKDefinition`, ~line 615) derive PK-def
  collation as `columns[colIndex].collation || 'BINARY'`. There is **no** independent
  PK-clause collation override in this engine, so source PK-def collation ≡ source column
  collation always. The assertion's comparison is therefore exactly equivalent to the
  collation under which source-PK uniqueness holds — the guard is sound.
- **The binary-compare early-termination reasoning is accurate.** Confirmed `scan-layer.ts`
  breaks the prefix scan on `compareSqlValues(...)` with no collation (line 102) and
  `plan-filter.ts` `planAppliesToKey` matches the prefix on a no-collation `compareSqlValues`
  (line 23). Since `planAppliesToKey`-true rows in a slice are binary-homogeneous and
  contiguous in the NOCASE-ordered walk, breaking at the first byte-prefix mismatch is correct.
- **The assertion IS genuinely exercised in the matching direction.** The NOCASE equivalence
  suite would throw `INTERNAL` (and fail) if the backing PK collation derived as
  `undefined`/`BINARY` while the source is `NOCASE`; it passes, so the backing column
  empirically carries `NOCASE` — confirming the inheritance fact the assertion guards.
- **The docs contrast is factually correct.** `tryBuildCoveringPrefix` does gate off
  non-binary collation (`database-materialized-views.ts` lines 2041/2043, `isBinaryCollation`
  on both backing-PK and source-UC columns), for the documented reason.

### Considered and declined (with reason)

- **No positive (firing-direction) test for the new assertion.** The implementer flagged
  this. I considered adding a white-box test that forces the `INTERNAL` throw. Declined: the
  only ways to provoke it are (a) monkey-patching `deriveBackingShape` to emit a divergent
  backing collation — janky, and against the project's "no half-baked janky" guidance — or
  (b) refactoring the 3-line in-loop guard (which closes over `mv.name` and column names for
  its message) into an exported pure helper purely to unit-test a defensive internal-invariant
  assert — over-engineering for a guard whose mismatch the schema builder structurally prevents
  (verified above). The non-firing direction is covered across the full suite, and the guard's
  job is to fail loud on a *future* derivation regression. Positive coverage is a nice-to-have,
  not a correctness gap; left as-is rather than introduce a brittle/over-built test.

### Coverage breadth (acknowledged floors, not defects)

- **Equivalence is probabilistic** (`numRuns: 60`, 7-letter id space, ≤12 mutations/run) — a
  property floor, as the implementer noted.
- **MV-path composite NOCASE PK not exercised end-to-end** — only single-column NOCASE PK
  goes through the full MV path; the layer test covers a composite `(NOCASE, int)` PK directly.
- **Only NOCASE among non-binary collations.** RTRIM/others untested; the invariant and
  reasoning are collation-agnostic and NOCASE is the representative case.
- **Store module not run.** The MV backing is always a `memory` table regardless of source
  module, so `yarn test:store` is not expected to alter this path; not executed.
- These are honest floors a future ticket may widen; none indicates an incorrectness.

### Tangential observation (not filed — out of scope, pre-existing)

- `runAlterPrimaryKey` (`src/runtime/emit/alter-table.ts` ~line 570) and the store module's
  `alterPrimaryKey` build new PK definitions as `{ index, desc }` **without** `collation`,
  so an `ALTER … ALTER PRIMARY KEY` drops PK-def collation (→ `BINARY`). Pre-existing, outside
  this diff, and only latently reachable by MV maintenance after a source PK alter (a path not
  in this ticket's scope). Noted for awareness; not a regression introduced here.

### Validation run

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts"
  "packages/quereus/test/incremental/maintenance-equivalence.spec.ts"` — **33 passing**.
- sqllogic over `53-materialized-views-rowtime` — **1 passing**.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.

### Disposition

No defects found; no minor inline fixes required; no major findings to spin off into new
tickets. The implementation is correct, the new invariant is sound and precisely stated, and
the documentation reflects the new reality.
