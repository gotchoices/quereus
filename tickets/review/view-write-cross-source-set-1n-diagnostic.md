<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-06T18:21:16.697Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\view-write-cross-source-set-1n-diagnostic.review.2026-06-06T18-21-16-697Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Review the plan-time rejection of a 1:many cross-source `update v set owner.x = partner.y` — where the owning (assigned) side joins more than one partner row — with a dedicated `cross-source-ambiguous-cardinality` diagnostic naming the ambiguity, instead of the generic runtime `Scalar subquery returned more than one row`. The proof is partner-side uniqueness (PK / non-partial UNIQUE constraint / non-partial UNIQUE index ⊆ the join-pinned partner columns); the FK-child-reads-parent direction stays accepted.
files: packages/quereus/src/planner/mutation/multi-source.ts (ownerJoinsAtMostOnePartner, stripSideQualifier, decomposeUpdate gate closure), packages/quereus/src/planner/mutation/mutation-diagnostic.ts (MutationDiagnosticReason), packages/quereus/test/logic/93.4-view-mutation.sqllogic (~L630 new reject + accept), packages/quereus/test/quereus/view-mutation-substrate.spec.ts (structured-reason spec), docs/view-updateability.md (§ Inner Join cross-source `set`, § Current limitations)
----

## What changed

### 1. `MutationDiagnosticReason` — new reason (`mutation-diagnostic.ts`)
Added `cross-source-ambiguous-cardinality` with a one-line comment: the 1:many
cross-source `set` reject. Carries `column` (the assigned view column) and `table`
(the view name) on the diagnostic, like the sibling cross-source reasons.

### 2. `ownerJoinsAtMostOnePartner(ownerIdx, partnerIdx, sel, sides)` — the proof (`multi-source.ts`)
New pure helper near `resolveColumnSide`. Decides whether the **owning** side
provably joins **at most one** partner row:
- Collects the join's direct owner↔partner `column = column` equalities via the
  existing `collectCrossSideEqualities(sel.from!, sides)` (which already walks every
  nested ON predicate + USING list across the n-way tree) and gathers the
  **partner-side** columns they pin (lowercased) into `partnerEquatedCols`.
- Returns `true` iff some **unique key** of the partner table is a (non-empty) subset
  of `partnerEquatedCols`. Unique keys considered: `primaryKeyDefinition`; each
  `uniqueConstraints` entry **without** a `predicate`; each `indexes` entry with
  `unique === true` and **no** `predicate`. (`IndexColumnSchema.index` is the column
  ordinal — confirmed against `schema/table.ts`.)
- `partnerEquatedCols.size === 0` (no direct owner↔partner equality — the multi-hop
  case) ⇒ `false` (conservative reject). A partial unique key (predicate present) is
  excluded — it does not bound rows outside its scope.

This is the inverse of `edgeCorrelated`'s FK reasoning, but **FK is not required**.

### 3. The gate — threaded into `stripSideQualifier` (`multi-source.ts`)
`stripSideQualifier` gained an optional `gateCrossSourceCardinality?: (partnerCol) =>
void` parameter, called in the `otherQuals.has(t)` branch **before**
`registerCrossSource(col)` — i.e. at the **rewrite site**, so it covers a partner ref
nested in a value subquery as well as a top-level one (both lower to
`capturedValueSubquery`).

The closure is built per-assignment in `decomposeUpdate` (only on the capture-carrier
path, symmetric with `registerCrossSource`), bound to the assignment's owning side
index and memoized per partner side. It resolves the partner via
`resolveColumnSide(partnerCol, analysis.sides)` and, when the owner is not provably
at-most-one, raises `cross-source-ambiguous-cardinality` naming the assigned column,
the partner base column, and the partner table.

Ordering preserved: `gateCrossSourceReads` (the base-lineage gate) still runs first, so
a **computed** partner column rejects `no-inverse` before the cardinality check. The
legacy `propagateMultiSource` path (no carrier) still hits the `cross-source-assignment`
reject first — the cardinality gate is reached only on the build path.

### 4. Tests + docs
- `93.4-view-mutation.sqllogic` (~L630, after the existing cross-source block): a
  **reject** (parent-reads-child view, parent joins two children — asserts `-- error:
  assigned side joins more than one`, then confirms the parent base is unchanged), and
  an **accept** (partner join column is `UNIQUE` but not the PK — value applied).
- `view-mutation-substrate.spec.ts`: a new `describe` asserting
  `err.mutationDiagnostic.reason === 'cross-source-ambiguous-cardinality'` for the 1:many
  direction and a no-throw `ViewMutationNode` for the at-most-one direction (FK child
  reads parent PK).
- `docs/view-updateability.md`: § Inner Join cross-source `set` paragraph documents the
  at-most-one requirement, the partner-side-uniqueness proof, and the multi-hop
  conservative reject; § Current limitations adds the new reason to the "still rejected"
  list.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `view-mutation-substrate.spec.ts` — **6 passing** (incl. the 2 new).
- `logic.spec.ts --grep 93.4-view-mutation` — **passing** (the new reject + accept and
  every pre-existing cross-source accept: `ax_jv_x`, `ax_jv_x2`, `ax_xscpk_v`,
  `ax_xs_self`, `ax_jv_xc` reject).
- Full `yarn workspace @quereus/quereus test` (memory) — **4907 passing, 9 pending, 0
  failing**. (`property.spec.ts` Family B cross-source round-trips are all
  child-reads-parent / at-most-one → unaffected.)
- `eslint 'src/**/*.ts' 'test/**/*.ts'` — clean.

## Review focus / use cases to probe

- **Soundness of the proof direction.** The proof is about the **partner**'s unique key,
  not the owner's. Confirm `ax_xscpk_v` (composite-PK *owner*) stays accepted because the
  partner `p` is joined by its PK `pp` — the owner's composite PK only widens the
  correlation, it is never the cardinality bound. Likewise the self-join `ax_xs_self`
  (`m.id` is the partner table's PK, alias-keyed) — verify `resolveColumnSide` /
  `collectCrossSideEqualities` pin the partner side correctly despite the colliding table
  names.
- **Coverage gaps (tests are a floor):**
  - The **unique-INDEX** branch (`create unique index … `, `idx.unique === true`, no
    predicate) is implemented but **only the column-level UNIQUE *constraint* branch has a
    test**. A `create unique index` accept test would pin the index branch directly.
  - The **partial unique key** exclusion (a UNIQUE constraint/index *with* a `predicate`
    as the only candidate ⇒ reject) is implemented but **untested**. Worth a partial-index
    reject test.
  - **Nested-in-value-subquery** partner ref (`set x = (select … where … = b.y)`): the
    gate is at the rewrite site so it should fire, but there is **no dedicated test** for
    the nested-subquery cross-source path. Probe it.
  - **Multi-hop / transitive** cross-source (owner and partner not directly joined, e.g.
    `a join b … join c …`, `set a.x = c.y`): conservatively **rejected** (no direct
    equality pins a partner column). This only over-rejects; **no shipped view body
    exercises it**, so it is documented but untested. If it later proves needed, a
    follow-up for transitive value-determinacy (union-find over all cross-side equalities)
    is the noted direction — do NOT widen it here.
- **Schema-metadata assumption.** The proof reads `uniqueConstraints` / `indexes` off the
  resolved `TableReferenceNode.tableSchema`. Confirmed: column-level `UNIQUE` populates
  `uniqueConstraints` (via `SchemaManager.extractUniqueConstraints`); the memory layer's
  auto-created covering indexes for unique constraints are **not** flagged `unique`, so the
  index branch won't double-count them. Only memory-backed validation was run —
  `yarn test:store` was **not** run (the proof is plan-time schema metadata, identical
  across modules, so a store-specific failure is not expected, but it was not exercised).
- **Degenerate empty PK** (`primary key ()`, ≤1 row table) is conservatively **rejected**
  by the `cols.length > 0` guard even though it is technically at-most-one — an accepted
  residual conservatism, not a regression.
