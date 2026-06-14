description: A row-time covering MV that enforces an index-derived UNIQUE (CREATE UNIQUE INDEX … (col COLLATE x)) does not honor the index's per-column collation uniformly. The candidate generation (_lookupCoveringConflicts / MaterializedViewManager.lookupCoveringConflicts) narrows candidates under the SOURCE column's DECLARED collation, and memory's checkUniqueViaMaterializedView re-validates under the DECLARED collation — while the store's findUniqueConflictViaCoveringMv now re-validates under the INDEX collation (store-index-derived-unique-honors-index-collation). Result: a coarser-collation derived UNIQUE enforced via a covering MV can miss conflicts (subset candidate set), and a finer-collation derived UNIQUE enforced via a covering MV diverges store-vs-memory. Decide one covering-MV enforcement-collation policy (the index per-column collation) and apply it uniformly across candidate generation + both modules' MV re-validation.
files:
  - packages/quereus/src/core/database-materialized-views.ts          # lookupCoveringConflicts (candidate gen) + tryBuildCoveringPrefix — compares under sourceSchema.columns[uc.columns[k]].collation (declared)
  - packages/quereus/src/vtab/memory/layer/manager.ts                 # checkUniqueViaMaterializedView (~1133) — re-validates under schema.columns[col].collation (declared); checkUniqueViaIndex (~1068) is the index-collation reference
  - packages/quereus-store/src/common/store-table.ts                  # findUniqueConflictViaCoveringMv — now uses uniqueEnforcementCollations (index collation); the per-module reference for the target behavior
  - packages/quereus/test/covering-structure.spec.ts                  # candidate-generation + MV-enforcement collation tests
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic       # cross-module parity (currently exercises the per-scan path only for index-derived shapes)
----

# Covering-MV enforcement of an index-derived UNIQUE should honor the index collation uniformly

## Background

`store-index-derived-unique-honors-index-collation` aligned the store's **DML and
isolation-merge** UNIQUE enforcement for a `CREATE UNIQUE INDEX … (col COLLATE x)`-derived
constraint to the **index's per-column collation** (mirroring memory's `checkUniqueViaIndex`
auto-index path and the store's own `buildIndexEntries` dedup). That fix covered the
per-scan path (`findUniqueConflict`), the covering-MV re-validation
(`findUniqueConflictViaCoveringMv`), and the isolation merge path
(`findMergedUniqueConflict`).

It deliberately left **two engine-side seams unchanged**, because they form one coherent
"what collation does a covering MV enforce an index-derived UNIQUE under" policy question
that affects both modules and needs a single decision:

### 1. Candidate generation narrows under the DECLARED collation (subset for a coarser index)

`MaterializedViewManager.lookupCoveringConflicts` (the engine side of
`db._lookupCoveringConflicts`) re-compares each backing candidate under
`sourceSchema.columns[uc.columns[k]].collation` — the **declared column collation** — and its
fast-path `tryBuildCoveringPrefix` bails to a full scan on any non-BINARY collation (the full
scan then re-compares under the declared collation).

- **Finer index** (`COLLATE BINARY` over a `NOCASE` column): the declared (NOCASE) comparison
  is **coarser** than the index (BINARY), so the candidate set is a **superset** of the
  index-collation matches. The store's `findUniqueConflictViaCoveringMv` (index-collation
  re-validation) filters this superset down correctly → end-to-end correct on the store.
- **Coarser index** (`COLLATE NOCASE` over a `BINARY` column): the declared (BINARY) comparison
  is **finer** than the index (NOCASE), so the candidate set is a **subset** — a
  NOCASE-equal/BINARY-different conflict (`'Bob'` vs `'BOB'`) is **never generated**, so no
  amount of downstream re-validation can recover it. A coarser-collation derived UNIQUE
  enforced *through a covering MV* can therefore silently miss a conflict. (The per-scan path —
  no covering MV — is correct: it is fully fixed by the landed ticket.)

### 2. Memory's MV re-validation uses the DECLARED collation (finer-index store/memory divergence)

`MemoryTableManager.checkUniqueViaMaterializedView` (~manager.ts:1133) re-validates under
`schema.columns[col].collation` (declared), unlike its sibling `checkUniqueViaIndex` (~1068)
which uses `index.specColumns[i]?.collation ?? schema.columns[col].collation` (index collation).
The store's `findUniqueConflictViaCoveringMv` now uses the index collation. So for a **finer**
index-derived UNIQUE enforced through a covering MV:

- memory's MV path over-rejects a case-variant the BINARY index should admit, while
- the store's MV path admits it (correct).

This is a cross-module divergence — and an *intra-memory* inconsistency (memory's own
auto-index path admits the same case-variant its MV path rejects).

## Why this is backlog, not an immediate fix

This requires a **policy decision** (the covering-MV enforcement collation for an index-derived
UNIQUE should be the index's per-column collation) applied across three sites at once —
candidate generation, memory MV re-validation, store MV re-validation — and the candidate
generation change is a non-trivial widening (today the prover's collation gate keys the backing
under the *output*/declared collation; threading the index collation through the
prefix-scan/full-scan candidate generation is the real work). It is an exotic construction (an
*explicit covering MV* over an *explicit-COLLATE* `CREATE UNIQUE INDEX` whose collation differs
from the column's), with no current test exercising it, so it is a future correctness/consistency
concern rather than active work.

## Desired end state

- `lookupCoveringConflicts` generates a candidate set that is a **superset of index-collation
  matches** for both finer and coarser index-derived UNIQUEs (widen the comparison to the index
  collation, or fall back to a full scan that compares under the index collation).
- Both modules' covering-MV re-validation uses the **index per-column collation** (the store
  already does; align memory's `checkUniqueViaMaterializedView`).
- A cross-module parity case for an index-derived UNIQUE enforced **through a covering MV**
  (finer + coarser) added to a logic file that runs under both `yarn test` and `yarn test:store`
  (the landed ticket's `102.2-unique-collation.sqllogic` §9 covers only the per-scan path for
  index-derived shapes; its covering-MV §4 uses a *non-derived* NOCASE column).

## Out of scope

- Non-derived (table-level / column) UNIQUE — enforcement collation == declared == output;
  already sound and consistent on both modules.
- The relation-key promotion gate (`enforcementCollationCoversDeclared`) — audited sound and
  unchanged by the landed ticket; it under-promotes (never over-claims) regardless of the
  covering-MV enforcement collation.

---

## Triage decision (2026-06-13, human sign-off): gate covering-MV eligibility on collation — don't widen candidate generation

The dev's reframe: *"Shouldn't we just not consider it covered if it doesn't have
the same collation?"* — adopted. This **supersedes the "Desired end state" above**
and collapses the hard three-site candidate-generation widening into a simple
eligibility gate, aligned with the engine's covering-structure-is-optional
philosophy (correctness comes from the per-scan fallback, which the landed
`store-index-derived-unique-honors-index-collation` ticket already made correct).

**The rule:** at the point a covering MV is classified as answering an
index-derived UNIQUE (the row-time covering-structure selection), compare the
MV backing key's enforcement collation against the **index's per-column
collation**. If the MV key collation is **finer** than the index collation
(BINARY MV key under a NOCASE index → its candidate set is an unsound *subset*,
the silent-miss case), the MV does **not** cover that UNIQUE — decline it and let
the constraint enforce via the per-scan path (already correct). The minimal sound
gate is "decline when MV key is finer than index enforcement"; the simplest is
"decline on any non-equal collation."

- **Coarser-or-equal MV key** (NOCASE MV under a BINARY index → superset) is
  sound *iff* re-validation runs under the index collation. Two choices for the
  plan pass: (a) keep it eligible and align **memory's**
  `checkUniqueViaMaterializedView` to the index collation (the store's
  `findUniqueConflictViaCoveringMv` already does this — closes the finer-index
  store/memory divergence in §2), or (b) for maximum simplicity, decline it too
  (exact-collation-match-or-per-scan) and accept the minor perf loss in this
  exotic case. Recommend (a): it's a one-line alignment that also fixes the
  existing intra-memory inconsistency, and it keeps the optimization where it's
  sound.
- **No candidate-generation widening.** `lookupCoveringConflicts` /
  `tryBuildCoveringPrefix` stay as-is; the subset-candidate problem disappears
  because a finer MV key is never *selected* as covering in the first place.
- **Eligibility locus** (the new gate) is wherever the row-time covering-MV is
  matched to the UC — find it via the prover's row-time classification
  (docs/lens.md § "enforced-set-level row-time"; `database-materialized-views.ts`
  covering-conflict entry). The plan pass pins the exact site.

**Acceptance:** a finer-collation MV is declined as covering and the UNIQUE
enforces correctly via per-scan (no silent miss), cross-module; a coarser/equal
MV stays eligible and memory + store agree (per choice (a)). The exotic shape
gets a cross-module parity case under both `yarn test` and `yarn test:store`.
