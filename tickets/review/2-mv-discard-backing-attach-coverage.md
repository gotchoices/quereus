description: A cleanup hook that drops a freshly-created storage backing when attaching a maintained view fails was unused and untested in this repo; a focused test now proves it fires only in the right cases and stays inert otherwise.
files:
  - packages/quereus/test/materialized-view-discard-backing.spec.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
difficulty: medium
----

# Review: coverage for the `discardBackingForAttach` cleanup seam

## What was implemented

The engine has an attach-lifecycle triad on `VirtualTableModule`:
`ensureBackingForAttach` (create a durable store on attach) →
`retireBackingForAttach` (migrate rows back + drop on detach) →
`discardBackingForAttach` (drop a *freshly-created* store on a **failed fresh
attach**). The third seam's firing condition was dead-in-repo (no in-repo module
implements any of the three; the real implementor is downstream / lamina), hence
untested. This ticket closes that gap with an in-repo spy module + spec — **no
engine behavior change**.

The exact firing condition (materialized-view-helpers.ts attach `catch`, ~line 1221):

```
if (discardBackingOnFailure && !reconcileCommitted && !priorMaintained)
    await module.discardBackingForAttach?.(db, schemaName, name);
```

- `discardBackingOnFailure` is set **only** by the `alter table … set maintained`
  verb (`runSetMaintained`), NOT by `create table … maintained`
  (`createMaintainedTable`) — there the create path's own `dropTable` retires the
  store, so a discard would double-drop.
- A failed fresh attach is produced by a declared `check (v > 0)` the derived rows
  violate: `validateDeclaredConstraintsOverContents` throws AFTER
  `ensureBackingForAttach`, inside the try, with `reconcileCommitted` false and
  `priorMaintained` undefined.

### Changes

- **NEW** `packages/quereus/test/materialized-view-discard-backing.spec.ts` — spy
  module (subclasses `MemoryTableModule`, records `ensure`/`discard`/`retire`
  seam calls as `'<op>:<schema>.<name>'`, keeps memory's `getBackingHost` so
  hosting/reconcile are unchanged) + 6 tests.
- **EDIT** `src/vtab/module.ts` — extended the `discardBackingForAttach`
  doc-comment with a DRY cross-reference to the `discardBackingOnFailure` flag's
  verb-gating + create-path exclusion (comment only).

## Tests / use cases covered (all passing)

`yarn workspace @quereus/quereus test --grep "discardBackingForAttach"` → **6 passing**.

1. **Fresh-attach failure ⇒ ensure THEN discard.** `set maintained` over a body
   violating a CHECK; asserts `spy.ops` deep-equals `['ensure:main.mt',
   'discard:main.mt']` (ordering, not just membership), table reverts to plain +
   writable, source untouched (atomicity).
2. **Re-attach failure ⇒ NO discard (`priorMaintained` branch).** Succeed once,
   clear the spy, re-attach a violating body; asserts no `discard`, and mt2 reverts
   to its prior maintained derivation with prior rows intact.
3. **Create-`maintained` failure ⇒ NO discard (`discardBackingOnFailure` false).**
   `create table … using spy maintained as <violating>`; asserts `ensure` recorded
   but no `discard` (cleanup via `dropTable`), table dropped.
4. **Successful attach ⇒ ensure, no discard.** Clean attach logs only
   `['ensure:main.mt']`, table maintained, rows materialized.
5. **Detach ⇒ retire (triad symmetry control).** `drop maintained` records
   `['retire:main.mt']`; pins the full triad in-repo.
6. **Optional-call safety control.** A plain `MemoryTableModule` (no seams)
   survives a fresh-attach failure as a catalog-only rollback — `?.` no-op, no crash.

## Validation performed

- `yarn workspace @quereus/quereus test --grep "discardBackingForAttach"` → 6 passing.
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`,
  so the spec's call sites type-check).
- `yarn workspace @quereus/quereus test` (full suite) → **6364 passing, 9 pending,
  exit 0**. No regressions. (The `[property-planner] Rule '…' never fired` lines are
  pre-existing informational warnings from property tests, unrelated to this change.)

## Known gaps / honest limitations (reviewer: treat as a floor)

- **Seams are no-ops in-repo.** The spy records *which engine branch calls which
  seam*; it does NOT model a real durable store. So these tests prove engine-side
  **routing/gating**, not the physical drop/migrate semantics — those belong to the
  downstream (lamina) implementor's own tests. This is by design per the ticket's
  "keep forward infra + cover it" decision.
- **The reconcile-committed branch is intentionally NOT covered.** The
  `!reconcileCommitted` term excludes a failure on the post-reconcile reshape ops
  (which commit the reconcile eagerly, then run data-validating column ops).
  Reproducing it needs a reshape-on-attach whose `postReconcileOps` throw after the
  eager commit — substantially more setup than the other branches, marginal value
  for a no-op spy. The committed store is *intentionally* kept (stale) and never
  discarded. This is documented inline at the top of the spec — verify the comment
  reads accurately and the omission is acceptable.
- **Interaction with `mv-replicable-gate-late-host-coverage` (item 1, independent —
  no `prereq`).** If that ticket's INTERNAL guard also lands, it throws inside the
  same attach `try`, so a fresh attach failing on the guard would *also* route
  through `discardBackingForAttach`. The spy tolerates this (no-op). Neither spec
  assumes the other's module exists. Reviewer: confirm no cross-spec coupling if
  both are present.
- **Reviewer angles worth a second look:** (a) is asserting `spy.ops` *ordering*
  (ensure-before-discard) the right strictness, or too brittle if the engine ever
  reorders the seam calls? (b) does the CHECK-violation trigger reliably exercise
  the *non-reshape* path (same shape src→mt), keeping `reconcileCommitted` false as
  intended? (c) the create-maintained test asserts `ensure` IS recorded — confirm
  that matches the intended contract (the create path does call `ensureBackingForAttach`).
