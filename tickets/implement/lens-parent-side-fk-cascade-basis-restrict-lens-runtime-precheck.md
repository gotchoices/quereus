description: IMPLEMENT — enforce a lens parent-side FK RESTRICT over a non-restrict basis FK by a runtime pre-check (the logical dual of `assertNoRestrictedChildrenForParentMutation`), fired BEFORE the basis op so it observes pre-cascade child state. The current deferred `NOT EXISTS` lens check races the same-statement basis CASCADE/SET NULL/SET DEFAULT and is silently dropped.
prereq:
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, docs/lens.md
----

# Lens parent-side FK RESTRICT must win over a non-restrict basis FK (runtime pre-check)

## Confirmed reproduction

Verified live (temporary spec, `pragma foreign_keys = true`, default memory backend):

```sql
declare schema y {
  table parent (id integer primary key, name text);
  table child  (id integer primary key, pid integer null,
                constraint fk foreign key (pid) references parent(id)
                  on delete cascade on update cascade)
}
apply schema y;
declare logical schema x {
  table parent (id integer primary key, name text);
  table child  (id integer primary key, pid integer null,
                constraint fk_pid foreign key (pid) references parent(id))   -- bare ⇒ RESTRICT
}
apply schema x;
insert into x.parent (id, name) values (1, 'a');
insert into x.child (id, pid) values (10, 1);
delete from x.parent where id = 1;
```

Observed probe: `{aborted:false, parent:[{n:0}], child:[{n:0}]}` — the delete
**succeeds** and the child is cascade-deleted. Expected: **ABORT**, both rows
survive (the logical RESTRICT must win).

## Root cause (traced end-to-end)

Two enforcement mechanisms fire on the **same basis parent write**, in the wrong
relative order for this case:

1. **Lens parent-side RESTRICT check** — `collectLensParentSideForeignKeyConstraints`
   (`planner/mutation/lens-enforcement.ts`) correctly *retains* a `NOT EXISTS(select
   1 from <logicalChild> where … = OLD.<key>)` for the cascade case (the action gate
   only elides a `restrict` basis FK). It is routed as a plain `RowConstraintSchema`
   through `buildConstraintChecks` (`planner/building/constraint-builder.ts`), whose
   `needsDeferred = containsSubquery(expression) || containsCommittedRef(expression)`
   heuristic **auto-defers it to commit** because it contains an `EXISTS`. (Unlike the
   physical RESTRICT path: `buildParentSideFKChecks` builds a `ConstraintCheck`
   directly with `needsDeferred:false` — immediate.)

2. **Basis referential action** — `executeForeignKeyActionsAndLens`
   (`runtime/foreign-key-actions.ts`) runs the basis CASCADE/SET NULL/SET DEFAULT
   *during* statement execution, mutating the basis children.

The basis cascade deletes/nulls the children mid-statement; at commit the deferred
lens `NOT EXISTS` over the logical child sees the **post-cascade** state (no
surviving children) and passes. A deferred `NOT EXISTS` is structurally unable to
observe the pre-cascade state, so it can never enforce RESTRICT against a
same-statement cascade.

Note the physical path already solves the analogous timing problem with a
**runtime pre-check fired BEFORE `vtab.update`**: `dml-executor.ts`
(`processDeleteRow` / `processUpdateRow` / `processEvictions`) calls
`assertTransitiveRestrictsForParentMutation` → `assertNoRestrictedChildrenForParentMutation`
before the vtab op + cascade. That pre-check is keyed off the **basis** FK action
(`fk.onDelete/onUpdate === 'restrict'`) and scans declared `TableSchema.foreignKeys`,
so it never sees a logical-only FK whose action is RESTRICT. The lens path has no
such pre-check.

## Scope / provenance

- **Pre-existing**, shipped by `lens-parent-side-fk-enforcement`; *not* introduced by
  `lens-parent-side-fk-basis-redundancy-elision` (that ticket's retain/elide decision
  is correct — this is a timing/firing bug in the retained path).
- Reachable only when the **logical** FK op-action is RESTRICT while the **basis** FK
  op-action is non-RESTRICT (cascade / set null / set default) — the deliberate "lens
  is stricter than basis" configuration. When the basis FK is also RESTRICT, the basis
  immediate check + physical runtime pre-check enforce it (and the lens check is
  elided). When the lens FK is itself non-RESTRICT it is out of scope (handled by the
  cascade walker `executeLensForeignKeyActions`).
- Affects **DELETE** (basis `on delete cascade|set null|set default`) and **UPDATE**
  of a referenced key (basis `on update …`).

## Fix design — runtime lens RESTRICT pre-check (the logical dual)

Add a runtime pre-check that is the **logical dual of
`assertNoRestrictedChildrenForParentMutation`**, keyed off the **logical** FK action,
fired BEFORE the basis op so it observes the **pre-cascade** child state. This mirrors
the existing, proven physical defense-in-depth pattern, is backend-agnostic (a plain
view scan), and reuses the reverse-map + discovery infrastructure already in
`executeLensForeignKeyActions`.

### New function (`runtime/foreign-key-actions.ts`)

```
assertLensRestrictsForParentMutation(
  db, basisParentTable, operation: 'delete' | 'update', oldRow, newRow?
): Promise<void>
```

Structure (mirror `executeLensForeignKeyActions` / `executeLensFkActionsForParentSlot`,
but assert non-existence instead of issuing cascade DML):

- Early return when `foreign_keys` is off.
- Reverse-map basis → logical parent slots: for every lens slot whose single basis
  spine (`resolveSlotBasisSource`) is `basisParentTable`.
- For each slot, `findLogicalParentFkRefs(parentSlot, sm)`; for each ref whose
  **op-appropriate logical action is `restrict`** (`fk.onDelete`/`fk.onUpdate`):
  - Map logical parent referenced columns → basis columns (`logicalToBasisColumnMap`)
    → basis indices; read OLD referenced values off `oldRow`. A column with no plain
    basis projection disqualifies that ref (cannot read its basis value) — skip.
  - **MATCH SIMPLE:** skip when any OLD referenced value is NULL.
  - **UPDATE short-circuit:** skip when no referenced parent column changed, using
    `sqlValuesEqual` on OLD vs NEW basis values (the proper change test — this also
    avoids the plain-`=` nullable-key gap the deferred plan-time guard has, see
    `lens-parent-side-fk-nullable-key-update-gap`).
  - Scan the **logical child view** (schema-qualified, logical column names — exactly
    what `issueLensFkAction` reads): `select 1 from <schema>.<child> where
    <childLogicalCol> = ? … limit 1`, bind the OLD values. If any row exists, throw
    `QuereusError`/`ConstraintError` with `StatusCode.CONSTRAINT` and a RESTRICT
    message parallel to the physical one, e.g.
    `FOREIGN KEY constraint failed: DELETE on '<logicalParent>' violates RESTRICT from
    '<logicalChild>'` (matcher-compatible with `/constraint|foreign|fk/i`).

Factor the OLD/NEW-basis-value extraction + MATCH-SIMPLE + UPDATE-short-circuit loop
shared with `executeLensFkActionsForParentSlot` into one helper so the two paths
cannot drift (both live in `foreign-key-actions.ts`; the column→basis-index mapping
also exists there). Reuse `quoteIdentifier`.

### Wiring — ride the existing transitive walk

Call `assertLensRestrictsForParentMutation` from **inside**
`assertTransitiveRestrictsForParentMutation` (step 1, immediately after the physical
`assertNoRestrictedChildrenForParentMutation`). The three DML-executor call sites
(`processDeleteRow`, `processUpdateRow`, `processEvictions`) already invoke the
transitive walker before/around the vtab op, so they get the lens scan for free with
**no `dml-executor.ts` changes**.

The lens scan itself is **direct** (non-recursive): transitivity through *basis*
cascades is provided for free because each basis cascade in `executeSingleFKAction`
issues nested DML (`db._execWithinTransaction('DELETE FROM child …')`) that re-enters
`processDeleteRow`/`processUpdateRow`, which re-fires the transitive walker (and thus
the lens scan) at the next level. Additionally, because the lens scan rides the
*basis* transitive recursion (which recurses with each cascading basis `childTable`
as the new "parent"), a basis cascade that lands on a deeper basis table backing a
logical parent is also covered within the single walk.

### What does NOT change

- `collectLensParentSideForeignKeyConstraints` and its `lensParentSideForeignKeyRedundant`
  elision logic are **unchanged** — the collector's retain/elide decision is correct;
  only timing/firing changes. The deferred plan-time `NOT EXISTS` stays as harmless
  commit-time defense-in-depth (exactly mirroring the physical plan-time + runtime
  coexistence). For the cascade case the runtime pre-check now throws before
  `vtab.update`, so the deferred check is never reached; for the lens-only (no basis
  FK) case both fire and both ABORT — no spurious failures (an unreferenced parent
  matches neither).
- No new `RowConstraintSchema` deferral-override field is introduced (the alternative
  "make the lens check immediate" approach would require threading a force-immediate
  flag through the shared `buildConstraintChecks` heuristic — more invasive and riskier
  than reusing the proven runtime pattern; documented here as the rejected alternative).

## Semantics decision (document in docs/lens.md)

When basis and lens parent-side actions diverge, **the lens RESTRICT wins** for every
non-restrict basis action:
- lens RESTRICT over basis CASCADE ⇒ parent delete/key-update **ABORTs** (children not
  cascade-deleted/updated).
- lens RESTRICT over basis SET NULL / SET DEFAULT ⇒ **ABORTs** (children not nulled/
  defaulted). The pre-check fires before the basis op, so the still-referencing
  children are observed and the mutation is rejected.

This is the intended "lens is stricter than basis" outcome. (The inverse — a basis
RESTRICT under a lens cascade, and other divergent-action sub-cases — remains tracked
by `lens-parent-side-fk-divergent-basis-action`, backlog; this ticket covers only the
lens-RESTRICT-over-non-restrict-basis direction.)

## Out of scope / follow-ups to note (do not chase here)

- **rowid-mode / store backends (lamina):** the physical transitive pre-walk exists
  partly because rowid-chained backends silently no-op nested cascades post-mutation.
  Validate this fix on the default memory backend (`yarn test`). If a store-specific
  gap surfaces, file a backlog ticket rather than expanding scope (`yarn test:store`
  is not agent-runnable inside a ticket).
- `lens-parent-side-fk-nullable-key-update-gap` (the plan-time guard's plain-`=`
  nullable-key-to-NULL miss) is *partly* mitigated as a side effect (the runtime
  pre-check uses `sqlValuesEqual`), but that ticket is about the plan-time guard and is
  not closed here — leave it.

## TODO

### Phase 1 — implement the runtime pre-check
- [ ] In `runtime/foreign-key-actions.ts`, factor the shared OLD/NEW-basis-value
      extraction (logical referenced col → basis col → basis index, MATCH SIMPLE skip,
      UPDATE `sqlValuesEqual` short-circuit) out of `executeLensFkActionsForParentSlot`
      into a reusable helper.
- [ ] Add `assertLensRestrictsForParentMutation(db, basisParentTable, operation,
      oldRow, newRow?)` per the design above: reverse-map basis→logical parent slots,
      discover referencing logical FKs (`findLogicalParentFkRefs`), and for each
      RESTRICT op-action scan the logical child view (`select 1 … limit 1`) and throw
      `StatusCode.CONSTRAINT` on a surviving reference. Match the physical RESTRICT
      message shape.
- [ ] Call it from inside `assertTransitiveRestrictsForParentMutation` step 1 (right
      after `assertNoRestrictedChildrenForParentMutation`), so all three DML-executor
      call sites pick it up with no `dml-executor.ts` change. Confirm pragma gating and
      cycle handling compose with the enclosing walk.

### Phase 2 — tests (packages/quereus/test/lens-enforcement.spec.ts)
- [ ] Behavioral DELETE: lens RESTRICT over basis CASCADE — delete of a referenced
      logical parent **ABORTs**, parent and child both survive (the repro above).
- [ ] Same for basis **SET NULL** and **SET DEFAULT** (DELETE) — ABORT, child retains
      its FK value (not nulled/defaulted).
- [ ] UPDATE-of-referenced-key analogue for each non-restrict basis action
      (`on update cascade|set null|set default`) — ABORT, rows unchanged. Include the
      benign UPDATE that does not touch the referenced key ⇒ succeeds (short-circuit).
- [ ] (Optional) composite-key variant.
- [ ] A direct-call unit test of `assertLensRestrictsForParentMutation` in
      `test/runtime/fk-restrict-runtime.spec.ts` (mirror the existing
      `assertNoRestrictedChildrenForParentMutation` direct-call test).

### Phase 3 — regression + docs
- [ ] Confirm the collector-decision tests (`lens enforcement: parent-side FK
      basis-redundancy elision`) and the cascade/set-null/set-default action tests
      still pass — this fix changes firing/timing, not the collector's retain/elide
      decision.
- [ ] Confirm the `restrict`-basis elided path is unaffected (still ABORTs via the
      basis immediate + physical runtime pre-check; the extra lens pre-check is
      redundant-but-sound).
- [ ] Update `docs/lens.md` § Constraint Attachment (Foreign key, parent-side
      paragraph): a RESTRICT lens FK over a **non-restrict basis** FK is enforced by a
      runtime pre-check (the logical dual of `assertNoRestrictedChildrenForParentMutation`,
      keyed off the *logical* action), fired before the basis op so it observes
      pre-cascade child state — correcting the "auto-deferred to commit" framing for
      this case and the prior "(divergent-action … out of scope)" caveat as it applied
      to lens-RESTRICT-over-non-restrict-basis.
- [ ] Build + lint + run `yarn test` (memory backend); fix any fallout. If a failure is
      plainly unrelated/pre-existing, follow the `.pre-existing-error.md` flow.
