description: Added a partial-write rollback arm to the multi-source-join directly-supplied INSERT coverage in `packages/quereus/test/property.spec.ts`. The pre-existing collision test only ever seeded each key into BOTH bases, so a colliding supplied key failed on the fan-out's FIRST member op and the second base was never touched — "both unchanged" held trivially by first-op-failure, not by rollback. The new test seeds the two bases with overlapping-but-not-identical key sets, picks a supplied key present in EXACTLY ONE base, and asserts rejection + both bases byte-for-byte unchanged regardless of fan-out order, which exercises the true partial-write rollback (first insert succeeds, second fails, written base rolled back).
files: packages/quereus/test/property.spec.ts
----

## What changed

New property test in `describe('multi-source inner join')` (immediately after the
existing both-collide `... rejected atomically` test):

`it('PutGet: a directly-supplied insert key present in exactly one base rolls the partial write back', ...)`

Key differences from the prior test it complements:

- **Independent base seeding.** Two separate arbitraries (`aSeed` → `dk_a`, `bSeed` → `dk_b`)
  with overlapping integer key ranges (1..9) but not identical sets, instead of the old
  single `kept` list that wrote the same key into both bases. Each base is deduped and
  modeled independently (`keptA`/`keptB`).
- **Independent oracle.** Rows present in only one base are invisible through the inner
  join, so the assertions read each base image directly (`select k, av from dk_a`,
  `select k, bv from dk_b`) rather than the view image.
- **Three arms by membership of supplied `K`:**
  - `inA !== inB` (one-base-collide): insert must be rejected; both bases byte-for-byte
    unchanged from pre-insert. This is the partial-write rollback path — depending on
    engine fan-out order the collision is either first-op (no write) or second-op (first
    base written then rolled back); both produce the same observable outcome, so the
    assertion does not over-fit member ordering.
  - `inA && inB` (both-collide): retained as a first-op-failure guard.
  - neither: fresh key, both bases gain it.
- **Guard:** `expect(oneBaseSeen, ...).to.be.greaterThan(0)` ensures the new
  partial-write arm actually fires (it did — observed during implement).

`numRuns: 120` (raised from the sibling's 60) to make the one-base-collide arm reliably hit.

## Validation performed

- `node test-runner.mjs --grep "rolls the partial write back" --reporter spec` → 1 passing.
- `node test-runner.mjs --grep "multi-source inner join" --reporter spec` → 14 passing
  (whole describe block, no regressions).

Run from `packages/quereus`.

## Reviewer focus / known gaps

- This is **test-only**; no production code changed. The engine behavior (multi-base
  writes under a transaction, partial failure rolls back) was believed correct and is
  now asserted.
- The test asserts the partial-write outcome **observationally** (both bases unchanged)
  but cannot directly assert *which* fan-out order occurred — the collides-second
  (genuine rollback) vs collides-first (no write) split is engine-internal. The guard
  proves the one-base arm fires, not that both sub-orders fire. If the reviewer wants a
  stronger guarantee that the rollback-of-a-written-base sub-path specifically executes,
  consider pinning fan-out order (e.g. a deterministic seed where K is known to be in the
  second-written base) — but that would over-fit member ordering, which the ticket
  explicitly warned against. Left as-is per the ticket's "regardless of fan-out order"
  directive.
- Did not run `yarn test` (full suite) or `test:store` — change is isolated to one new
  property test; the targeted grep runs cover it.
