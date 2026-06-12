description: review the central permitsGrandfatheredCheckViolators gate (getTrustedCheckExtraction) and the lens-prover adoption of it.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # new central gate: EMPTY_CHECK_EXTRACTION + getTrustedCheckExtraction
  - packages/quereus/src/planner/nodes/reference.ts                    # gate refactored onto the central accessor (behavior unchanged)
  - packages/quereus/src/schema/lens-prover.ts                         # both enumerableDomain call sites now go through the trusted accessor
  - packages/quereus/test/optimizer/check-fold-gated-by-capability.spec.ts  # extended: central-accessor pin + lens-prover end-to-end gate
  - docs/lens.md                                                       # getput-lossy advisory row documents the basis-domain trust gate
  - docs/module-authoring.md                                           # capability table row updated to name both consumers
----

# lens-prover CHECK-domain use bypasses the grandfathered-violators capability gate — implemented

## What was built

The **central** option from the ticket's open design question. A new
capability-aware accessor in `planner/analysis/check-extraction.ts`:

- `getTrustedCheckExtraction(tableSchema, vtabModule = tableSchema.vtabModule)`
  returns the shared exported `EMPTY_CHECK_EXTRACTION` when the module declares
  `permitsGrandfatheredCheckViolators: true`, else delegates to
  `getCheckExtraction`. The module param is a minimal structural
  `CapabilityProvider` (no dependency on `vtab/module.ts`), defaulting to the
  schema's own `vtabModule` reference — logical (lens-slot) tables carry no
  module and are never gated.

Consumers:

- `TableReferenceNode.computePhysical` (reference.ts) now calls
  `getTrustedCheckExtraction(this.tableSchema, this.vtabModule)` — the module is
  passed **explicitly** because the node's module is resolved at construction
  (tests construct nodes with a module distinct from the schema's). The local
  `EMPTY_CHECK_EXTRACTION` const moved into check-extraction.ts. Behavior
  unchanged; the four pre-existing spec tests still pass.
- `lens-prover.ts` — both `enumerableDomain(getCheckExtraction(...))` sites
  (`provePutGetByEnumeration` over `ctx.table`, `proveForwardInjective` over
  `basis`) now use the trusted accessor with the schema-resolved module. The
  load-bearing change is the **basis** site: a grandfathering basis module
  yields no enumerable basis domain, so the forward-injectivity/bijection proof
  conservatively fails and the `lens.getput-lossy` advisory stands (matching
  reference.ts's conservative direction). The logical-table site is a no-op
  gate today (no module) but keeps every prover read behind the seam.

## Testing

Extended `test/optimizer/check-fold-gated-by-capability.spec.ts`:

- `getTrustedCheckExtraction` unit pin: schema-resolved module, cap absent
  (domain extracted) vs cap on (extraction empty wholesale).
- Lens end-to-end (mirrors `55.5-lens-authored-inverse.sqllogic` § 6, the
  bijective `upper(code)` / `lower(new.grp)` shape, deployed `over main` with
  a `using <module>` basis table): control on `memory` suppresses
  `lens.getput-lossy`; the grandfathering module leaves the advisory active,
  sited at the authored column.

Ran: the extended spec (8 passing), all lens unit specs (lens-prover, lens-ack,
lens-overrides, lens-fd-contribution, lens-foundation — 121 passing), lens
sqllogic suites via `logic.spec.ts --grep lens` (4 passing), the full
`test/optimizer/` folder (1362 passing), `tsc --noEmit` on both src and test
tsconfigs, and eslint on the four touched package files — all clean.

## Known gaps / reviewer notes

- `getCheckExtraction` remains exported (the trusted accessor and the cache
  live around it). A future consumer could still call it directly; the
  docstring now directs row-set-fact consumers to the trusted accessor, but
  nothing mechanically prevents the bypass.
- The PutGet **violation** path still enumerates the logical table's own CHECK
  domain ungated — sound (a `lens.putget-violation` is a function-law break
  independent of stored rows, and logical tables carry no module), but worth a
  fresh-eyes check.
- The end-to-end test deploys the lens `over main` with a `create table …
  using <module>` basis rather than a declared/applied basis schema (declared
  schemas have no `using` clause); confirm that's an acceptable harness shape.
- No shipped module declares the capability, so the fix stays latent in
  production paths — the spec's test double is the only activation.

NOTE for reviewer: the implement diff for this ticket is NOT under its own commit — a concurrent runner commit (c04e512e, "ticket(implement): maintained-table-attach-detach-verbs") swept these changes in along with ticket 6.2's work. Review the files named above within that commit.
