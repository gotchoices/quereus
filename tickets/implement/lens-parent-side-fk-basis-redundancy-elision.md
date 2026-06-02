description: Elide the lens-level parent-side FK check (the synthesized `NOT EXISTS` over the logical child) when the re-planned basis parent write provably already enforces an equivalent parent-side FK — the parent-side complement of the shipped `lens-fk-basis-redundancy-elision`. Reuses the child-side redundancy helpers (`mappedFkBasisPairs`, `basisCarriesEquivalentFk`, `isNonRowReducingProjection`), adding an action-match gate so a basis FK whose action is *not* `restrict` (it would cascade / null instead of reject) never subsumes a lens RESTRICT.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK basis-redundancy elision

## Context

`collectLensParentSideForeignKeyConstraints` (shipped by `lens-parent-side-fk-enforcement`,
now in `complete/`) emits a deferred `NOT EXISTS` over the logical *child* for every
logical FK that references a lens-backed logical *parent*, gated on the RESTRICT action.
It **double-enforces by design**: the check is synthesized even when the re-planned basis
parent write's own `buildParentSideFKChecks` already enforces an equivalent parent-side
FK (the basis child declares the matching FK referencing the basis parent). That is always
sound — both reject the same orphaning — but pays a redundant `NOT EXISTS` scan at commit.

The child side already solved its analogue: `lensForeignKeyRedundant` elides the lens-level
`EXISTS` when three structural conditions prove the basis child write's `buildChildSideFKChecks`
already covers it (`packages/quereus/src/planner/mutation/lens-enforcement.ts:254-304`). This
ticket builds the parent-side dual, reusing those helpers rather than authoring a parallel set.

## Why this was split from the child-side ticket: the action-match caveat

On the **child** side, the FK *action* (`onDelete` / `onUpdate`) never enters the existence
check — a child-side `EXISTS` enforces "the parent must exist" regardless of referential
action — so the child-side elision ignores actions entirely.

On the **parent** side, the action is load-bearing. The lens-level check only emits for a
logical FK whose op-appropriate action is `restrict` (the existing action gate at
`lens-enforcement.ts:470-471`). For the basis parent-side check to *subsume* it, the basis
FK must **also reject** the orphaning — i.e. the basis FK's op-appropriate action must be
`restrict` too. If the logical FK is RESTRICT but the basis FK is `cascade` (or `setNull` /
`setDefault`), the re-planned basis parent write would **cascade-delete / null the children**
rather than reject, so `buildParentSideFKChecks` synthesizes **no** parent-side check for it
(`foreign-key-builder.ts:342-347` — only `action === 'restrict'` emits). Eliding the lens
RESTRICT in that case would silently drop enforcement: the orphaning delete would proceed
(cascading) when the lens intends to reject. **Therefore the elision must require the
subsuming basis FK's action to be `restrict` for the operation in question.**

Note `ForeignKeyAction = 'setNull' | 'setDefault' | 'cascade' | 'restrict'`
(`parser/ast.ts:506`) — there is no distinct `'no action'`; SQL NO ACTION normalizes to the
`restrict` default at schema-build time. So "the basis action must be at least as strict as
the logical RESTRICT" reduces to the exact test `action === 'restrict'`, matching the
physical `buildParentSideFKChecks` gate verbatim.

## The three structural conditions, read from the parent direction

Soundness of eliding the lens parent-side `NOT EXISTS` (over the *logical child* `L`) in
favor of the basis parent-side `NOT EXISTS` (over the *basis child* `B`) requires the basis
check to reject whenever the lens check would — i.e. `L`'s referencing rows ⊆ `B`'s. The
conditions mirror `lensForeignKeyRedundant` but the projection clause moves from the parent
slot to the **child** slot (the relation the parent-side subquery scans):

1. **Single-source, value-preserving child mapping** — the child slot resolves to one basis
   child table (`resolveSlotBasisSource(childSlot)`) and every logical FK child column maps
   with no transform to a plain basis child column. A single-source projection can only
   filter/reorder, never *add* rows, so `L ⊆ B` on the FK columns. (Both halves are already
   encoded by `mappedFkBasisPairs`, which also maps the parent referenced columns.)
2. **Equivalent basis FK referencing the basis parent** — the basis child carries an FK whose
   **unordered** `(basisChildCol → basisParentCol)` index pair-set equals the mapped one and
   references the basis parent (schema + name). This is exactly `basisCarriesEquivalentFk`'s
   match — so the basis parent write's `buildParentSideFKChecks` (which scans every table for
   FKs referencing the basis parent) will discover and enforce it.
3. **Faithful non-row-reducing logical child projection** — `isNonRowReducingProjection(childSlot.compiledBody)`.
   *Conservative-but-safe parity gate:* by (1) a single-source child already gives `L ⊆ B`,
   so a filtered child would still be sound to elide (the basis, scanning the superset `B`,
   rejects a superset of cases). We keep the gate anyway to mirror the child-side detector's
   structure exactly, to avoid subtle edge-case reasoning, and because including it can only
   *reduce* elision (default-to-double-enforce is always sound). **Do not "optimize" it away**
   without re-deriving the soundness argument — its presence is intentional.

Plus the new action-match gate (above): the matched basis FK's op-appropriate action must be
`restrict`.

## Multiple-matching-basis-FK soundness edge

`basisCarriesEquivalentFk` returns the *first* basis FK whose pair-set matches. For the
parent side this is not enough: if **any** basis FK with the matching pair-set referencing
the basis parent has a non-`restrict` action for the op, the basis parent write would
cascade/null the children — so eliding is unsound even if a *different* matching basis FK is
restrict. The action gate must therefore consider **every** matching basis FK, eliding only
when at least one matches and **none** of the matching ones is non-`restrict` for the op.
(Two FKs on identical child columns referencing the same parent with divergent actions is
pathological, but "any uncertainty defaults to enforce" demands the defensive scan.)

To express this without authoring a parallel matcher, **generalize** `basisCarriesEquivalentFk`
into a small `matchingBasisFks(basisChild, basisParent, mappedPairs): ForeignKeyConstraintSchema[]`
that returns *all* matches; have `basisCarriesEquivalentFk` delegate to it and return
`matches[0]` (preserving the child-side caller's behavior unchanged).

## Design

Refactor the structural core out of `lensForeignKeyRedundant` so both directions share it,
parameterized by which slot's body must be non-row-reducing:

```
// structural match only — no action reasoning; returns ALL subsuming basis FKs
function basisFksSubsuming(
  childSlot: LensSlot,
  fk: ForeignKeyConstraintSchema,
  parentSlot: LensSlot,
  logicalParentColumns: readonly string[],
  basisChild: TableSchema,
  basisParent: TableSchema,
  projectionToCheck: 'parent' | 'child',
): ForeignKeyConstraintSchema[] {
  const mappedPairs = mappedFkBasisPairs(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent);
  if (!mappedPairs) return [];
  const projSlot = projectionToCheck === 'parent' ? parentSlot : childSlot;
  if (!isNonRowReducingProjection(projSlot.compiledBody)) return [];
  return matchingBasisFks(basisChild, basisParent, mappedPairs);
}
```

`lensForeignKeyRedundant` (child-side, unchanged behavior) becomes: resolve `basisChild`
(from `slot`), `parentSlot` (from `fk.referencedTable` + `referencedSchema`), `basisParent`,
then `return basisFksSubsuming(slot, fk, parentSlot, parentCols, basisChild, basisParent, 'parent')[0];`.

New parent-side detector — note `parentSlot` and `basisParent` are already in hand inside
the collector loop (the parent is the slot passed to `collectLensParentSideForeignKeyConstraints`):

```
function lensParentSideForeignKeyRedundant(
  childSlot: LensSlot,
  fk: ForeignKeyConstraintSchema,
  parentSlot: LensSlot,
  basisParent: TableSchema,
  logicalParentColumns: readonly string[],
  operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
  schemaManager: SchemaManager,
): ForeignKeyConstraintSchema | undefined {
  const basisChild = resolveSlotBasisSource(childSlot, schemaManager);
  if (!basisChild) return undefined;
  const matches = basisFksSubsuming(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent, 'child');
  if (matches.length === 0) return undefined;
  // Action match: the basis parent-side check fires only for a `restrict` basis FK.
  // If ANY matching basis FK would cascade / null instead of reject, the basis write
  // does not subsume the lens RESTRICT — keep enforcing.
  const actionOf = (m: ForeignKeyConstraintSchema) => operation === RowOpFlag.DELETE ? m.onDelete : m.onUpdate;
  if (!matches.every(m => actionOf(m) === 'restrict')) return undefined;
  return matches[0];
}
```

Wire into `collectLensParentSideForeignKeyConstraints`:

- Replace the boolean early-return `if (!resolveSlotBasisSource(parentSlot, schemaManager)) return [];`
  with `const basisParent = resolveSlotBasisSource(parentSlot, schemaManager); if (!basisParent) return [];`
  so `basisParent` is available below.
- Inside the per-FK loop, **after** the count-mismatch guard (so `parentLogicalColumns` is
  validated) and **before** building the `NOT EXISTS`, call `lensParentSideForeignKeyRedundant(...)`.
  On a non-`undefined` result, `log(...)` on the `planner:lens-enforcement` channel and
  `continue` (elide). Mirror the child-side log wording, e.g.:
  `log('lens parent-side FK %s on %s: elided — provably subsumed by basis FK %s referencing %s (action restrict; the re-planned basis parent write enforces it)', fk.name ?? '<anon>', parentSlot.logicalTable.name, subsuming.name ?? '<anon>', subsuming.referencedTable);`

Keep all existing guards (single-source-spine gate, action gate on the *logical* FK,
count-mismatch skip) — the elision is an added short-circuit, not a replacement.

### Soundness invariant (carry into the doc-comment, like the child-side)

Every gap returns `undefined`/`[]` ⇒ enforce. A false "redundant" verdict silently drops a
RESTRICT rejection (a soundness hole), so the bias is hard-coded toward double-enforce:
multi-source child, non-plain child/parent column mapping, missing/permuted/partial basis FK,
row-reducing child body, and — the parent-side-only addition — **any** matching basis FK whose
op-appropriate action is not `restrict`.

## Docs

`docs/lens.md` § Constraint Attachment, the parent-side FK paragraph (line ~164, the
`**Live** (parent-side):` sentence and the line-158 maturity blockquote's parent-side clause).
Both currently read "It **double-enforces** by design … a parent-side basis-redundancy
elision is a backlog follow-up." Update to state the elision now ships, gated on the three
structural conditions (read from the child direction) **plus** the action-match requirement
(the subsuming basis FK must itself be `restrict` for the op), defaulting to double-enforce on
any uncertainty — and that the cascade-basis-FK case is exactly why the parent-side elision
needed the extra action gate the child side does not.

## Key tests (TDD — extend `packages/quereus/test/lens-enforcement.spec.ts`)

Add a `describe('lens enforcement: parent-side FK basis-redundancy elision', …)` block,
mirroring the child-side elision block (`spec.ts:481-638`) and reusing the existing helpers
(`slot(db, name)`, `collectLensParentSideForeignKeyConstraints`, `astToString`, `rows`,
`expectThrows`, `RowOpFlag`). Setups declare a **basis** schema that *does* carry the FK
(so `buildParentSideFKChecks` fires) and a **logical** schema that re-declares it — the
inverse of `deployParentFkLens`, which deliberately omits the basis FK.

- **Core elide (DELETE + UPDATE).** Basis child declares `foreign key (pid) references parent(id) on delete restrict on update restrict`;
  logical schema declares the same FK; both parent and child are faithful default single-source
  lenses. Assert `collectLensParentSideForeignKeyConstraints(slot(db,'parent'), sm, RowOpFlag.DELETE)`
  and `…RowOpFlag.UPDATE` both return `[]` (elided). Behaviorally: deleting a *referenced*
  parent still ABORTs (via the basis parent-side FK), an unreferenced parent deletes — i.e. no
  correctness change, only the redundant lens scan dropped.
- **Action mismatch — basis CASCADE ⇒ NOT elided (the headline new caveat).** Basis FK
  `on delete cascade`, logical FK RESTRICT. Assert the collector still emits exactly `1`
  constraint for DELETE (the lens RESTRICT is *not* dropped). Behaviorally: deleting a
  referenced parent ABORTs (the lens check fires) and the children survive — proving the lens
  RESTRICT was retained rather than letting the basis cascade silently delete them.
- **Per-op action read.** Basis FK `on delete restrict on update cascade`. Assert DELETE
  elides (`[]`) but UPDATE does **not** (`length === 1`) — the action gate reads the
  op-appropriate basis action.
- **Basis SET NULL / SET DEFAULT ⇒ NOT elided.** One case (e.g. `on delete set null`) to pin
  that only `restrict` subsumes (parametrizable with the cascade case).
- **No basis FK ⇒ enforce.** The `deployParentFkLens` shape (basis carries no FK): assert the
  collector still emits `1` (no over-elision) — the existing core parent-side test already
  proves enforcement; this adds the explicit "redundancy detector did not fire" assertion.
- **Permuted basis composite FK ⇒ NOT elided.** Composite logical FK `(a,b) → parent(px,py)`;
  basis declares `(a,b) references parent(py,px)` (swapped pairing). Pair-set mismatch ⇒
  emit `1`. Mirror child-side `spec.ts:523`.
- **Row-reducing child body ⇒ NOT elided (conservative gate).** Child lens body has a `where`
  (single-source but filtered) while basis carries the equivalent restrict FK. Assert the
  collector emits `1` (double-enforces) — pins condition 3. A behavioral assertion is optional
  (both checks reject identically here); the unit `length === 1` is the load-bearing one.
- **Rename override still elides.** Parent and/or child use a column rename in the lens body
  but the basis FK is over the basis columns; the mapped pair-set still matches ⇒ `[]`. Mirror
  child-side `spec.ts:586`.
- **Composite restrict basis FK elides.** Composite logical + matching composite basis restrict
  FK ⇒ `[]` for DELETE and UPDATE; deleting/updating a referenced composite key still ABORTs.

## Validation

- `yarn workspace @quereus/quereus test` (the lens-enforcement suite plus full regression) —
  green, no behavioral regressions (elision must not change any ABORT/accept outcome).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean (single-quote globs on Windows).

## TODO

- [ ] Generalize `basisCarriesEquivalentFk` → `matchingBasisFks(...)` returning all matches;
      delegate `basisCarriesEquivalentFk` to `matchingBasisFks(...)[0]` (child-side unchanged).
- [ ] Extract `basisFksSubsuming(..., projectionToCheck: 'parent' | 'child')` shared structural
      core; refactor `lensForeignKeyRedundant` to call it with `'parent'`.
- [ ] Add `lensParentSideForeignKeyRedundant(...)` with the `restrict`-only action-match gate
      (scans **all** matching basis FKs for the op).
- [ ] Wire it into `collectLensParentSideForeignKeyConstraints`: hoist `basisParent`, short-circuit
      + log + `continue` on subsumption, after the count-mismatch guard.
- [ ] Carry the soundness-invariant rationale into the new helpers' doc-comments (mirror the
      child-side detail).
- [ ] Add the test block above.
- [ ] Update the two `docs/lens.md` parent-side passages (lines ~158 and ~164).
- [ ] Run typecheck + lint + the test suite; confirm no behavioral change.
