description: REVIEW — a lens parent-side FK RESTRICT over a non-restrict basis FK is now enforced by a runtime pre-check (`assertLensRestrictsForParentMutation`, the logical dual of `assertNoRestrictedChildrenForParentMutation`), fired BEFORE the basis op so it observes the pre-cascade child state. Replaces the silently-dropped deferred `NOT EXISTS` that raced the same-statement basis CASCADE / SET NULL / SET DEFAULT.
prereq:
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, docs/lens.md
----

# Lens parent-side FK RESTRICT over a non-restrict basis (runtime pre-check)

## What changed

A **logical** FK with a RESTRICT op-action over a **non-restrict basis** FK (basis
`cascade` / `set null` / `set default`) — or over no basis FK at all — was silently
unenforced for the cascade case: the collector retains a deferred commit-time
`NOT EXISTS`, but the same-statement basis cascade mutates the children mid-statement,
so the deferred check observed the **post-cascade** (empty) child state and passed. The
parent delete succeeded and the children were cascade-deleted, when the lens RESTRICT
should have **ABORTed**.

The fix is the **logical dual** of the existing physical RESTRICT pre-check, fired at
the same pre-mutation timing:

- **New `assertLensRestrictsForParentMutation(db, basisParentTable, operation, oldRow, newRow?)`**
  (`runtime/foreign-key-actions.ts`). Reverse-maps the basis parent table → logical
  parent slot(s) (single-basis-spine only, identical boundary to the cascade walker
  `executeLensForeignKeyActions`), discovers referencing logical FKs
  (`findLogicalParentFkRefs`), and for each whose **op-appropriate logical action is
  `restrict`** scans the **logical child view** (`select 1 from <schema>.<child> where
  <childLogicalCol> = ? … limit 1`, OLD values bound). A surviving row ⇒ throws
  `StatusCode.CONSTRAINT` with a message parallel to the physical pre-check:
  `FOREIGN KEY constraint failed: DELETE on '<logicalParent>' violates RESTRICT from '<logicalChild>'`.

- **Wiring (no dml-executor.ts change):** called from inside
  `assertTransitiveRestrictsForParentMutation` step 1, immediately after the physical
  `assertNoRestrictedChildrenForParentMutation`. The three DML-executor call sites
  (`processDeleteRow`, `processUpdateRow`, `processEvictions`) already invoke the
  transitive walker before the vtab op, so the lens scan rides along for free.

- **Shared helper `resolveLensFkParentReferencedValues`:** the OLD/NEW basis-value
  extraction (logical referenced col → basis col → basis index) + MATCH SIMPLE skip +
  UPDATE `sqlValuesEqual` short-circuit was factored out of
  `executeLensFkActionsForParentSlot` so the cascade walker and the RESTRICT pre-check
  cannot drift. The cascade walker now delegates to it (behavior unchanged — verified by
  the existing cascade/divergent suites all passing).

- **docs/lens.md** § Constraint Attachment (Foreign key, parent-side paragraph): the
  "auto-deferred to commit" framing is corrected for the lens-RESTRICT-over-non-restrict-basis
  case; the final divergent-action sentence drops the now-stale "prereq's" framing.

The collector (`collectLensParentSideForeignKeyConstraints` /
`lensParentSideForeignKeyRedundant`) is **unchanged** — only firing/timing changes. The
deferred `NOT EXISTS` stays as harmless commit-time defense-in-depth.

## Semantics (the intended outcome)

When basis and lens parent-side actions diverge, **the lens RESTRICT wins** for every
non-restrict basis action:
- lens RESTRICT over basis CASCADE ⇒ parent delete / key-update **ABORTs** (children not
  cascade-deleted/re-keyed).
- lens RESTRICT over basis SET NULL / SET DEFAULT ⇒ **ABORTs** (children not nulled/defaulted).

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (memory backend, quereus package) — **4375 passing, 9 pending, 0 failing**.
- The two affected spec files run isolated — **124 passing**.

### Tests added
`packages/quereus/test/lens-enforcement.spec.ts` — new describe
`lens enforcement: parent-side FK RESTRICT over a non-restrict basis (runtime pre-check)`:
- DELETE: lens RESTRICT over basis CASCADE ABORTs; parent + child + basis child all
  survive (**the repro** — verified to actually fail before the fix, pass after).
- DELETE: over basis SET NULL — ABORT, child FK not nulled.
- DELETE: over basis SET DEFAULT (`pid integer default 0`) — ABORT, child FK not defaulted.
- UPDATE of referenced key: over basis CASCADE — ABORT, rows unchanged; **benign non-key
  UPDATE succeeds** (short-circuit).
- UPDATE of referenced key: over basis SET NULL / SET DEFAULT — ABORT, rows unchanged.
- Composite key: over basis CASCADE — delete + key-update of the referenced composite
  key ABORT; unreferenced composite parent deletes cleanly.
- Pragma gate: `foreign_keys = false` ⇒ no pre-check (basis CASCADE runs, child orphaned).

`packages/quereus/test/runtime/fk-restrict-runtime.spec.ts` — direct-call unit test of
`assertLensRestrictsForParentMutation` (throws on a referenced parent, returns cleanly on
an unreferenced one) mirroring the existing physical-pre-check direct-call test.

### Regression coverage that still passes (firing/timing-only change confirmed)
- `parent-side FK basis-redundancy elision` (collector retain/elide decisions) — unchanged.
- `parent-side FK CASCADE / SET NULL / SET DEFAULT actions` + mixed logical/basis cycle.
- `parent-side FK divergent basis action` (incl. the `logical RESTRICT over basis CASCADE`
  predicate test, which asserts `basisFksOverriddenByDivergentLensFk` is empty — unaffected,
  since that mechanism is for non-RESTRICT logical actions; the RESTRICT direction is now
  this pre-check's domain).
- `parent-side FK RESTRICT at the write boundary` (lens-only, no basis FK): still ABORTs —
  the pre-check now ABORTs earlier than the retained deferred check; both fire, both reject.

## Known gaps / things for the reviewer to probe

- **Store backend (lamina) not validated.** Per the ticket, validation is on the default
  memory backend only; `yarn test:store` is not agent-runnable inside a ticket (wall-clock).
  The pre-check is a plain pre-mutation **view scan** (backend-agnostic by construction, and
  it fires at the same point as the proven physical pre-walk that exists precisely for
  rowid-chained backends), but no store-backend run was done. If a store-specific gap
  surfaces in CI, file a backlog ticket rather than expanding scope here.
- **No dedicated multi-hop lens-RESTRICT transitive test.** Transitivity through *basis*
  cascades is provided by the enclosing `assertTransitiveRestrictsForParentMutation` (its
  pre-walk recursion + nested-DML re-entry both re-fire the lens scan at each level — a
  basis cascade landing on a deeper basis-backed logical parent is covered). This rides a
  well-tested physical mechanism, but there is no behavioral test that exercises a
  logical-RESTRICT-two-hops-down scenario specifically. Worth adding one if the reviewer
  wants belt-and-suspenders.
- **Double-fire for the lens-only case is intentional** (pre-check + retained deferred
  `NOT EXISTS`). Confirm there is no spurious failure path: an unreferenced parent matches
  neither, a referenced parent ABORTs at the pre-check before the deferred one is reached.
- `lens-parent-side-fk-nullable-key-update-gap` is **partly** mitigated as a side effect
  (the pre-check uses `sqlValuesEqual`, so a nullable-key value→NULL update is caught), but
  that ticket targets the *plan-time guard*'s plain-`=` miss and is **not** closed here.
- **Message shape:** the thrown message uses the **logical** table names and is
  matcher-compatible with `/constraint|foreign|fk/i`. Confirm this is acceptable parity with
  the physical message (which uses basis names).
