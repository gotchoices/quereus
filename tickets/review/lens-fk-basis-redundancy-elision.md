description: Review the lens FK basis-redundancy elision — at collection time, skip the lens-boundary `enforced-fk` EXISTS check when the basis child write provably already enforces an equivalent FK (single-source value-preserving child mapping + matching unordered basis FK pair-set + faithful non-row-reducing logical parent). Verify soundness: every uncertain case must default to double-enforce; a false "redundant" verdict silently drops enforcement.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Review: lens FK basis-redundancy elision

## What this does

`lens-fk-enforcement-wiring` (landed) double-enforces FK obligations by design:
`collectLensForeignKeyConstraints` synthesizes a lens-boundary `EXISTS` existence
check for every logical `enforced-fk`, **even when** the re-planned basis write's
own `buildChildSideFKChecks` already enforces an equivalent basis FK. This ticket
elides that redundant lens check **only when redundancy is provable**, leaving
every uncertain case double-enforcing (always sound).

The elision is a **collection-time** decision (not a stored obligation field):
redundancy depends on the *current* basis FK set, which is physical schema that can
drift out-of-band between deploys — so reading it at write-plan time makes the
elision exactly as sound as the physical `buildChildSideFKChecks`, which also reads
`tableSchema.foreignKeys` at plan time. The obligation classification
(`{ kind: 'enforced-fk' }`) is unchanged.

## What changed

**`lens-prover.ts` (reuse, not replicate).** Refactored the private
`resolveSingleBasisSource(db, body, basisSchemaName)` to take a `SchemaManager`
instead of a `Database` (it only ever used `db.schemaManager`), updated its two
internal call sites (`buildProveContext` / `buildLiteProveContext` now pass
`db.schemaManager`), and added an exported slot-level wrapper
`resolveSlotBasisSource(slot, schemaManager)` that resolves a slot's `compiledBody`
single-source basis table. This is the AGENTS.md §DRY-preferred option from the
ticket — the enforcement collector reuses the prover's single-source `from`-walk
rather than hand-rolling a second one.

**`lens-enforcement.ts`.** New `lensForeignKeyRedundant(slot, fk, referencedSchema,
logicalParentColumns, schemaManager)` returning the **subsuming basis FK** (for the
log) or `undefined` to enforce — a slight deviation from the ticket's `: boolean`
signature, chosen so the elision log can name the basis FK that subsumed it.
It checks all three conditions, defaulting to enforce on **any** gap:

1. **(1) single-source + value-preserving child mapping** — `resolveSlotBasisSource`
   resolves the child basis table; `mappedFkBasisPairs` maps every logical FK child
   column → basis child column via `logicalToBasisColumnMap` + `basisChild.columnIndexMap`.
   A name-only fallback (column not in the projection map) ⇒ `undefined` ⇒ enforce.
2. **(2) equivalent basis FK** — `mappedFkBasisPairs` also maps the logical referenced
   columns → basis parent columns (via the **parent** slot's `logicalToBasisColumnMap`),
   producing the mapped `(basisChildCol → basisParentCol)` index pair-set.
   `basisCarriesEquivalentFk` finds a basis FK on the child basis table whose
   `(bfk.columns[j] → resolveReferencedColumns(bfk)[j])` pair-set **equals** it as an
   unordered set and references the same basis parent (schema + name). A permuted basis
   FK yields a different pair-set; a partial one fails the arity check.
3. **(3) row-set equivalence** — the parent lens slot resolves (`getLensSlot`) and its
   single basis source is the basis parent, and `isNonRowReducingProjection(parentSlot.compiledBody)`
   holds: none of `where` / `groupBy` / `having` / `distinct` / `limit` / `offset` /
   `union` / `compound` / `withClause` (`orderBy` ignored — row-preserving).

Wired into `collectLensForeignKeyConstraints`: after the existing parent-arity guard,
`continue` + `log` (on the existing `planner:lens-enforcement` channel) when redundant.

**`docs/lens.md` § Constraint Attachment.** Updated the maturity blockquote and the
Foreign key bullet: the lens FK check is now elided when the basis carries a provably
equivalent FK over a faithful, non-row-reducing logical parent; any uncertainty
defaults to double-enforce.

## Why it is sound (the argument to scrutinize)

With (1) `NEW.logicalChildCol[i] == NEW.basisChildCol[i]`; with (2) the basis write's
FK check guarantees a basis-parent row exists for the written basis child values; with
(3) every basis-parent row maps 1:1 (values preserved on the referenced columns) to a
logical-parent row, so logical-parent ⊇ basis-parent on the referenced columns ⇒ the
lens-level existence check is implied by the basis check. MATCH SIMPLE NULL semantics
already agree (both EXISTS paths OR-guard on `IS NULL`).

**A false "redundant" verdict silently drops enforcement — a soundness hole.** The
review's central job is to confirm every early-return path defaults to *enforce*.

## Use cases / how to validate (tests in `lens-enforcement.spec.ts`,
`describe('… child-side FK basis-redundancy elision')`)

- **Elides (provable):** basis declares the same `child.pid → parent.id` FK, logical
  bodies are the faithful default projection ⇒ `collectLensForeignKeyConstraints(...).length === 0`;
  a dangling `insert into x.child` still ABORTs (via the basis FK), satisfying/NULL OK.
- **Composite elides** with an equivalent basis composite FK (same pair-set); a
  **permuted** basis FK (`references parent(py, px)`) does **NOT** elide (`length === 1`).
- **No basis FK ⇒ enforce** (`length === 1`, dangling still ABORTs) — guards over-elision.
- **Parent override with a `where` ⇒ does NOT elide** (condition 3 fails). The
  soundness-critical case: a value present in the basis parent but filtered out of the
  logical parent (id = -5) passes the basis FK yet **must ABORT** at the lens.
- **Rename override on child still elides** when the basis FK is on the basis column
  (`view child as select id, basis_pid as pid …` over basis FK on `basis_pid`).

## ⚠️ Honest gaps / things to scrutinize

1. **Conservative defaults are the entire safety story.** Soundness rests on *every*
   early return in `lensForeignKeyRedundant` / `mappedFkBasisPairs` /
   `basisCarriesEquivalentFk` being a default-to-enforce. The tests exercise the main
   gaps (no basis FK, permuted FK, filtered parent), but the following gaps default to
   enforce **only by the code's structure, not by a dedicated test** — worth an
   adversarial read (and a case each if the reviewer wants the floor raised):
   - **Multi-source child body** (a join) → `resolveSlotBasisSource(childSlot)` returns
     `undefined` ⇒ enforce. Untested directly.
   - **Parent is a plain table, not a lens** → `getLensSlot` returns `undefined` ⇒
     enforce. Untested. (In a logical schema the parent is normally itself a lens, but
     a cross-schema reference to a physical table is conceivable.)
   - **Cross-basis-schema FK** (child basis in schema A, parent basis in schema B): the
     `bfk.referencedSchema ?? basisChild.schemaName` vs `basisParent.schemaName` compare
     handles it, but is untested.
   - **UPDATE path:** the elision applies to INSERT and UPDATE alike (operations mask
     unchanged; the collector runs once per write-plan). The new tests assert
     enforce/elide via INSERT only; UPDATE-through-an-elided-FK-still-ABORTs is not
     separately pinned (the existing non-elision suite covers UPDATE enforcement).

2. **Degenerate duplicate-pair FK.** `mappedFkBasisPairs` builds a `Set`, so a
   pathological FK whose columns map two logical pairs to the **same**
   `(basisChild, basisParent)` index pair would shrink `pairs.size` below
   `fk.columns.length`; `basisCarriesEquivalentFk`'s `bfk.columns.length !== mappedPairs.size`
   check then mismatches and it defaults to non-elision (safe). Essentially unreachable
   (`(a,a) references parent(x,x)`), but the set-vs-multiset choice is worth a glance.

3. **`lensForeignKeyRedundant` returns the FK, not a `bool`.** Functionally equivalent
   to the ticket's `: boolean` (truthiness gates the `continue`), but it is a
   signature deviation — the returned FK is used purely for the elision log message.

4. **Reuse refactor blast radius.** `resolveSingleBasisSource`'s signature changed
   (`Database` → `SchemaManager`). Both in-file call sites were updated and the full
   prover/lens suites pass, but confirm no other caller existed (it was a private fn,
   so there should be none).

## Validation run

- `node … mocha … packages/quereus/test/lens-enforcement.spec.ts` — **53 passing**
  (the 6 new elision tests + all prior lens enforcement cases).
- `yarn workspace @quereus/quereus test` (full quereus suite) — **4249 passing,
  9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
