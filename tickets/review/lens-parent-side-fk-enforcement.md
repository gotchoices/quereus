description: Review the parent-side logical-FK RESTRICT/NO-ACTION enforcement at the lens write boundary — a delete/update through a lens-backed logical *parent* now runs a deferred `NOT EXISTS` existence check against the logical *child*, the cross-slot dual of the shipped child-side check. RESTRICT-only, DELETE + UPDATE; CASCADE/SET-NULL/SET-DEFAULT and parent-side redundancy elision are parked in backlog.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The parent side of a logical foreign key now enforces **RESTRICT / NO ACTION** on
**DELETE and UPDATE** through the lens — the exact mirror of the already-shipped
child-side existence check (`lens-fk-enforcement-wiring`). A delete/update of a
lens-backed logical *parent* synthesizes a deferred `NOT EXISTS` over the logical
*child* and routes it through the basis write's per-row constraint pipeline, so an
orphaning parent mutation ABORTs at commit even when the basis carries no FK.

### Implementation map (the diff is 4 source files + tests + docs)

1. **Synthesis seam** (`foreign-key-builder.ts`) — new exported
   `synthesizeFKNotExistsExpr(childTableName, childColumns, parentColumns, qualifier, fromSchema?)`,
   the `NOT EXISTS` dual of `synthesizeFKExistsExpr`, built on the shared
   `synthesizeFKSubquery` (which already takes `fromSchema`). The private physical
   `synthesizeNotExistsCheck` was **refactored to delegate** to it (passing no
   `fromSchema`), so `NOT EXISTS` synthesis lives in exactly one place.

2. **Cross-slot collector** (`lens-enforcement.ts`) —
   `collectLensParentSideForeignKeyConstraints(parentSlot, schemaManager, operation)`.
   This is the crux: the physical `buildParentSideFKChecks` finds FKs by scanning
   basis `TableSchema.foreignKeys`; a logical FK lives only on the *child* slot's
   `enforced-fk` obligation (on no basis table), so the collector walks
   `_getAllSchemas()` → `getAllLensSlots()` and, for each child slot whose FK
   references this `parentSlot`'s logical table (name + resolved schema,
   case-insensitive), emits one constraint **iff** `action === 'restrict'` on the
   op-appropriate `onDelete`/`onUpdate` — matching `buildParentSideFKChecks`'s gate
   exactly.
   - FROM is the **schema-qualified logical child**; child columns stay **logical**
     (resolve against the registered logical child view).
   - The parent's referenced columns are rewritten **logical→basis** via the
     *parent* slot's `logicalToBasisColumnMap` (reusing `resolveLogicalReferencedColumns`)
     for the `OLD.*`/`NEW.*` correlation side.
   - **DELETE** → plain `NOT EXISTS`, `operations: DELETE`.
   - **UPDATE** → `(OLD.p = NEW.p …) or <NOT EXISTS>`, `operations: UPDATE`
     (`buildParentSideUpdateGuard`) — reproduces the physical UPDATE short-circuit.
   - Tagged `LENS_BOUNDARY_ATTACHED_TAG`; the contained `EXISTS` auto-defers it to
     commit (same as the child side).

3. **Wiring** (`view-mutation-builder.ts` + `delete.ts`) —
   `lensParentSideForeignKeyConstraints(ctx, view, operation)` (pragma-gated on
   `foreign_keys`, resolves the *target* view's slot = the parent). Composed into
   `extraConstraints`: the **sole** extra for a `delete`, and appended (UPDATE-masked)
   to the row-local/child-FK/set-level list for `update`. `buildDeleteStmt` gained an
   `additionalConstraints = []` param threaded to its `buildConstraintChecks` call,
   and `buildBaseOp`'s delete case now forwards `extraConstraints` (previously a
   delete passed none).

## How to validate / key use cases (tests added — `test/lens-enforcement.spec.ts`, new describe block)

All run on a fresh `Database` through the full `declare/apply schema` pipeline.

- **Core gap (DELETE).** Basis `y` has no FK; logical `x.child fk(pid) references parent(id)`.
  Delete a *referenced* parent ⇒ ABORT; delete an *unreferenced* parent ⇒ succeeds.
- **UPDATE orphaning.** Re-keying the referenced parent key (id 1→99) while a child
  references it ⇒ ABORT.
- **Short-circuit guard (the correctness test, not just perf).** Updating a
  *non-referenced* parent column (`name`) while a child references the unchanged key ⇒
  **succeeds**. A plain `NOT EXISTS` over OLD would wrongly reject this.
- **Composite FK.** `references parent(px, py)`: delete/update of the referenced
  composite key ⇒ ABORT; unreferenced ⇒ succeeds.
- **Rename override on the parent.** Logical `id` ← basis `parent_id`; the `OLD.<basis>`
  rewrite resolves and enforcement holds (asserts `astToString` correlates on `parent_id`).
- **Pragma gate.** `pragma foreign_keys = false` ⇒ deleting a referenced parent is
  accepted (no parent-side enforcement).
- **Multi-source parent (documented no-op).** Parent maps to a two-table inner join ⇒
  collector returns `[]` for both ops; a delete/update does not throw a planner error.
- **Unit (collector shape).** Returns one boundary-tagged constraint with the correct
  `operations` mask and an `astToString` that is `NOT EXISTS` over the qualified logical
  child with `OLD.<basisParentCol>` correlation (and, for UPDATE, the `OLD.p = NEW.p … or`
  guard). Non-referenced parent ⇒ `[]`.
- **Composition.** Child-side and parent-side both enforce on the same schema.

### Validation run

- `yarn workspace @quereus/quereus run build` → exit 0 (clean `tsc`).
- Full suite (`node test-runner.mjs`) → **4260 passing, 9 pending, 0 failing** (10 new
  parent-side tests among them).
- `yarn run lint` → exit 0.

## Honest gaps / things for the reviewer to scrutinize

- **UPDATE guard NULL edge case — a genuine soundness gap vs physical RESTRICT, and a
  discrepancy with the source ticket's own truth table.** The guard uses plain `=`
  (the ticket explicitly mandated this and forbade null-safe `IS`). Consider a
  **nullable** referenced parent key (e.g. `references parent(email)` where `email` is
  a nullable unique column) updated **value→NULL** while a child references the old
  value:
  - guard `OLD.email = NEW.email` = `'a@x' = NULL` = **NULL**;
  - `NULL or <false NOT EXISTS>` = **NULL**;
  - the deferred check fails only on `value === false || value === 0`, so **NULL
    passes** ⇒ the orphaning update is **allowed**, whereas physical RESTRICT (which
    runs the NOT EXISTS because the column changed) would **reject** it.

  The source ticket's UPDATE truth table labels this row "may reject", but that is
  inconsistent with the ticket's own DELETE reasoning (which relies on `NULL or false
  = NULL = pass` to justify op-specific synthesis). The implementation follows the
  ticket's mandated plain-`=` design; this rare transition (nulling out a *nullable*
  referenced key while a child still references the prior value) is therefore a
  documented v1 divergence, **not** covered by a test (a test would assert the gap
  behavior). For a PK-referenced FK it is unreachable (PKs are NOT NULL). Reviewer
  decision: accept as a documented v1 limitation, or file a follow-up to make the
  guard `IS NOT DISTINCT FROM`-equivalent without a general `IS` operator.

- **Single-source-spine gate lives in the collector, not the wiring.** The ticket's
  prose described the collector without a single-source gate and put "multi-source
  parent routes nothing" only in Boundaries. I implemented the gate **inside the
  collector** (`if (!resolveSlotBasisSource(parentSlot, schemaManager)) return []`) —
  the most self-contained and directly-testable place, symmetric with the child-side
  redundancy detector's use of `resolveSlotBasisSource`. This is why the multi-source
  test asserts the collector returns `[]` directly. If the reviewer prefers the gate
  in the wiring (`lensParentSideForeignKeyConstraints`), it is a one-line move.

- **Multi-source DELETE ambiguity is orthogonal.** A two-table no-FK join delete is
  rejected upstream as `delete-ambiguous` (pre-existing multi-source behavior). The
  multi-source-parent test deliberately adds a basis FK between the join sides so the
  delete routes unambiguously; the "does not throw" assertion exercises our gate, not
  multi-source delete semantics.

- **Deferred timing (accepted v1).** Like the child side, the synthesized `NOT EXISTS`
  contains an `EXISTS`, so `constraint-builder.ts`'s `containsSubquery` auto-defers it
  to commit — unlike physical parent-side RESTRICT, which is immediate. Same ABORT
  outcome at commit; no `deferrable`/`needsDeferred` flags set on the routed
  `RowConstraintSchema` (it rides the auto-defer path). Worth confirming this is
  acceptable for parent-side as it already is for child-side.

- **Double-enforcement is intentional.** When the basis parent also carries an
  equivalent parent-side FK, both fire (sound — both reject the same condition). The
  parent-side redundancy elision is parked in
  `tickets/backlog/lens-parent-side-fk-basis-redundancy-elision.md` (which also flags
  the RESTRICT-logical-vs-CASCADE-basis action-mismatch caveat).

- **Runtime defense-in-depth untouched (by design).** `runtime/foreign-key-actions.ts`
  (`assertNoRestrictedChildrenForParentMutation` / `assertTransitiveRestricts…`) scans
  basis `foreignKeys` only and does not see logical FKs — exactly as the child-side
  relies solely on its synthesized plan-time check. Not extended in this ticket.

## Out of scope (parked in backlog)

- `tickets/backlog/lens-parent-side-fk-cascade-actions.md` — CASCADE / SET NULL / SET
  DEFAULT parent-side propagation through the lens.
- `tickets/backlog/lens-parent-side-fk-basis-redundancy-elision.md` — elide the
  lens-level parent-side check when the basis parent write provably already enforces an
  equivalent (action-compatible) parent-side FK.

Both already existed (created at plan stage) and were verified adequate; no edits made.
