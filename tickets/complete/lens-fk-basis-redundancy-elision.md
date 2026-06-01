description: Elide the lens-boundary `enforced-fk` EXISTS check at collection time when the re-planned basis child write provably already enforces an equivalent FK (single-source value-preserving child mapping + matching unordered basis FK pair-set + faithful non-row-reducing logical parent). Every uncertain case defaults to double-enforce.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Complete: lens FK basis-redundancy elision

## What shipped

`collectLensForeignKeyConstraints` previously double-enforced every logical
`enforced-fk` obligation: it synthesized a lens-boundary `EXISTS` existence check
even when the re-planned basis write's own `buildChildSideFKChecks` already enforced
an equivalent basis FK. This ticket elides that redundant lens check **only when
redundancy is provable**, leaving every uncertain case double-enforcing (always
sound).

The elision is a **collection-time** decision (not a stored obligation field):
redundancy is read off the *current* basis FK set at write-plan time, so it is
exactly as sound as the physical `buildChildSideFKChecks`, which also reads
`tableSchema.foreignKeys` at plan time. The obligation classification
(`{ kind: 'enforced-fk' }`) is unchanged.

### Implementation

- **`lens-prover.ts`** — refactored the private `resolveSingleBasisSource` to take a
  `SchemaManager` (it only ever used `db.schemaManager`), updated its two in-file call
  sites, and added the exported slot-level wrapper `resolveSlotBasisSource(slot,
  schemaManager)`. The enforcement collector reuses the prover's single-source
  `from`-walk rather than hand-rolling a second one (AGENTS.md §DRY).
- **`lens-enforcement.ts`** — new `lensForeignKeyRedundant(...)` returning the
  subsuming basis FK (for the log) or `undefined` to enforce. It checks all three
  conditions and defaults to enforce on any gap:
  1. **single-source + value-preserving child mapping** (`resolveSlotBasisSource` +
     `mappedFkBasisPairs`),
  2. **equivalent basis FK** — `basisCarriesEquivalentFk` matches an unordered
     `(basisChildCol → basisParentCol)` index pair-set against the basis child's FKs,
     same basis parent (schema + name),
  3. **row-set equivalence** — the parent lens slot resolves to the basis parent and
     `isNonRowReducingProjection(parentSlot.compiledBody)` holds.
  Wired into the collector: `continue` + log on the `planner:lens-enforcement` channel
  when redundant.
- **`docs/lens.md` § Constraint Attachment** — maturity blockquote + Foreign key
  bullet updated to describe the elision and its three gates.

## Review findings

### Scope checked
Read the full implement diff (`041bddb3`) with fresh eyes before the handoff: the two
source files, the test additions, `docs/lens.md`, plus the surrounding machinery the
change depends on (`foreign-key-builder.ts buildChildSideFKChecks` /
`synthesizeFKExistsExpr`, `ForeignKeyConstraintSchema`, `resolveReferencedColumns`,
`ast.ts SelectStmt`). Scrutinized for soundness (the central risk: a false "redundant"
verdict silently drops enforcement), DRY, type safety, timing/transaction semantics,
referential-action and match-type interactions, and the reuse-refactor blast radius.

### Soundness — confirmed sound
- **Every early return defaults to enforce.** `lensForeignKeyRedundant`,
  `mappedFkBasisPairs`, and `basisCarriesEquivalentFk` each return
  `undefined`/non-match on any gap (multi-source child, name-only mapping,
  unresolved column index, missing/permuted/partial basis FK, no parent lens slot,
  row-reducing parent body). The subsumption argument (child value-preservation ⇒
  basis FK on basis values ≡ lens FK on logical values; non-row-reducing parent ⇒
  logical-parent ⊇ basis-parent on referenced cols ⇒ basis check implies lens check)
  holds, and the directionality is correct (a *filtered* parent would make the lens
  strictly stricter and is correctly rejected by condition 3).
- **AST field names in `isNonRowReducingProjection` verified** against
  `ast.ts:170` `SelectStmt` — `where`, `groupBy`, `having`, `distinct`, `limit`,
  `offset`, `union`, `compound`, `withClause` all exist (a wrong name would silently
  pass, a soundness hole — none found). `orderBy` is correctly ignored
  (row-preserving). `union`/`compound` are load-bearing (a compound SELECT keeps its
  first arm in `from`, so single-source resolution alone would not catch it) and both
  are checked.
- **Timing is neutral.** The physical basis child-side FK check is built
  `initiallyDeferred: true` (`foreign-key-builder.ts:207`), matching the lens EXISTS
  auto-defer-to-commit — so eliding the lens check does not change
  immediate-vs-deferred transaction semantics.
- **No match-type gap.** `ForeignKeyConstraintSchema` carries no match-type field
  (all FKs are MATCH SIMPLE); both the basis and lens checks OR-guard on `IS NULL`.
- **Referential actions out of scope.** `onDelete`/`onUpdate` are parent-side; the
  elision only drops the child-side existence check, so a logical-vs-basis action
  divergence cannot be masked by it.
- **Reuse refactor is clean.** `resolveSingleBasisSource` has exactly three call
  sites — all in `lens-prover.ts` (`buildProveContext`, `buildLiteProveContext`, the
  new `resolveSlotBasisSource`); the export is consumed only by `lens-enforcement.ts`.
  No stray caller of the changed private signature.
- **Degenerate duplicate-pair FK** (two logical pairs mapping to one basis index
  pair) shrinks `pairs.size` below `fk.columns.length` and fails
  `basisCarriesEquivalentFk`'s arity check ⇒ safe default to enforce. Essentially
  unreachable; the set-vs-multiset choice is safe either way.

### Minor — fixed inline
- **UPDATE-through-an-elided-FK was untested.** The elision drops the lens check for
  INSERT *and* UPDATE alike (the collector runs once per write-plan; `[]` covers both
  ops), but the implementer's tests asserted enforce/elide via INSERT only. Added a
  regression test (`an UPDATE through an elided FK still ABORTs a dangling value`) that
  confirms re-keying a child to a dangling parent ABORTs via the basis FK, a failed
  update rolls back, and updates to a valid parent / to NULL succeed. **54 passing**
  (was 53).

### Considered, not actioned (verified safe by code structure)
- **Multi-source child body** (a join) → `resolveSlotBasisSource` returns `undefined`
  ⇒ enforce. Not pinned with a dedicated test: a join-child lens would not produce an
  `enforced-fk` obligation in the first place, so a `length === 0` assertion would pass
  for the wrong reason (no obligation rather than elision-skip) and mislead. The
  default-to-enforce is clear from the `if (!basisChild) return undefined` guard.
- **Parent is a plain table, not a lens** → `getLensSlot` returns `undefined` ⇒
  enforce. Same fragility (hard to construct without it passing for the wrong reason);
  guarded by `if (!parentSlot) return undefined`.
- **Cross-basis-schema FK** — the `bfk.referencedSchema ?? basisChild.schemaName` vs
  `basisParent.schemaName` compare in `basisCarriesEquivalentFk` handles it; untested
  but structurally correct.

### Signature note (not a finding)
`lensForeignKeyRedundant` returns the subsuming `ForeignKeyConstraintSchema` rather
than the ticket's `: boolean`. Functionally equivalent (truthiness gates the
`continue`); the returned FK is used only to name the subsuming basis FK in the
elision log. Acceptable deviation.

### Major findings
None. No new fix/plan/backlog tickets filed.

## Validation

- `packages/quereus/test/lens-enforcement.spec.ts` — **54 passing** (the 6 elision
  tests + the new UPDATE regression + all prior lens enforcement cases).
- `yarn workspace @quereus/quereus test` — **4250 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
