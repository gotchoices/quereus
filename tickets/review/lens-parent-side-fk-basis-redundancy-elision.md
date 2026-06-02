description: REVIEW — parent-side FK basis-redundancy elision shipped. The lens-level parent-side `NOT EXISTS` (over the logical child) is now elided when the re-planned basis parent write provably already enforces an equivalent parent-side FK, gated on the three structural conditions shared with the child side PLUS a parent-side-only action-match gate (every matching basis FK must be `restrict` for the op). Build + lint + full quereus suite green (4296 passing).
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Review: lens parent-side FK basis-redundancy elision

## What shipped

The parent-side complement of `lens-fk-basis-redundancy-elision`. Before this, a
logical FK referencing a lens-backed logical *parent* always synthesized a deferred
`NOT EXISTS` over the logical child on parent DELETE/UPDATE — even when the re-planned
basis parent write's own `buildParentSideFKChecks` already enforced an equivalent
parent-side FK (double-enforcement by design). The lens-level check is now **elided
when provably redundant**, with any uncertainty defaulting to double-enforce.

### Code (`packages/quereus/src/planner/mutation/lens-enforcement.ts`)

- **`matchingBasisFks(basisChild, basisParent, mappedPairs)`** — generalized from the
  old `basisCarriesEquivalentFk`: returns **all** basis FKs whose unordered index
  pair-set matches and that reference the basis parent (not just the first). Returning
  every match is load-bearing for the parent-side action gate.
- **`basisFksSubsuming(childSlot, fk, parentSlot, logicalParentColumns, basisChild,
  basisParent, projectionToCheck)`** — the shared **structural** core (no action
  reasoning). Computes the mapped pair-set, checks the relevant slot's body is
  non-row-reducing (`projectionToCheck` selects `'parent'` for the child-side detector
  — it scans the parent — or `'child'` for the parent-side detector — it scans the
  child), and returns `matchingBasisFks(...)`.
- **`lensForeignKeyRedundant`** (child-side, **behavior unchanged**) refactored to
  `basisFksSubsuming(..., 'parent')[0]`.
- **`lensParentSideForeignKeyRedundant(childSlot, fk, parentSlot, basisParent,
  logicalParentColumns, operation, schemaManager)`** — new. Resolves the child's basis
  source, calls `basisFksSubsuming(..., 'child')`, then applies the **action-match
  gate**: returns a match only if **every** matching basis FK's op-appropriate action
  (`onDelete`/`onUpdate`) is `restrict`. If *any* is `cascade`/`setNull`/`setDefault`,
  it returns `undefined` (retain the lens RESTRICT).
- **`collectLensParentSideForeignKeyConstraints`** — hoisted `basisParent` out of the
  single-source-spine early-return; added the elision short-circuit (`log` + `continue`)
  **after** the count-mismatch guard and **before** building the `NOT EXISTS`. All
  pre-existing guards (single-source spine, logical-FK action gate, count-mismatch) are
  retained — the elision is an added short-circuit, not a replacement.

### Why the parent side needs the extra action gate (the core insight to verify)

Child-side FK existence is action-agnostic (a child-side `EXISTS` enforces "the parent
must exist" regardless of referential action), so the child-side elision ignores actions.
The parent side is different: `buildParentSideFKChecks` synthesizes a check **only** for
`restrict` (`foreign-key-builder.ts:342-347`). A basis FK with `cascade`/`setNull`/
`setDefault` would mutate the children instead of rejecting, so the basis parent write
enforces **no** parent-side check for it — eliding a lens RESTRICT in that case would
silently drop enforcement. Hence: elide only when *every* matching basis FK is `restrict`
for the op. (`ForeignKeyAction` has no `'no action'`; NO ACTION normalizes to `restrict`
at schema-build time — `manager.ts:extractForeignKeys` does `fk.onDelete ?? 'restrict'`
— so the gate is the exact `=== 'restrict'` test the physical builder uses.)

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- Targeted `test/lens-enforcement.spec.ts` — 73 passing.
- Full `yarn workspace @quereus/quereus test` — **4296 passing, 9 pending, exit 0**; no
  behavioral regressions (elision changed no ABORT/accept outcome in any existing test).

### New test block: `describe('lens enforcement: parent-side FK basis-redundancy elision')`

Helper `deployParentFkBasisEquivLens(db, { basisFkTail?, childOverride? })` — the inverse
of `deployParentFkLens`: the **basis** child carries the FK, the **logical** child
re-declares it (bare ⇒ RESTRICT). `basisFkTail` tunes the basis FK's referential actions.

Cases (all assert the collector output; several add behavioral assertions):
- **Core elide (DELETE + UPDATE)** — basis restrict/restrict, faithful default lenses ⇒
  `[]` for both ops; behaviorally deleting a referenced parent still ABORTs via the basis
  FK and the child is **not** orphaned, an unreferenced parent deletes.
- **Basis CASCADE ⇒ retained** — collector emits `1` for both ops (the headline caveat).
- **Per-op read** — basis delete-restrict/update-cascade ⇒ DELETE `[]`, UPDATE `1`.
- **Basis SET NULL ⇒ retained** — `1` for both ops.
- **No basis FK ⇒ retained** — `1` for both ops (no over-elision).
- **Permuted basis composite FK ⇒ retained** — pair-set mismatch ⇒ `1`.
- **Row-reducing child body ⇒ retained** — child `where id > 0` ⇒ `1` (conservative gate).
- **Child rename override ⇒ elides** — logical `pid` ← basis `basis_pid`, basis FK over
  `basis_pid` ⇒ `[]`; basis FK still ABORTs a referenced-parent delete.
- **Composite restrict elides (DELETE + UPDATE)** — `[]` for both; delete/re-key of a
  referenced composite key still ABORTs via the basis FK.

### Docs

`docs/lens.md` § Constraint Attachment — updated both the maturity blockquote (line ~158)
and the `**Live** (parent-side):` paragraph (line ~164): the elision now ships, gated on
the three structural conditions (read from the child direction) plus the action-match
gate, defaulting to double-enforce on any uncertainty, with the cascade-basis-FK case
called out as the reason the parent side needs the extra gate. The `collectLens…`
collector doc-comment was likewise updated (it previously said "backlog follow-up").

## Known gaps / things for the reviewer to probe

- **Deviation from the ticket's literal TODO:** the ticket asked to keep
  `basisCarriesEquivalentFk` as a thin wrapper delegating to `matchingBasisFks(...)[0]`.
  Once both detectors route through the shared `basisFksSubsuming` (which calls
  `matchingBasisFks` directly), that wrapper is **dead code**, so it was **removed** for
  DRY/lint cleanliness. Child-side behavior is unchanged (`lensForeignKeyRedundant` now
  takes `basisFksSubsuming(..., 'parent')[0]`, structurally identical). Confirm you agree
  with the removal vs. keeping a wrapper.
- **CASCADE behavioral assertion is unit-only, by design.** The cascade test asserts only
  the *collector decision* (`length === 1`, "retain"), not the end-to-end runtime outcome
  of a basis-CASCADE-vs-retained-lens-RESTRICT parent delete. That runtime interleaving
  (does the basis cascade delete the children before the deferred lens `NOT EXISTS`
  evaluates at commit, letting the delete through? or does the lens RESTRICT abort?) is
  **pre-existing behavior unchanged by this ticket** — the status quo before this change
  already double-enforced (never elided) the cascade case. If the reviewer wants, an
  end-to-end probe of that interleaving would be a worthwhile *separate* investigation
  (potential fix/backlog ticket), but it is orthogonal to elision soundness.
- **Soundness bias is one-directional.** Every gap returns `undefined`/`[]` ⇒ enforce. A
  false "redundant" verdict is a soundness hole (drops a RESTRICT rejection); a false
  "not redundant" only costs a redundant scan. Worth a second pair of eyes on
  `lensParentSideForeignKeyRedundant`'s `matches.every(... === 'restrict')` — the
  defensive "scan ALL matching basis FKs" requirement (a single non-restrict match must
  veto elision even if another match is restrict).
- **Elision reads the *current* basis FK set** at write-plan time (not stored on the
  obligation), exactly as sound as the physical `buildParentSideFKChecks` it defers to —
  both read `tableSchema.foreignKeys` at plan time, so both survive out-of-band basis DDL
  drift identically.
- **Tests are a floor.** The new block leans on collector-output unit assertions (the
  deterministic, load-bearing checks) with behavioral assertions on the clean restrict
  elide cases. Edge cases not covered: a child basis table carrying *two* matching FKs to
  the same parent with divergent actions (pathological — the `every` scan handles it, but
  no test exercises it because no single DDL declares two such FKs); a parent rename
  override combined with the elision (only child rename is tested).
