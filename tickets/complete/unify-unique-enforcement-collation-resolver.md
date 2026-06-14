description: Unified the per-column UNIQUE-enforcement collation resolver. Canonical `uniqueEnforcementCollations` is exported from `@quereus/quereus` and imported by `quereus-store` + `quereus-isolation` (their byte-identical private copies deleted); memory's `checkUniqueViaIndex` (live-`MemoryIndex` source) is pinned to the helper by a conformance test. Reviewed, validated, and accepted; one pre-existing memory-enforcement bug surfaced and filed.
prereq:
files:
  - packages/quereus/src/schema/unique-enforcement.ts          # canonical helper + module/JSDoc (claim scoped during review)
  - packages/quereus/src/index.ts                              # public export of uniqueEnforcementCollations
  - packages/quereus-store/src/common/store-table.ts           # private copy deleted; 2 call sites use the import
  - packages/quereus-isolation/src/isolated-table.ts           # private copy deleted; 1 call site uses the import
  - packages/quereus/src/vtab/memory/layer/manager.ts          # checkUniqueViaIndex comment + KNOWN-gap note (review)
  - packages/quereus/test/unique-enforcement-collation.spec.ts # conformance lock (7 cases) + scoped docstring (review)
  - tickets/fix/memory-multi-index-unique-collation-resolution.md  # NEW fix ticket filed during review
difficulty: medium
----

# Unify the UNIQUE-enforcement collation resolver across packages (completed)

Three packages hand-maintained a byte-identical per-column UNIQUE-enforcement
collation resolver; a fourth (memory `checkUniqueViaIndex`) computes the same
logical value from a live `MemoryIndex` handle. The drift risk was real: the
row-time covering-MV eligibility gate and the store/isolation/memory re-validators
must agree on the per-column enforcement collation or a covering-MV subset-miss
re-opens.

**Resolution:** `uniqueEnforcementCollations(schema, uc)` is exported from
`@quereus/quereus` and imported directly by `quereus-store/store-table.ts` (2 call
sites) and `quereus-isolation/isolated-table.ts` (1 call site); their private
copies were deleted. Memory's `checkUniqueViaIndex` cannot share the import (it
reads collations from a live `MemoryIndex` resolved by column-set, not by name),
so it is pinned by `test/unique-enforcement-collation.spec.ts`. Net: 3 copies → 1
shared function; the 4th conformance-locked.

## Review findings

### What was checked
- **Implement diff read first, fresh eyes** (`git show bcd7c1b5`), before the
  handoff summary.
- **DRY / unification correctness** — confirmed the canonical helper is byte-for-
  byte equivalent to the three deleted copies; `this.tableSchema!` non-null
  assertions and the read-the-passed-schema freshness guarantee (post-`ALTER
  COLUMN SET COLLATE`) preserved at all call sites.
- **Dead-import check** — `UniqueConstraintSchema` is still referenced in both
  `store-table.ts` and `isolated-table.ts` (predicate caches, method signatures);
  no orphaned imports after the private methods were deleted. `git`/lint clean.
- **Conformance-test faithfulness** — verified the test's `viaLiveIndexCollations`
  replicates `checkUniqueViaIndex`'s exact expression
  (`index.specColumns[i]?.collation ?? schema.columns[col].collation`) against the
  REAL live `MemoryIndex`, and `resolveLiveIndex` replicates
  `findIndexForConstraint`'s by-column-set match. It genuinely tests by-name vs
  by-column-set agreement, not a tautology.
- **memory `checkUniqueViaMaterializedView`** — confirmed it already uses the
  shared helper (by-name), consistent with store/isolation.
- **Docs** — read every touched file; confirmed the module JSDoc, `index.ts`
  export comment, and `manager.ts` comment reflect the new shared-import reality.
- **Build / lint / tests** — all green (see below).
- **Edge probing** — exercised the by-name vs by-column-set distinction with a
  multi-index-same-column-set schema (NOT covered by the lock's shapes).

### What was found
- **MAJOR (pre-existing, filed):** Memory under-enforces a UNIQUE constraint when
  **two UNIQUE indexes cover the same column-set with different collations** and
  the finer index is created first. `findIndexForConstraint` resolves by
  column-set and returns the FIRST matching index, so both column-set-equal UCs
  enforce under that index's collation — a coarser-declared UNIQUE is silently
  under-enforced (a NOCASE duplicate is admitted). Reproduced directly:
  memory ADMITS, store/isolation (by-name helper) and SQLite REJECT; the defect is
  creation-order-sensitive. The unify refactor did **not** touch
  `findIndexForConstraint`/`checkUniqueViaIndex` resolution — it surfaced, not
  introduced, the bug, and the by-name helper store/isolation now share is the
  *correct* side. **Disposition:** out of scope for a pure-refactor ticket →
  filed `tickets/fix/memory-multi-index-unique-collation-resolution.md` with a
  concrete repro, root cause, and likely direction.
- **MINOR (fixed inline):** The conformance test docstring and the
  `unique-enforcement.ts` module JSDoc both claimed the two index-resolution paths
  "agree for every constraint shape that arises" — an overstatement, false for the
  multi-index-same-column-set shape above. **Scoped the claims** to the normal
  single-index-per-column-set regime and cross-referenced the new fix ticket. Also
  added a KNOWN-gap note at the `checkUniqueViaIndex` live-handle read in
  `manager.ts`. Comment-only; lint re-run clean.

### What was NOT found (explicitly)
- **No regression in the unification itself.** The helper is identical to the
  deleted copies; every store/isolation/memory UNIQUE-collation test passes. The
  refactor is sound and accepted.
- **No type-safety / resource-cleanup / error-handling regressions.** No new
  `any`, no swallowed exceptions, no new allocations in the hot path (the helper is
  the same per-call computation as before, now shared). The conformance test
  closes its `Database` in a `finally`.
- **Missing-index-metadata tolerance** (`derivedFromIndex` set but record gone →
  fall back to declared, must not throw) — both paths guard with `?.`; not
  reachable via normal DDL, verified by inspection.
- **Partial UNIQUE** (`CREATE UNIQUE INDEX … WHERE …`) — the predicate does not
  affect collation resolution; logically covered, no dedicated case needed.

### Validation performed
- `yarn build` — exit 0 (sequential through all packages; proves store + isolation
  type-check against the new cross-package export).
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsconfig.test.json`
  type-check); re-run after the review comment edits — still exit 0.
- `packages/quereus/test/unique-enforcement-collation.spec.ts` — 7 passing.
- `packages/quereus-store/test/unique-constraints.spec.ts` — 31 passing (incl. the
  index-derived-collation and covering-MV suites, now routed through the shared
  import).
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — 85 passing.
- **Deferred (documented):** `yarn test:store` (full LevelDB sqllogic re-run) — a
  release / store-issue check per AGENTS.md; this is a pure refactor and the
  targeted store collation suite passed directly. Re-run out-of-band before a
  release.
