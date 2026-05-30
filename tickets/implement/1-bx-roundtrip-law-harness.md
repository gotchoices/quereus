----
description: Tier-A round-trip law property block (PutGet/GetPut/forward-backward lineage agreement) over the shipped single-source projection-filter path; pure test code, lands before the substrate.
prereq: bx-operator-model-and-roundtrip-laws
files: test/property.spec.ts, docs/view-updateability.md, docs/architecture.md
----

## Why

The forward relational walk (`computePhysical` → `PhysicalProperties.fds`) has a
structural soundness net: the **Key Soundness** property block
(`property.spec.ts`) materializes rows and asserts `keysOf` / `isSet` never
over-claim (Tiers 1 + 2). The **backward** walk that drives view write-through —
`analysis/update-lineage.ts`, `analysis/scalar-invertibility.ts`,
`mutation/propagate.ts` — has **no** such net: nothing forces it to agree with the
forward FD facts. The `bx-operator-model-and-roundtrip-laws` spike decided that the
cheapest, first-to-land insurance is a per-operator round-trip **law** in the
property suite. This ticket implements Tier A of that spike over the shape the
backward walk admits today (single-source projection-and-filter; the Phase-1
AST-rewrite path in `building/view-mutation.ts`).

This is pure test code. It touches no engine surface and does not depend on the
plan-node substrate — it depends only on the spike's spec.

## What it adds

A new `describe('View Round-Trip Laws', …)` block in `property.spec.ts`, structured
exactly like Key Soundness (a positional core + a negative self-test that proves the
check reds on an injected violation), covering three laws over a generated
single-source projection-and-filter view and a randomly-seeded small base table:

- **PutGet (write-then-read).** Generate a mutation (insert / update / delete) that
  the Phase-1 rewrite admits, apply it through the view, read the view back, and
  assert: rows outside the view predicate are untouched; computed (non-`base`)
  columns are not writable (a write to one is rejected with the `no-inverse`
  diagnostic, not silently dropped); the post-state view image reflects exactly the
  mutation on the writable columns. This is the property generalization of the two
  hand-authored Phase-1 review regressions — `LIMIT`/`OFFSET`/`DISTINCT`
  write-widening and the alias-qualifier leak — which would now red as *properties*.
- **GetPut (read-then-write-back).** Read a row through the view, write the same
  values back via an update keyed on the view's identifying predicate, assert the
  base table diff is empty.
- **Forward/backward lineage agreement (the structural crux).** Plan the view body;
  for each output column, cross-check the backward lineage
  (`deriveViewColumns` → `ViewColumnLineage`) against the forward FD facts of the
  planned body (`keysOf` / `fds` via the unified surface): every `base`-writable
  column has a forward FD path to that base column, and every key the forward walk
  advertises on the view output is reconstructible by the backward identifying
  predicate. A disagreement throws.

The view-body zoo reuses the projection-and-filter shapes already exercised by the
`93.x-view-mutation*` sqllogic corpus (bare `select *`, rename projection, computed
column, equality-predicate filter, alias-qualified body), generated over the same
small-integer arbitraries Key Soundness uses, so the block shares helpers with the
existing harness where practical.

## Scope boundaries (kept honest, per the spike)

- **Single-source projection-and-filter only.** Multi-source / join / aggregate
  bodies are out of scope here — the backward walk rejects them today, so there is
  nothing to round-trip. The substrate ticket extends this same law block to the
  planned multi-source tree when it lands.
- **No engine changes.** If a law reds against current behavior, that is a *finding*
  to route to a fix/ ticket, not a reason to edit engine code in this ticket. (The
  spike's PoC asserts the law is green over shipped Phase-1 behavior, so a red here
  is a genuine regression signal.)
- **Best-effort isolation, like Key Soundness.** A generated body that the rewrite
  rejects for an unrelated structured reason is a `fc.pre` discard, not a failure.

## Acceptance

- New `View Round-Trip Laws` block in `property.spec.ts`, `numRuns: 50`, green and
  non-flaky (re-run 5×, mirroring how Key Soundness was stabilized).
- A negative self-test proves each law throws on an injected violation (the
  `checkNoOverClaim('injected', …)` pattern).
- `docs/view-updateability.md` § Mutation Propagation gains a short "Round-trip laws"
  note pointing at the property block as the backward-direction soundness net (the
  dual of Key Soundness for the forward direction), and `docs/architecture.md`'s
  property-test catalog gains a bullet for it.
- Full `yarn test` green; no regression.

## TODO (implement)

Phase 1 — law core + negative self-tests
- [ ] Add `describe('View Round-Trip Laws', …)` to `property.spec.ts`; extract a
      positional law core analogous to `checkKeysAndSet`, plus a record adapter.
- [ ] Negative self-tests: PutGet reds on write-widening (a deleted row outside the
      predicate), GetPut reds on a spurious base diff, lineage-agreement reds on a
      `base` column with no forward FD path. Assert each throws.

Phase 2 — view-body generators
- [ ] Arbitraries for single-source projection-and-filter bodies (bare `*`, rename,
      computed column, equality filter, alias-qualified) over the existing
      small-integer row arbitraries; reuse `createTables` / `seedTables` shape.
- [ ] `fc.pre` discard for bodies the Phase-1 rewrite rejects for unrelated reasons.

Phase 3 — the three laws
- [ ] PutGet: generate an admissible mutation, apply through the view, read back,
      assert predicate-honest + computed-read-only + correct writable image.
- [ ] GetPut: read-then-write-back, assert empty base diff.
- [ ] Lineage agreement: plan the body, cross-check `deriveViewColumns` against
      `keysOf` / `fds` of the planned body.

Phase 4 — stabilize + document
- [ ] `numRuns: 50`; re-run 5× for flake.
- [ ] Doc note in `docs/view-updateability.md` § Mutation Propagation; bullet in
      `docs/architecture.md` property-test catalog.
- [ ] Full `yarn test`; confirm green and no regression.
