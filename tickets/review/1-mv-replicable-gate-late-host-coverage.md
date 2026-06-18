description: Review a new safety check (and its tests) that stops materialized views from quietly skipping a portability guard in one rare backing-store setup.
files:
  - packages/quereus/src/vtab/backing-host.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/materialized-view-replicable.spec.ts
  - docs/materialized-views.md
difficulty: medium
----

# Review: defensive guard + coverage for the lenient backing-host gate resolution

## What this implemented

The MV **replicable-determinism gate** (rejects a non-replicable FUNCTION/COLLATION
in a derivation body when the backing host declares `requiresReplicableDerivations`)
runs at maintenance-plan registration. On the `alter table … set maintained` ATTACH
path, registration fires **before** a module's late durable-backing seam
(`ensureBackingForAttach`), so the host is resolved **leniently** via
`tryResolveBackingHost` (returns `undefined` → gate skipped) when no host exists yet.

This was sound only by an **undocumented, unenforced invariant**: a host that demands
replicable derivations must resolve its `getBackingHost` capability *eagerly* (before
the late seam). The change closes that gap three ways:

1. **Contract documented** (`backing-host.ts` on `requiresReplicableDerivations`;
   cross-referenced on `module.ts` `ensureBackingForAttach`; `tryResolveBackingHost`
   doc-comment in `materialized-view-helpers.ts` now cites the guard;
   `docs/materialized-views.md` gate section gains one paragraph).
2. **Defensive guard** in `attachMaintainedDerivation`
   (`materialized-view-helpers.ts`): capture `gateHostAbsent` (resolved against the
   pre-reshape `table`) *before* the gate registration (~line 1085); after the late
   seam + the single `resolveBackingHost(db, live)` (~line 1148), throw
   `StatusCode.INTERNAL` if `gateHostAbsent && host.requiresReplicableDerivations`. The
   throw is inside the existing `try`, so the catch runs `restorePrior()` /
   `discardBackingForAttach` cleanup and the table reverts to ordinary, untouched.
   Guard is **attach-only** — create-MV (`materializeView`) has the host present at
   gate time by construction, so the check would be dead there.
3. **Regression tests** added to `materialized-view-replicable.spec.ts` (5 new `it`s in
   a new `describe('attach-path gate + late-host defensive guard')`).

## Validation performed

- `yarn workspace @quereus/quereus test` → **6354 passing, 9 pending, 0 failing**.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → clean.
- **Guard proven load-bearing**: temporarily disabling the guard (`if (false && …)`)
  makes the builtin-only guard test fail with "Expected an error" (silent registration)
  and the nonrepl-companion fail on message mismatch; re-enabling restores green.

## Test/use-case map (what the new tests pin)

- **Attach-path FUNCTION reject** (`mt_fn`, `using repl`): `alter table … set
  maintained as select id, nonrepl(v) …` rejects via the gate (host eager/present);
  existing attach coverage was collation-only. Asserted with the existing
  `expectReplicableReject` shape (`cannot be materialized` / `nonrepl` / `replicable`;
  `getMaintainedTable` undefined).
- **Eager-host-with-late-seam** (`EagerDemandWithSeamModule`): gate fires at
  registration BEFORE the seam — `ensureBackingForAttach` spy stays empty on the reject,
  records exactly once on a builtin-only accept. Pins that gate firing does not depend
  on the absence of a late seam.
- **Defensive-guard reject, builtin-only** (`LateBackingModule(true)`, `mt_late`,
  `abs(v)`): canonical guard proof — body is builtin-only so the *only* possible reject
  is the guard; INTERNAL error names `requiresReplicableDerivations` / `plan-build
  time`; `getMaintainedTable` undefined; the seam ran (`ensured == ['main.mt_late']`).
- **Defensive-guard reject, nonrepl companion** (`mt_late2`): same late+demanding host,
  `nonrepl(v)` body — also rejects via the guard (asserts the guard message).
- **Negative control** (`LateBackingModule(false)`, `mt_late_ok`): lateness alone is
  inert — a `nonrepl(v)` body attaches fine on a non-demanding late host.

## Known gaps / things for the reviewer to probe (tests are a floor, not a ceiling)

- **The nonrepl-companion's failure mode without the guard is subtler than the ticket
  framed.** I found that with the guard disabled, the `mt_late2` nonrepl body does NOT
  silently slip — it still throws the *replicable* error, but from the **reshape
  re-registration** (`db.registerMaterializedView(live)` ~line 1180, reached because
  `nonrepl(v)`'s derived type differs from the declared `integer`, triggering an
  expressible retype reshape; that re-registration resolves the now-present host and
  fires the gate). So the reshape arm is an *incidental* second net — but **not a
  reliable one**: a non-replicable body whose derived shape *exactly* matches the
  declared columns (no reshape, no re-registration) on a late+demanding host would slip
  both the early gate and any re-registration, leaving the guard as the **sole** net.
  The builtin-only test is the canonical proof precisely because builtins pass the gate
  at every invocation. **Suggested hardening:** add a test with a non-replicable UDF
  whose return type is *declared* to match the pre-existing column exactly (no reshape),
  to demonstrate the true silent-slip case the guard uniquely catches. I did not add it
  because pinning a UDF's exact derived `logicalType` from the spec is fiddly; the
  reviewer may know the cleaner idiom.
- **Re-attach (`priorMaintained`) over a demanding host is not explicitly tested.**
  Reasoned safe: on re-attach the host is present from the prior attach, so
  `gateHostAbsent === false` and the guard never spuriously fires. A dedicated
  re-attach test would be stronger than the reasoning.
- **Reshape + late + demanding combination is not directly tested.** The guard sits
  after the single `resolveBackingHost(db, live)` and before the reconcile / post-
  reshape re-registration, so a reshaping late+demanding attach would throw the guard
  and the catch's `restoreReshaped(current)` path would run. Constructing a scenario
  that is simultaneously a reshape AND a genuinely-late host is awkward with the memory
  reference host; left to reasoning.
- **The guard is unreachable by any in-tree host** (memory/store/lamina all honor the
  eager-resolution invariant — lamina is late-but-non-demanding, the synced-store is
  demanding-but-eager). Only the synthetic `LateBackingModule(true)` exercises it. This
  is intentional (defense-in-depth against a future contract-violating host author), but
  means there is no production code path covering it.
- **Test-module type signatures:** `ensureBackingForAttach` is declared *without*
  `override` (it is an optional interface method not present on `MemoryTableModule`),
  while `getBackingHost` keeps `override` (the base declares it). Confirmed by the test
  type-check pass; worth a glance if the base class surface shifts.

## Edge cases confirmed (per the ticket's checklist)

- Create-MV asymmetry: create path still rejects via the *gate* (host present at gate
  time), guard absent there — existing create-path tests remain green.
- `pragma nondeterministic_schema` orthogonality: untouched (new tests don't exercise
  the pragma, and the guard/gate are both pragma-independent).
- Guard is a pure no-op on memory/store (`requiresReplicableDerivations` falsy) — the
  common path pays one already-resolved-host property read.
- `discardBackingOnFailure`: the test modules omit `discardBackingForAttach`, so the
  optional cleanup call after a guard throw is a no-op (the ticket sanctioned this).
