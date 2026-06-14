description: Review the "replicable" determinism class — a function flag (builtins auto-qualify, UDFs opt in), a host-declared `requiresReplicableDerivations` capability, and a host-conditional create-time MV gate that rejects any non-replicable function in a derivation body. Inert by default (no in-tree host demands it yet); exercised via a test host.
files:
  - packages/quereus/src/schema/function.ts                       # BaseFunctionSchema.replicable flag
  - packages/quereus/src/func/registration.ts                     # replicable on the 3 *FuncOptions + 4 create*Function helpers
  - packages/quereus/src/core/database.ts                         # createScalar/AggregateFunction option + builtin auto-stamp
  - packages/quereus/src/vtab/backing-host.ts                     # BackingHost.requiresReplicableDerivations + header section
  - packages/quereus/src/core/database-materialized-views.ts      # findNonReplicableFunction walk + nonReplicableDerivationError + gate in buildMaintenancePlan
  - packages/quereus/test/materialized-view-replicable.spec.ts    # new focused spec (10 cases)
  - docs/migration.md                                             # § Determinism requirements + § Current gaps
  - docs/materialized-views.md                                    # create-time gate (replicable reject)
----

# Replicable determinism class — review handoff

## What the spec asked for

`docs/migration.md` § Determinism requirements is the spec. A derivation hosted on a
backing that **replicates across peers** must be **bit-identical across platforms and app
versions** — strictly stronger than the engine's existing per-database determinism gate
(`physical.deterministic`). "Replicable" is that stronger class. It is **inert by default**:
only a backing host that opts in (the future sync-store) activates the gate, so an ordinary
`create materialized view … using memory` sees zero behavior change.

## What landed

1. **`BaseFunctionSchema.replicable?: boolean`** (`schema/function.ts`) — orthogonal to the
   `DETERMINISTIC` flag. `true` ⇒ asserted bit-identical across peers/platforms/app-versions;
   absent/`false` ⇒ not asserted (the conservative UDF default).

2. **Builtins auto-qualify** (`core/database.ts` `registerBuiltinFunctions`) — stamped
   `replicable: true` via a **spread copy** `{ ...funcDef, replicable: true }` (the shared
   exported `BUILTIN_FUNCTIONS` constants are NOT mutated). Single seam that knows a schema is
   a builtin. Non-deterministic builtins (`random`, `now`) are stamped too — harmless, the
   determinism gate rejects them first.

3. **UDF opt-in** (`func/registration.ts`) — `replicable?` added to `ScalarFuncOptions`,
   `TableValuedFuncOptions`, `AggregateFuncOptions` and copied onto the schema in all four
   `create*Function` helpers. `core/database.ts` `createScalarFunction`/`createAggregateFunction`
   options plumb it through. `registerFunction(schema)` honors a hand-built `replicable: true`
   with no change.

4. **Host capability** (`vtab/backing-host.ts`) — `readonly requiresReplicableDerivations?: boolean`
   on `BackingHost`, with a `## Replicable-determination requirement` header section. Memory and
   store hosts leave it `undefined` (no edit needed beyond the optional field).

5. **Create-time gate** (`core/database-materialized-views.ts`) — in `buildMaintenancePlan`,
   **after** `analyzed` is built and **before** arm selection (`tryBuildBoundedDeltaArm`), so it
   applies regardless of which maintenance arm wins:
   - `findNonReplicableFunction(node)` — a `getChildren()` walk mirroring `findNonDeterministic`,
     using the structural `'functionSchema' in node` test to cover all four function-bearing node
     kinds (scalar, aggregate, TVF call, TVF reference) uniformly; returns the function NAME when
     `functionSchema.replicable !== true`.
   - `nonReplicableDerivationError(mvName, fnName)` — a **dedicated** `StatusCode.UNSUPPORTED`
     error (does NOT reuse `cannotMaterialize`, whose "use a plain view" steering is wrong here);
     names the function and steers to `replicable: true` at registration.
   - Resolves the host via the existing `this.backingHost(mv)` (`MaintainedTableSchema` IS the
     backing `TableSchema`).

## Validation done

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json`, so
  the new spec's call sites are type-checked too). Exit 0.
- `yarn test` (full quereus suite) — **6269 passing, 9 pending**, exit 0, no regressions.
- New spec `test/materialized-view-replicable.spec.ts` run explicitly — **10 passing**. It
  defines a `repl` test host (memory host with `requiresReplicableDerivations = true`) and covers:
  builtin-only body accepts; non-replicable scalar UDF in a **projection** rejects (message names
  the function AND `replicable`); same shape with a **declared-replicable** UDF accepts; the
  non-replicable UDF `using memory` **accepts** (inert-by-default); non-replicable UDF in **WHERE**,
  **GROUP BY**, **aggregate-arg**, and a **lateral TVF arg** each reject; `pragma
  nondeterministic_schema` does **not** lift the reject; and the direct `registerFunction({ …,
  replicable: true })` path accepts.

## Use cases / behaviors to validate

- **Inert default** (load-bearing): any existing `using memory` / `using store` MV is unchanged —
  the gate block is skipped when the host declares no requirement. Confirm no row-time path was
  touched (the gate is create/register-only, not per-row).
- **Each body position** carries a `functionSchema` on a *distinct* node kind; a walk that misses
  one is a silent gap. All five (projection, WHERE, GROUP BY, aggregate-arg, TVF-arg) are tested.
- **Orthogonality**: a replicable-host body is already required deterministic, so the only *new*
  check is the class. `pragma nondeterministic_schema` lifts the determinism gate but NOT this one.
- **Error wording**: names the function, says `replicable`, says "built-in functions qualify
  automatically", and does NOT steer to a plain view (distinct from `cannotMaterialize`).

## Known gaps / things a reviewer should poke at (tests are a floor, not a finish line)

- **No in-tree host demands it yet.** `requiresReplicableDerivations = true` exists only on the
  spec's *future* sync-store; the gate is exercised solely through the test host. The production
  demanding host is out of scope for this ticket (the rest of the sync roadmap). Nothing in the
  shipped tree sets the flag, so the gate is dormant in real usage — intended.
- **Nested calls not separately tested.** The ticket calls out `udf_outer(upper(udf_inner(x)))`.
  The walk recurses through all scalar args (same recursion as `findNonDeterministic`), and the
  single-UDF positions are tested, but no explicit *nested*-UDF case was added. Low risk (the
  recursion is shared and proven), but a 2-line nested case would harden it — consider adding.
- **Aggregate-UDF and TVF-UDF `replicable: true` opt-in paths are type-checked but not
  behaviorally gated in a test.** The aggregate-arg test uses `sum(nonrepl(v))` where `nonrepl`
  is a *scalar* UDF (the aggregate node is the builtin `sum`); the TVF-arg test uses a scalar UDF
  inside a builtin TVF's argument. So the `createAggregateFunction(..., replicable)` and
  `createTableValuedFunction(..., replicable)` plumbing in `registration.ts` is covered by
  lint/types but no test creates a *non-replicable aggregate UDF* or a *non-replicable TVF* and
  watches the gate reject it. Worth a couple of cases if the reviewer wants the plumbing pinned
  behaviorally, not just structurally.
- **MV-over-MV** argued correct (a consumer reads the source MV's *backing table* — a
  `TableReference`, not a function — so only the consumer's own body functions are walked; the
  source MV was validated at its own create). Not separately tested.
- **Re-registration / catalog import idempotence** argued (same body ⇒ same verdict; desirable on
  import so a tampered catalog can't smuggle a non-replicable body past a demanding host). Not
  separately tested — `buildMaintenancePlan` re-runs on source-ALTER re-register and
  `importMaterializedView`, but no test drives an import against a demanding host.
- **Host resolution moved earlier.** The gate calls `this.backingHost(mv)` on *every*
  `buildMaintenancePlan` (create / re-register / import), including non-demanding hosts — one map
  lookup + a fresh host object per registration (NOT per row). Negligible, but confirm it can't
  throw on a path where the backing isn't yet in the module (existing arms already
  `_findTable(mv.name, …)` at the same point, so the backing is present by construction).
- **Custom collations are out of scope** (the gate is functions-only, per the spec wording). If
  collation replicability ever becomes a requirement, that is the parked `replicable-collation-class`
  backlog note — not filed yet (no concrete requirement).
- **Window functions** are builtin-only (separate `WindowFunctionSchema` registry, no UDF path)
  and inherently replicable; the walk does not (and must not) flag them. Documented; no test (no
  window-UDF registration path exists to write a negative case against).
