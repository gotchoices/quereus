description: Parent-side logical-FK RESTRICT/NO-ACTION enforcement at the lens write boundary — a delete/update through a lens-backed logical *parent* runs a deferred `NOT EXISTS` existence check against the logical *child* (the cross-slot dual of the shipped child-side check). RESTRICT-only, DELETE + UPDATE; CASCADE/SET-NULL/SET-DEFAULT and parent-side redundancy elision parked in plan/. Reviewed and completed.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The parent side of a logical foreign key now enforces **RESTRICT / NO ACTION** on **DELETE and
UPDATE** through the lens — the mirror of the child-side existence check. A delete/update of a
lens-backed logical *parent* synthesizes a deferred `NOT EXISTS` over the logical *child* and
routes it through the basis write's per-row constraint pipeline, so an orphaning parent mutation
ABORTs at commit even when the basis carries no FK.

Implementation (4 source files + tests + docs):

- `foreign-key-builder.ts` — new exported `synthesizeFKNotExistsExpr(...)`, the `NOT EXISTS`
  dual of `synthesizeFKExistsExpr` built on the shared `synthesizeFKSubquery`. The private
  physical `synthesizeNotExistsCheck` was refactored to delegate to it (DRY — single synthesis site).
- `lens-enforcement.ts` — `collectLensParentSideForeignKeyConstraints(parentSlot, schemaManager,
  operation)`: walks every schema's lens slots, finds each child slot whose `enforced-fk`
  obligation references this parent slot's logical table (name + schema, case-insensitive), and
  emits one constraint **iff** `action === 'restrict'` on the op-appropriate `onDelete`/`onUpdate`
  — matching `buildParentSideFKChecks`'s gate. FROM = schema-qualified logical child (child cols
  logical); parent referenced cols rewritten logical→basis for the `OLD.*`/`NEW.*` correlation.
  DELETE → plain `NOT EXISTS`; UPDATE → `(OLD.p = NEW.p …) or <NOT EXISTS>` short-circuit guard.
  Tagged `LENS_BOUNDARY_ATTACHED_TAG`; the contained `EXISTS` auto-defers it to commit.
- `view-mutation-builder.ts` + `delete.ts` — `lensParentSideForeignKeyConstraints(...)`
  (pragma-gated on `foreign_keys`) composed into `extraConstraints`: the sole extra for `delete`,
  appended (UPDATE-masked) for `update`. `buildDeleteStmt` gained an `additionalConstraints` param
  threaded to `buildConstraintChecks`; `buildBaseOp`'s delete case now forwards `extraConstraints`.

## Review findings

**Scope of review:** read the full implement diff (`52089c81`) before the handoff summary;
cross-checked against the physical `buildParentSideFKChecks` / `buildChildSideFKChecks`, the
deferred-constraint evaluation (`runtime/deferred-constraint-queue.ts`), the auto-defer heuristic
(`constraint-builder.ts` `containsSubquery`), and the `additionalConstraints` threading through
`delete.ts` → `buildConstraintChecks`. Validation re-run on the branch.

### Verified correct (checked, found sound)

- **Central correctness claims hold.** Confirmed the deferred-constraint check fails only on
  `value === false || value === 0` (so `NOT EXISTS=false ⇒ ABORT`, NULL passes), and that the
  synthesized `NOT EXISTS` contains an `Exists` node so `containsSubquery` auto-defers it — both
  exactly as the handoff describes. The op-specific synthesis (DELETE plain, UPDATE guarded) is
  justified by these semantics.
- **Parity with `buildParentSideFKChecks`.** Cross-slot discovery, the RESTRICT-only action gate
  on the op-appropriate `onDelete`/`onUpdate`, the count-mismatch skip guard, and the schema/name
  case-insensitive match all mirror the physical builder. The DRY refactor of the physical
  `synthesizeNotExistsCheck` to delegate to the new shared helper is clean.
- **`additionalConstraints` wiring.** `buildConstraintChecks` already accepted the param (from the
  child-side ticket) and merges it with `tableSchema.checkConstraints` filtered by op; `delete.ts`
  threads it before the basis's own `buildParentSideFKChecks` runs, so basis-FK and lens-FK checks
  compose (double-enforce) rather than collide. `OLD.<basisCol>` resolves via the DELETE scope's
  unqualified→OLD registration (rename test asserts `parent_id` correlation).
- **Edge cases reasoned through:** composite keys (one-of-N changed ⇒ guard false ⇒ runs), multiple
  children referencing one parent (one constraint each), self-referential FK (parent==child slot),
  NULL parent key on DELETE (no child can match under MATCH SIMPLE ⇒ passes), pragma gate.
- **Tests** cover happy path, the core no-basis-FK gap, UPDATE orphaning, the short-circuit
  *correctness* (not just perf) case, composite FK, rename override, pragma gate, multi-source
  no-op, the collector unit shape (DELETE vs UPDATE forms), non-referenced parent, and child+parent
  composition. Full suite **4260 passing / 9 pending / 0 failing**; build `tsc` exit 0; lint exit 0.

### Major finding → new ticket filed

- **Nullable-referenced-key UPDATE→NULL soundness gap (empirically confirmed).** The UPDATE guard
  uses plain `=`. For a **nullable** referenced parent key, updating it value→NULL while a child
  references the old value evaluates `'a@x' = NULL` → NULL → `NULL or <false NOT EXISTS>` → NULL,
  which the deferred check lets **pass** — the orphaning update is allowed, diverging from physical
  RESTRICT (which rejects because the column changed). I reproduced this with a standalone probe
  (`ABORTED? false`, child left dangling). Narrow: requires an FK referencing a *nullable* unique
  column; unreachable for NOT-NULL/PK-referenced keys (the overwhelming majority). The shipped
  plain-`=` followed the source plan ticket's explicit mandate; the fix needs a null-safe guard
  (`IS NOT DISTINCT FROM`-equivalent) built from existing AST nodes. **Filed**
  `tickets/backlog/lens-parent-side-fk-nullable-key-update-gap.md` and added a concise v1-divergence
  caveat to the `docs/lens.md` parent-side FK paragraph (it previously read as full RESTRICT parity).

### Accepted as documented v1 limitations (no action)

- **Deferred timing.** Like the child side, the synthesized `NOT EXISTS` auto-defers to commit
  (vs physical parent-side RESTRICT being immediate). Same ABORT outcome at commit; symmetric with
  the already-shipped, already-reviewed child side. Accept.
- **Double-enforcement** with an equivalent basis parent-side FK is intentional and sound; elision
  is the parked follow-up.
- **Single-source-spine gate in the collector** (not the wiring) — the most self-contained,
  directly-testable place, symmetric with the child-side redundancy detector's `resolveSlotBasisSource`
  use. Fine as-is.
- **Runtime defense-in-depth** (`runtime/foreign-key-actions.ts`) scans basis `foreignKeys` only and
  does not see logical FKs — by design, exactly as the child side relies solely on its synthesized
  plan-time check. Not extended; correct.

### Docs

- `docs/lens.md` parent-side FK paragraph reviewed and found accurate for the common case; added the
  v1-divergence caveat (above). No other doc references the prior "parent-side out of scope" claim
  that would now be stale.

### Handoff-accuracy note (non-issue)

- The handoff said the two follow-up tickets are "parked in backlog/" — accurate at the implement
  commit. The runner has since promoted both to `tickets/plan/`
  (`lens-parent-side-fk-cascade-actions`, `lens-parent-side-fk-basis-redundancy-elision`), staged as
  pure renames; standard backlog→plan pipeline bookkeeping, left untouched.

## Out of scope (tracked elsewhere)

- `tickets/plan/lens-parent-side-fk-cascade-actions.md` — CASCADE / SET NULL / SET DEFAULT
  parent-side propagation through the lens.
- `tickets/plan/lens-parent-side-fk-basis-redundancy-elision.md` — elide the lens-level parent-side
  check when the basis parent write provably already enforces an equivalent parent-side FK.
- `tickets/backlog/lens-parent-side-fk-nullable-key-update-gap.md` — the nullable-referenced-key
  UPDATE→NULL null-safety fix (filed by this review).
