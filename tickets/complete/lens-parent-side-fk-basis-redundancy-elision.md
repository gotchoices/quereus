description: COMPLETE — parent-side FK basis-redundancy elision. The lens-level parent-side `NOT EXISTS` over the logical child is elided when the re-planned basis parent write provably already enforces an equivalent parent-side FK, gated on the three structural conditions shared with the child side PLUS a parent-side-only action-match gate (every matching basis FK must be `restrict` for the op). Reviewed, validated, shipped.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK basis-redundancy elision — complete

The parent-side complement of `lens-fk-basis-redundancy-elision`. A logical FK
referencing a lens-backed logical *parent* synthesized a deferred `NOT EXISTS`
over the logical child on parent DELETE/UPDATE even when the re-planned basis
parent write's own `buildParentSideFKChecks` already enforced an equivalent
parent-side FK. The lens-level check is now **elided when provably redundant**,
defaulting to double-enforce on any uncertainty.

## What shipped (as implemented)

- `matchingBasisFks(...)` — returns **all** basis FKs whose unordered index
  pair-set matches and reference the basis parent (generalizes the old
  `basisCarriesEquivalentFk`; the wrapper was removed as dead code once both
  detectors route through the shared core).
- `basisFksSubsuming(..., projectionToCheck)` — the shared structural core
  (mapped pair-set + non-row-reducing projection of the scanned slot:
  `'parent'` for child-side, `'child'` for parent-side).
- `lensForeignKeyRedundant` (child-side) refactored to `basisFksSubsuming(..., 'parent')[0]`
  — behavior unchanged.
- `lensParentSideForeignKeyRedundant(...)` — new; structural core + the
  **action-match gate**: elide only when **every** matching basis FK's
  op-appropriate action (`onDelete`/`onUpdate`) is `restrict`. Any
  `cascade`/`setNull`/`setDefault` ⇒ retain the lens RESTRICT.
- `collectLensParentSideForeignKeyConstraints` — hoisted `basisParent` and added
  the elision short-circuit after the count-mismatch guard, before building the
  `NOT EXISTS`. All pre-existing guards retained.
- `docs/lens.md` § Constraint Attachment updated (maturity blockquote + parent-side
  paragraph + collector doc-comment).

## Why the parent side needs the extra action gate

Child-side FK existence is action-agnostic. The parent side is not:
`buildParentSideFKChecks` synthesizes a check **only** for `restrict`
(`foreign-key-builder.ts:347`). A non-restrict basis FK mutates the children
instead of rejecting, so the basis parent write enforces no parent-side check for
it — eliding a lens RESTRICT there would silently drop enforcement. NO ACTION
normalizes to `restrict` at schema-build (`manager.ts` `extractForeignKeys`,
`fk.onDelete ?? 'restrict'` / `?? 'restrict'` — verified for both column- and
table-level FKs), so the gate is the exact `=== 'restrict'` test the physical
builder uses.

## Review findings

Adversarial pass over commit `210151aa`. Read the full source + test + docs diff
first, then verified every load-bearing external claim against the codebase.

### Verified sound (checked, no change needed)

- **Foundational assumption holds.** The re-planned basis parent DELETE/UPDATE
  routes through `buildDeleteStmt`/`buildUpdateStmt`, both of which call
  `buildParentSideFKChecks` under the `foreign_keys` pragma (delete.ts:161,
  update.ts:203). There is additionally an *immediate* runtime RESTRICT pre-check
  on the basis parent write (`assertNoRestrictedChildrenForParentMutation`). So
  the elided `restrict`-basis case is doubly enforced at the basis level.
- **Action-gate claims verified.** `buildParentSideFKChecks` emits only for
  `action === 'restrict'` (foreign-key-builder.ts:347); restrict checks are
  *immediate* (`deferrable:false`). NO ACTION → `restrict` normalization confirmed
  at both FK extraction sites (manager.ts:970-971 table-level, plus the
  column-level path).
- **Child-side behavior unchanged.** `lensForeignKeyRedundant` now takes
  `basisFksSubsuming(..., 'parent')[0]`; the condition order (mappedPairs → parent
  non-row-reducing → matching FK) is structurally identical to the pre-refactor
  body. The `basisCarriesEquivalentFk` wrapper removal is correct (dead once both
  callers use the shared core) — concur with the implementer's deviation from the
  ticket's literal TODO.
- **Soundness bias is one-directional.** Every gap returns `[]`/`undefined` ⇒
  enforce. The `matches.every(... === 'restrict')` defensive scan (a single
  non-restrict match vetoes elision) is correct; the empty-array case is guarded by
  the prior `matches.length === 0` return.
- **Conservative child-projection gate is sound.** A row-reducing logical child is
  a subset of the basis child, so the basis parent-side check (scanning the
  superset) rejects a superset of cases — eliding would still be sound, but the gate
  conservatively retains. Never unsound.
- **Drift parity.** Elision reads the current `tableSchema.foreignKeys` at
  write-plan time, exactly as the physical `buildParentSideFKChecks` it defers to.

### Lint / typecheck / tests

- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- Full `yarn workspace @quereus/quereus test` — **4297 passing, 9 pending, exit 0**
  (4296 prior + the one test added below). No regressions.

### Fixed inline (minor)

- **Coverage gap closed.** The implementer flagged that a parent-rename override
  combined with elision was untested (only child rename was). The parent half of
  `mappedFkBasisPairs` (logical→basis parent column mapping under a non-identity
  projection) was exercised only by identity projections. Added test
  *"elides under a PARENT rename override when the basis FK references the renamed
  basis parent column"* (`lens-enforcement.spec.ts`) — logical `id` ← basis
  `basis_id`, basis restrict FK over `basis_id`; asserts `[]` for DELETE + UPDATE
  and that the basis FK still ABORTs a referenced-parent delete. Passes.

### Filed as new ticket (major — pre-existing, not caused by this diff)

- **`fix/lens-parent-side-fk-cascade-basis-restrict-lens-not-enforced`** — I
  actually ran the end-to-end probe the implementer explicitly left as unit-only.
  **Confirmed a real, reachable soundness gap:** a lens RESTRICT FK over a basis
  CASCADE (or SET NULL / SET DEFAULT) FK does **not** enforce the RESTRICT.
  Deleting a referenced logical parent *succeeds* (`{aborted:false,
  parent:[{n:0}], child:[{n:0}]}`): the basis cascade deletes the children during
  the statement, so the retained deferred lens `NOT EXISTS` sees no children at
  commit and passes. Root cause: the lens parent-side check is auto-deferred to
  commit (via its `EXISTS`), so it cannot observe the pre-cascade child state — a
  deferred `NOT EXISTS` structurally cannot enforce RESTRICT against a
  same-statement cascade (the physical RESTRICT check is *immediate*, by contrast).
  This is **pre-existing** behavior from `lens-parent-side-fk-enforcement` — the
  elision correctly *retains* (never elides) the cascade case; the bug is that
  retention is insufficient. Orthogonal to elision soundness; out of scope for this
  ticket per the implementer's (correct) scoping. Full repro + remediation
  direction in the ticket.

### Not covered (acknowledged, no action)

- The two-matching-FKs-with-divergent-actions pathological case (the `every` scan
  handles it, but no single DDL declares two such FKs, so it is unconstructible in
  a test today). The defensive scan is correct by inspection.

## Net

Elision logic is sound and well-gated; child-side behavior preserved; docs accurate;
build + lint + full suite green at 4297 passing. One inline test added; one
pre-existing, orthogonal soundness gap (basis cascade vs. lens RESTRICT timing)
discovered, reproduced, and filed as a fix ticket.
