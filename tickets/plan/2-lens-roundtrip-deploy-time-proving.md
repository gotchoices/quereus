description: Promote GetPut/PutGet from "caught at mutation time" to a computed deploy-time predicate over the view-complement object, closing the lens prover's `proveRoundTrip` seam.
files: packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Why

Today the lens round-trip laws are enforced *operationally*: non-invertibility is caught at mutation time by view-updateability's `no-inverse` diagnostic, and a non-reconstructible key is caught by the prover's key-reconstructibility check. `proveLens`'s `proveRoundTrip` is an encapsulated no-op stub (see `complete/3-lens-prover-and-attachment` review findings). The model in `docs/view-updateability.md` § *The predicate-honest complement* and `docs/lens.md` § *Round-trip detection* already names the missing piece and the seam for it.

This is the single biggest credibility lever versus the formal-methods peers (BIRDS verifies put strategies with a theorem prover; Links proves relational lenses compositionally). Because Quereus resolves the Bancilhon–Spyratos ambiguity by predicate-honest fan-out, the **complement is determined, not chosen** — which makes GetPut/PutGet *decidable* for the supported fragment without a theorem prover. We should compute them at deploy.

## What it must do

The `view-complement.ts` annotation layer already exposes `viewComplement(node)` / `complementOf` for the single-source projection-and-filter case (the projected-away base columns + the negation-free residual of the view predicate, in the FD/predicate vocabulary). This ticket makes the prover *consume* it as a computed check:

- **GetPut holds iff `put` leaves the complement fixed.** For the writable fragment, prove that the backward base operations modify no column/row outside the view image — i.e. the complement is invariant under `put`.
- **PutGet holds iff `get ∘ put` reproduces the written view image.** Prove the forward re-derivation of the written values equals what was written, over the writable columns.
- The check is a **deploy-time predicate** computed from the compiled body's FD / lineage / complement surface — not a runtime probe and not an enumerated checklist. It must degrade to the **safe verdict** (no spurious error) when a fact cannot be established, consistent with every other prover check.
- On failure it emits the existing coded/sited diagnostic surface (`lens.non-invertible`, sited `{table, constraint?, column?}`) — the same vocabulary as view-updateability's mutation-time diagnostics — so the deploy blocks atomically before catalog mutation.

## Expected behaviour / use cases

- A lens override whose `put` is non-invertible and undisambiguated is rejected at `apply schema`, before any write is attempted — not only at first mutation.
- An all-invertible computed chain (`(speed + 1) * 2 as adjusted`) passes the deploy-time round-trip check and stays writable.
- A body that the complement layer cannot characterize (out-of-fragment shape) yields no spurious `lens.non-invertible` — it falls through to the existing mutation-time / key-reconstructibility nets, preserving today's behaviour.
- The verdict agrees with the runtime truth: anything the deploy-time check passes must not later red at mutation time for an invertibility reason, and vice-versa, over the supported fragment.

## Dependencies / relationships

- The complement is currently defined for **single-source projection-and-filter**. Extending the computed predicate to the join/decomposition fragment depends on the complement being defined there, which tracks with `1-view-write-through-shape-gaps`. This ticket should compute the predicate for the fragment the complement currently covers and leave a clean extension point for the richer shapes (no hard `prereq` — they advance independently).
- North-star alignment: keep the check shaped so it composes with the eventual mechanical `put`-from-`get` auto-derivation (the load-bearing invariant: no backward rule auto-derivation could not reproduce).

## Tests (TDD seeds)

- Property: for each body in the single-source round-trip zoo, the **computed** GetPut/PutGet predicate agrees with the operational law harness (`test/property.spec.ts` § View Round-Trip Laws) — same pass/red verdict, including the injected-violation negative self-test.
- Deploy-time: an override with an opaque-step computed column declared writable is rejected at `apply schema` with `lens.non-invertible` (sited at the column), not at first write.
- Safety: an out-of-fragment body produces no `lens.non-invertible` (no over-block) — assert the deploy succeeds and mutation-time nets still govern.
