description: IMPLEMENT — make a lens-backed logical parent-side FK's **non-RESTRICT** action (cascade / set null / set default) win over a structurally-equivalent **divergent** basis FK action over the same columns. Today the lens cascade walker elides action-agnostically whenever an equivalent basis FK exists, so the basis action governs: a logical `set null` over a basis `cascade` deletes the children instead of nulling them; a logical `cascade` over a basis `restrict` is aborted by the basis RESTRICT before it can run. Resolve by making the walker's elision action-aware (elide only when the basis action AGREES) and suppressing the basis FK's physical action / RESTRICT check at every enforcement site when a divergent non-RESTRICT logical FK overrides it.
prereq: lens-parent-side-fk-cascade-basis-restrict-lens-runtime-precheck
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK divergent basis action — the logical action wins

## Semantics decision (authoritative)

When a lens-backed logical parent and its basis child both carry a parent-side FK over the
**same structurally-equivalent columns** (mapped unordered `(basisChildCol → basisParentCol)`
index-pair set), but with **divergent referential actions** for the op, the **logical FK's
action is the authoritative contract and wins**. The basis action over those equivalent
columns is suppressed; the logical action runs.

This ticket closes the **logical action is non-RESTRICT** half of the divergence matrix
(logical `cascade` / `set null` / `set default` diverging from any different basis action,
including a basis RESTRICT). The complementary **logical action is RESTRICT** half (lens
RESTRICT over a non-RESTRICT basis) is handled by the prereq
`lens-parent-side-fk-cascade-basis-restrict-lens-runtime-precheck` via its
`assertLensRestrictsForParentMutation` pre-check. Together the two tickets make the **logical
FK's action win for every divergent (basis action × logical action) pair**, and the
"divergent basis-vs-lens action" limitation in `docs/lens.md` is fully closed.

## Background — why the basis currently governs

A logical FK lives only on a child lens slot's `enforced-fk` obligation (on no basis table).
Three enforcement mechanisms fire on a basis parent DELETE / UPDATE:

1. **Lens cascade walker** — `executeLensForeignKeyActions` → `executeLensFkActionsForParentSlot`
   (`runtime/foreign-key-actions.ts`) propagates the non-RESTRICT logical actions by issuing
   DML against the logical *child view*. It currently **elides action-agnostically** via
   `basisChildCarriesEquivalentFk` (`schema/lens-fk-discovery.ts`): *any* matching basis FK —
   regardless of action — skips the lens cascade, letting the basis action run alone.
2. **Physical cascade walker** — `executeForeignKeyActions` propagates the basis FK's
   non-RESTRICT action over the basis child.
3. **Basis RESTRICT enforcement** — the immediate plan-time `NOT EXISTS` from
   `buildParentSideFKChecks` (`planner/building/foreign-key-builder.ts`, `needsDeferred:false`
   for restrict) **and** the runtime pre-checks `assertNoRestrictedChildrenForParentMutation`
   / `assertTransitiveRestrictsForParentMutation` (fired *before* `vtab.update`).

The two divergence failures, both rooted in the action-agnostic elision at (1):

- **logical `set null` over basis `cascade`** (DELETE): the lens walker elides → (2) the
  physical cascade *deletes* the basis children. The logical SET NULL never nulls them.
- **logical `cascade` over basis `restrict`** (DELETE / key-UPDATE): (3) the basis RESTRICT
  immediate check + runtime pre-check **abort the parent mutation** before the lens cascade
  at (1) can run. The logical CASCADE never fires.

## Fix design — action-aware elision + basis suppression (exact complements)

The fix is two coordinated halves that must be **exact complements** in the canonical
single-equivalent-basis-FK case, so the children are mutated by *exactly one* path (never
both ⇒ no double-mutation; never neither ⇒ no dropped enforcement):

- **(A) Lens walker fires** the logical action unless an equivalent basis FK whose op-action
  **agrees** exists.
- **(B) Basis enforcement is suppressed** for a basis FK precisely when a **divergent
  non-RESTRICT** logical FK overrides it.

### Shared discovery (DRY — `schema/lens-fk-discovery.ts`)

Both halves derive from one structural core (`mappedFkBasisPairs` + `matchingBasisFks`, the
same core the redundancy detector and `basisChildCarriesEquivalentFk` already share). Add:

```ts
/**
 * The basis FKs (declared on the logical child's basis table) that are structurally
 * equivalent to `ref`'s logical FK over the same mapped (basisChildCol → basisParentCol)
 * index-pair set referencing `basisParent`. The lens-walker's per-ref match list — the
 * action-aware generalization of basisChildCarriesEquivalentFk (which is now `…​.length > 0`).
 * Resolves the ref's own basis child via resolveSlotBasisSource; returns [] on a multi-source
 * child, a non-plain mapping, or no matching basis FK.
 */
export function matchingBasisFksForLensRef(
  ref: LogicalParentFkRef,
  parentSlot: LensSlot,
  basisParent: TableSchema,
  schemaManager: SchemaManager,
): ForeignKeyConstraintSchema[]

/**
 * The set of basis FKs on tables referencing `basisParent` that are OVERRIDDEN by a
 * divergent **non-RESTRICT** logical FK over the same equivalent columns for `operation`
 * — i.e. the basis FKs whose physical action / RESTRICT check must be suppressed because
 * the logical action governs. Reverse-maps basisParent → parent slot(s) (like
 * executeLensForeignKeyActions), discovers referencing logical FKs (findLogicalParentFkRefs),
 * and for each logical ref whose op-action is non-RESTRICT, adds every structurally-equivalent
 * basis FK whose op-action DIFFERS. Identity-comparable against TableSchema.foreignKeys (the
 * returned FK objects are the same references the enforcement sites iterate). Empty (cheap)
 * when no parent slot is backed by basisParent — the common non-lens case.
 */
export function basisFksOverriddenByDivergentLensFk(
  basisParent: TableSchema,
  operation: 'delete' | 'update',
  schemaManager: SchemaManager,
): Set<ForeignKeyConstraintSchema>
```

Refactor `basisChildCarriesEquivalentFk` to keep its current (action-agnostic) meaning — it
stays **exported** (the existing direct-call unit tests use it) — but is no longer the lens
walker's elision gate.

**Complement invariant (the load-bearing correctness argument, document inline):** for one
equivalent basis FK `m` with logical op-action `L` (non-RESTRICT) and basis op-action `B`:
`L === B` ⇒ walker elides AND `m ∉ overridden` (basis acts; one action). `L !== B` ⇒ walker
fires AND `m ∈ overridden` (basis suppressed; one action). The pathological multi-equivalent-
basis-FK case (two basis FKs over identical columns with mixed actions) is documented as a
sound-but-non-minimal residual: the walker fires when *any* match diverges, and only the
*divergent* basis FKs are suppressed, so an agreeing same-action basis FK may also run (a
double application of the *same* idempotent-ish action — e.g. SET NULL twice) — never a
dropped enforcement. This matches the existing "default to enforce / any uncertainty
double-acts" bias and the pathological framing in the ticket.

### (A) Action-aware lens-walker elision (`executeLensFkActionsForParentSlot`)

Replace the `basisChildCarriesEquivalentFk(...)` boolean elide with:

```ts
const matches = matchingBasisFksForLensRef(ref, parentSlot, basisParentTable, sm);
const agree = matches.length > 0
  && matches.every(m => (operation === 'delete' ? m.onDelete : m.onUpdate) === action);
if (agree) { log('… elided — basis carries an AGREEING equivalent FK (basis governs)'); continue; }
// matches.length === 0 → basis does not enforce (current fire path)
// matches diverge      → the logical action wins; basis is suppressed at (B). Fire it.
```

### (B) Suppress the basis FK at every enforcement site

Compute the suppression set **once** per parent mutation / plan build, then skip the basis FK
when present. The returned objects are identity-equal to the iterated `TableSchema.foreignKeys`
entries, so `suppressed.has(fk)` is a direct lookup.

- **`executeForeignKeyActions`** (`runtime/foreign-key-actions.ts`): compute
  `const suppressed = basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager)`
  before the schema loop; `if (suppressed.has(fk)) continue;` right before `executeSingleFKAction`
  (after the existing `action === 'restrict'` skip). Prevents the physical cascade/null/default
  the logical action replaces.
- **`assertNoRestrictedChildrenForParentMutation`** (`runtime/foreign-key-actions.ts`): same
  compute-once; `if (suppressed.has(fk)) continue;` after the `action !== 'restrict'` skip.
  Prevents the basis RESTRICT pre-check from aborting a parent mutation that a logical cascade
  must complete.
- **`assertTransitiveRestrictsForParentMutation`** (`runtime/foreign-key-actions.ts`): step 1
  delegates to the above (covered). In **step 2** (the cascade-recursion that walks non-RESTRICT
  basis FKs to find deeper RESTRICTs), skip a suppressed basis FK too — the physical cascade it
  walks will not run (the logical action replaces it), and the logical action's own transitivity
  is enforced when its child-view DML re-enters the transitive walk at the next level. Use the
  same compute-once set.
- **`buildParentSideFKChecks`** (`planner/building/foreign-key-builder.ts`): compute
  `const suppressed = basisFksOverriddenByDivergentLensFk(tableSchema, op, ctx.schemaManager)`
  (translate `RowOpFlag.DELETE → 'delete'`, else `'update'`) once at the top; `if (suppressed.has(fk)) continue;`
  after the `action !== 'restrict'` skip. Prevents the **immediate** plan-time `NOT EXISTS`
  from firing during the parent write (before the lens cascade nulls/deletes the children),
  which would otherwise reject the mutation. Soundness/drift profile is identical to the
  existing `lensParentSideForeignKeyRedundant` elision: the decision reads the *current* basis
  FK set at plan time, exactly as the physical builder does.

Pragma gating: every site is already inside a `foreign_keys` gate; the shared helper is a cheap
early-empty when no lens slot is backed by the parent, so non-lens DML pays one set construction
that returns empty.

## Worked outcomes (the acceptance behaviors)

- logical `set null` over basis `cascade` (DELETE): basis cascade **suppressed** at
  `executeForeignKeyActions`; lens walker fires SET NULL ⇒ children **nulled, not deleted**.
- logical `cascade` over basis `restrict` (DELETE / key-UPDATE): basis RESTRICT **suppressed**
  at the plan-time immediate check + runtime pre-checks; parent mutation proceeds; lens walker
  fires CASCADE ⇒ children **cascade-deleted / re-keyed**, mutation not aborted.
- logical `set default` over basis `cascade`, logical `cascade` over basis `set null`, etc. —
  every divergent non-RESTRICT pair resolves to the logical action via the same two halves.
- Agreeing actions (logical `cascade` over basis `cascade`, …) are **unchanged**: the walker
  still elides, the basis governs, no double-mutation.
- No-equivalent-basis-FK case (the canonical cascade lens, basis FK-free) is **unchanged**: no
  match ⇒ walker fires, nothing to suppress.

## What does NOT change

- `collectLensParentSideForeignKeyConstraints` / `lensParentSideForeignKeyRedundant` (the lens
  RESTRICT collector + its elision) — only `executeLensFkActionsForParentSlot` changes here.
  The collector still emits only for a **logical** RESTRICT action, which this ticket does not
  touch (those are the prereq's domain).
- `assertLensRestrictsForParentMutation` (the prereq's lens-RESTRICT pre-check) — orthogonal:
  it fires only for a **logical** RESTRICT action; this ticket's suppression predicate ignores
  logical RESTRICT refs (`logicalAction` non-RESTRICT only), so the two never overlap.
- `basisChildCarriesEquivalentFk` stays exported with its action-agnostic meaning for the
  existing unit tests; it is just no longer the walker's gate.

## TODO

### Phase 1 — shared discovery helpers (`schema/lens-fk-discovery.ts`)
- [ ] Add `matchingBasisFksForLensRef(ref, parentSlot, basisParent, schemaManager)` (resolve
      the ref's basis child, `mappedFkBasisPairs`, `matchingBasisFks`); refactor
      `basisChildCarriesEquivalentFk` to `matchingBasisFksForLensRef(...).length > 0` over a
      synthesized ref (or share an internal core) so there is one match path.
- [ ] Add `basisFksOverriddenByDivergentLensFk(basisParent, operation, schemaManager)`:
      reverse-map basisParent → parent slot(s) (mirror `executeLensForeignKeyActions`),
      `findLogicalParentFkRefs`, and for each ref whose op-action is **non-RESTRICT**, add every
      `matchingBasisFksForLensRef` entry whose op-action **differs**. Document the complement
      invariant + the pathological-multi-match residual inline.

### Phase 2 — action-aware lens-walker elision (`runtime/foreign-key-actions.ts`)
- [ ] In `executeLensFkActionsForParentSlot`, replace the `basisChildCarriesEquivalentFk`
      elide with the `matches` / `agree` logic above. Keep MATCH SIMPLE + the UPDATE
      referenced-column-change short-circuit unchanged (they run after the elide decision).

### Phase 3 — basis suppression at the four sites
- [ ] `executeForeignKeyActions`: compute-once `suppressed`, skip suppressed FKs before
      `executeSingleFKAction`.
- [ ] `assertNoRestrictedChildrenForParentMutation`: compute-once, skip suppressed restrict FKs.
- [ ] `assertTransitiveRestrictsForParentMutation` step 2: compute-once, skip suppressed
      cascading FKs in the recursion.
- [ ] `buildParentSideFKChecks`: compute-once (RowOpFlag → 'delete'/'update'), skip suppressed
      restrict FKs before synthesizing the immediate `NOT EXISTS`.

### Phase 4 — tests (`packages/quereus/test/lens-enforcement.spec.ts`)
Add a `describe('lens enforcement: parent-side FK divergent basis action')`. Deploy a
**basis-with-FK + logical-with-divergent-FK** shape (the basis carries the FK with action B,
the logical child re-declares it with action L ≠ B over the same columns) — adapt
`deployParentFkBasisEquivLens` (basis tail + a `childOverride` re-declaring the logical FK with
a divergent action), or write a focused helper. `pragma foreign_keys` defaults on.
- [ ] **DELETE, logical `set null` over basis `cascade`:** delete the referenced logical parent
      ⇒ children **survive with FK = NULL** (count unchanged, `pid is null`), basis children
      likewise nulled (not deleted).
- [ ] **DELETE, logical `cascade` over basis `restrict`:** delete the referenced logical parent
      **succeeds** (not aborted) ⇒ children **cascade-deleted** (parent + children gone). This is
      the case the basis RESTRICT immediate-check/pre-check previously aborted.
- [ ] **DELETE, logical `set default` over basis `cascade`** (logical child column `default 0`
      referencing a valid parent) ⇒ children survive with FK = 0, not deleted.
- [ ] **UPDATE of the referenced key, logical `set null` over basis `cascade`** ⇒ children
      nulled, not re-keyed; and the **benign** non-key UPDATE short-circuits (no cascade).
- [ ] **Agreeing-action control** (logical `cascade` over basis `cascade`): behavior unchanged
      (single cascade, no double-mutation) — pin it so the action-aware gate did not regress the
      agree path.
- [ ] **No-equivalent-basis-FK control** (the existing `deployCascadeLens` cascade shape): still
      fires the logical action (regression pin for the refactor).
- [ ] (Optional) direct-call unit tests for `matchingBasisFksForLensRef` (returns the basis FK
      for an equivalent shape, `[]` for a permuted/absent one) and
      `basisFksOverriddenByDivergentLensFk` (contains the basis FK iff divergent non-RESTRICT;
      empty when actions agree or the logical action is RESTRICT).

### Phase 5 — docs + validation
- [ ] Update `docs/lens.md` § Constraint Attachment: drop the **divergent basis-vs-lens
      parent-side action** limitation in **both** places it is stated — the maturity blockquote
      (the `lens-parent-side-fk-cascade-actions` sentence, ~line 158) and the Foreign-key bullet
      (the "One documented **limitation**: a divergent basis-vs-lens parent-side action …" close,
      ~line 164). Replace with: the **logical** FK action wins over a divergent equivalent basis
      action — the lens walker elides only on an **agreeing** basis action, and the basis FK's
      physical action / RESTRICT check is suppressed (`basisFksOverriddenByDivergentLensFk`) at
      the cascade walker, the runtime RESTRICT pre-checks, and the plan-time
      `buildParentSideFKChecks` when a divergent non-RESTRICT logical FK overrides it; together
      with the prereq's lens-RESTRICT pre-check the logical action wins for every divergent pair.
- [ ] Build + lint (single-quote globs on Windows) + `yarn test` (memory backend). Fix any
      fallout; if a failure is plainly unrelated/pre-existing, follow the
      `tickets/.pre-existing-error.md` flow. `yarn test:store` is **not** agent-runnable inside
      the ticket — if a store-specific (rowid-mode) gap is suspected, file a backlog ticket
      rather than expanding scope (mirrors the prereq's out-of-scope note).
