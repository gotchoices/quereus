description: lens-prover CHECK-domain use now goes through the central permitsGrandfatheredCheckViolators gate (getTrustedCheckExtraction); reviewed and completed.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # central gate: EMPTY_CHECK_EXTRACTION + getTrustedCheckExtraction; getCheckExtraction now module-internal
  - packages/quereus/src/planner/nodes/reference.ts                    # gate refactored onto the central accessor (behavior unchanged)
  - packages/quereus/src/schema/lens-prover.ts                         # both enumerableDomain call sites now go through the trusted accessor
  - packages/quereus/test/optimizer/check-fold-gated-by-capability.spec.ts  # central-accessor pin + lens-prover end-to-end gate
  - docs/lens.md                                                       # getput-lossy advisory row documents the basis-domain trust gate
  - docs/module-authoring.md                                           # capability table row names both consumers
----

# lens-prover CHECK-domain use bypassed the grandfathered-violators capability gate — implemented + reviewed

## What was built

The **central** option from the original ticket's open design question. A new
capability-aware accessor in `planner/analysis/check-extraction.ts`:

- `getTrustedCheckExtraction(tableSchema, vtabModule = tableSchema.vtabModule)`
  returns the shared exported `EMPTY_CHECK_EXTRACTION` when the module declares
  `permitsGrandfatheredCheckViolators: true`, else delegates to the raw
  extraction. The module param is a minimal structural `CapabilityProvider`
  (no dependency on `vtab/module.ts`), defaulting to the schema's own
  `vtabModule`; logical (lens-slot) tables carry no module and are never gated.

Consumers migrated to the accessor:

- `TableReferenceNode.computePhysical` (reference.ts) — passes its own module
  explicitly (resolved at construction, independent of the schema). Behavior
  unchanged.
- `lens-prover.ts` — both `enumerableDomain(...)` sites. The load-bearing one
  is the **basis** site in `proveForwardInjective`: a grandfathering basis
  module yields no enumerable domain, so the bijection proof conservatively
  fails and the `lens.getput-lossy` advisory stands (matching reference.ts's
  conservative direction). The logical-table site is a no-op gate today (no
  module) but keeps every prover read behind the seam.

## Review findings

Reviewed the implement diff (swept into commit `c04e512e` alongside ticket
6.2's work) with fresh eyes against the original `fix/` ticket's open design
question, then validated.

**Soundness — checked, no issues.**
- Basis gate (`proveForwardInjective`): under the cap the basis CHECK
  extraction is empty → `enumerableDomain` returns `undefined` → the
  injectivity/bijection proof returns `false` → the `lens.getput-lossy`
  advisory is **kept**. That is the conservative (safe) direction: keeping the
  advisory means "GetPut may be lossy", which is correct when grandfathered
  basis rows may sit outside the declared domain. Confirmed load-bearing:
  without the gate the cap-on test would suppress the advisory and fail.
- Logical-table gate (`provePutGetByEnumeration` over `ctx.table`): `ctx.table`
  is the logical lens spec (`isLogical`, `vtabModule` undefined), so the gate is
  a structural no-op. Sound regardless — the logical CHECK domain is a
  *declaration* the lens promises to maintain, a function-law property
  independent of any stored rows, so grandfathering does not apply. Both
  `ctx.table` and `ctx.basisSource` are `TableSchema`, so the default
  `tableSchema.vtabModule` resolution is correct for the basis site.

**Type safety / resource — checked, no issues.** `CapabilityProvider` is
structural and compatible with the optional `TableSchema.vtabModule`
(`AnyVirtualTableModule`) and the explicit `this.vtabModule` pass at the node.
`EMPTY_CHECK_EXTRACTION` is a shared singleton of `readonly` arrays; every
consumer (`enumerableDomain`, the `reference.ts` `addFd`/merge folds) reads
only — no mutation risk.

**Completeness — checked, one gap closed.**
- The original ticket's stated central-gate intent was "future consumers
  cannot forget it," but `getCheckExtraction` was left **exported**, leaving the
  bypass open. Verified no source consumer (only stale `dist/` bundles
  reference it) and **un-exported it** (now module-internal, with a docstring
  pointing future callers at the trusted accessor) — fixed inline this pass.
  This mechanically enforces the gate.
- Swept every other `.checkConstraints` reader (`constraint-builder`,
  `runtime/emit/{constraint-check,add-constraint,alter-table}`, `ddl-generator`,
  `func/builtins/schema`, catalog/manager/memory-layer): all are write-time
  enforcement, DDL generation, or storage — none derive optimizer/prover
  row-set value facts, so no other gating site is needed. Write-time CHECK
  enforcement is correct regardless of grandfathering (only pre-existing rows
  are grandfathered; forward writes are always enforced). Assertion-hoist and
  partial-UNIQUE are independent paths, documented as deliberately not gated by
  this flag (they concern ASSERTION/UNIQUE, not table-CHECK grandfathering).

**Docs — checked, accurate.** `docs/lens.md` (getput-lossy advisory row) and
`docs/module-authoring.md` (capability table row) both now name the trust gate
and both consumers, matching the code.

**Tests.** The implementer's spec covers the central-accessor unit pin
(cap absent vs cap on) and the lens end-to-end (`memory` control suppresses
`lens.getput-lossy`; the grandfathering module leaves it active, sited at the
authored column). Verified the lens test genuinely distinguishes the gate
(load-bearing, see above). No further test added — the existing matrix covers
happy path, cap-on suppression, and the end-to-end advisory interaction.

**Validation run (all green):**
- `getTrustedCheckExtraction` / capability-gate / lens-basis specs — 8 passing.
- Full `*.spec.ts` suite — 5910 passing, 9 pending, 0 failing.
- `--grep lens` (unit + sqllogic) — 461 passing.
- `tsc --noEmit` clean; `eslint` clean on touched files — both re-run after the
  un-export edit.

## Disposition

No major findings; no new tickets spawned. One minor finding (exported raw
accessor) fixed inline. The fix remains latent in production paths — no shipped
module declares `permitsGrandfatheredCheckViolators`; the spec's test double is
the only activation, by design.
