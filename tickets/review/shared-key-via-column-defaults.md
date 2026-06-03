description: REVIEW — Collapsed the bespoke SharedKeyGenerator surrogate mechanism into the engine's column-default + equivalence-class machinery, plus a new `mutation_ordinal()` per-row context primitive. The shared key in a multi-source/decomposition insert is now sourced from the anchor key column's declared DEFAULT, evaluated once per row at the envelope and EC-threaded into every member. The integer-auto/uuid7/callback generator type, per-row/per-statement cadence, and the generator/gencadence reserved tags are gone. Build + full memory test suite + store test suite + lint all green.
files: packages/quereus/src/func/builtins/mutation.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/index.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/lens-access-routing.spec.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/view-updateability.md, docs/lens.md, docs/architecture.md

## What landed

The shared key for a multi-table write-through (two-table key-preserving inner-join insert, n-way lens decomposition insert) is no longer a parallel re-encoding of column defaults. There is now **one policy**: source the value from the **anchor key column's declared `default`**, evaluate it **once per produced row at the envelope**, and thread the single value into every member's key column via the **equivalence class** the join establishes. The engine chooses no ID policy of its own.

### Kept (legitimate infrastructure, unchanged in spirit)
- The **envelope** (`ViewMutationNode.envelope`, `EnvelopeScanNode`, `runtime/emit/envelope-scan.ts`, materialize-once / stash-in-`rctx.tableContexts` / readback). It is simply fed by the anchor default + per-row ordinal instead of `seed + ordinal`.
- `StorageShape.anchorRelationId`, `keyColumnsByRelation`, the directly-supplied path, and `buildInsertStmt`'s `preBuiltSource` seam.

### Torn out
- `SharedKeyGenerator` type + `SharedKey.generator` field (`vtab/mapping-advertisement.ts`, re-export in `index.ts`).
- The `integer-auto` mint arithmetic + `ViewMutationNode.mint` (`{seed, cadence}`) plumbing. `MutationEnvelope.mint` → `MutationEnvelope.keyDefault?: ScalarPlanNode`; the emitter (`runtime/emit/view-mutation.ts`) evaluates it per row with `rctx.mutationOrdinal` set.
- The `requireIntegerSurrogate` / non-integer-strategy rejection branches in `multi-source.ts` + `decomposition.ts`; both forks collapse to "supplied-or-anchor-defaulted-then-EC-threaded". The only remaining insert rejection is the ordinary `no-default` (now also raised when a surrogate's anchor key column declares no default) + the still-deferred composite-key shape.
- Reserved tags `quereus.lens.decomp.generator.<id>` / `quereus.lens.decomp.gencadence.<id>` (specs + `DECOMP_GENERATOR_VALUES`/`DECOMP_CADENCE_VALUES`) and the builder handling in `mapping-advertisement-tags.ts`.
- `resolveAdvertisement` validation (`lens-compiler.ts`): "surrogate requires a generator" → "the anchor's surrogate key column declares a DEFAULT" (deploy-time, per-arity). "logical-tuple must not carry a generator" check removed (the field is gone).

### New primitive
`mutation_ordinal()` — nullary, **deterministic** builtin (`func/builtins/mutation.ts`, registered in `func/builtins/index.ts`) returning the 1-based ordinal of the row being produced in the current statement, read off the new `RuntimeContext.mutationOrdinal`. It is the column-`default`-position analogue of `row_number()`. Set per row by the INSERT DML executor (`stampMutationOrdinal` in `dml-executor.ts`) **and** the shared-surrogate envelope. Emitted via a `customEmitter` (it reads the runtime context); errors when evaluated outside a mutation-context scope.

## Handoff disclosures (per the ticket's required call-outs)

1. **Intentional behavior change (zero-config → declared default).** A surrogate decomposition previously worked with no configuration. It now **requires** the basis author to declare a `default` on the anchor's surrogate key column (or expose the key as a supplied logical column), else: deploy-time reject (lens) or `no-default` at insert (multi-source join). **Migration recipe** (reconstructs the old monotonic-integer behavior): `default (coalesce((select max(<key>) from <anchor>), 0) + mutation_ordinal())`. Documented in all three docs + the 93.4 test header.

2. **Ordinal primitive name/scope:** `mutation_ordinal()` (final). Nullary, deterministic, INTEGER, non-null. Verified reachable from BOTH the decomposition/multi-source envelope and an ordinary single-source multi-row insert column default (93.4 case (i)).

3. **`SharedKey.kind` — KEPT** (not removed). Reasons: (a) it is a clean, already-resolved coverage fact (surrogate = key not a logical column → source from anchor default; logical-tuple = supplied) consumed directly by the put fan-out, `deriveSurrogateMemberKeys`, and the validator; deriving it from coverage on every read would be redundant work; (b) the `quereus.lens.decomp.keykind.<id>` tag and `kind` are referenced across ~6 test files and the advertisement builder — removing it is broad churn for zero functional gain. Its doc comment was rewritten to frame it as a coverage fact, not a generation policy.

4. **Composite shared keys — STILL DEFERRED** (`unsupported-decomposition-key`). The default+EC approach did not lift the single-column restriction for free (the envelope threads one appended `__shared_key` column; the per-member key projection assumes a single column). Not expanded in this ticket per its guidance.

## Reviewer focus — the higher-risk, scope-adjacent changes

**Two CREATE-TABLE guard relaxations in `schema/manager.ts` were required for the canonical recipe to work** (the ticket's recipe is self-referencing: `max(rid) from anchor` declared *on* the anchor). Both were verified necessary by an empirical probe (a self-ref subquery default was rejected before these). Please scrutinize:

- **`rejectIllegalReferences`** now tracks subquery depth and rejects a top-level (depth-0) column reference in a DEFAULT, but allows column refs **nested inside a subquery** (they are scoped to the subquery's own FROM, not the inserting row). Parameters stay rejected at any depth. Without this, `(select max(rid) from t)` in a default was rejected as "may not reference columns".
- **`validateDefaultDeterminism`** now **defers** determinism validation to INSERT time when the default's build fails AND the default **embeds a subquery** (`defaultEmbedsSubquery`) — a subquery may forward/self-reference the table being created, which is not yet registered at validation time. Determinism is re-checked at insert (both the single-source insert expansion and the envelope's `buildKeyDefault` call `validateDeterministicDefault`). Non-subquery build failures stay strict. **Trade-off:** a typo'd table name inside a subquery default now surfaces at insert time rather than CREATE TABLE time.

**Other things worth a second look:**
- **`mutation_ordinal()` must not be constant-folded.** It is nullary + deterministic, which *could* invite folding/caching. Verified safe: `const-pass.ts classifyNode` only folds a functional node with ≥1 const child, so a zero-operand call is left intact (reasoned + green tests). A reviewer might double-check no CSE/cache rule hoists it.
- **Plain-insert vs envelope `max()` semantics differ** (documented, but subtle): the envelope freezes a pre-mutation snapshot, so `max() + mutation_ordinal()` is the correct monotonic allocator there; a **plain** single-source insert writes incrementally, so a `max()`-based default already sees prior rows of the same statement — compose the ordinal with state directly there. 93.4 case (i) isolates `mutation_ordinal()` accordingly; the docs note the distinction.
- **`stampMutationOrdinal`** (dml-executor) sets the ordinal *before pulling each source row* so the upstream default projection sees it; this assumes pull-driven, non-prefetched, 1:1 in-order source iteration. Fine for VALUES/SELECT inserts; an interposed prefetch/reordering node could in principle decouple it (no such path today).
- **Fork policy:** `RuntimeContext.mutationOrdinal` declared `shared-frozen` (transient, never mutated inside a parallel fork). `parallel-driver.ts fork()` + the fork-contract spec + its `makeRuntimeContext` sentinel were updated in lockstep.

## Validation performed (treat tests as a floor)

- `yarn build` (full monorepo) — green.
- `yarn workspace @quereus/quereus test` — **4447 passing, 0 failing, 9 pending**.
- `yarn test:store` (LevelDB store path) — **4443 passing, 0 failing**.
- `yarn lint` (quereus, single-quoted globs) — clean.
- Empirical end-to-end probes (built dist): self-ref `max()+mutation_ordinal()` surrogate threads to both members + allocates above existing keys; a clock-based non-deterministic default under `pragma nondeterministic_schema` is captured once and threaded (members agree, joined count == member count); plain `mutation_ordinal()` default yields 1..N.

### Test coverage added/migrated
- `93.4-view-mutation.sqllogic` Phase 2b rewritten: (a) `max()+mutation_ordinal()` reconstructs monotonic integers, threaded both bases, allocates above existing keys; (b) allocator default on an FK-parent anchor; (c) non-deterministic clock default under `nondeterministic_schema`, captured-once-and-threaded (members agree, distinct per row); (d) directly-supplied key; (e) non-key not-null no-default reject; (f) surrogate-with-no-anchor-default reject; (g) computed/non-invertible; (h) shared key exposed twice; (i) **plain single-source insert `mutation_ordinal()` default** (general primitive proof).
- `lens-put-fanout.spec.ts`: surrogate `surrogateAd`/`setupSurrogate` migrated to an anchor default; per-row + single-row + deploy-time no-default-reject tests (per-statement cadence tests removed — cadence is gone).
- `property.spec.ts`: Family B multi-source insert (`createJoinBase` anchor default), Family C decomposition surrogate (`deploySurrogate` anchor default), and the deferred-shapes test (uuid7-generator → surrogate-with-no-anchor-default deploy reject) migrated. All round-trip/lineage families green.
- `lens-advertisement.spec.ts` / `lens-access-routing.spec.ts`: removed the `generator` field from advertisements; surrogate get/IND tests given anchor defaults; the "no generator" validation test became "anchor declares no DEFAULT"; the obsolete "logical-tuple carrying a generator" test removed.
- `reserved-tags.spec.ts`: tag count 22 → 20. `fork-contract.spec.ts`: `mutationOrdinal` policy declared.

### Known gaps / suggested adversarial probes for the reviewer
- No test exercises a custom **UDF allocator** default (e.g. a registered `next_rid()`); only `max()+mutation_ordinal()` and a clock read. The mechanism is generator-agnostic (it's just a column default), but a UDF-allocator path is unproven by tests.
- The "replay yields byte-identical base rows" guarantee is exercised as "members agree on the captured value" (evaluate-once-and-thread). There is no dedicated statement-replay assertion — that rides the pre-existing mutation-context capture infra, which this change did not touch.
- Composite shared keys + the schema-manager guard relaxations are the most likely places for an edge case to hide; an adversarial pass on subquery-bearing defaults (correlated subqueries, params nested in subquery defaults, multi-statement allocation races) would be valuable.
