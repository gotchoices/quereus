description: Add a "replicable" determinism class for functions — bit-identical across peers/platforms/app-versions, stronger than the per-database determinism gate. UDFs opt in via `replicable: true`; builtins auto-qualify; a backing host declares `requiresReplicableDerivations`; create-time validation of an MV/derivation body rejects any non-replicable function when the resolved host demands it.
difficulty: hard
files:
  - packages/quereus/src/schema/function.ts                       # BaseFunctionSchema.replicable flag
  - packages/quereus/src/func/registration.ts                     # plumb `replicable` option onto schemas
  - packages/quereus/src/core/database.ts                         # createScalarFunction/createAggregateFunction option + builtin auto-stamp
  - packages/quereus/src/vtab/backing-host.ts                     # BackingHost.requiresReplicableDerivations
  - packages/quereus/src/core/database-materialized-views.ts      # create-time replicable walk in buildMaintenancePlan
  - packages/quereus/test/materialized-view-diagnostics.spec.ts   # pattern reference for a focused create-gate spec
  - docs/migration.md                                             # § Determinism requirements / § Current gaps (the spec)
  - docs/materialized-views.md                                    # create-time gate doc (add the replicable reject)
----

# Replicable determinism class

`docs/migration.md` § Determinism requirements is the spec. The engine's
existing create-time determinism gate means **"pure within this database"**
(`physical.deterministic`, propagated from leaves — rejected for an MV body
unless `pragma nondeterministic_schema`). A derivation whose backing replicates
across peers must additionally be **bit-identical across platforms and app
versions**: a UDF that case-folds/locale-sorts via the host JS engine is stable
on one machine yet platform-dependent, so two peers would derive different bytes
and never converge. "Replicable" is that stronger class.

The class is **inert by default**. Memory and store hosts declare no
requirement, so an ordinary `create materialized view … using memory` sees zero
behavior change. It activates only for a host that opts in (the future
sync-store module), which is why this ships safely ahead of the rest of the sync
roadmap.

## Design (resolved — no open questions)

### 1. The flag on the function schema

Add an optional `replicable?: boolean` to `BaseFunctionSchema`
(`schema/function.ts`), alongside the existing `flags`. Semantics: `true` ⇒ the
function is asserted bit-identical across platforms/app-versions; absent/`false`
⇒ not asserted (the conservative default for a UDF). It is **orthogonal** to the
`DETERMINISTIC` flag — replicability only matters for a function that is already
deterministic, and the determinism gate handles non-determinism independently.

### 2. Builtins auto-qualify

Builtins are registered through one seam — `Database.registerBuiltinFunctions`
(`core/database.ts`, the `BUILTIN_FUNCTIONS.forEach`). Stamp `replicable: true`
there (spread a copy: `mainSchema.addFunction({ ...funcDef, replicable: true })`
— do **not** mutate the shared exported `BUILTIN_FUNCTIONS` constants in place).
This is the single point that *knows* a schema is a builtin, so we get
auto-qualification without editing ~100 builtin definitions and without
defaulting UDFs to replicable. Rationale: Quereus implements its own collation /
case-folding / numeric formatting, so a deterministic builtin cannot drift
between peers' JS engines.

Non-deterministic builtins (`random`, `now`, …) are stamped replicable too — it
is harmless because the determinism gate rejects them first; replicability is a
secondary class that only bites a function that *is* deterministic.

Window functions live in a separate registry (`schema/window-function.ts`,
`WindowFunctionSchema`) with **no user-defined registration path** — they are
builtin-only and therefore inherently replicable. The body walk (below) only
inspects nodes that carry a scalar/aggregate/TVF `FunctionSchema`, so window
nodes are never flagged; document this rather than add a window check.

### 3. UDF opt-in

- `func/registration.ts`: add `replicable?: boolean` to `ScalarFuncOptions`,
  `TableValuedFuncOptions`, `AggregateFuncOptions`, and copy it onto the
  returned schema in `createScalarFunction` / `createTableValuedFunction` /
  `createIntegratedTableValuedFunction` / `createAggregateFunction`.
- `core/database.ts`: add `replicable?: boolean` to the `options` of
  `Database.createScalarFunction` and `Database.createAggregateFunction`, pass
  it through. `Database.registerFunction(schema)` already passes a full schema
  through, so a `replicable: true` field on a hand-built schema is honored with
  no change.

### 4. Host-declared requirement

Add to the `BackingHost` interface (`vtab/backing-host.ts`):

```ts
/** When true, the engine validates at create that every function in a
 *  materialized-view / derivation body hosted here is REPLICABLE (declared
 *  bit-identical across peers/platforms/app-versions — builtins auto-qualify).
 *  A host whose backing replicates (the sync-store) demands it so a
 *  platform-dependent UDF cannot diverge peers. Absent/false ⇒ no requirement
 *  (memory, store) ⇒ zero behavior change. NOT escapable by
 *  `pragma nondeterministic_schema` — that lifts the per-database determinism
 *  gate, a separate and weaker concern; a replicating host's bit-identity
 *  requirement cannot be locally waived without breaking convergence. */
readonly requiresReplicableDerivations?: boolean;
```

The memory reference host (`vtab/memory/module.ts` `MemoryBackingHost`) and the
store host (`quereus-store/src/common/backing-host.ts`) leave it `undefined` —
no edit needed beyond the interface (optional field). Document on the
`backing-host.ts` header (add a short `## Replicable-determination requirement`
section) that this is an opt-in capability declaration consumed only at create.

### 5. Create-time validation

The single choke point is `MaterializedViewManager.buildMaintenancePlan`
(`core/database-materialized-views.ts:1432`) — it runs for **every** MV
registration (create, source-ALTER re-register, catalog import/rehydrate),
already analyzes the body (`analyzed: BlockNode`), and already throws on an
ineligible body. Add the replicable gate there, after `analyzed` is built and
**before** arm selection so it applies regardless of which maintenance arm wins:

```ts
const host = this.backingHost(mv);              // existing private helper, line ~1361
if (host.requiresReplicableDerivations) {
  const offending = findNonReplicableFunction(analyzed);
  if (offending) throw nonReplicableDerivationError(mv.name, offending);
}
```

- `findNonReplicableFunction(node)` — a recursive `getChildren()` walk (mirror
  `findNonDeterministic`, line ~3162) that, for any node exposing a
  `functionSchema: FunctionSchema` whose `returnType.typeClass` is scalar /
  relation / aggregate (i.e. scalar `function.ts`, aggregate
  `aggregate-function.ts`, TVF `table-function-call.ts` + `reference.ts`
  `TableFunctionReferenceNode`), returns the function NAME when
  `functionSchema.replicable !== true`. Use a structural check
  (`'functionSchema' in node`) so it covers all four node kinds uniformly. Walk
  the **analyzed** plan (same plan the determinism gate uses) so nested calls
  (UDF inside builtin inside UDF), WHERE/GROUP BY/aggregate-arg/TVF-arg
  positions are all reached.
- `nonReplicableDerivationError(mvName, fnName)` — a **dedicated** error (do NOT
  reuse `cannotMaterialize`, whose "use a plain view / create table as" steering
  is wrong here). `StatusCode.UNSUPPORTED`. Wording must name the function and
  steer to the fix, e.g.: *"materialized view 'X' cannot be materialized on this
  backing host: it calls non-replicable function 'fn'. This host requires every
  function in the body to be bit-identical across peers/platforms; declare the
  function `replicable: true` at registration (built-in functions qualify
  automatically)."*

This sits next to — not replacing — the determinism gate. The two are
independent: a replicable-host body is already required deterministic (the floor
/ per-arm determinism rejects), so the only *new* check is the class, satisfying
the migration doc's "enforce the derived-identity rule where cheap".

## Edge cases & interactions

- **Inert host (memory/store).** `requiresReplicableDerivations` absent ⇒ the
  whole block is skipped ⇒ a non-replicable UDF in an MV `using memory` still
  creates. This is the load-bearing "zero behavior change" property — test it.
- **Builtin-only body on a demanding host** → passes (auto-qualified).
- **Non-replicable UDF anywhere** on a demanding host → rejects. Cover each
  position independently: projection column, WHERE predicate, GROUP BY key,
  aggregate argument, and a TVF (lateral) call — each carries a `functionSchema`
  on a distinct node kind, so a walk that misses one is a silent gap.
- **Declared-replicable UDF** on a demanding host → passes.
- **Nested calls.** `udf_outer(upper(udf_inner(x)))` — the walk must flag the
  innermost/outermost non-replicable call; recursion through all scalar args is
  mandatory.
- **`pragma nondeterministic_schema` does NOT lift the replicable gate.** A test
  must set the pragma (lifting the determinism reject) and confirm a
  non-replicable UDF on a demanding host still rejects — the two gates are
  orthogonal.
- **Re-registration / catalog import.** `buildMaintenancePlan` re-runs on
  source-ALTER re-register and on `importMaterializedView` (even the
  adopt-without-refill path runs `registerMaterializedView`). The gate is
  idempotent (same body ⇒ same verdict) and *desirable* on import: a tampered
  catalog cannot smuggle a non-replicable body past a demanding host. Confirm an
  import/rehydrate of a demanding-host MV does not spuriously reject a
  builtin-only body.
- **MV-over-MV.** A consumer MV reads another MV's *backing table* (a
  `TableReference`, not a function), so only the consumer's own body functions
  are walked — correct; the source MV was validated at its own create.
- **Window functions** — builtin-only, separate schema type, no UDF path ⇒
  inherently replicable; the walk does not (and must not) flag them.
- **Custom collations** registered by an embedder *could* drift across peers and
  are NOT covered here (the gate is functions-only, per the spec's wording
  "every function in the body"). This is out of scope — see the parked backlog
  note `replicable-collation-class` if collation replicability becomes a
  requirement.
- **Aggregate/TVF schema detection.** `aggregate-function.ts`,
  `table-function-call.ts`, and `reference.ts` `TableFunctionReferenceNode` all
  expose `functionSchema`; the structural `'functionSchema' in node` test covers
  them without per-type imports.

## Key tests (TDD)

A focused spec modeled on `test/materialized-view-diagnostics.spec.ts` (sqllogic
cannot register UDFs or custom hosts). Define a small test host: a
`MemoryTableModule` subclass whose `getBackingHost` returns a `BackingHost`
delegating to the memory host but with `requiresReplicableDerivations = true`,
registered as e.g. `repl`. Then:

- builtin-only body `using repl` → registers (no reject).
- a non-replicable scalar UDF in a `using repl` body → throws; message contains
  the function name AND `replicable`.
- the same UDF re-registered with `replicable: true` → `using repl` create
  succeeds.
- the non-replicable UDF in a `using memory` body → succeeds (no requirement) —
  the inert-by-default assertion.
- non-replicable UDF in WHERE / GROUP BY / aggregate-arg / a lateral TVF arg →
  each rejects (one case each).
- `pragma nondeterministic_schema = true` does not lift the reject for a
  non-replicable UDF on `using repl`.
- direct-schema path: `db.registerFunction({ …, replicable: true })` →
  `using repl` create succeeds.

## TODO

- `schema/function.ts`: add `replicable?: boolean` to `BaseFunctionSchema` (doc
  comment: stronger-than-deterministic, bit-identical across peers/platforms).
- `func/registration.ts`: add `replicable?` to the three `*FuncOptions` and copy
  onto the returned schema in all four `create*Function` helpers.
- `core/database.ts`: add `replicable?` to `Database.createScalarFunction` and
  `createAggregateFunction` options and plumb through; stamp builtins
  `replicable: true` in `registerBuiltinFunctions` via a spread copy.
- `vtab/backing-host.ts`: add `readonly requiresReplicableDerivations?: boolean`
  to `BackingHost` with the doc comment above; add a short header section.
- `core/database-materialized-views.ts`: add `findNonReplicableFunction` (walk)
  + `nonReplicableDerivationError` (dedicated error), and the guarded check in
  `buildMaintenancePlan` after `analyzed` and before `tryBuildBoundedDeltaArm`.
- Add the focused spec (test host + the cases above).
- Docs: add the replicable reject to `docs/materialized-views.md`'s create-time
  gate section; tick the "Replicable determinism class" item in
  `docs/migration.md` § Current gaps and point § Determinism requirements at the
  implemented surface.
- Validate: `yarn workspace @quereus/quereus run lint` and `yarn test` (stream
  with `tee`). Run the new spec explicitly.
