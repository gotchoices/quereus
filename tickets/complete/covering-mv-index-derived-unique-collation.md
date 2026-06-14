description: Collation eligibility gate declining a row-time covering MV for a finer/incomparable index-derived UNIQUE, plus the memory covering-MV re-validation alignment to the index per-column collation. Reviewed and completed.
files:
  - packages/quereus/src/schema/unique-enforcement.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus/test/covering-structure.spec.ts
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic
  - packages/quereus-store/test/unique-constraints.spec.ts
  - docs/materialized-views.md
  - docs/lens.md
  - docs/schema.md   # review pass: added covering-MV gate cross-reference to the index-derived enforcement paragraph
----

# Complete: gate covering-MV eligibility for an index-derived UNIQUE on collation

## What shipped

A row-time covering MV generates UNIQUE conflict candidates under the **declared**
source-column collation `D` (`lookupCoveringConflicts` / `tryBuildCoveringPrefix`,
confirmed at `database-materialized-views.ts:3034` — `sourceSchema.columns[uc.columns[k]].collation`),
while the re-validators (memory `checkUniqueViaMaterializedView`, store
`findUniqueConflictViaCoveringMv`) filter under the **index per-column** collation `I`.
The candidate set is a sound *superset* of the `I`-matches — safe to filter down — only
when `D ⊒ I` per constrained column. A finer/incomparable index-derived UNIQUE (coarser
NOCASE index over a BINARY column, RTRIM-over-BINARY, unrelated customs) could otherwise
make the candidate set a *subset* that silently misses conflicts.

The fix:
- **New helper** `schema/unique-enforcement.ts`: `uniqueEnforcementCollations` (index-
  COLLATE-else-declared per column) and `coveringMvHonorsIndexCollation` (the per-column
  predicate `normalize(I) === 'BINARY' || normalize(I) === normalize(D)`, AND over all
  columns — proves `D ⊒ I` without a collation lattice via the BINARY-floor or
  name-equality test).
- **The gate** in `findRowTimeCoveringStructure`: after the matched MV passes
  full-rebuild + stale checks, `return undefined` when `!coveringMvHonorsIndexCollation`.
  Unresolved source schema falls through (no throw).
- **Memory alignment** in `checkUniqueViaMaterializedView`: re-validate under
  `uniqueEnforcementCollations` instead of the declared column collation — matching
  `checkUniqueViaIndex`, the store, and the isolation overlay.

All three covering-structure callers (store, memory, lens-prover `findBasisCovering`)
funnel through the single resolver `_findRowTimeCoveringStructure`, so they decline the
same MV in lockstep; candidate generation never runs for a declined MV.

## Review findings

### Correctness / soundness — checked, no defects

- **Candidate-generation collation premise verified.** `lookupCoveringConflicts` compares
  candidates under the **declared** collation `D` (`database-materialized-views.ts:3034`),
  not the index collation. This is the load-bearing premise of the whole superset-filter
  argument and it holds.
- **Predicate is a correct sufficient condition for `D ⊒ I`.** Final conflict set =
  `{≡_D} ∩ {≡_I}`; correct enforcement set = `{≡_I}`; equality requires `≡_I ⊆ ≡_D`, i.e.
  `D ⊒ I`. The two name-only tests are each sufficient: BINARY-floor (`I=BINARY` ⇒
  byte-identity ⊆ any `D`-equal, by comparator reflexivity) and `I==D`. Under-claims
  safely for exotic custom pairs (perf-only loss, never a correctness loss). Confirmed
  agreement with the triage's "option (a) — no candidate widening" intent.
- **Positional alignment `uc.columns[i]` ↔ `index.columns[i]` is real**, guaranteed by
  `appendIndexToTableSchema` (`schema/table.ts:409` — `columns: indexSchema.columns.map(c => c.index)`).
  Both the gate and every re-validator index `index.columns[i].collation` by `i` over
  `uc.columns`; the alignment makes that sound.
- **No false-decline correctness loss.** Declining only removes an optimization; the
  fallback (auto-index / per-scan) always enforces under `I`. A `derivedFromIndex` UNIQUE
  always has its enforcing index (the index and its derived UC are added/dropped together,
  `schema/table.ts`), so a declined-MV derived UNIQUE always routes to a live
  `checkUniqueViaIndex` / `findUniqueConflict` — never an orphan.
- **Non-derived UNIQUE is never declined** (`index` undefined ⇒ `I=D` per column ⇒
  eligible), so the lens "sole structure" world is not at risk of routing a non-derived
  UNIQUE to a retired auto-index.
- **Module-agnostic gate.** The gate resolves the *authoritative* schema-manager schema
  (`ctx._findTable`) for its verdict regardless of which module (store copy / memory)
  passed `uc`, while each re-validator uses its own copy of the same `index.columns[i].collation`
  field — so the gate and the enforcement collation cannot desync.
- **`normalizeCollationName` (trim+uppercase) applied to both sides** before comparison,
  so `'nocase'`/`'NOCASE'`/`'BINARY'` spellings all reconcile. Integer/no-collation columns
  normalize to `'BINARY'` on both sides ⇒ eligible (no regression for the common
  integer-key covering MV that dominates the existing suite).

### Tests — ran all, green; coverage assessed

- `yarn lint` (quereus: eslint + `tsc -p tsconfig.test.json --noEmit`) ✓
- Full quereus **memory** suite: **6259 passing, 9 pending** ✓ (the gate sits on the hot
  per-UNIQUE-check path; full run confirms no regression).
- `covering-structure.spec.ts` whole file: **92 passing** ✓ (incl. the 9 new gate tests:
  premise/load-bearing, finer/equal/non-derived eligible, coarser/RTRIM/composite
  declined, two e2e memory).
- `102.2-unique-collation.sqllogic` §10 under **memory** ✓ and under **store**
  (`QUEREUS_TEST_STORE=true`) ✓.
- quereus-store full suite: **573 passing** ✓ (incl. the new coarser-index covering-MV
  store test).
- quereus-isolation full suite: **126 passing** ✓.
- Coverage is genuinely broad: happy path, edge cases (composite-one-member-coarser,
  RTRIM, plain index falling back to D), error/rejection paths, both modules, and the
  premise check that proves the gate is load-bearing rather than defense-in-depth.

### Docs — read every touched file; one gap fixed inline

- `docs/materialized-views.md` § Enforcement through a covering MV — new gate paragraph is
  accurate against the implementation (candidate gen under `D`, re-validate under `I`,
  BINARY-floor ∨ `I==D`, AND semantics, load-bearing, under-claim-safe, all-three-callers).
- `docs/lens.md` § Constraint Attachment — inherited-gate note accurate; `findBasisCovering`
  verified to consult `_findRowTimeCoveringStructure` (`lens-prover.ts:1824`).
- `docs/schema.md` "Index-derived UNIQUE enforcement collation" paragraph was accurate but
  **silent on the covering-MV interaction** — **fixed inline** with a one-line
  cross-reference to the gate, noting the gate reads the same `index.columns[i].collation`
  this resolver does (which is *why* it stays consistent across `ALTER COLUMN … SET
  COLLATE`, per that same paragraph's documented propagation behavior). Anchor
  `#enforcement-through-a-covering-mv` verified.

### Residual gaps (assessed, accepted — not defects)

- **ALTER COLUMN SET COLLATE re-evaluation: reasoned-and-now-documented, not unit-tested.**
  The gate re-reads `schema.columns[].collation` + `schema.indexes` fresh each call, and
  `docs/schema.md` already documents that `ALTER COLUMN … SET COLLATE` propagates into the
  index column. Because the gate's eligibility test and the re-validator's comparison both
  derive `I` from the *same* `index.columns[i].collation` field, they cannot disagree
  post-ALTER — the case is safe by construction. A dedicated ALTER-then-gate test was
  judged unnecessary (and risk-prone to author correctly given the ALTER/MV/index
  interaction); the inline schema.md note records the invariant instead.
- **Lens index-derived basis decline not separately exercised.** `findBasisCovering`
  consults the same resolver, so the gate applies identically; existing lens row-time
  tests use a non-derived `unique(email)` (always eligible) and stay green. The path is
  structurally covered by the single-chokepoint design; a dedicated lens-prover case is a
  coverage nicety, not a correctness gap.

### Major finding → new ticket

- **Cross-package duplication of the enforcement-collation resolver** (three copies:
  `schema/unique-enforcement.ts`, `quereus-store/store-table.ts`,
  `quereus-isolation/isolated-table.ts`, plus a fourth inline spelling in memory's
  `checkUniqueViaIndex`). They MUST stay in lockstep — a drift could re-open the
  subset-miss the gate closes — yet are hand-maintained. Explicitly scoped out of the
  implement ticket (spans 3 packages, import-cycle risk). Filed
  `tickets/backlog/unify-unique-enforcement-collation-resolver.md` to unify behind one
  helper or lock the agreement with a cross-module conformance test.

### Pre-existing, not this ticket

- An LSP-only `number`-not-assignable-to-`void` diagnostic at
  `quereus-store/test/unique-constraints.spec.ts` `db.watch(scope, e => watchEvents.push(e))`
  (the existing eviction-reporting test, outside this diff). The store package does not
  type-check its test files in CI (transpile-only) and `yarn workspace @quereus/store test`
  passes (573), so no test/build actually fails — no `.pre-existing-error.md` warranted.
  Flagged for transparency only.

## Out of scope (unchanged, audited)

- Candidate-generation widening (`lookupCoveringConflicts` / `tryBuildCoveringPrefix`).
- Cross-package unification of the enforcement-collation resolver (now backlogged).
- The relation-key promotion gate (`enforcementCollationCoversDeclared`).
- Non-derived UNIQUE enforcement (declared == enforcement == output — already sound).
