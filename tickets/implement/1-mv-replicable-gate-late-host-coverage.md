description: A safety check that stops materialized views from using non-portable functions or sorting rules could be quietly skipped in one rare setup; add a guard and tests so it can never slip through unnoticed.
files:
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/vtab/backing-host.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/test/materialized-view-replicable.spec.ts
difficulty: medium
----

# Independent review + coverage for the lenient backing-host resolution (`tryResolveBackingHost`)

## Background

This is item 1 of the follow-up review of the MV engine changes that landed under
the LevelDB ticket (commit `45619c26`). The change under review:

`database-materialized-views.ts` switched the **replicable-determinism gate** in
`buildMaintenancePlan` from `this.backingHost(mv)` (throws when no host) to
`tryResolveBackingHost(db, mv)` (returns `undefined`, skips the gate, when no host).
The gate rejects a non-replicable FUNCTION or COLLATION in a derivation body when the
resolved backing host declares `requiresReplicableDerivations` (the synced-store flavor).

`tryResolveBackingHost` is the new lenient counterpart of `resolveBackingHost` in
`materialized-view-helpers.ts`. Its inline rationale: a module that materializes its
durable backing *late* — lamina's `ensureBackingForAttach`, which runs **after** the
gate — has no host at plan-build time, and a host that demands replicable derivations
"always exists by then," so skipping when absent never lets a non-replicable body slip
past.

## The soundness boundary (confirmed during planning)

The control flow that makes this load-bearing:

```
attachMaintainedDerivation()                       materialize-view-helpers.ts
  ├─ db.registerMaterializedView(maintained)       line ~1077  ← GATE runs here
  │     └─ buildMaintenancePlan()
  │           └─ host = tryResolveBackingHost(db, mv)   ← host ABSENT ⇒ gate skipped
  └─ try {
       await module.ensureBackingForAttach(...)    line ~1129  ← lamina makes host HERE
       const host = resolveBackingHost(db, live)    line ~1134  ← host now PRESENT
       ...reconcile...
     }
```

So the gate fires **before** the late durable-backing materialization. The design is
sound **iff** no backing host is simultaneously:

  (a) **late** — `getBackingHost` returns `undefined` until `ensureBackingForAttach`, AND
  (b) **demanding** — declares `requiresReplicableDerivations`.

Today this holds by construction: lamina is late but non-demanding; the synced-store is
demanding but resolves its `getBackingHost` eagerly (the host capability surface exists
before `ensureBackingForAttach`, even though the physical store materializes late). The
**create-MV** path (`materializeView`) is unconditionally safe — it creates the backing
via `createBackingTable` *before* `registerMaterializedView`, so the host is always
present at gate time there.

The hazard is that (a)+(b) is an **undocumented, unenforced invariant**. A future host
author who both demands replicable derivations and defers `getBackingHost` to
`ensureBackingForAttach` would silently let a non-replicable body through — a
convergence-breaking data hazard with no error.

## Decision

Keep the lenient `tryResolveBackingHost` call (it is correct and necessary for the
late-host lamina case). Close the soundness gap three ways:

1. **Document the contract** as a hard invariant on the demanding-host capability.
2. **Add a cheap defensive guard** on the attach path that converts the silent hole
   into a loud, immediate error — so a contract-violating host fails fast instead of
   corrupting peers.
3. **Add regression tests** that pin the attach-path gate (function *and* collation) and
   that pin the defensive guard.

## Implementation

### Contract documentation

- In `backing-host.ts`, on the `requiresReplicableDerivations` doc-comment, add a
  normative sentence: a host that declares it **must** resolve via
  `getBackingHost` at maintenance-plan-build time — i.e. eagerly, **before** any
  `ensureBackingForAttach` — because the replicable gate runs at registration, before the
  late-backing seam. A host may materialize its physical/durable store late, but its host
  *capability surface* (carrying this flag) must resolve eagerly.
- Mirror a one-line cross-reference on `VirtualTableModule.ensureBackingForAttach` in
  `module.ts` (the late-backing seam) pointing at that invariant.
- Tighten the `tryResolveBackingHost` doc-comment in `materialized-view-helpers.ts` to
  reference the guard added below (so the "skipping when absent is sound" claim is
  backed by an enforced check, not just prose).

### Defensive guard (attach path only)

In `attachMaintainedDerivation` (`materialized-view-helpers.ts`):

- Capture, **before** `db.registerMaterializedView(maintained)` (~line 1077), whether the
  gate-time host was absent:
  `const gateHostAbsent = tryResolveBackingHost(db, table) === undefined;`
  (Resolve against `table` — the pre-reshape catalog record the gate registration also
  sees; `tryResolveBackingHost` is already imported into this module or import it.)
- After `ensureBackingForAttach` + `resolveBackingHost(db, live)` (~line 1134), once the
  now-present `host` is in hand, add:
  ```
  if (gateHostAbsent && host.requiresReplicableDerivations) {
      throw new QuereusError(
          `cannot attach derivation to '${schemaName}.${name}': its backing host requires `
          + `replicable derivations but did not resolve until after the durable backing was `
          + `materialized, so the replicable-determinism gate could not run. A host that sets `
          + `requiresReplicableDerivations must resolve via getBackingHost at plan-build time `
          + `(before ensureBackingForAttach).`,
          StatusCode.INTERNAL,
      );
  }
  ```
  This sits inside the existing `try`, so the catch runs `restorePrior()` /
  `discardBackingForAttach` cleanup and the failing statement rolls back the reconcile —
  the table reverts to ordinary, untouched.
- Do **not** add the guard to `materializeView` (create-MV); the create path's backing is
  present at gate time by construction, so the check would be dead there.

Note the guard is *defense-in-depth*, not the primary mechanism: it makes the
currently-implicit invariant self-enforcing. It is `INTERNAL` because reaching it means a
host author violated the documented contract.

### Tests (`materialized-view-replicable.spec.ts`)

The spec already defines `ReplBackingModule` (memory host + `requiresReplicableDerivations`,
eager host) and the `nonrepl` UDF / `MYLOCALE` collation fixtures. Extend it:

- **Attach-path FUNCTION reject (new — existing attach coverage is collation-only).**
  Over the `repl` module, create a plain table then attach a body calling `nonrepl`:
  ```sql
  create table mt_fn (id integer primary key, nv integer) using repl;
  -- expect reject naming 'nonrepl' + 'replicable'; mt_fn must NOT become maintained
  alter table mt_fn set maintained as select id, nonrepl(v) as nv from t;
  ```
  Assert via the existing `expectReplicableReject`-shaped checks (message contains
  `cannot be materialized`, `nonrepl`, `replicable`; `getMaintainedTable('main','mt_fn')`
  is `undefined`).

- **Late-but-eager-host attach still rejects (models the synced-store shape).**
  Define a module that uses `ensureBackingForAttach` (records that it ran, delegates the
  actual hosting to the inner memory host so the reconcile still works) **but** whose
  `getBackingHost` resolves eagerly and demands replicable. Attaching a `nonrepl` body must
  still reject, and the spy must confirm `ensureBackingForAttach` was reached only on the
  accept control (it never runs on the reject, because the gate fires first). This pins
  that the gate firing does not depend on the absence of a late-backing seam.

- **Defensive-guard reject (truly-late + demanding).**
  Define a module that is **both** late (its `getBackingHost` returns `undefined` until
  `ensureBackingForAttach` flips an internal flag, after which it returns the demanding
  inner host) **and** demanding. Attach an otherwise-valid **builtin-only** body (so the
  *only* thing that can reject is the guard, not the replicable gate itself):
  ```sql
  create table mt_late (id integer primary key, av integer) using late_demand;
  alter table mt_late set maintained as select id, abs(v) as av from t;
  -- expect INTERNAL reject naming 'requiresReplicableDerivations' / 'plan-build time';
  -- mt_late must NOT become maintained
  ```
  This is the test that **fails if the guard is removed** (without the guard, the late host
  silently registers, and a `nonrepl` body would slip the gate). Add a companion assertion:
  with the guard in place, the same late+demanding module rejects a `nonrepl(v)` body too
  (proving the hole it guards is real) — but the builtin-only case is the canonical guard
  proof because it isolates the guard from the gate.

- **Negative control:** the same `late_demand` module on a NON-demanding inner host (flag
  off) attaches a `nonrepl` body fine `using memory`-style — i.e. lateness alone is not
  the trigger (mirrors the existing "inert on a non-demanding host" tests).

## Edge cases & interactions

- **Create-MV vs attach asymmetry.** Confirm the guard is attach-only and create-MV
  (`create materialized view … using repl`) still rejects via the *gate* (host present at
  gate time), not the guard — the existing create-path tests must remain green.
- **Re-attach (`priorMaintained`).** A re-attach over an already-maintained table on a
  demanding host: the gate fires at the re-registration (host present from the prior
  attach). Confirm the guard's `gateHostAbsent` is `false` there, so re-attach is never
  spuriously rejected by the guard.
- **Reshape attach.** The reshape arm re-registers the plan post-reshape (~line 1166) and
  resolves the host at ~line 1134 as well; ensure the guard placement (after the single
  `resolveBackingHost(db, live)` at ~1134, before the reconcile) covers the reshape arm
  without double-throwing.
- **`pragma nondeterministic_schema`.** The replicable class is orthogonal to and not
  waivable by this pragma; the existing tests assert this for create — the new attach-path
  function test should not regress it (the guard and gate are both independent of the
  pragma).
- **Guard never fires for memory/store.** Memory and store leave
  `requiresReplicableDerivations` undefined, so `host.requiresReplicableDerivations` is
  falsy and the guard is a pure no-op — the common path pays one already-resolved-host
  property read and nothing else.
- **`discardBackingOnFailure` interaction.** The guard throws inside the same `try` as the
  reconcile, so on a fresh attach with `discardBackingOnFailure` set, the catch's
  `discardBackingForAttach` cleanup runs. For the test modules, ensure their
  `discardBackingForAttach` (if implemented) tolerates being called after a guard throw
  (the store was just made by `ensureBackingForAttach`); a spy that no-ops is fine.

## TODO

- Document the eager-resolution invariant on `requiresReplicableDerivations`
  (`backing-host.ts`) and cross-reference it on `ensureBackingForAttach` (`module.ts`).
- Tighten the `tryResolveBackingHost` doc-comment to cite the guard.
- Add the `gateHostAbsent` capture + post-`resolveBackingHost` defensive guard in
  `attachMaintainedDerivation`.
- Extend `materialized-view-replicable.spec.ts`: attach-path function reject;
  late-but-eager-host reject + `ensureBackingForAttach` spy; defensive-guard reject
  (builtin-only + nonrepl); non-demanding-late negative control.
- Run `yarn workspace @quereus/quereus test` (or the MV spec subset) and `yarn lint`
  (single-quote globs on Windows); stream output with `tee`.
