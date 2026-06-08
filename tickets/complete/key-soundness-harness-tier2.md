description: Tier-2 (isolated per-node materialization) of the key-soundness property harness — walks every relational node in the optimized plan tree, emits + runs each in isolation, and asserts keysOf()/isSet never over-claim on that node's own rows. Best-effort: nodes that can't emit standalone are skipped.
files: packages/quereus/test/property.spec.ts, docs/architecture.md
----

## What was built

Tier 2 of the `describe('Key Soundness', …)` block in
`packages/quereus/test/property.spec.ts`. Tier 1 (already shipped) reads
`keysOf()`/`isSet` off the **top** result node and checks materialized rows
never contradict them; Tier 2 does the same **per inner node**, for every
relational node in the optimized plan tree, materialized in isolation
(`emitPlanNode` + `Scheduler.run` with a strict, table-context-free runtime
mirroring `Database._executeSingleStatement`). Emission/run failures *skip*
(correlated/parameterized/connection-bound inner nodes can't run standalone); a
`checkedNodes > 0` guard prevents the tier from degenerating into all-skips.

Refactors: extracted the positional core `checkKeysAndSet(label, keys, isSet,
rows)` from `checkNoOverClaim` (now a thin record→positional adapter); hoisted
the shared `queries`/`rowArbA`/`rowArbB`/`createTables`/`seedTables` helpers to
`describe` scope; added `collectRelationalNodes` (id-deduped tree walk) and
`materializeNode`.

## Review findings

### Reviewed (what was checked)

- **Implement-stage diff** (`git show 44937de4`) read first, before the handoff.
- **Positional key/column alignment** — the load-bearing contract. Verified
  `RelationType.keys: ColRef[][]` and `ColRef.index` is the column-*position*
  index into the node's own output columns (`common/datatype.ts:38-62`), and
  `keysOf` returns exactly `key.map(ref => ref.index)` (`fd-utils.ts:763-794`).
  The scheduler's raw output rows are positional in `getType().columns` order
  (db.eval's `rowToObject` maps positional→name by that same order). So Tier 2's
  positional `checkKeysAndSet` is checking the right thing — and sidesteps the
  inner-node column-name-collision problem by design.
- **Runtime-context construction** in `materializeNode` cross-checked against the
  four established standalone-emit sites (`_executeSingleStatement`,
  `statement.ts`, `database-assertions.ts`, `const-evaluator.ts`) — strict row
  context, empty/strict table contexts, no tracer/metrics. Consistent.
- **Skip/fail boundary** — the `try/catch` wraps only `materializeNode`;
  `checkKeysAndSet` runs *outside* it, so a genuine over-claim throw propagates
  and fails the test while only emit/run failures skip. Correct.
- **NULL semantics in `tupleSig`** — two NULLs hash equal. Correct for `isSet`
  (SQL DISTINCT collapses NULLs); stricter than SQL UNIQUE for keys (which keeps
  NULLs distinct). Confirmed *not reachable* by the current zoo: claimed keys
  land only on PKs / GROUP BY / DISTINCT outputs, and the only NULL source
  (LEFT JOIN right-padding) never lands in a claimed key column. Shared,
  pre-existing helper from Tier 1 — not introduced here.
- **Lint / typecheck / tests** — `yarn lint` clean, `yarn typecheck` clean,
  `property.spec.ts` 45 passing, full `yarn test` **3637 passing / 9 pending / 0
  failing**. No regression.
- **Docs** — checked every doc that mentions `property.spec` / the FD-key
  surface (`architecture.md`, `optimizer.md`, `test/README.md`).

### Found + fixed inline (minor)

- **Doc gap**: `docs/architecture.md`'s property-test catalog listed every other
  suite but omitted the Key Soundness harness entirely (Tier 1 was never
  documented there either). Added a **Key Soundness** bullet describing both
  tiers, the soundness-not-completeness contract, the isolation mechanism, and
  the skip-by-design + `checkedNodes > 0` guard.

### Major findings → new tickets

None. No correctness, type-safety, resource-cleanup, or DRY issues warranting a
separate ticket. The implementer's documented floors (silent per-node skip;
no correlated/nullable-key shapes exercise the skip path or the NULL-key edge of
`tupleSig`) are deliberate scope boundaries, not defects — each costs
*completeness* of the harness, never *soundness* of a green run. Both are
acceptable as-is; if a future change makes a whole node class start throwing on
isolated emit, the tier would stay green as long as some other node still
materializes (the `checkedNodes > 0` guard only catches a *fully* vacuous tier).
A reviewer wanting stronger teeth could assert a minimum count or required set
of checked node types — intentionally not added, to avoid coupling the test to
optimizer output shape.

## Acceptance check

- [x] Tier-2 walk added to the existing `Key Soundness` block.
- [x] Emission/run failures **skip** rather than fail.
- [x] Same invariants as Tier 1, via the shared `checkKeysAndSet` core.
- [x] `numRuns: 50`.
- [x] No regression (full suite green).
- [x] Enabled by default; no flakiness observed.
- [x] Docs updated (`architecture.md` property-test catalog).
