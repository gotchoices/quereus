description: Enforce the parent side of a logical foreign key at the lens write boundary — a delete/update through a lens-backed logical *parent* runs the RESTRICT existence check against the logical *child* relation, symmetric to the shipped child-side existence check. RESTRICT/NO-ACTION detection only (DELETE + UPDATE); CASCADE/SET NULL/SET DEFAULT and basis-redundancy elision are parked in backlog.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Context & what already ships

`lens-fk-enforcement-wiring` made a logical FK's **child-side** existence check live
at the lens boundary: `collectLensForeignKeyConstraints` (in
`planner/mutation/lens-enforcement.ts`) reads each `enforced-fk` obligation off the
**child** slot, synthesizes a MATCH SIMPLE-guarded `EXISTS` against the
schema-qualified logical parent (child NEW columns rewritten to basis terms, parent
columns left logical), tags it `LENS_BOUNDARY_ATTACHED_TAG`, and routes it through
the basis write's `extraConstraints` seam. The contained `EXISTS` auto-defers it to
commit. It is wired in `view-mutation-builder.ts` via `lensForeignKeyConstraints`,
gated on the `foreign_keys` pragma, for `insert`/`update` only.

The **parent side** is unenforced through the lens. The physical parent-side
machinery — `buildParentSideFKChecks` (`foreign-key-builder.ts`, a `NOT EXISTS` over
the child for RESTRICT) and `runtime/foreign-key-actions.ts` (cascades) — both
discover FKs by scanning declared `TableSchema.foreignKeys` on **basis** tables. A
logical FK lives only on the logical child slot's `obligations`, on no basis table,
so a delete/update of a logical *parent* through the lens runs no parent-side check
and can orphan logical child rows.

This ticket closes that gap for **RESTRICT/NO ACTION** on **DELETE and UPDATE** — the
minimum-viable parent-side guarantee and exact mirror of the child-side. Cascades and
the parent-side redundancy-elision optimization are explicitly out of scope (see
Boundaries).

## Design

### 1. Cross-slot discovery (the crux)

Parent-side enforcement must find logical FKs declared on **other** logical slots that
**reference this** slot's logical table — the dual of how `buildParentSideFKChecks`
scans every schema for basis tables referencing the physical parent. A new collector:

```
collectLensParentSideForeignKeyConstraints(
  parentSlot: LensSlot,
  schemaManager: SchemaManager,
  operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
): RowConstraintSchema[]
```

walks `schemaManager._getAllSchemas()` → `schema.getAllLensSlots()`; for each *child*
slot it scans `childSlot.obligations` for `kind === 'enforced-fk'`, and for each FK
whose `referencedTable` + resolved `referencedSchema` (default
`childSlot.logicalTable.schemaName`) match `parentSlot.logicalTable` (name +
schemaName, case-insensitive) it emits one parent-side constraint — **iff** the
operation-appropriate action gates it (below). Discovering via the child slot's
`enforced-fk` obligations (not raw basis `foreignKeys`) is the precise mirror of the
child-side collector and reuses the prover's classification.

Action gate: `const action = operation === RowOpFlag.DELETE ? fk.onDelete :
fk.onUpdate;` then emit only when `action === 'restrict'` — **match
`buildParentSideFKChecks`'s gate exactly** (it emits for `'restrict'`; cascades are
handled elsewhere). NO ACTION parity therefore follows whatever the physical builder
does today; do not diverge.

### 2. Synthesis — reuse the shared `synthesizeFKSubquery` seam

The parent-side check is `NOT EXISTS(SELECT 1 FROM <childLogical> WHERE
<child>.<childCol_i> = OLD.<parentBasisCol_i> …)`:

- **FROM** is the **logical child** relation, **schema-qualified** by the child slot's
  logical schema (so it resolves to the registered logical view regardless of the
  basis search path the routed constraint is built under — same trick the child-side
  `EXISTS` uses for the parent). Child columns stay **logical** names.
- **OLD side** references the **parent basis** row being deleted/updated, so the
  parent's referenced columns are rewritten **logical → basis** via the *parent*
  slot's `logicalToBasisColumnMap` (the mirror of how the child-side rewrites NEW
  child columns). Resolve the parent's logical referenced column names by reusing the
  existing `resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager)`
  (prefers `fk.referencedColumnNames`, falls back to the parent logical PK), then map
  each via `parentSlot`'s map (`map.get(name) ?? name`, matching the child-side
  fallback).

Add a shared exported synthesizer to `foreign-key-builder.ts`, the `NOT EXISTS` dual
of `synthesizeFKExistsExpr`:

```
synthesizeFKNotExistsExpr(
  childTableName: string,
  childColumns: readonly string[],
  parentColumns: readonly string[],
  qualifier: 'OLD' | 'NEW',
  fromSchema?: string,
): AST.UnaryExpr   // NOT ( EXISTS(SELECT 1 FROM [fromSchema.]child WHERE child.c = <q>.p …) )
```

built on the existing `synthesizeFKSubquery` (already takes `fromSchema`). Refactor
the private `synthesizeNotExistsCheck` to delegate to it (physical path passes no
`fromSchema`, child/parent names off the `TableSchema`s) so the `NOT EXISTS` synthesis
lives in exactly one place — the ticket's explicit instruction.

### 3. DELETE vs UPDATE — the no-change short-circuit

- **DELETE** → plain `NOT EXISTS(... = OLD.parentBasis ...)`, `operations: DELETE`.
  A NULL OLD parent value makes `child.fk = OLD.p` never true ⇒ `NOT EXISTS` true ⇒
  passes (MATCH SIMPLE), no null-guard needed.

- **UPDATE** → `( (OLD.p1 = NEW.p1 and OLD.p2 = NEW.p2 …) or <NOT EXISTS over OLD> )`,
  `operations: UPDATE`. The guard reproduces the physical UPDATE short-circuit
  (`emit/constraint-check.ts` skips the parent-side `NOT EXISTS` when no referenced
  parent column changed) — **a correctness requirement, not just perf**: a plain
  `NOT EXISTS` over OLD values would reject a benign update that does not touch the
  referenced columns but whose key a child still references. Plain `=` suffices (no
  null-safe `IS` — which is not a general scalar operator here): every NULL case
  falls through to the `NOT EXISTS`, which itself passes for a NULL OLD key. Verify
  the truth table against the physical `sqlValuesEqual` short-circuit:
  - all referenced cols unchanged & non-null → guard true → pass (skip), matches physical.
  - any col changed (non-null→different) → guard false → `NOT EXISTS` runs.
  - col NULL→NULL → guard NULL → `NOT EXISTS` over NULL OLD → passes (physical skips → passes).
  - OLD NULL→value → guard NULL → `NOT EXISTS` over NULL OLD → passes (physical skips → passes).
  - OLD value→NULL → guard NULL → `NOT EXISTS` over the OLD value → may reject (physical runs → may reject).

  Do **not** add the guard to the DELETE form: for DELETE, NEW is all-NULL so `OLD =
  NEW` is NULL, and `NULL or <false NOT EXISTS>` evaluates to NULL, which the
  deferred-constraint check (`value === false || value === 0`) would **not** treat as
  a failure — silently dropping a valid RESTRICT rejection. Op-specific synthesis
  avoids this.

### 4. Wiring — thread the parent-side constraints onto the base op (DELETE too)

`view-mutation-builder.ts` currently builds `extraConstraints` for non-delete ops
only, and `buildBaseOp`'s `delete` case passes none — `buildDeleteStmt` has no
`additionalConstraints` param. Parent-side fires on DELETE and UPDATE, so:

- Add `lensParentSideForeignKeyConstraints(ctx, view, operation)` — resolves the
  **target** view's slot (the parent) and calls the new collector; gated on
  `ctx.db.options.getBooleanOption('foreign_keys')`, mirroring
  `lensForeignKeyConstraints`. Returns `[]` for a plain view / non-referenced parent.
- In `buildViewMutation`, compose `extraConstraints` as:
  - `delete` → `lensParentSideForeignKeyConstraints(ctx, view, RowOpFlag.DELETE)`
  - else → the existing row-local + child-FK + set-level list **plus**
    `lensParentSideForeignKeyConstraints(ctx, view, RowOpFlag.UPDATE)`.
  (The `operations` mask + `shouldCheckConstraint` already partition INSERT vs UPDATE
  vs DELETE, so merging a UPDATE-masked parent-side constraint into the shared update
  list is safe.)
- Thread `extraConstraints` into the delete base op: `buildBaseOp`'s `delete` case →
  `buildDeleteStmt(ctx, op.statement, extraConstraints)`; add an
  `additionalConstraints: ReadonlyArray<RowConstraintSchema> = []` param to
  `buildDeleteStmt` and forward it as the trailing arg of its `buildConstraintChecks`
  call (which already accepts `additionalConstraints`).

### 5. Timing & deferral

The synthesized `NOT EXISTS` contains an `EXISTS`, so `constraint-builder.ts`'s
`containsSubquery` auto-defers it to commit — like the lens child-side `EXISTS`, and
unlike the physical parent-side RESTRICT (immediate). This is the accepted v1 timing
(identical ABORT outcome at commit; symmetric with the already-shipped child-side).
No `deferrable`/`needsDeferred` flags are set on the routed `RowConstraintSchema` — it
rides the auto-defer path, the same as every other lens-routed constraint.

## Boundaries (document, park, or note)

- **Single-source spine.** The parent-side constraint rides the parent's basis base
  op, so the parent must be the single-source spine (its `OLD.*` is one basis row). A
  multi-source / decomposition parent routes nothing extra (same limitation the
  child-side and row-local classes carry). The child *relation* in the FROM is read as
  an ordinary logical view, so it may be any readable lens. Document; assert a
  multi-source parent does not crash.
- **CASCADE / SET NULL / SET DEFAULT** through the lens → parked in
  `tickets/backlog/lens-parent-side-fk-cascade-actions.md`.
- **Parent-side basis-redundancy elision** (don't double-enforce when the basis parent
  side already enforces an equivalent FK) → parked in
  `tickets/backlog/lens-parent-side-fk-basis-redundancy-elision.md`. v1 **double-enforces**
  (sound: both reject the same condition). One caveat to capture there: a logical FK
  declaring RESTRICT whose **basis** FK declares CASCADE would have the basis re-plan
  cascade-delete children while the lens RESTRICT rejects — a logical/basis
  declaration mismatch, acceptable for v1, resolved by the elision pass.
- **Runtime defense-in-depth.** `runtime/foreign-key-actions.ts`
  (`assertNoRestrictedChildrenForParentMutation` / `assertTransitiveRestricts…`) scans
  basis `foreignKeys` only and will not see logical FKs — exactly as the lens
  child-side relies solely on its synthesized plan-time `EXISTS`. The lens parent-side
  relies solely on the synthesized plan-time `NOT EXISTS`. Note, do not extend the
  runtime walker in this ticket.

## Key tests (TDD — `test/lens-enforcement.spec.ts`)

Mirror the existing suite's harness (`declare schema y …; apply schema y; declare
logical schema x …; apply schema x;` fresh `Database` per case; `slot(db, name)`;
`expectThrows`). Expected outcomes:

- **DELETE RESTRICT, basis has no FK.** Logical `x.child fk(pid) references parent(id)`,
  basis `y` carries no FK. Insert a referencing child, then `delete from x.parent
  where id = …` ⇒ ABORT (`/constraint|foreign|fk_/i`). A `delete` of an *unreferenced*
  parent row succeeds.
- **UPDATE of the referenced key orphaning a child** ⇒ ABORT.
- **UPDATE of a non-referenced parent column** (referenced key unchanged) while a
  child references it ⇒ **succeeds** (the short-circuit guard). This is the test that
  pins correctness, not just perf.
- **Composite FK** parent-side (`references parent(px, py)`): delete/update of the
  composite key ⇒ ABORT when referenced.
- **Rename override on the parent** (logical→basis parent column rename): the
  `OLD.<basis>` rewrite still resolves and enforcement holds.
- **`pragma foreign_keys = off`** ⇒ no parent-side enforcement (the wiring gate).
- **Multi-source parent** ⇒ documented no-op; assert delete/update does not throw a
  planner error.
- **Unit `collectLensParentSideForeignKeyConstraints`**: for a referenced logical
  parent it returns one `RowConstraintSchema` tagged `LENS_BOUNDARY_ATTACHED_TAG`,
  with the correct `operations` mask (DELETE / UPDATE per the `operation` arg) and an
  `astToString(expr)` that is a `NOT EXISTS` over the schema-qualified logical child
  with `OLD.<basisParentCol>` correlation (and, for UPDATE, the `OLD.p = NEW.p … or`
  guard). For a non-referenced parent / `off`-pragma it returns `[]`.

## Docs

Update `docs/lens.md` § Constraint Attachment to flip the now-stale "Parent-side FK
actions through the lens are out of scope" — present in **two** places: the maturity
blockquote (~line 152) and the **Foreign key** bullet (~line 158). State that
parent-side **RESTRICT/NO ACTION** on DELETE+UPDATE is now live
(`collectLensParentSideForeignKeyConstraints`, the cross-slot discovery dual of
`buildParentSideFKChecks`), auto-deferred to commit, gated on `foreign_keys`,
double-enforcing pending the parent-side redundancy ticket; **CASCADE/SET NULL/SET
DEFAULT remain out of scope** (backlog). Keep prose-only, no summary doc.

## TODO

### Phase 1 — synthesis seam
- [ ] Add `synthesizeFKNotExistsExpr(childTableName, childColumns, parentColumns, qualifier, fromSchema?)` to `foreign-key-builder.ts` (NOT EXISTS via `synthesizeFKSubquery`, `fromSchema`-qualified).
- [ ] Refactor private `synthesizeNotExistsCheck` to delegate to it (physical path: no `fromSchema`).

### Phase 2 — collector
- [ ] Add `collectLensParentSideForeignKeyConstraints(parentSlot, schemaManager, operation)` to `lens-enforcement.ts`: cross-slot discovery over `getAllLensSlots()` × `enforced-fk` obligations, action gate `=== 'restrict'`, parent referenced cols via `resolveLogicalReferencedColumns` mapped to basis through the parent slot's `logicalToBasisColumnMap`, child cols logical.
- [ ] DELETE form: plain `NOT EXISTS`, `operations: DELETE`. UPDATE form: `(AND OLD.p=NEW.p) or NOT EXISTS`, `operations: UPDATE`. Tag both `LENS_BOUNDARY_ATTACHED_TAG`.

### Phase 3 — wiring
- [ ] `view-mutation-builder.ts`: add `lensParentSideForeignKeyConstraints(ctx, view, operation)` (pragma-gated, resolves target slot); include it in the `delete` and `update` `extraConstraints`.
- [ ] Thread `extraConstraints` into the DELETE base op: `buildBaseOp` delete case + new `additionalConstraints` param on `buildDeleteStmt` → forward to `buildConstraintChecks`.

### Phase 4 — tests + docs
- [ ] Add the parent-side cases above to `test/lens-enforcement.spec.ts`.
- [ ] Update `docs/lens.md` (both out-of-scope mentions).
- [ ] Create the two backlog tickets (cascade actions; parent-side redundancy elision).

### Validation
- [ ] `yarn workspace @quereus/quereus run build`
- [ ] `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens-parent.log; tail -n 80 /tmp/lens-parent.log` (stream; do not silently redirect).
- [ ] Lint (single-quote globs on Windows).
