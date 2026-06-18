description: Reviewed and accepted a safety check (plus tests) that stops materialized views from quietly skipping a cross-device portability guard in one rare backing-store setup.
files:
  - packages/quereus/src/vtab/backing-host.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/materialized-view-replicable.spec.ts
  - docs/materialized-views.md
difficulty: medium
----

# Complete: defensive guard + coverage for the lenient backing-host gate resolution

## What was implemented (carried from the implement stage)

The MV **replicable-determinism gate** rejects a non-replicable FUNCTION/COLLATION in
a derivation body when the backing host declares `requiresReplicableDerivations`. On
the `alter table … set maintained` ATTACH path the gate runs at maintenance-plan
registration, which fires **before** a module's late durable-backing seam
(`ensureBackingForAttach`). There the host is resolved **leniently** via
`tryResolveBackingHost` (returns `undefined` → gate skipped) when no host exists yet —
sound only by the invariant that a host demanding replicable derivations resolves its
`getBackingHost` capability *eagerly*. The change closes the gap three ways:

1. **Contract documented** — normative eager-resolution invariant on
   `backing-host.ts` (`requiresReplicableDerivations`), cross-referenced on `module.ts`
   (`ensureBackingForAttach`) and the `tryResolveBackingHost` JSDoc; one paragraph in
   `docs/materialized-views.md`.
2. **Defensive guard** in `attachMaintainedDerivation` — captures `gateHostAbsent`
   (resolved against the pre-reshape `table`) before the gate registration, then after
   the late seam + the single `resolveBackingHost(db, live)` throws
   `StatusCode.INTERNAL` if `gateHostAbsent && host.requiresReplicableDerivations`. The
   throw is inside the existing `try`, so the catch runs the normal rollback and the
   table reverts to ordinary.
3. **Regression tests** — 5 new `it`s in a new `describe('attach-path gate + late-host
   defensive guard')` in `materialized-view-replicable.spec.ts`.

## Review findings

### Validation re-run (independent)

- **Full suite** (`yarn workspace @quereus/quereus test`, memory-backed): **6354
  passing, 9 pending, 0 failing** — matches the implementer's report. No failures
  filtered out (`Select-String failing|AssertionError|Error:` → none).
- **Lint** (`yarn workspace @quereus/quereus lint` — eslint + `tsc -p
  tsconfig.test.json`): **clean (exit 0)**, before and after my edit.
- **New tests**: all 5 pass under the project runner (ts-node loader).

### Correctness — checked, sound

- **Guard capture-point equivalence.** `gateHostAbsent` resolves against `table`; the
  gate inside `buildMaintenancePlan`/`registerMaterializedView` resolves against the
  `maintained` record. Confirmed equivalent: `tryResolveBackingHost` →
  `module.getBackingHost(db, schemaName, name)` keys only on schema+name, never the
  shape (read `materialized-view-helpers.ts:2438` and
  `database-materialized-views.ts:1465`). Both records share schema/name/module, so the
  two resolutions agree.
- **Guard is single-sited after the sole `resolveBackingHost(db, live)`** and before the
  post-reshape re-registration, so it covers the reshape arm; the throw lands in the
  existing `try`, and the catch's `restorePrior()` / `restoreReshaped(current)` /
  `discardBackingForAttach` cleanup runs correctly per branch (verified against
  `materialized-view-helpers.ts:1203-1224`).
- **Gate-vs-guard separation in the tests.** The builtin-only guard test (`mt_late`,
  `abs(v)`) is the canonical proof: a builtin body passes the gate at every invocation,
  so the *only* possible reject is the guard. Reasoned through the no-guard counterfactual
  and it matches the implementer's honest note — `mt_late2`'s nonrepl body, without the
  guard, would instead throw the *replicable* error from the reshape re-registration, so
  `expectGuardReject` (asserts `'plan-build time'`) still detects guard removal. With the
  guard present, the guard fires first (before line 1201 re-registration). Consistent.

### Regression risk — checked, none

- **No in-tree host is both late and demanding.** Searched all of `packages/` (ex-dist,
  ex-test): no `src` module sets `requiresReplicableDerivations` (only doc references),
  and `quereus-store`/`quereus-isolation` forward `getBackingHost` eagerly
  (`isolation-module.ts:200-204`). The guard is therefore pure defense-in-depth against
  a future contract-violating host author — it cannot fire for any shipping host, so it
  introduces no behavior change on the common path (one already-resolved-host property
  read).

### Findings fixed in this pass (minor)

- **TS parameter property removed (convention + portability).** `LateBackingModule`
  used `constructor(private readonly demanding: boolean)` — a TypeScript parameter
  property. This form appears **nowhere else** in `packages/quereus` (0 occurrences in
  `src` or `test`; the codebase consistently declares fields explicitly), and it fails
  under Node's native strip-only type stripping (only ts-node tolerates it — a direct
  `mocha` invocation errored `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` until I switched to the
  project runner). Converted to an explicit field + constructor assignment matching the
  rest of the codebase. Re-ran the 5 tests + full lint: green. No functional change.

### Findings deferred / judged adequate (not blocking, no new ticket)

- **Implementer's suggested "no-reshape non-replicable UDF" hardening test — judged
  redundant, not added.** The guard branch is **body-agnostic** (`gateHostAbsent &&
  host.requiresReplicableDerivations` — it never inspects the body). The existing
  builtin-only test already exercises exactly that branch with no reshape, so a
  non-replicable-no-reshape variant would cover the *same* guard code, adding semantic
  documentation but no new path. Left out deliberately.
- **Re-attach / reshape+late+demanding combinations not directly tested.** Reasoned safe
  (re-attach ⇒ `priorMaintained` ⇒ host already present ⇒ `gateHostAbsent === false` ⇒
  guard never fires; reshape+late+demanding ⇒ guard throws before re-registration and
  `restoreReshaped` runs). Constructing a genuinely-late *and* reshaping synthetic host
  over the memory reference is awkward; the reasoning is sound and the cleanup branches
  are exercised elsewhere. Not worth a ticket.

### Docs — checked

- The four code/doc touchpoints (`backing-host.ts`, `module.ts`,
  `materialized-view-helpers.ts` JSDoc, `docs/materialized-views.md`) are mutually
  consistent and accurately describe the new guard + invariant.
- **Pre-existing gap noted (out of scope, no ticket):** `docs/module-authoring.md` — the
  host-authoring doc — does **not** document the late-backing seam family at all
  (`ensureBackingForAttach` / `discardBackingForAttach` / `retireBackingForAttach` /
  `requiresReplicableDerivations` are absent). The new normative invariant lives on the
  interface JSDoc (`backing-host.ts`), which is the canonical place a host author
  consults, so this ticket is complete as-is. Documenting the whole seam family in
  module-authoring.md is a broader, independent doc task — flagged here rather than filed,
  since adding only the sub-invariant there would be orphaned without the seam context.

### Empty categories

- **Major findings → new tickets: none.** The guard is correct, load-bearing (proven by
  the implementer's `if (false && …)` experiment and re-confirmed by reasoning), and
  carries no regression risk for shipping hosts. Nothing rose above minor.
- **Error-path / resource-cleanup defects: none found.** The throw reuses the existing
  rollback machinery; cleanup branches (`restorePrior` / `restoreReshaped` /
  `discardBackingForAttach`) were traced and are correct for the guard's throw site.
