description: A safety hook that drops a half-created storage backing when turning a table into a maintained view fails was never exercised in this repo; a focused test now proves it fires only when it should and stays quiet otherwise.
files:
  - packages/quereus/test/materialized-view-discard-backing.spec.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
difficulty: medium
----

# Complete: coverage for the `discardBackingForAttach` cleanup seam

## What shipped

A spy-module test spec plus a doc-comment cross-reference closing the
coverage gap on the third attach-lifecycle seam of `VirtualTableModule`:

`ensureBackingForAttach` (create a durable store on attach) →
`retireBackingForAttach` (migrate rows back + drop on detach) →
`discardBackingForAttach` (drop a *freshly-created* store on a **failed fresh
attach**).

No in-repo module implements the triad (the real implementor is downstream /
lamina), so the precise firing condition was dead-in-repo and untested. The
ticket added an in-repo `SpyBackingModule` (subclasses `MemoryTableModule`,
records `ensure`/`retire`/`discard` seam calls, keeps memory's `getBackingHost`
so hosting/reconcile are unchanged) and 6 tests driving every branch of:

```
if (discardBackingOnFailure && !reconcileCommitted && !priorMaintained)
    await module.discardBackingForAttach?.(db, schemaName, name);
```

**No engine behavior change** — the only source edit is a comment in
`module.ts` (a DRY cross-reference to the `discardBackingOnFailure` verb-gating).

## Review findings

### Checked — engine vs. test fidelity (all confirmed accurate)

- **Firing condition matches the engine.** Read `attachMaintainedDerivation`
  (materialized-view-helpers.ts ~1208–1224): the catch's discard guard is
  exactly `discardBackingOnFailure && !reconcileCommitted && !priorMaintained`,
  matching the spec's documented condition.
- **`runSetMaintained` passes `discardBackingOnFailure = true`**; **`createMaintainedTable`
  leaves it default-false** and cleans up via `sm.dropTable(...)` in its catch —
  so test #3's "ensure recorded, no discard, table dropped" and the new
  `module.ts` doc-comment ("create path's own `dropTable` retires it; a discard
  would double-drop") are both correct.
- **`runDropMaintained` calls `retireBackingForAttach`** — test #5's detach/retire
  assertion is accurate.
- **`MemoryTableModule` does NOT implement any of the three seams** (verified via
  search of `src/vtab/memory/`), so the spy's methods are genuine additions, not
  overrides of real behavior — the comment "memory hosts the live table directly"
  holds, and the seams only *observe* which engine branch fires.
- **`schemaManager.getMaintainedTable` / `getTable` exist and behave as asserted.**
- **No cross-coupling with `mv-replicable-gate-late-host-coverage`.** The
  replicable-determinism guard fires only when `gateHostAbsent && host.requiresReplicableDerivations`;
  the spy keeps memory's eagerly-resolving `getBackingHost` (so `gateHostAbsent`
  is false) and memory's host does not require replicable derivations, so that
  guard never fires in these tests. No spec assumes the other's module exists.

### Checked — test quality / aspects

- **Ordering assertion (`['ensure:main.mt','discard:main.mt']`) is correct, not
  brittle.** The non-reshape path calls `ensureBackingForAttach` exactly once
  before the catch's discard; the order is a genuine engine guarantee
  (discard undoes the prior ensure), so asserting the ordered sequence is the
  right strictness.
- **Atomicity coverage is real.** Test #1 verifies the rolled-back reconcile
  leaves `mt` empty + writable and `src_bad` untouched; test #2 verifies a failed
  re-attach restores the prior derivation *and its rows* (`[{id:1,v:5}]`); test #5
  verifies retire keeps rows. These exercise statement-level rollback, not just
  seam routing.
- **Resource cleanup / isolation:** fresh `Database` per test in `beforeEach`,
  `db.close()` in `afterEach`, `spy.clear()` to isolate re-attach ops. No
  cross-test state leakage.

### Found — minor (not fixed; rationale below)

- **`expect(err.message).to.contain('mt')` is a loose assertion** (a 2-char
  substring). `captureError` already guarantees an error was thrown, and `'mt'`
  does not accidentally match `'maintained'` (no adjacent `m`+`t`), so the check
  is harmless. Tightening it to a CHECK/constraint keyword would couple the test
  to error-message wording (more brittle, negative value). **Left as-is.**

### Found — major

- **None.** No new tickets filed.

### Intentionally NOT covered (verified acceptable, no ticket)

- **The reconcile-committed branch** (`!reconcileCommitted` term). Reaching it
  needs a reshape-on-attach whose `postReconcileOps` throw *after* the eager
  reconcile commit — substantial setup. For a no-op spy the observable outcome
  ("ensure recorded, no discard, committed store kept stale") is **structurally
  identical** to the already-covered `priorMaintained` and create-maintained
  no-discard branches; the only unique element is the reshape/commit machinery,
  which is the downstream durable-store implementor's test territory. Marginal
  in-repo value confirms the implementer's deferral. Documented inline at the top
  of the spec.

### Docs

- **No doc update required.** The seam triad is documented in `module.ts` JSDoc
  (extended accurately by this ticket). `docs/materialized-views.md` mentions
  `ensureBackingForAttach` only in the replicable-gate context and remains
  accurate. No other doc references the cleanup triad.

## Validation performed (review pass)

- `yarn workspace @quereus/quereus test --grep "discardBackingForAttach"` → **6 passing**.
- `yarn workspace @quereus/quereus lint` → **exit 0** (eslint + `tsc -p tsconfig.test.json`,
  type-checking the spec's call sites).
- `yarn workspace @quereus/quereus test` (full suite) → **6364 passing, 9 pending,
  exit 0**. No regressions. The `[property-planner] Rule '…' never fired` lines
  are pre-existing informational warnings from property tests, unrelated to this
  change.

## End
