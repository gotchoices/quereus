description: Review the read-side FD contribution of lens-declared logical keys (PK/UNIQUE) to the optimizer — a soundness-gated `AssertedKeysNode` pass-through inlined at the lens-view boundary. Scrutinize the soundness gate (especially the row-time→guarded refinement) and the projection-coverage limitation.
files: packages/quereus/src/planner/nodes/asserted-keys-node.ts, packages/quereus/src/runtime/emit/asserted-keys.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/test/lens-fd-contribution.spec.ts, docs/lens.md, docs/optimizer.md
----

## What shipped

A declared logical key (PK / `unique`) that the lens *proves* or *actively enforces* now surfaces as a **functional dependency on the inlined-view boundary**, so the optimizer can use it for DISTINCT elimination / ORDER-BY trailing-key pruning / join elimination on the **read** path. Read-side only; write path untouched.

**Mechanism (mirrors `AliasNode`/`RetrieveNode`):**
- `AssertedKeysNode` (`planner/nodes/asserted-keys-node.ts`) — a unary pass-through that carries `assertedFds` and, in `computePhysical`, passes every child physical property through unchanged (attribute IDs preserved) then merges the asserted FDs via `addFd`. `getType`/`getAttributes` return the source's directly. Emits its source directly (`runtime/emit/asserted-keys.ts`, mirrors `emitAlias`) → **zero runtime cost**.
- `PlanNodeType.AssertedKeys` enum entry; emitter registered in `runtime/register.ts`; added to `coverage-prover.ts` `PASS_THROUGH` and `mutation/propagate.ts` `PASSTHROUGH_NODES` (sound — pure row-preserving single-source pass-through).
- `computeLensAssertedKeyFds(slot, db)` (exported from `schema/lens-prover.ts`) — the soundness-gated slot→FD encoder.
- Wired in `planner/building/select.ts` `buildFrom` lens branch: resolves the slot, computes FDs, wraps the inlined view's `ProjectNode` in `AssertedKeysNode` when ≥1 FD is produced (inside the optional `AliasNode`). The `ProjectNode`'s output indices == the prover's non-hidden output-index space (the `effectiveColumns`/`columnProvenance` order), factored into a shared `buildOutputIndex` helper so the two can't drift.

**The soundness gate (by obligation kind):**

| Obligation | Contributed FD |
|---|---|
| `proved` | unconditional `key → others` |
| `vacuous` | `∅ → all_cols` (≤1-row) |
| `enforced-set-level` `row-time` | **guarded** `key → others [guard: key IS NOT NULL]` (re-validated, see below) |
| `enforced-set-level` `commit-time` | **none** (detection-only; transient mid-statement duplicate ⇒ unsound) |
| `enforced-row-local` / `enforced-fk` | **none** (not uniqueness facts) |

## ⚠️ Deviations from the plan ticket — please scrutinize

The plan's design had three points the implementation **deliberately changed for soundness**. These are the highest-value review targets.

1. **Row-time contributes a GUARDED FD, not an unconditional one.** The plan's table said row-time → unconditional "yes". But a `row-time` obligation is *structurally always over a nullable `unique`* — a NOT-NULL basis UC would have classified `proved` (it seeds an unconditional key FD the body proves), never reaching the covering-structure path. SQL `UNIQUE` permits multiple NULL tuples, and the engine's own `relationTypeFromTableSchema` excludes nullable UCs from `keys` — so an *unconditional* `key → others` over a row-time key is **unsound** (it would let DISTINCT/join-elim drop rows that share a NULL key). The implementation contributes `key → others [guard: key IS NOT NULL]` (the exact shape a partial `UNIQUE` emits; activated by a surrounding `WHERE key IS NOT NULL` via the existing `FilterNode` guard-activation path). **Consequence:** the plan's `select distinct k from Lens` (no predicate) does *not* eliminate; `select distinct … from Lens where k is not null` does. Reviewer: confirm you agree the guarded form is the correct soundness call, and that the partial-UC exclusion (only non-partial basis UC ⇒ NULL-skip is the whole scope) is sufficient.

2. **`proved` is redundant-but-harmless, never load-bearing.** The plan posited a "body proves it but local propagation loses it" DISTINCT test. That scenario **cannot exist**: `proved` is computed as `isUnique(optimized-body-top-node, outCols)` — i.e. it holds *iff* local per-node FD propagation surfaces the key. So the AssertedKeysNode's `proved` FD is always already present on the boundary (subsumed by `addFd`). The genuinely **load-bearing** case is `row-time` (the covering structure is a deploy-time fact the inlined body knows nothing about) and possibly `vacuous`. `proved` is still contributed (harmless, robust to future propagation gaps). I tested `proved` via ORDER-BY pruning as a **regression guard that the boundary node doesn't break existing FD flow**, not as proof of added value.

3. **Bare key-only-projection DISTINCT is NOT covered by the FD surface.** `select distinct k from Lens` (project onto *only* the key) loses the FD: `projectFds` drops `k → others` once the dependents are projected away, and `rule-distinct-elimination` on a single-column projection relies on declared `RelationType.keys` (via `projectKeys`/`isSet`), which the FD-only `AssertedKeysNode` does not set. The plan explicitly chose FDs over inventing `RelationType.keys`, so this is the accepted consequence: the contribution helps `select distinct *` / multi-column DISTINCT / ORDER-BY pruning / join-elim, but **not** bare key-only DISTINCT. Tests project `(email, label)` (dropping the PK) to exercise the FD path. **Open question for the reviewer:** is bare key-only DISTINCT worth also asserting declared keys for, or is the FD-only scope acceptable for v1? (Asserting keys would contradict the plan's guidance and complicate the projection-pruning rules.)

## Row-time currency (resolved assumption)

A covering MV **can** be dropped or go stale out-of-band between deploys — the basis is a *physical* schema whose DDL does not re-run the lens prover. So the row-time contribution is **re-validated at plan time** (`revalidateRowTime` → `findBasisCovering`, no body re-plan): the FD is contributed only when a non-stale row-time covering MV still answers the backing basis UC *and* that UC is non-partial; otherwise it downgrades to no FD. `proved`/`vacuous` need no currency check (structural facts of the immutable compiled body). Cost: a couple of map builds + an MV-manager lookup, per row-time obligation, per lens reference — at plan-build time only.

## Write-path interaction (traced — confirmed safe)

- The standard lens mutation decomposition walks the **compiled body over basis tables** (`single-source.ts` `analyzeView` → `buildSelectStmt(view.selectAst)`), where the lens view (and thus `AssertedKeysNode`) **never appears**. So FD contribution does not touch the write path.
- RETURNING re-query reads through the view path → picks up the node → sound (the gated kinds — `proved`/`vacuous`/`row-time` — hold at every observation point post-write; `commit-time` is gated out).
- `commit-time` keys never reach a contributable FD, so no mid-statement self-reference (`insert into Lens select … from Lens`) can observe an unsound key.
- `AssertedKeys` was added to `propagate.ts` `PASSTHROUGH_NODES` defensively for a hypothetical lens-over-lens body walk (sound — it is row-preserving single-source).

## Tests (a floor, not a ceiling)

New `test/lens-fd-contribution.spec.ts` (11 cases): unit assertions on `computeLensAssertedKeyFds` (proved→unconditional, vacuous→`∅→all`, row-time→guarded with the exact `is-null` clause, commit-time→none, unproved re-keyed PK→none, hidden composite-PK member→none + reads don't crash, plain view→no slot) and end-to-end optimizer behavior (row-time DISTINCT eliminated under `IS NOT NULL` + control retained without it; commit-time DISTINCT retained; proved ORDER-BY pruning; row-time DISTINCT-elimination preserves rows).

**Gaps a reviewer should probe:**
- No **join-elimination** test, though the same FD enables it. Worth adding an adversarial case.
- The hidden-key test exercises the *read-only / commit-time* path; it does **not** exercise `encodeKeyFd`'s hidden-skip for a *contributable* (proved/row-time) obligation — that combination is structurally gated out earlier (proved/row-time require all key columns mapped), so the hidden-skip is defense-in-depth only. Confirm that reasoning.
- Composite-key row-time (multi-column nullable unique → multi-clause guard) is not directly tested. `buildNotNullGuard` emits one clause per nullable column; a composite case would be worth a unit assertion.
- Property/Key-Soundness harness (`test/property*.spec.ts`) stays green — but it may not generate lens fixtures; the empirical soundness backstop for *this* feature is the gate's correctness, not the harness. Consider whether a lens-aware property case is warranted.

## Validation run

- `yarn workspace @quereus/quereus build` → exit 0.
- Full suite (`mocha "packages/quereus/test/**/*.spec.ts"`) → **4201 passing, 9 pending, 0 failing**.
- Lens + optimizer + property + planner subset → 2112 passing, 0 failing.
- `yarn workspace @quereus/quereus lint` → exit 0 (clean).
- `query_plan(?)` over a lens read shows `ASSERTEDKEYS` in the op list and the query executes — confirms emit / serialization / planviz / validation handle the new node via the generic mechanism (no exhaustive node-type switch was missed).

No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
