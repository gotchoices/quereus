description: Review the unification of the per-column UNIQUE-enforcement collation resolver. The canonical `uniqueEnforcementCollations` is now exported from `@quereus/quereus` and imported by `quereus-store` + `quereus-isolation` (their private copies deleted); memory's `checkUniqueViaIndex` (live-`MemoryIndex` source, cannot share the import) is pinned to the helper by a new conformance test.
prereq:
files:
  - packages/quereus/src/schema/unique-enforcement.ts          # canonical helper + updated module/JSDoc
  - packages/quereus/src/index.ts                              # new public export (after L143)
  - packages/quereus-store/src/common/store-table.ts           # private copy deleted; 2 call sites now use the import
  - packages/quereus-isolation/src/isolated-table.ts           # private copy deleted; 1 call site now uses the import
  - packages/quereus/src/vtab/memory/layer/manager.ts          # checkUniqueViaIndex comment tightened (live handle retained)
  - packages/quereus/test/unique-enforcement-collation.spec.ts # NEW #4 conformance lock (7 cases)
difficulty: medium
----

# Review: unify the UNIQUE-enforcement collation resolver across packages

## What changed (and why it is safe)

Three packages hand-maintained a byte-identical per-column UNIQUE-enforcement
collation resolver; a fourth (memory `checkUniqueViaIndex`) computes the same
logical value from a different source (a live `MemoryIndex` handle). The drift
risk is real: the row-time covering-MV eligibility gate
(`coveringMvHonorsIndexCollation`) decides MV eligibility using the quereus copy,
while the store/isolation/memory-MV re-validators filter conflicts under their
copy — a divergence re-opens a covering-MV subset-miss (a coarser-index covering
MV silently missing a conflict) or over-rejects.

Adopted **Option 1** for the three textually-identical copies and an **Option-2
conformance lock** for the one that cannot share the import:

- **Exported** `uniqueEnforcementCollations` from `@quereus/quereus`
  (`index.ts`, after the schema re-exports at L143). `coveringMvHonorsIndexCollation`
  stays internal (only the MV gate uses it).
- **`quereus-store/store-table.ts`** — private method deleted; both call sites
  (`findUniqueConflict`, `findUniqueConflictViaCoveringMv`) now call
  `uniqueEnforcementCollations(this.tableSchema!, uc)`. The `this.tableSchema!`
  non-null assertion and the freshness guarantee (helper reads the *passed*
  schema each call, so an `ALTER COLUMN SET COLLATE` propagating a new per-column
  collation is still picked up) are preserved.
- **`quereus-isolation/isolated-table.ts`** — private method deleted; the
  `findMergedUniqueConflict` call site now uses the import.
- **memory `checkUniqueViaMaterializedView`** already imported the helper — no
  change.
- **memory `checkUniqueViaIndex`** is the "fourth copy": it reads
  `index.specColumns[i]?.collation ?? schema.columns[col].collation` from the
  *live* `MemoryIndex` that `findIndexForConstraint` resolves **by column-set**,
  whereas the shared helper resolves the index **by name** (`uc.derivedFromIndex`).
  These land on the same index/collations for every shape that arises, but a
  true import-time share would require widening the helper's `(schema, uc)`
  signature with a `MemoryIndex` handle (muddying the clean contract). Left the
  live-handle read in place, **tightened its comment**, and **locked the agreement
  with a conformance test** instead.

Net: 3 copies → 1 shared function; the 4th pinned by a test that fails loudly if
the two index-resolution paths ever disagree.

## Validation performed (the floor — extend it)

- `yarn build` — exit 0. The root build is `… && build:isolation && build:store && …`
  (each `tsc`); a chained `&&` exit 0 proves store + isolation type-check against
  the new cross-package export.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsconfig.test.json`
  type-check, so the new spec and call-site signatures are covered).
- `yarn test` — **Done in 3m 33s, no failures** (6281 + 126 + 62 + … passing
  across workspaces). Covers `covering-structure.spec.ts`, the new conformance
  spec, the isolation suite, and the quereus-store package's own specs (run via
  `workspaces foreach -A run test`).
- `packages/quereus/test/unique-enforcement-collation.spec.ts` — **7 passing**.
- `packages/quereus-store/test/unique-constraints.spec.ts` (run directly) —
  **31 passing**, incl. the `index-derived UNIQUE honors the index per-column
  collation` suite (finer/coarser/composite/plain) and the covering-MV
  enforcement paths — all now routing through the shared import.

### The new conformance lock — what it asserts

For each shape it builds the table+constraint via SQL, then asserts, **per
column**, that `uniqueEnforcementCollations(schema, uc)` (by-name) equals the
`checkUniqueViaIndex` expression evaluated against the **live `MemoryIndex`**
resolved by-column-set (`index.specColumns[i]?.collation ?? schema.columns[col].collation`).
It reaches the live index the same way `findIndexForConstraint` does (committed
layer → `getSecondaryIndex(name)`, via the module's manager map — the
`getBackingManager` pattern from `maintenance-replace-all.spec.ts`). Comparison is
**normalized-name** (an absent collation behaves as BINARY; SQLite collation
names are case-insensitive). Shapes: finer (BINARY index / NOCASE col), coarser
(NOCASE index / BINARY col), equal, plain (no index COLLATE), composite (finer +
plain — exercises index 1), non-derived single, non-derived composite. Each also
asserts an expected normalized result so the shapes provably exercise the
distinction they claim.

## Reviewer focus / known gaps (treat tests as a floor, not a finish line)

- **Faithfulness of the lock.** The test *replicates* `findIndexForConstraint`'s
  column-set match rather than calling the (private) method, but it reads the
  **actual** live `MemoryIndex.specColumns` — so it genuinely tests by-name vs
  by-column-set agreement, which is the equivalence the ticket cares about. If
  `findIndexForConstraint`'s own matching logic changed, the test would need to
  track it. Consider whether exposing a thin test seam would be worth more than
  the replication (the ticket judged not — widening the surface defeats the
  unification).
- **Not exercised by the lock:**
  - The **missing-index-metadata tolerance** (`derivedFromIndex` set but the
    index record gone → both paths fall back to declared, must not throw). Not
    reachable via normal DDL without corrupting the schema; both sides guard it
    with `?.`. Verify by inspection.
  - **Partial UNIQUE** (`CREATE UNIQUE INDEX … WHERE …`) index-derived collation —
    the predicate does not affect collation resolution, so it is logically
    covered, but there is no dedicated case.
- **`yarn test:store` (full LevelDB sqllogic re-run) deferred** — it re-runs the
  entire quereus logic corpus against the store backend (slow; per AGENTS.md a
  release / store-issue check). This change is a pure refactor (identical function
  body, now shared) and the **targeted** store collation suite
  (`unique-constraints.spec.ts`) passed directly, so the broader corpus is
  unlikely to surface anything new. Re-run out-of-band if preparing a release.
- **Doc drift addressed:** `unique-enforcement.ts`'s module comment no longer says
  the copies are "deliberately NOT yet unified" — it now states store/isolation
  import the helper and memory's `checkUniqueViaIndex` is conformance-locked (and
  why). Confirm the prose still reads true.

## Use cases worth a manual sanity check

- An index-derived UNIQUE with an explicit per-column COLLATE that is **coarser**
  than the column (NOCASE index over a BINARY column) must still reject a
  NOCASE-equal duplicate through **both** the plain-scan and covering-MV paths in
  store/isolation — the shared helper must return the index collation, not the
  declared one.
- `ALTER COLUMN … SET COLLATE` on an index column: a `derivedFromIndex` UNIQUE
  must re-key enforcement under the new collation (helper reads the post-ALTER
  `this.tableSchema!`). The store unique suite passed; spot-check it still holds.
