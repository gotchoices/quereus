description: The "replicable" determinism class — a function flag (builtins auto-qualify, UDFs opt in), a host-declared `requiresReplicableDerivations` capability, and a host-conditional create-time MV gate that rejects any non-replicable function in a derivation body. Inert by default; exercised via a test host.
files:
  - packages/quereus/src/schema/function.ts                       # BaseFunctionSchema.replicable flag
  - packages/quereus/src/func/registration.ts                     # replicable on the 3 *FuncOptions + 4 create*Function helpers
  - packages/quereus/src/core/database.ts                         # createScalar/AggregateFunction option + builtin auto-stamp
  - packages/quereus/src/vtab/backing-host.ts                     # BackingHost.requiresReplicableDerivations + header section
  - packages/quereus/src/core/database-materialized-views.ts      # findNonReplicableFunction walk + nonReplicableDerivationError + gate in buildMaintenancePlan
  - packages/quereus/test/materialized-view-replicable.spec.ts    # focused spec (now 13 cases)
  - docs/migration.md                                             # § Determinism requirements + § Current gaps
  - docs/materialized-views.md                                    # create-time gate (replicable reject)
----

# Replicable determinism class — completed

A stronger-than-deterministic function class ("replicable" = asserted bit-identical across
peers/platforms/app-versions) plus a host-conditional create-time MV gate that rejects any
non-replicable function in a derivation body when the backing host declares
`requiresReplicableDerivations`. **Inert by default**: no in-tree host sets the flag, so an
ordinary `using memory`/`using store` MV sees zero behavior change; the future sync-store is
the intended consumer. Builtins auto-qualify (Quereus owns its collation / case-folding /
numeric formatting); UDFs opt in with `replicable: true` at registration. Orthogonal to the
determinism gate — not lifted by `pragma nondeterministic_schema`.

## What shipped (unchanged from implement, all verified)

1. `BaseFunctionSchema.replicable?: boolean` (`schema/function.ts`).
2. Builtins auto-stamped via a spread copy `{ ...funcDef, replicable: true }` in
   `Database.registerBuiltinFunctions` (the shared `BUILTIN_FUNCTIONS` constants are not mutated).
3. UDF opt-in: `replicable?` on `ScalarFuncOptions` / `TableValuedFuncOptions` /
   `AggregateFuncOptions` and copied onto the schema in all four `create*Function` helpers;
   `Database.createScalarFunction` / `createAggregateFunction` options plumb it through;
   `registerFunction(schema)` honors a hand-built `replicable: true`.
4. `BackingHost.requiresReplicableDerivations?: boolean` capability declaration.
5. Create-time gate in `buildMaintenancePlan` — `findNonReplicableFunction(analyzed)` (a
   `getChildren()` walk using the structural `'functionSchema' in node` test) +
   `nonReplicableDerivationError(mv, fn)` (a dedicated `UNSUPPORTED` error that does NOT steer
   to a plain view), placed **before arm selection** so it applies to every maintenance arm.

## Review findings

### Scope of review
Read the implement diff (`git show 0b68ed9f`) with fresh eyes before the handoff. Verified the
function-bearing node set against the code (`functionSchema` is declared `public readonly`
non-optional on exactly: scalar `function.ts`, aggregate `aggregate-function.ts`, TVF call
`table-function-call.ts`, and **two** classes in `reference.ts` — the structural
`'functionSchema' in node` test covers all of them regardless of count, with no false-undefined
since the field is non-optional). Confirmed the gate's call site, the new host-resolution surface,
docs accuracy across all touched files, lint, and the full test suite.

### Correctness / design — no major issues
- **Gate placement is correct and arguably better than the determinism gate's.** The replicable
  gate sits before `tryBuildBoundedDeltaArm`, so it runs for *every* arm. (Note for context: the
  existing `findNonDeterministic` determinism gate only runs inside the full-rebuild floor at
  `buildFullRebuildPlan` line ~2110 — so a bounded-delta-shaped body's determinism is gated in the
  arm builders, not there. This is pre-existing and out of scope; the replicable gate does *not*
  inherit that arm-dependence, which is the safer design.)
- **New host-resolution surface acknowledged and safe.** The gate adds a `this.backingHost(mv)`
  (→ `resolveBackingHost`) call into plan-building, where previously the host was resolved only in
  row-time maintenance-apply paths. `resolveBackingHost` throws `INTERNAL` only if the module lacks
  the backing-host capability or doesn't know the table — by construction the backing exists at
  `registerMaintenancePlan` time. The full suite (6272) exercises this for memory with no
  regression. **Caveat (not chased):** `yarn test` is memory-only; the store backing-host's
  create-time resolution under this new call was not exercised by `yarn test`. Low risk (store
  leaves the flag undefined, so it's a single map lookup + host object per registration, not per
  row), but a `yarn test:store` run is the out-of-band confirmation if a release wants it.
- **`'functionSchema' in node` is robust** to false positives (only the four/five function node
  kinds declare it) and false negatives (field is non-optional ⇒ always defined). Traversal order
  returns the innermost offending UDF for nested calls (verified by the new nested-UDF test).
- **Error wording** names the function, says `replicable`, says built-ins qualify, and does not
  steer to a plain view — distinct from `cannotMaterialize`. Verified.
- **MV-over-MV, re-register/import idempotence, window functions, collations** — reviewed the
  handoff's arguments against the code and concur; all out of scope or correct by construction.

### Minor findings — fixed inline this pass
- **Doc typo** (`vtab/backing-host.ts`): section header read "Replicable-**determination**
  requirement"; corrected to "Replicable-**determinism**" (comment-only).
- **Test coverage hardened** (`test/materialized-view-replicable.spec.ts`, 10 → 13 cases) — the
  handoff flagged these as plumbing pinned by types but not by behavior:
  - **Nested UDF inside a builtin arg** (`abs(nonrepl(v))`): confirms the walk recurses into
    builtin arguments and names the inner UDF (not the outer replicable builtin).
  - **Non-replicable aggregate UDF** rejects (names the function) **and** a replicable aggregate
    UDF accepts — pins the `createAggregateFunction(replicable)` plumbing behaviorally.
  - **Non-replicable TVF UDF** (the TVF node's *own* `functionSchema`, distinct from a scalar UDF
    inside a builtin TVF's arg) rejects; the replicable TVF asserts it is not rejected *for
    replicability* (its keyless-bag body is rejected by the separate `cannotMaterialize` gate,
    which is itself proof the replicable gate let it through).

### Major findings — none
No new fix/plan/backlog tickets filed. The one parked future item, **`replicable-collation-class`**
(collation replicability if it ever becomes a requirement), remains correctly unfiled — there is no
concrete requirement, and the gate is functions-only by spec.

### Validation
- `yarn workspace @quereus/quereus run lint` — clean, exit 0 (eslint + `tsc -p tsconfig.test.json`).
- `yarn test` (all workspaces) — **6272 passing** in the quereus suite (was 6269; +3 new cases),
  every other workspace green, exit 0. No regressions.
- Focused spec run explicitly — **13 passing**.
