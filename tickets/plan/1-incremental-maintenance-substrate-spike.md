----
description: Design-spike — unify the engine's two delta paths (row-time MV inverse-projection maintenance; the DeltaExecutor binding kernel) under one shared key-filtered-residual `MaintenancePlan` abstraction + a new backward (maintenance-direction) cost gate, on the recompute-the-slice model. DECISION: the Z-set / DBSP-style delta-circuit representation is DEFERRED indefinitely (parked in `incremental-maintenance-zset-exploration`); no PoC is run now — IVM growth stays hand-coded on the residual-recompute family. No production code lands from this ticket — it produces the shared-abstraction design + the cost-gate spec the three follow-on tickets adopt.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/src/core/database-transaction.ts, docs/incremental-maintenance.md, docs/materialized-views.md, docs/optimizer.md
----

## Why this spike exists

Quereus has **two change-driven engines that are one idea expressed twice**, and a
third group of plan-stage tickets each re-deriving incremental maintenance by hand
for one more body shape. Before building the next three shapes independently, decide
the shared substrate once.

The two existing engines:

- **Row-time materialized-view maintenance** (`core/database-materialized-views.ts`,
  `applyRowTimeChange`) — synchronous, in-transaction, at the DML write boundary. For
  the covering-index shape (single source, linear `Filter → Project → Sort`,
  passthrough projection covering the source PK) the per-row backing delta is a **pure
  inverse projection of the changed row**: `project(row)` to a backing row, key it by
  the backing PK, delete the old image / upsert the new. O(log n), no body
  re-execution, no scan. It is *not* a delta circuit — it is a column permutation plus
  a btree write.
- **The `DeltaExecutor` binding kernel** (`runtime/delta-executor.ts`) — a per-relation
  dispatcher that classifies each `TableReferenceNode` as `'row' | 'group' | 'global'`
  (via `binding-extractor.ts` / `analyzeRowSpecific`) and, at COMMIT, hands a consumer
  the changed binding tuples (or flags the relation for full re-evaluation under a
  ratio-based cost fallback). It is **detection / notification**, not maintenance:
  assertions and `Database.watch` are its only consumers, and
  [incremental-maintenance.md](../../docs/incremental-maintenance.md) explicitly states
  materialized views are **not** a kernel consumer.

The three plan-stage tickets that each extend incremental maintenance for one shape:

- `materialized-view-rowtime-general-bodies` — single-source aggregates, row-preserving
  inner/cross joins, lateral-TVF fan-out. Its own body notes the on-commit residual
  machinery was deleted by the consolidation and **must be rebuilt** (per-changed-slice
  residual recompute, delete-then-upsert, degrade-to-full-rebuild) — and flags the open
  question of whether residual re-execution per statement is affordable and where the
  cost cliff sits.
- `materialized-view-rowtime-mv-over-mv-cascade` — drive dependents synchronously,
  DAG-ordered, when a maintenance write hits a backing table another MV reads.
- `optimizer-keyed-cross-product-join-keys` — surface the product key
  `(leftKey ∪ shiftedRightKey)` of a keyed cross/lateral join so the lateral-TVF
  backing PK is recoverable from `keysOf` instead of bespoke advertisement reasoning.

All three share the same missing pieces: **(a)** a common representation of "given a
source change, what is the bounded backing delta and how is it applied", and **(b)** a
**cost judgment** for *whether the incremental path is worth it vs. a full rebuild* —
the engine has a rich forward optimizer cost model (`planner/cost/index.ts` +
`StatsProvider` in `planner/stats/index.ts`) but **nothing on the maintenance
(backward) direction**. Today eligibility is a hard **shape allowlist**
(`buildRowTimePlan` rejects anything but the covering-index shape); each follow-on
ticket widens that allowlist by hand.

## The thesis to adjudicate (and the decisive answer)

A standing proposal: adopt a **Z-set / DBSP-style delta-circuit internal
representation** (Budiu/McSherry et al. 2022, *DBSP: Automatic Incremental View
Maintenance*) where each relational operator carries a mechanical incremental lift
(linear ops commute with delta; joins are bilinear,
`Δ(R⋈S) = ΔR⋈S + R⋈ΔS + ΔR⋈ΔS`; aggregates/recursion integrate over a delta stream)
while keeping the synchronous in-transaction application policy row-time already uses.
Eligibility then becomes a **cost gate** rather than a shape allowlist, which forces
the missing maintenance cost model into existence.

The proposal's appeal is real (it is the principled end state), but its stated premise
is **only half-true against this codebase**, and the spike must say so plainly:

- **"The OLD/NEW capture is already a Z-set."** *Not literally.* Change capture
  (`core/database-transaction.ts`, `mergeRecordInto`) is an **op-keyed
  last-write-wins state machine**: a per-PK record `{ op: insert|update|delete,
  oldProjection?, newProjection? }`, where `insert→update` collapses to `insert`,
  `delete→insert` collapses to `update`, etc. A genuine Z-set is a multiset with signed
  integer **weights** that *accumulate* (and UPDATE is not a primitive — it is
  `delete(old, −1) + insert(new, +1)`). Adopting Z-sets means **rewriting change
  capture itself** (weights, no UPDATE merge), not reading the existing capture
  differently.
- **"The two delta engines are DBSP re-derived by hand."** *Half-true.* The deleted
  on-commit subsystem (see the `complete/materialized-view-incremental-*` archives) and
  today's general-bodies plan both compute by **key-filtered residual recompute against
  live sources, with a full-rebuild escape hatch** — i.e. *recompute the affected
  slice*, deliberately **not** delta algebra. That is a legitimate IVM family (the
  "recompute a bounded slice" school), distinct from delta circuits, and it composes
  trivially with arbitrary relational operators (the residual is just the body with a
  key filter injected) without per-operator delta lifts.

So a literal "rewrite maintenance onto a Z-set circuit" is a **parallel new subsystem**
landing on a dirty in-flight branch — precisely the big-bang this project forbids — and
it is **not** required to ship the three follow-on shapes, all of which the
recompute-the-slice family already covers.

**Decision (settled): extract the shared abstraction + build the maintenance cost gate
on the recompute-the-slice model; do NOT adopt a Z-set circuit.** The Z-set / DBSP
delta-circuit representation is **deferred indefinitely** — no PoC is scheduled. It is
parked as `incremental-maintenance-zset-exploration` (backlog) so the analysis is not
lost, to be revisited only if a future need (large batched deltas, or reviving the
deleted true-delta shapes) makes the constant-factor case compelling. The follow-ons
build on the shared abstraction; IVM growth stays hand-coded on the residual-recompute
family — the lowest-risk path that still delivers the missing backward cost model.

Rationale for the default over the circuit:

1. **Additivity.** The shared `MaintenancePlan` abstraction + cost gate is a refactor
   of code that already exists (`RowTimeMaintenancePlan` generalized; the
   `binding-extractor` classification reused) plus one new cost surface. A Z-set circuit
   is new representation, new capture, new executor — none reviewable in small slices.
2. **Operator coverage for free.** Residual recompute handles aggregates, joins,
   lateral TVFs, set-ops, and recursion uniformly (inject a key filter, re-run the
   body). The circuit needs a correct, separately-verified delta lift per operator
   before any of those shapes work — and recursion/aggregates need integrators, the
   hardest part of DBSP.
3. **The synchronous policy caps the win.** Row-time maintenance runs *inside* the
   writing statement with a small per-statement change set. DBSP's asymptotic advantage
   is largest for large batched deltas; for the small-delta, in-transaction regime the
   constant factors of residual recompute on a key-filtered slice are usually already
   competitive — exactly what the PoC must confirm or refute, not assume.
4. **It still forces the missing cost model.** The recommended path delivers the
   backward cost gate (the thesis's most valuable by-product) without betting the
   subsystem on the representation.

## What the spike produces (the design, not code)

### 1. The `MaintenancePlan` abstraction

A consumer-neutral description of how a derived relation is kept consistent with a
source change, generalizing today's `RowTimeMaintenancePlan` from
"projection-only" to a small tagged union of **maintenance strategies**, each a
recipe the synchronous row-time driver (and a future commit-time driver) can execute:

```
type MaintenanceStrategy =
  | { kind: 'inverse-projection';                 // SHIPPED shape, unchanged semantics
      projectionSourceCols: number[];
      predicate?: CompiledPredicate;
      backingPkDefinition: PkDef }
  | { kind: 'residual-recompute';                 // general bodies (recompute-the-slice)
      binding: BindingMode;                        //   from binding-extractor (row/group)
      residual: CompiledRelationalPlan;            //   body with a key/group filter injected
      deleteSliceKeyOrder: number[] | null;        //   backing keys to evict before re-insert
      degradeToRebuild: boolean }                  //   set by the cost gate
  | { kind: 'prefix-delete';                       // lateral-TVF fan-out (base-PK prefix)
      basePkPrefixLen: number;
      residual: CompiledRelationalPlan }
  | { kind: 'full-rebuild' };                      // always-correct escape (cost-gate result)
```

- The `'inverse-projection'` arm **is exactly today's `RowTimeMaintenancePlan`** — the
  spike must specify it as a *rename/lift*, not a rewrite, so the shipped covering-index
  path keeps byte-for-byte semantics.
- `'residual-recompute'` reuses `BindingMode` and the
  `extractCoveredKeysForTable` / `analyzeRowSpecific` machinery already shipped for the
  DeltaExecutor — i.e. **the two engines converge on one binding analysis**, the
  unification the gap names.
- The **application policy is orthogonal to the strategy**: every strategy is applied
  synchronously at the DML write boundary through the existing
  `applyMaintenanceToLayer` privileged-write path; the spike's diagram must show the
  strategy/policy split so a future commit-time policy can reuse the same strategies.

### 2. The backward (maintenance-direction) cost gate

A small `maintenanceCost(strategy, changeCardinality, sourceStats)` surface that
returns the estimated cost of one statement's worth of maintenance under a strategy,
reusing `planner/cost/index.ts` formulas and `StatsProvider.tableRows` /
`distinctValues`. The eligibility decision becomes:

```
choose argmin over { residual-recompute(slice), full-rebuild } of maintenanceCost(...)
  where the slice cost uses changeCardinality (rows touched this statement,
  known at the DML boundary) and the residual's planned cost from the forward optimizer;
  full-rebuild cost = forward cost of the whole body.
```

This is the generalization of `DeltaExecutor`'s existing `deltaPerRowFallbackRatio`
heuristic (`delta-executor.ts`) into a real comparator — the spike must explicitly
state it **subsumes** that ratio and that the ratio's `0.5` default becomes the cost
gate's fallback when stats are absent (so behavior is unchanged when no stats exist).

The shape allowlist does **not** vanish — soundness gates (a strategy must *exist* for
the body shape; non-deterministic projections still rejected; bag bodies still
rejected) stay as hard preconditions. The cost gate only chooses **among sound
strategies**, and "no sound incremental strategy" still means full-rebuild (or, for
row-time where rebuild-per-write is unaffordable, create-time rejection — the spike
must state which shapes can degrade to rebuild under the synchronous policy and which
must reject, since a per-write full rebuild is pathological).

### 3. Z-set delta circuit — deferred (no PoC)

The Z-set / DBSP delta-circuit representation is **deferred indefinitely** by decision;
this spike runs **no PoC** and ships nothing toward it. The rationale and the eventual
revisit triggers (large batched deltas; reviving the deleted recursive-semi-naive /
count-based-set-op true-delta shapes) are parked in
`incremental-maintenance-zset-exploration` (backlog) so the analysis above is preserved.
General-bodies and the cascade ship on `'residual-recompute'`; the backward cost model
(the most valuable by-product of the original thesis) is delivered by §2 regardless.

### 4. Correctness: the law / property test the spike mandates

Independent of which path wins, the spike specifies a **maintenance-equivalence property
test** (in the existing `fast-check` style of the Key-Soundness Tier-1/2 harness): for a
zoo of eligible body shapes and random source mutations, assert

```
read(MV_backing)  ==  evaluate(body) against current sources   (as multisets/sets)
```

after every mutation and after rollback — i.e. *maintenance never diverges from a fresh
body evaluation*. This is the single correctness oracle both the shipped
inverse-projection path and any new strategy must satisfy, and it is the regression net
the three follow-ons run against.

## Decisive recommendation (summary)

1. **Build the shared `MaintenancePlan` abstraction** (lift `RowTimeMaintenancePlan`
   into the `'inverse-projection'` arm; add `'residual-recompute'` / `'prefix-delete'` /
   `'full-rebuild'` arms) — the convergence point the two engines and three tickets all
   need.
2. **Build the backward maintenance cost gate**, subsuming `deltaPerRowFallbackRatio`.
3. **Z-set circuit is deferred indefinitely** (parked in
   `incremental-maintenance-zset-exploration`); no PoC now. IVM growth stays on the
   residual-recompute family.
4. **Mandate the maintenance-equivalence property test** as the shared oracle.

## Implement follow-ons this spike unblocks

The spike's output is the design for these (it does **not** itself land production
code). Each becomes / gets retargeted to depend on the abstraction + cost gate:

- `incremental-maintenance-plan-abstraction` (NEW implement) — lift
  `RowTimeMaintenancePlan` to the `MaintenancePlan` union (`'inverse-projection'` arm =
  shipped semantics) + the maintenance-equivalence property harness. The smallest first
  step; no new body shapes yet.
- `incremental-maintenance-cost-gate` (NEW implement) — the backward cost surface +
  `deltaPerRowFallbackRatio` subsumption.
- `materialized-view-rowtime-general-bodies` (RETARGETED plan) — builds the
  `'residual-recompute'` / `'prefix-delete'` arms on the abstraction, gated by the cost
  gate, rather than re-inventing residual maintenance.
- `materialized-view-rowtime-mv-over-mv-cascade` (RETARGETED plan) — drives dependents
  through the same `MaintenancePlan` execution path.
- `optimizer-keyed-cross-product-join-keys` (RETARGETED plan) — supplies the backing-PK
  key the `'prefix-delete'` / lateral-TVF residual arm consumes from `keysOf`.

Whether `materialized-view-recursive-semi-naive-delta` / count-based set-op deltas (the
deleted on-commit "true delta" follow-ups) are ever revived is **deferred indefinitely**
alongside the Z-set question (parked in `incremental-maintenance-zset-exploration`): they
are the shapes a Z-set circuit would win on, so they are filed only if that exploration is
ever picked up and the circuit adopted.

## Out of scope

- Any change to the synchronous in-transaction **application policy** (row-time stays
  the sole maintenance timing; this spike does not resurrect a post-commit MV path).
- Lens-layer set-level constraint maintenance (a separate DeltaExecutor consumer tracked
  under `3-lens-prover-and-constraint-attachment`) — it rides the kernel, not the MV
  maintenance path, and is unaffected.
- Re-litigating the row-time-only consolidation.
