description: Collapse the bespoke SharedKeyGenerator surrogate mechanism into the engine's existing column-default + equivalence-class machinery, plus one new per-row ordinal context primitive. Tear out the parallel generator type/strategy/tags/mint. Defaults only — the basis author declares whatever generator they want; the engine just evaluates it once per produced row and threads it via the EC.
files: packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/func/builtins/, packages/quereus/src/func/registration.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md, docs/architecture.md

## Background — why this change

A multi-table write-through (a two-table key-preserving inner-join insert, or an n-way
lens decomposition insert) needs a shared key that lives in neither the logical row nor
any single base table, **generated once per produced row and threaded into every member**
of the fan-out. The mechanism that shipped to satisfy this introduced a dedicated
`SharedKeyGenerator` type (`strategy: 'integer-auto' | 'uuid7' | 'callback'`,
`cadence: 'per-row' | 'per-statement'`, optional `expr`) carried on the advertisement's
`SharedKey` descriptor, with only the `integer-auto` strategy actually wired — a
`seed + ordinal` computation (`seed = max(anchor.key)`) baked into the runtime emitter.
Non-integer / declared-default generators are rejected at plan time.

That mechanism is a parallel re-encoding of concepts the engine already has, and it is the
wrong altitude:

- `strategy: 'callback'` + `expr` **is** a column `default` expression.
- `strategy: 'integer-auto'` is a default the engine *invented* because the basis author
  didn't declare one — the engine choosing an ID policy it has no business choosing.
- `cadence` **is** the existing mutation-context per-row / per-statement cadence.
- `SharedKey.kind: surrogate | logical-tuple` **is** a coverage fact ("is this key column
  also a logical column?") the lens already tracks.

The engine already specifies the correct policy: the synthesized decomposition join (and any
authored join) puts the members' key columns in **one equivalence class**, and the
insert-defaulting chain (`docs/view-updateability.md` § Per-Operator Semantics → Projection)
already has **EC propagation** (step 4) and **column-default-via-envelope** (step 6, which
explicitly says it "threads the one captured value through every branch" for a shared join
key). The `SharedKeyGenerator` path bypasses that chain with a narrower, redundant one.

## Target design — defaults only, plus a per-row ordinal context

The shared key becomes an ordinary defaulted column. There is **one** policy:

1. **Source the value from the anchor key column's declared `default`.** The advertisement's
   `anchorRelationId` already names the member whose key column originates the surrogate. The
   envelope evaluates that column's `default` expression **once per produced logical row**,
   under the existing **per-row mutation-context cadence** (captured and recorded for replay,
   so a non-deterministic default — `uuid7()`, an allocator UDF — works under
   `pragma nondeterministic_schema`, exactly as a base-column default does today).
2. **Thread it via the equivalence class.** The other members' key columns are in the
   anchor key's EC (established by the synthesized/authored join), so EC propagation carries
   the one evaluated value into every member's key column. No per-member regeneration.
3. **Directly-supplied still works.** When a view column maps to the shared key (the
   `logical-tuple` case), the supplied value flows in through the value list and EC-propagates
   as before — no generation.
4. **No default + not supplied + `not null` ⇒ ordinary `no-default` diagnostic.** Same rule
   as any other column. The engine no longer invents a value.

The **only** new primitive is the "added default context": a deterministic per-row ordinal,
exposed to default-expression (and mutation-context) evaluation so a user can author a
high-water-mark allocator themselves — the thing `integer-auto` hard-coded. The envelope
already computes this ordinal (`materializeEnvelope`'s `ordinal` counter); the change is to
**expose it** instead of consuming it internally.

- Working name `mutation_ordinal()` — a nullary builtin returning the 1-based ordinal of the
  row being produced within the current statement. **Deterministic** (so it needs no
  nondeterminism opt-out). Valid only during default / mutation-context evaluation; errors
  (or returns a defined sentinel) elsewhere. Implementer confirms the final name/spelling.
- This reconstructs the old `integer-auto` behavior as user-authored SQL, e.g. a basis
  surrogate column declared
  `default (coalesce((select max(rid) from anchor_tbl), 0) + mutation_ordinal())`,
  and generalizes the documented `row_number()`-based ID-composition pattern
  (`docs/architecture.md` § Sequential ID Generation) to the column-default position, where
  a window function cannot reach.
- The seed subquery is evaluated at the envelope **before** any base write, so it observes
  pre-mutation state for every row (which is why the ordinal is needed to distinguish rows of
  a multi-row insert). An optional efficiency refinement — hoisting a row-invariant default
  sub-expression to evaluate once per statement — is allowed but **not required** for
  correctness; do not over-build it in this ticket.

### Kept vs torn out

**Kept (legitimate infrastructure):**

- The **envelope** — `ViewMutationNode.envelope`, `EnvelopeScanNode`, `runtime/emit/envelope-scan.ts`,
  and the "materialize the augmented source once, stash in `rctx.tableContexts`, every base op
  reads the identical rows back" mechanism. This is the genuine new substrate (it realizes
  "evaluate once, share across the fan-out" and the pre-mutation-snapshot timing). It stays;
  it is simply fed from the anchor default + ordinal context instead of `seed + ordinal`.
- `StorageShape.anchorRelationId` and the per-member shared-key columns (`keyColumnsByRelation`):
  which member originates the key and which columns join (→ the EC). Still required.
- The directly-supplied path and `buildInsertStmt`'s `preBuiltSource` seam.

**Torn out (superfluous):**

- The `SharedKeyGenerator` type and the `generator` field on `SharedKey`
  (`vtab/mapping-advertisement.ts`).
- `SharedKey.kind` — derive `surrogate` vs `logical-tuple` from coverage (is the shared-key
  column a logical column?). Remove unless a concrete need survives; if kept, justify in the
  handoff.
- The `integer-auto` mint arithmetic in `runtime/emit/view-mutation.ts` (`doMint`,
  `perStatementMint`, `seedIdx`, `seed + ordinal`), and `ViewMutationNode.mint`
  (`{ seed, cadence }`) plus the `max(anchor.key)` seed construction in
  `view-mutation-builder.ts`.
- The non-`integer-auto` `no-default` rejection and the `requireIntegerSurrogate` /
  surrogate-strategy branches in `planner/mutation/decomposition.ts`; the mint vs
  directly-supplied fork in `planner/mutation/multi-source.ts` (`analyzeMultiSourceInsert`)
  collapses to "supplied-or-defaulted-then-EC-threaded."
- Reserved tags `quereus.lens.decomp.generator.<id>` and `quereus.lens.decomp.gencadence.<id>`
  (and `quereus.lens.decomp.keykind.<id>` if `kind` is removed) — `reserved-tags.ts` specs and
  the `mapping-advertisement-tags.ts` builder. The generator/cadence now come from the anchor
  column's own `default` declaration.
- The `resolveAdvertisement` validation in `lens-compiler.ts` that "a surrogate key requires a
  generator"; replace with "the anchor's shared-key column carries a `default` **or** the key
  is exposed as a (supplied) logical column" (a deploy-time check, sited per existing contract).

### Intentional behavior change (call out loudly in docs + handoff)

A surrogate decomposition previously worked with **zero configuration** — `integer-auto`
fabricated keys. After this change the basis author **must declare a `default`** on the
anchor's surrogate key column (or expose the key as a supplied logical column). This is the
point of the change: the engine stops choosing an ID policy. Document the canonical
recipe for the old behavior (`default (… max(anchor.key) … + mutation_ordinal())`) so the
migration path is obvious. Existing tests/usages that relied on zero-config minting (e.g.
`93.4-view-mutation.sqllogic` § Phase 2b, the property suite's surrogate-split family, the
worked example in `3.6-view-mutation-shared-surrogate-insert`) must be updated to declare a
default.

## TODO

### Phase 1 — the per-row ordinal context primitive

- Add the deterministic per-row ordinal builtin (working name `mutation_ordinal()`) in
  `func/builtins/`, registered via `func/registration.ts`. Return the 1-based ordinal of the
  row being produced within the current statement; valid only during default /
  mutation-context evaluation.
- Thread the existing envelope ordinal (`materializeEnvelope`) into the
  default-expression evaluation context so the builtin resolves to it per row. Confirm the
  same primitive is reachable from an ordinary single-source insert's column-default
  evaluation (it is a general mutation-context primitive, not decomposition-specific).
- Determinism: the ordinal is deterministic, so it must **not** trip the determinism gate;
  verify a default using only `mutation_ordinal()` + deterministic state needs no
  `nondeterministic_schema` opt-out.

### Phase 2 — source the shared key from the anchor default + EC threading

- In the multi-source insert path (`multi-source.ts` `analyzeMultiSourceInsert`,
  `view-mutation-builder.ts` `buildMultiSourceInsert`): replace the mint-vs-supplied fork with
  "evaluate the anchor key column's `default` once per row at the envelope (per-row cadence),
  EC-propagate to the other members." Reuse the existing insert-defaulting EC propagation
  rather than a bespoke injection where possible.
- Do the same for the decomposition insert path (`decomposition.ts` `analyzeDecompositionInsert`,
  `view-mutation-builder.ts` `buildDecompositionInsert`): the anchor member's key default
  feeds every member's shared-key column via EC.
- Feed the envelope's appended shared-key column from the evaluated anchor default instead of
  `seed + ordinal`. Keep the materialize-once / stash-in-context / `EnvelopeScanNode`-readback
  flow intact.
- Preserve atomicity (mid-fan-out failure rolls back) and the pre-mutation-snapshot timing
  (anchor default — including any `max()` subquery — evaluated before base writes).

### Phase 3 — tear out the generator mechanism

- Remove `SharedKeyGenerator`, `SharedKey.generator`, and (pending the coverage-derivation
  check) `SharedKey.kind` from `vtab/mapping-advertisement.ts`.
- Remove the `integer-auto` mint arithmetic and `ViewMutationNode.mint` plumbing
  (`runtime/emit/view-mutation.ts`, `view-mutation-node.ts`, `view-mutation-builder.ts` seed
  construction).
- Remove the surrogate-strategy / `requireIntegerSurrogate` / non-`integer-auto` rejection
  branches in `decomposition.ts` and the mint fork in `multi-source.ts`; the only remaining
  rejection is the ordinary `no-default` (no default + not supplied + not-null) and the
  still-deferred shapes (composite key — see note).
- Remove the `generator` / `gencadence` (and possibly `keykind`) reserved-tag specs
  (`reserved-tags.ts`) and builder handling (`mapping-advertisement-tags.ts`).
- Update `resolveAdvertisement` validation (`lens-compiler.ts`) to the
  default-or-supplied check.
- Composite shared keys remain deferred unless the default+EC approach lifts the
  single-column restriction for free (each key column has its own default + EC) — if it does,
  enabling it is a welcome bonus; if not, keep the existing `unsupported-decomposition-key`
  reject and document. Do not let composite expand this ticket's scope.

### Phase 4 — comprehensive tests

- `93.4-view-mutation.sqllogic` (multi-source insert): migrate the surrogate examples to a
  declared anchor `default`. Add cases: (a) anchor default `… max() … + mutation_ordinal()`
  reconstructs the old monotonic-integer behavior, distinct per row, threaded to both bases;
  (b) a deterministic allocator-style default; (c) a non-deterministic default (a test UDF or
  `uuid7()`-style) under `pragma nondeterministic_schema`, captured once and threaded — and
  assert **replay** yields byte-identical base rows; (d) directly-supplied key still works;
  (e) no default + not supplied + not-null ⇒ `no-default` diagnostic.
- Lens decomposition insert tests (the `lens-multi-source-put-insert-fanout` sqllogic file +
  property `Family C — decomposition fan-out` in `property.spec.ts`): migrate the surrogate
  split to a declared default; assert all members agree on the threaded key.
- `property.spec.ts` View Round-Trip Laws (Family B multi-source, Family C decomposition):
  update the surrogate families; keep the deferred-shape *reject* assertions (composite key,
  etc.) accurate to the new diagnostics.
- New focused test for the ordinal primitive in a **plain** (non-decomposition) multi-row
  insert column default — proves it is a general mutation-context primitive.
- Determinism/replay assertion as in (c) above — the captured-once-and-replay guarantee is the
  load-bearing correctness property of moving generation to defaults.

### Phase 5 — docs

- `docs/view-updateability.md`: rewrite § Mutation Context to describe default-sourced shared
  key + the `mutation_ordinal()` context primitive (drop `integer-auto` / `SharedKeyGenerator`
  framing). The worked `next_rid()` example now actually works — make it correct and
  authoritative. Tighten § Projection defaulting step 6 to point at this. Update
  Current limitations (remove "only integer-auto"; note composite if still deferred). Update
  the Implementation Map (envelope rows stay; remove generator references).
- `docs/lens.md`: rewrite the § The Default Mapper "shared key need not be a logical key"
  bullet (surrogate = a basis-declared default on the anchor key + EC threading; drop the
  generator). Update § The module mapping advertisement (the descriptor advertises *which*
  columns join + the anchor; it no longer carries a generator/kind). Update the put-fan-out
  INSERT description, Current limitations, and the Implementation Map.
- `docs/architecture.md`: § Sequential ID Generation — add `mutation_ordinal()` as a
  first-class per-row primitive alongside `row_number()`, and note it composes into a column
  `default` (the surrogate-key case), so there is one ID story across query and default
  positions.

### Phase 6 — build & validate

- `yarn build`, then `yarn workspace @quereus/quereus test` (stream with `tee`), then lint
  (single-quoted globs on Windows). All green before handoff.
- `yarn test:store` exercises the store code path for surrogate/default behavior; run it if
  time permits, otherwise document the deferral per workflow.
- Handoff (`review/`) must call out: the intentional zero-config→declared-default behavior
  change and its migration recipe; the final name/scope of the ordinal primitive; whether
  `SharedKey.kind` was removed or kept (with reason); and whether composite keys were lifted
  or remain deferred.
