description: Propagate CASCADE / SET NULL / SET DEFAULT parent-side actions for a logical foreign key through the lens — deleting/updating a lens-backed logical parent cascades (deletes / nulls / defaults) the referencing logical child rows. The action complement to the RESTRICT/NO-ACTION parent-side detection `lens-parent-side-fk-enforcement` shipped. Realized as a runtime cascade walker (the logical dual of `executeForeignKeyActions`) that issues the propagating DML against the logical child *view*, so each cascade re-enters the lens write path and its own constraints fire.
prereq: lens-parent-side-fk-enforcement
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, docs/lens.md
----

## Context

`lens-parent-side-fk-enforcement` (shipped) makes the **parent side** of a logical FK
enforce **RESTRICT / NO ACTION** at the lens boundary: a delete/update of a lens-backed
logical *parent* synthesizes a deferred `NOT EXISTS` over the logical *child* and routes
it through the basis write's per-row constraint pipeline (`collectLensParentSideForeignKeyConstraints`
in `planner/mutation/lens-enforcement.ts`, wired via `view-mutation-builder.ts`'s
`extraConstraints` seam). Its action gate is `action === 'restrict'` only — it deliberately
**detects** an orphaning mutation and rejects it, but propagates no action.

The physical CASCADE / SET NULL / SET DEFAULT machinery lives in
`runtime/foreign-key-actions.ts`:
- `executeForeignKeyActions(db, parentTable, op, oldRow, newRow)` — called from the DML
  executor (`runtime/emit/dml-executor.ts`) after each base-row delete/update. It scans
  every schema's `TableSchema.foreignKeys`, and for each child FK whose op-action is
  `cascade`/`setNull`/`setDefault` issues the propagating DML via
  `db._execWithinTransaction(...)` against the **basis** child table (`executeSingleFKAction`).
- A logical FK lives **only** on the child slot's `enforced-fk` obligation — on *no* basis
  table — so `executeForeignKeyActions` never sees it. When a lens-backed logical parent is
  deleted/updated, the basis op (`y.parent`) runs, but no logical cascade fires: the action
  is silently a no-op, or (when the lens declares RESTRICT) the shipped parent-side detection
  rejects.

This ticket adds the missing **write propagation** for the non-RESTRICT parent-side actions.

## Why a runtime walker (not a plan-time check)

The RESTRICT side rides the plan-time `extraConstraints` seam because a RESTRICT check is a
read (`NOT EXISTS`). A CASCADE is a *write* — it mutates the child rows — so it cannot ride
that seam. Mirroring the physical path, the cleanest realization is a runtime walker that
issues the propagating DML **against the logical child view** (`x.child`), not the basis
child (`y.child`):

- The logical DML re-plans through the lens write substrate (`buildViewMutation`), so each
  cascade re-enters the full lens write path — the child's own row-local checks, child-side
  FK existence checks, set-level checks, **and nested logical cascades** all fire for free,
  exactly as a user-issued `delete from x.child` would.
- Recursion + termination work identically to the physical SQL-issuing path: each cascade is
  a real nested statement (`_execWithinTransaction`), and a cycle terminates by data
  exhaustion (the next level matches no rows once the prior level deleted/re-keyed them) —
  the same way `executeSingleFKAction`'s `_execWithinTransaction` cascades terminate today
  (the `visited` set is unused on that SQL-issuing path; it is load-bearing only for the
  in-process `assertTransitiveRestrictsForParentMutation` walker).

## Architecture

### Trigger point — basis-keyed, alongside the physical walker

The DML executor runs the **basis** op for a lens parent mutation (`tableSchema = y.parent`).
Add `executeLensForeignKeyActions(db, basisParentTable, op, oldRow, newRow)` called
immediately **after** each existing `executeForeignKeyActions(...)` call site in
`dml-executor.ts` (the primary delete/update paths in `processDeleteRow` / `processUpdateRow`,
plus the REPLACE `replacedRow` and `processEvictions` delete paths, for parity — wherever a
basis row delete/update fires physical FK actions, the logical dual fires too). Consider a
thin combined wrapper (`executeForeignKeyActionsAndLens`) replacing the bare
`executeForeignKeyActions` calls to keep the two from drifting; or add the second call
inline. The function is a no-op (early return) when `foreign_keys` is off or no lens slot is
backed by `basisParentTable`, so non-lens DML pays one cheap scan over lens slots (most DBs
have none).

`executeLensForeignKeyActions` (in `runtime/foreign-key-actions.ts`):

1. Gate on `foreign_keys` (mirror `executeForeignKeyActions`).
2. **Reverse-map basis → logical parent slots:** iterate `db.schemaManager._getAllSchemas()`
   × `schema.getAllLensSlots()`, keep slots whose `resolveSlotBasisSource(slot, sm)` is
   `basisParentTable` (schema + name match). These are the logical parents backed by this
   basis table (usually 0 or 1). A slot with no single basis spine never matches — the
   documented single-source-spine boundary, identical to the RESTRICT collector.
3. For each parent slot, discover referencing logical FKs via the shared cross-slot helper
   (below), filter to op-action ∈ {`cascade`, `setNull`, `setDefault`}.
4. **Elision (compose with the physical walker):** skip the lens cascade when the basis child
   already carries a structurally-equivalent FK referencing the basis parent (`mappedFkBasisPairs`
   + `matchingBasisFks` — the same structural core the redundancy detector uses, *without* the
   non-row-reducing projection gate, which is a RESTRICT-side conservatism). When such a basis
   FK exists, the physical `executeForeignKeyActions` already propagates over the basis, and
   the logical view reflects it — firing the lens cascade on top would be redundant (same
   action) or double-mutating (divergent action). The basis governs in that configuration;
   the divergent-action sub-case is a documented limitation (see backlog ticket below).
5. **MATCH SIMPLE / short-circuit (mirror physical):** read the parent's referenced values
   from the basis row — map each logical referenced column → basis column
   (`logicalToBasisColumnMap(parentSlot)`) → basis index (`basisParentTable.columnIndexMap`)
   → value from `oldRow` (and `newRow` for update). Skip if any OLD value is NULL. For UPDATE,
   skip if no referenced parent column changed (`sqlValuesEqual` over the basis indices).
6. **Issue the propagating DML against the logical child view** (the logical dual of
   `executeSingleFKAction`), using the *logical* child schema/table/column names and binding
   the OLD parent values (and NEW for cascade-update):
   - `cascade` + delete → `delete from <childLogicalSchema>.<childLogicalTable> where <childLogicalCol> = ? …`
   - `cascade` + update → `update <childLogical> set <childLogicalCol> = ? … where <childLogicalCol> = ? …`
     (NEW parent values in SET, OLD in WHERE)
   - `setNull` → `update <childLogical> set <childLogicalCol> = null … where <childLogicalCol> = ? …`
   - `setDefault` → `update <childLogical> set <childLogicalCol> = (<logical child column default>) … where …`
     — the default is the **logical** child column's `defaultValue` AST
     (`childSlot.logicalTable.columns[fk.columns[i]].defaultValue`, `expressionToString`, else NULL).

   Bind values as parameters; do **not** inline. Quote logical identifiers (`quoteIdentifier`).
   The schema prefix is needed when the logical schema is not `main`.

### Shared cross-slot discovery — extract to `schema/lens-fk-discovery.ts`

The cross-slot scan (walk every schema's lens slots, find each child slot whose `enforced-fk`
obligation references a given parent slot's logical table, resolve the logical child + parent
referenced column names) is currently inline in `collectLensParentSideForeignKeyConstraints`.
The runtime walker needs the *same* discovery. To keep it DRY **and** respect layering
(runtime and planner both sit above `schema/`), extract the catalog-only pieces into a new
`schema/lens-fk-discovery.ts`:

- `logicalToBasisColumnMap(slot)` — moved from `lens-enforcement.ts` (pure catalog read of
  `columnProvenance` × `compiledBody.columns`).
- `resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager)` — moved.
- `pairKey`, `mappedFkBasisPairs`, `matchingBasisFks` — moved (catalog-only structural
  equivalence; needed by both the RESTRICT redundancy detector and the cascade elision).
- **New** `findLogicalParentFkRefs(parentSlot, schemaManager)`:
  ```ts
  interface LogicalParentFkRef {
    childSlot: LensSlot;
    fk: ForeignKeyConstraintSchema;
    childLogicalColumns: string[];   // child FK column logical names
    parentLogicalColumns: string[];  // parent referenced column logical names
  }
  ```
  Returns every logical FK (on any lens slot in any schema) that references `parentSlot`'s
  logical table (name + resolved schema, case-insensitive), with the count-mismatch guard the
  RESTRICT collector already applies (skip when `parentLogicalColumns.length !== fk.columns.length`).
  Does **not** apply an action gate — callers filter (`restrict` for the RESTRICT collector,
  `cascade`/`setNull`/`setDefault` for the cascade walker).

`lens-enforcement.ts` then imports these from the new module (deleting its private copies),
and `collectLensParentSideForeignKeyConstraints` / `lensParentSideForeignKeyRedundant` /
`basisFksSubsuming` reuse `findLogicalParentFkRefs` + the moved helpers — a behavior-preserving
refactor. `resolveSlotBasisSource` and `isNonRowReducingProjection` stay where they are
(`lens-prover.ts` and `lens-enforcement.ts` respectively; the projection gate is RESTRICT-side
only).

## Composition / cycle detection

- **No double-cascade:** the elision step skips the lens cascade exactly when the basis path
  propagates over an equivalent basis FK. Where only the logical FK carries the action (the
  canonical lens shape — basis is action-free, as in `deployParentFkLens`), only the lens
  cascade fires.
- **Cycle termination:** identical to the physical SQL-issuing path — each cascade is a nested
  statement and a cycle terminates by data exhaustion. A mixed logical/basis FK cycle composes
  because both walkers fire from the same nested statements. Validate (test) that a mixed cycle
  does not double-delete and terminates.

## Boundaries (v1)

- **Single-source-spine parent** only (the parent slot must resolve to one basis table) — the
  same boundary the RESTRICT side carries. A multi-source / decomposition parent fires no lens
  cascade (the reverse-map step finds no matching single-basis slot).
- **Divergent basis-vs-lens parent-side action over the same equivalent columns** (e.g. basis
  `on delete cascade` under a logical `on delete set null`, or a basis RESTRICT that aborts the
  parent before any logical cascade can run) is **out of scope** — the basis action governs,
  documented as a limitation. Filed as `lens-parent-side-fk-divergent-basis-action` (backlog).
  This is the same family as the in-flight fix `lens-parent-side-fk-cascade-basis-restrict-lens-not-enforced`
  (lens RESTRICT over basis non-RESTRICT) — orthogonal to this ticket's elision logic; do not
  attempt to solve it here.
- The child of a cascade may be any **writable** logical table; the cascade DML goes through
  the ordinary view-mutation write path and errors exactly as a user-issued DML would if that
  path cannot honor it (e.g. an unsupported multi-source child delete).

## Key tests (TDD targets)

Behavioral (sqllogic or `lens-enforcement.spec.ts`), each over the canonical
`deployParentFkLens`-style shape (basis carries **no** FK; the action lives only on the
logical FK), with `pragma foreign_keys = true`:

- **CASCADE DELETE** — logical FK `on delete cascade`; `delete from x.parent where id = 1`
  ⇒ referencing `x.child` rows gone (`select count(*) from x.child` → 0); the parent gone.
- **CASCADE UPDATE** — logical FK `on update cascade`; `update x.parent set id = 9 …`
  ⇒ child FK column rewritten to `9` (child row preserved, `pid = 9`).
- **SET NULL** — `on delete set null` (and the update analogue) ⇒ child FK column nulled,
  child row preserved.
- **SET DEFAULT** — child logical FK column declares a default (e.g. `pid integer default 0`);
  `on delete set default` ⇒ child FK column set to `0`.
- **MATCH SIMPLE** — a NULL parent referenced value ⇒ no cascade.
- **UPDATE short-circuit** — updating a non-referenced parent column ⇒ no cascade (child
  untouched).
- **Transitive** — `x.parent` → `x.child` (cascade) → `x.grandchild` (cascade); deleting the
  parent cascades all the way (all three logical levels empty).
- **Re-enters the lens write path** — the logical child carries its own constraint (a
  row-local `check`, or a child-side FK to another logical parent); a cascade-update that would
  violate it ABORTs (proves the cascade rides the lens write path, not a basis-direct write).
- **Elision / no double-cascade** — basis *also* carries the equivalent CASCADE FK: deleting
  the parent removes the children exactly once (count is exact, no error); end state correct.
- **Pragma gate** — `foreign_keys = false` ⇒ no lens cascade.
- **Multi-source parent** — documented no-op (no lens cascade; delete/update of the
  multi-source parent does not throw a planner error).
- **Mixed cycle** — a logical+basis FK cycle terminates and does not double-delete.

Unit (collector/discovery, mirroring the existing `collectLensParentSideForeignKeyConstraints`
unit tests): `findLogicalParentFkRefs` returns the expected child refs for a referenced parent
slot and `[]` for a non-referenced one; the cascade elision predicate fires iff an equivalent
basis FK exists.

## Validation

- `yarn workspace @quereus/quereus run build` (tsc exit 0).
- `yarn test` (full suite green; stream with `tee` per AGENTS.md).
- Lint (`eslint`, single-quoted globs on Windows).

## TODO

### Phase 1 — extract shared discovery (behavior-preserving)
- Create `packages/quereus/src/schema/lens-fk-discovery.ts`; move `logicalToBasisColumnMap`,
  `resolveLogicalReferencedColumns`, `pairKey`, `mappedFkBasisPairs`, `matchingBasisFks` from
  `lens-enforcement.ts`; add `findLogicalParentFkRefs(parentSlot, schemaManager)` +
  `LogicalParentFkRef`.
- Re-point `lens-enforcement.ts` imports; refactor `collectLensParentSideForeignKeyConstraints`
  (and the child-side collectors / redundancy detectors as needed) to consume the moved helpers
  + `findLogicalParentFkRefs`. Confirm the existing `lens-enforcement.spec.ts` suite stays green
  (pure refactor).

### Phase 2 — runtime cascade walker
- Add `executeLensForeignKeyActions(db, basisParentTable, operation, oldRow, newRow)` to
  `runtime/foreign-key-actions.ts`: reverse-map basis→logical parent slots, discover + filter
  (`cascade`/`setNull`/`setDefault`), elide when an equivalent basis FK exists, apply
  MATCH SIMPLE + UPDATE short-circuit, and issue the logical-child DML.
- Add the logical-child action issuer (the dual of `executeSingleFKAction`, targeting the
  logical view + logical column names + logical default).

### Phase 3 — wire into the DML executor
- Call `executeLensForeignKeyActions` after every `executeForeignKeyActions` call in
  `runtime/emit/dml-executor.ts` (primary delete/update; replacedRow; evictions), ideally via a
  combined wrapper so the sites cannot drift.

### Phase 4 — tests + docs
- Add the behavioral + unit tests above.
- Update `docs/lens.md` § Constraint Attachment: the parent-side paragraph currently says
  "**CASCADE / SET NULL / SET DEFAULT** parent-side actions through the lens remain out of
  scope (backlog)" — replace with the shipped behavior (runtime cascade walker against the
  logical child view, elision composing with the physical walker, single-source-spine +
  divergent-action limitations). Update the `collectLensParentSideForeignKeyConstraints` and
  the maturity-banner doc comments in `lens-enforcement.ts` that say cascades are out of scope.
- Run build + full test + lint; if a failure is plainly pre-existing/unrelated, follow the
  `.pre-existing-error.md` flag procedure.
