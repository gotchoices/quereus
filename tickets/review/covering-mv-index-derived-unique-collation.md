description: Review the collation eligibility gate that declines a row-time covering MV for a finer/incomparable index-derived UNIQUE, plus the memory covering-MV re-validation alignment to the index per-column collation. Verify the gate is sound (no false-decline that loses correctness, no false-accept that re-opens the subset-miss), the three callers (store/memory/lens) decline in lockstep, and the cross-module behavior agrees.
prereq:
files:
  - packages/quereus/src/schema/unique-enforcement.ts                  # NEW shared helper: uniqueEnforcementCollations + coveringMvHonorsIndexCollation (the predicate)
  - packages/quereus/src/core/database-materialized-views.ts           # findRowTimeCoveringStructure (gate added ~L2885); lookupCoveringConflicts/tryBuildCoveringPrefix UNCHANGED
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # checkUniqueViaMaterializedView (~L1133, now re-validates under index collation via the helper)
  - packages/quereus-store/src/common/store-table.ts                   # findUniqueConflictViaCoveringMv (behavior unchanged; stale "coarser out of scope" comment rewritten)
  - packages/quereus/test/covering-structure.spec.ts                   # NEW describe "index-derived collation gate" (9 tests incl. premise check + e2e memory)
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # NEW §10 (runs under yarn test AND yarn test:store)
  - packages/quereus-store/test/unique-constraints.spec.ts             # FINER-MV comment de-caveated; NEW coarser-index covering-MV store test
  - docs/materialized-views.md                                         # § Enforcement through a covering MV — new collation-gate paragraph
  - docs/lens.md                                                       # § Constraint Attachment row-time bullet — inherits-the-gate note
difficulty: medium
----

# Review: gate covering-MV eligibility for an index-derived UNIQUE on collation

## What landed

A row-time covering MV answers a UNIQUE constraint by generating conflict
**candidates** under the **declared** source-column collation `D`
(`lookupCoveringConflicts` / `tryBuildCoveringPrefix`, both UNCHANGED), while the
**re-validators** filter under the **index per-column** collation `I`. The candidate
set is a sound *superset* of the `I`-matches — safe to filter down — only when `D ⊒ I`
per constrained column. Previously a finer/incomparable index-derived UNIQUE (a
**coarser** NOCASE index over a BINARY column, RTRIM-over-BINARY, unrelated customs)
could make the candidate set a *subset* that silently misses conflicts.

**The fix (triage choice (a) — no candidate-generation widening):**

1. **New helper** `packages/quereus/src/schema/unique-enforcement.ts`:
   - `uniqueEnforcementCollations(schema, uc)` — index-COLLATE-else-declared per column
     (the resolution already duplicated in store-table.ts / isolated-table.ts; kept
     **within the quereus package only** — cross-package unification is out of scope).
   - `coveringMvHonorsIndexCollation(schema, uc)` — the per-column predicate
     `normalizeCollationName(I) === 'BINARY' || normalizeCollationName(I) === normalizeCollationName(D)`,
     AND over all columns. Proves `D ⊒ I` **without a collation lattice** (collations
     are opaque comparators) via the BINARY-floor (reflexivity) or name-equality tests.
2. **The gate** in `findRowTimeCoveringStructure` (database-materialized-views.ts):
   after the matched MV passes the full-rebuild + stale checks, resolve the source
   schema (`ctx._findTable`) and `return undefined` when
   `!coveringMvHonorsIndexCollation(sourceSchema, uc)`. Defensive: an unresolved source
   schema falls through to the prior behavior (no throw).
3. **Memory alignment** in `checkUniqueViaMaterializedView` (manager.ts): re-validate
   under `uniqueEnforcementCollations(schema, uc)` instead of the declared
   `schema.columns[col].collation` — matching `checkUniqueViaIndex`, the store, and the
   isolation overlay. (`checkUniqueByScanning` left as-is — a derived UNIQUE always has a
   matching auto-index, so a declined-MV derived UNIQUE routes to `checkUniqueViaIndex`,
   never the cold scan.)

Gating at the single resolver is sound for **all three** callers (store
`findUniqueConflictViaCoveringMv`, memory `findIndexForConstraint`, lens-prover
`findBasisCovering`): declining only removes an unsound *optimization*; every fallback
already honors `I`. Candidate generation never runs for a declined MV.

## Premise — SETTLED during implement (the gate is load-bearing, not defense-in-depth)

The ticket flagged it as unsettled. **Confirmed via test:** the coverage prover's own
collation gate (`proveCoverage`, coverage-prover.ts ~L329) compares the **output**
column collation against the **declared** base-column collation — NOT the index
collation — so it **DOES** link a coarser-index covering MV (output=declared=BINARY ==
base BINARY ⇒ covers ⇒ `coveringStructureName` stamped). Without the new gate that link
would resolve and the declared-collation candidate set would silently miss the conflict.
The premise-check test asserts `coveringStructureName` is set for the coarser shape, then
that the gate declines it. The gate comment and the materialized-views.md paragraph were
updated to state this is load-bearing.

## The two surviving live cases (both now agree cross-module)

| index `I` | declared `D` | eligible? | path | agree? |
|-----------|--------------|-----------|------|--------|
| BINARY (finer) | NOCASE | **yes** | MV; re-validate under BINARY | yes — memory alignment was the fix |
| NOCASE (coarser) | BINARY | **no** | declined ⇒ per-scan / auto-index | yes — both via `checkUniqueViaIndex`/`findUniqueConflict` |
| NOCASE | NOCASE (equal/non-derived) | **yes** | MV; re-validate under NOCASE | yes — unchanged |

The finer row (I=BINARY/D=NOCASE) is the memory-alignment assertion: pre-fix memory
re-validated under D (NOCASE) and over-rejected `'bob'` after `'Bob'`; post-fix it
re-validates under I (BINARY) and admits both — matching the store.

## Use cases to test / validate (reviewer)

These are the floor, not the ceiling — scrutinize for gaps below.

- **Gate unit (memory, `covering-structure.spec.ts`):** finer/equal/non-derived → MV
  returned; coarser/RTRIM-over-BINARY/composite-with-one-coarser-member → `undefined`.
- **E2E memory enforcement:** finer-index covering MV admits `'Bob'` + `'bob'` (genuine
  BINARY dup still rejected); coarser-index rejects `'Bob'`→`'BOB'` via declined-MV
  per-scan.
- **E2E both modules (`102.2-unique-collation.sqllogic` §10, runs under `yarn test` AND
  `yarn test:store`):** 10a finer + MV (count=2, BINARY dup rejected); 10b coarser + MV
  (`'BOB'` rejected, distinct value inserts); 10c plain-index + MV (NOCASE folding,
  mirrors §4).
- **Store (`quereus-store/test/unique-constraints.spec.ts`):** finer-MV de-caveated
  (store + memory now agree); new coarser-index covering-MV store test (`'BOB'` rejected
  via declined-MV per-scan).

## Honest gaps / things to scrutinize

- **ALTER COLUMN SET COLLATE re-evaluation is reasoned, NOT directly tested.** The gate
  re-reads `schema.columns[].collation` + `schema.indexes` fresh each call (no caching),
  so eligibility *structurally* tracks a post-ALTER collation flip. I did **not** add an
  ALTER-then-gate test (existing ALTER-collation coverage lives in the 10.4 suite). If you
  want belt-and-suspenders, add a memory test: flip a column BINARY→NOCASE under a BINARY
  index (stays eligible: I=BINARY floor) and confirm the gate verdict tracks. Low risk
  (stateless gate), but untested here.
- **Lens classification inherits the gate but is not separately exercised by a new test.**
  `findBasisCovering` consults the same resolver, so a finer/incomparable index-derived
  *basis* UC now classifies commit-time (not row-time). Existing lens row-time tests use a
  **non-derived** `unique(email)` (always eligible) and stay green (lens-foundation +
  full memory suite pass). No new lens test asserts the *index-derived basis declines to
  commit-time* path — consider whether that warrants a lens-prover.spec.ts case.
- **Four copies of the enforcement-collation resolution** (store-table.ts,
  isolated-table.ts, memory via the new helper, and the new helper itself) remain
  un-unified across packages — explicitly out of scope (spans 3 packages, import-cycle
  risk). File a backlog ticket if the duplication bothers the reviewer.
- **Pre-existing LSP type diagnostic (NOT mine):**
  `quereus-store/test/unique-constraints.spec.ts:~296` `db.watch(scope, e => watchEvents.push(e))`
  surfaces a `number`-not-assignable-to-`void` LSP warning. It is in the existing
  eviction-reporting test (outside my diff), the store package does not type-check its
  test files in CI (transpile-only at runtime), and the full store suite passes. Left
  untouched — flagging for transparency, not a regression.
- **`coveringMvHonorsIndexCollation` under-claims** for an exotic custom-collation pair
  where `D ⊒ I` holds semantically but neither the BINARY-floor nor name-equality test
  fires — declined (per-scan), a **perf-only** loss in an already-exotic shape, never a
  correctness loss. By design (the triage avoids a collation lattice). Confirm you agree
  this is the right tradeoff.

## Validation run (all green)

- `yarn build` (quereus) ✓
- `yarn lint` (quereus: eslint + `tsc -p tsconfig.test.json --noEmit`) ✓
- `yarn test` (quereus memory): **6259 passing, 9 pending, 0 failing** ✓
- quereus-store full suite: **573 passing** ✓ ; `typecheck` ✓
- quereus-isolation full suite: **126 passing** ✓
- `102.2-unique-collation.sqllogic` under store mode (`QUEREUS_TEST_STORE=true`): ✓
- New `covering-structure.spec.ts` gate suite: **9 passing** ✓

Not run (out-of-band, slow): full `yarn test:store` across every logic file — only the
102.2 file was run under store mode here. The store unique-constraints spec + isolation
suite cover the store/isolation enforcement paths directly.

## Out of scope (unchanged, audited)

- Candidate-generation widening (`lookupCoveringConflicts` / `tryBuildCoveringPrefix`).
- Cross-package unification of the enforcement-collation resolver.
- The relation-key promotion gate (`enforcementCollationCoversDeclared`).
- Non-derived UNIQUE enforcement (declared == enforcement == output — already sound).
