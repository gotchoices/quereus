description: Read-side FD contribution of lens-declared logical keys (PK/UNIQUE) to the optimizer — a soundness-gated `AssertedKeysNode` pass-through inlined at the lens-view boundary. Reviewed and completed.
files: packages/quereus/src/planner/nodes/asserted-keys-node.ts, packages/quereus/src/runtime/emit/asserted-keys.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/test/lens-fd-contribution.spec.ts, docs/lens.md, docs/optimizer.md
----

## What shipped

A declared logical key (PK / `unique`) that the lens *proves* or *actively enforces* surfaces as a **functional dependency on the inlined-view boundary**, so the optimizer can use it for DISTINCT elimination / ORDER-BY trailing-key pruning / join elimination on the **read** path. Read-side only; write path untouched.

`AssertedKeysNode` (a zero-runtime-cost unary pass-through modeled on `AliasNode`) carries soundness-gated `assertedFds` and merges them onto the child's physical FD set via `addFd`. `computeLensAssertedKeyFds(slot, db)` (in `schema/lens-prover.ts`) is the slot→FD encoder, gated by obligation kind:

| Obligation | Contributed FD |
|---|---|
| `proved` | unconditional `key → others` (redundant-but-harmless) |
| `vacuous` | `∅ → all_cols` (≤1-row) |
| `enforced-set-level` `row-time` | **guarded** `key → others [guard: key IS NOT NULL]`, re-validated at plan time against the current catalog + non-partial basis UC |
| `enforced-set-level` `commit-time` | none (transient mid-statement duplicate ⇒ unsound) |
| `enforced-row-local` / `enforced-fk` | none (not uniqueness facts) |

Wired in `planner/building/select.ts` `buildFrom` (lens branch), wrapping the inlined view's `ProjectNode` inside the optional `AliasNode`; added to the `coverage-prover.ts` `PASS_THROUGH` and `mutation/propagate.ts` `PASSTHROUGH_NODES` sets (both sound — row-preserving single-source pass-through).

## Review findings

**Process:** read the implement diff (`ff30774c`) with fresh eyes before the handoff summary, then traced soundness through `fd-utils.ts`, `partial-unique-extraction.ts` (the established guarded-FD producer this mirrors), `reference.ts` (declared-key seeding), and the lens prover's deploy gates. Ran build, lint, the new spec, and a 2095-test lens/optimizer/planner/plan subset.

### Checked — and the verdict

- **Soundness gate (`computeLensAssertedKeyFds` / `assertedFdForObligation`).** Correct. `superkeyToFd([], n)` ⇒ `∅ → all_cols`; guarded FDs are skipped by `computeClosure` until a surrounding `FilterNode` strips the guard (`predicateImpliesGuard`), so a row-time key never eliminates a DISTINCT without an `IS NOT NULL` predicate. `addFd` subsumes the redundant `proved` FD. The deviations from the plan (guarded row-time instead of unconditional; `proved` redundant-but-harmless; bare key-only DISTINCT not covered) are all the **sound** call and are correctly documented in `docs/lens.md` / `docs/optimizer.md`.

- **Row-time soundness — the load-bearing case.** Confirmed it does **not** depend on the (still-pending) write-side set-level enforcement. `findBasisCovering` requires a **matching non-partial basis UNIQUE constraint** over the mapped basis columns; that basis UC is what actually enforces non-null uniqueness in the data, so the guarded `key → others [guard: key IS NOT NULL]` holds at every read observation point. The plan-time `revalidateRowTime` (covering-structure currency + `uc.predicate === undefined`) is a correct conservative downgrade-to-no-FD; on multiple basis UCs over the same columns it takes the first via `.find()` (under-claims if that one is partial — safe).

- **`buildNotNullGuard` uses logical `col.notNull` to decide which clauses to emit.** Probed for a soundness hole (logical NOT-NULL key column over a *nullable* basis column would skip the `IS NOT NULL` clause ⇒ unconditional FD over a NULL-permitting basis UC). The lens prover **blocks this at deploy** via `lens.nullability-mismatch` (severity error) whenever a NOT-NULL logical column maps to a nullable basis expression *with no total default*. The only residual is the total-default escape, whose read-side coalescing semantics are a **pre-existing, broader** lens concern (it governs every NOT-NULL-based optimization — filter null-rejection, partial-UNIQUE guard discharge — not just this FD), and changing `buildNotNullGuard` would not actually close it because the guard-activation discharge (`isColumnNonNullable`) reads the same boundary output-column nullability. Conclusion: rely on the established invariant "boundary output-column nullability is sound", documented here as the assumption. No code change; not a new defect.

- **FD-index ↔ view-output-column alignment.** The FD indices come from `buildOutputIndex(slot)` (non-hidden `columnProvenance` order, shared with `buildProveContext` so they can't drift), while the node wraps the registered view's `ProjectNode`. The genuinely load-bearing invariant ("columnProvenance order == view output order") is asserted, not proved, in code — but it is **directly guarded** by the end-to-end `row-time correctness — DISTINCT elimination preserves the rows` test: a mis-indexed FD would either fail to eliminate or drop rows. Verified passing.

- **Node-type registry completeness.** Emitter registered (`register.ts`); both pass-through sets updated. No exhaustive `PlanNodeType` switch in the physical/serialization/cost paths misbehaves — confirmed by the passing `plan/` golden-plan subset and the implementer's `query_plan` check (the node shows as `ASSERTEDKEYS` and executes).

- **Write-path isolation.** Re-confirmed: standard lens mutation decomposition walks the compiled body over basis tables, where `AssertedKeysNode` never appears; `commit-time` keys are gated out so no mid-statement self-reference observes an unsound key.

### Minor — fixed in this pass

- **Coverage gap (composite-key row-time guard).** The implementer flagged that a multi-column nullable unique → multi-clause guard was not directly tested. Probed the path (it works: `{a,b} → {id,label} [guard: a IS NOT NULL, b IS NOT NULL]`, one clause per column) and added a verified unit test `composite row-time — a multi-column nullable unique emits one IS NOT NULL guard clause per column` to `test/lens-fd-contribution.spec.ts`. Spec now 12 passing.

### Minor — documented, not actioned (no behavior/correctness impact)

- **Join-elimination not directly tested.** The same FD that drives DISTINCT elimination drives join elimination; the capability is mechanically present (the FD flows through the identical boundary surface). Left as a known coverage gap rather than a speculative end-to-end test — DISTINCT elimination + the `proved` ORDER-BY-pruning test already prove the FD reaches and is consumed by the uniqueness read surface.
- **Subquery decorrelation walk.** `rule-subquery-decorrelation.ts` skips only `Project`/`Alias` when descending into an EXISTS subquery; an `AssertedKeysNode` between them would halt the walk, costing a decorrelation opportunity for a lens referenced inside a correlated subquery. Pure missed-optimization (never a correctness issue), narrow trigger, no demonstrating test — not changed to avoid scope creep into the decorrelation rules.

### Not actioned (out of scope / accepted v1 limitation)

- **Bare key-only-projection DISTINCT** (`select distinct k from Lens`) is not covered — the FD-only surface drops `k → others` once dependents are projected away, and single-column DISTINCT elimination relies on declared `RelationType.keys` which the FD-only node deliberately does not set. This is the plan's explicit FD-over-declared-keys choice; accepted for v1.
- **Property/Key-Soundness harness** does not generate lens fixtures; the empirical soundness backstop for this feature is the gate's correctness (covered by the unit tests), not the harness.

## Validation run

- `yarn workspace @quereus/quereus build` → exit 0.
- `yarn workspace @quereus/quereus lint` → exit 0 (clean, after the added test).
- `test/lens-fd-contribution.spec.ts` → **12 passing** (11 shipped + 1 added).
- Lens + optimizer + planner + plan subset → **2095 passing, 0 failing**.

No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
