description: Added (implement) and then strengthened (review) a partial-write rollback arm to the multi-source-join directly-supplied INSERT coverage in `packages/quereus/test/property.spec.ts`. The pre-existing collision test only ever seeded each key into BOTH bases, so a colliding supplied key failed on the fan-out's FIRST member op and the second base was never touched — "both unchanged" held trivially by first-op-failure, not by rollback. The new test seeds the two bases with overlapping-but-not-identical key sets, picks a supplied key present in EXACTLY ONE base, and asserts rejection + both bases byte-for-byte unchanged regardless of fan-out order, exercising the true partial-write rollback (first insert succeeds, second fails, written base rolled back).
files: packages/quereus/test/property.spec.ts
----

## What shipped

New property test in `describe('multi-source inner join')` of
`packages/quereus/test/property.spec.ts`:

`it('PutGet: a directly-supplied insert key present in exactly one base rolls the partial write back', ...)`

- **Independent base seeding.** Two arbitraries (`aSeed` → `dk_a`, `bSeed` → `dk_b`) with
  overlapping integer key ranges (1..9) but not identical sets, each deduped and modeled
  independently (`keptA`/`keptB`).
- **Independent oracle.** Rows present in only one base are invisible through the inner
  join, so assertions read each base image directly (`select k, av from dk_a`,
  `select k, bv from dk_b`) rather than the view image.
- **Three arms by membership of supplied `K`:** one-base-collide (`inA !== inB`,
  the partial-write rollback path), both-collide (`inA && inB`, first-op-failure guard),
  and fresh (neither — both bases gain it).
- `numRuns: 120`.

### Review change (this pass)

The implement-stage handoff documented a real gap: the single `oneBaseSeen > 0` guard
proved *an* arm fired but not that the **genuine rollback sub-path** (collision on the
side fanned out SECOND, so the first base is written then rolled back) ever executed — it
could be satisfied entirely by first-op-failure (collides-first) cases.

Closed it **without** over-fitting fan-out order by splitting the guard per collision
side: `aOnlySeen` / `bOnlySeen`, requiring **both** `> 0`. The fan-out drives its sides in
a fixed order (`multi-source.ts` / `view-mutation-builder.ts`: "the emitter drives them in
that order"; `dk_a`/`dk_b` have no FK between them, so the order is consistent). Whichever
side is written second, its "K-only-on-that-side" case is a true partial-write rollback;
guaranteeing both side-only arms fire guarantees that sub-path executes regardless of which
side the engine writes first. Removed the now-purposeless `bothCollideSeen`/`freshSeen`
counters (incremented but never asserted).

## Review findings

**Implement diff reviewed first** (`git show 9bf6f7d0`), then the handoff.

- **Correctness / oracle:** The independent per-base model is right — inner-join hides
  single-base rows, so reading each base directly is the only sound oracle.
  `assertRowsEqual` sorts column signatures, so the order-independent comparisons are
  valid. Arm partition (`inA !== inB` / `inA && inB` / else) is exhaustive and disjoint.
  No issues.
- **Falsifiability (the ticket's core concern):** *Major-adjacent, fixed inline.* As
  handed off, the test asserted the right invariant but did not guarantee it exercised the
  rollback-of-a-written-base path. Strengthened via the per-side split guard described
  above; this is the minimal fix that keeps the "regardless of fan-out order" directive.
  Verified empirically — both `aOnlySeen` and `bOnlySeen` guards pass at `numRuns: 120`,
  so both side-only collisions (hence the second-written-side rollback) fire every run.
  A genuinely non-atomic engine would now fail `partial-write <side> rolled back`.
- **Type safety / style:** `unknown` for caught errors, typed `Set<number>` and row
  arrays, no `any`, tabs, lowercase SQL — consistent with surrounding tests and AGENTS.md.
- **Resource cleanup:** `drop ... if exists` at test top and `delete from` per run;
  later tests self-clean the same way. No leak.
- **Docs:** `docs/view-updateability.md:157` already states the atomicity invariant ("The
  complete list of base operations executes atomically … If any operation fails … the
  entire statement aborts"). The test asserts documented behavior — **no doc change
  required** (verified, not assumed).
- **Production code:** None changed; test-only ticket. Engine atomicity was believed
  correct and is now asserted under a falsifiable construction.
- **Security / performance:** N/A — test-only, bounded fuzz (`numRuns: 120`, keys 1..9,
  arrays ≤ 6). Runtime ~330ms.

### Validation

- `node test-runner.mjs --grep "multi-source inner join" --reporter spec` → 14 passing.
- `node test-runner.mjs --grep "Property-Based Tests" --reporter min` → 86 passing
  (full property suite, no regressions).
- `npx eslint 'test/property.spec.ts'` → clean (exit 0).
- All run from `packages/quereus`. Did not run `yarn test` (full monorepo) or `test:store`
  — change is isolated to one property test against the memory vtab; the store path is not
  touched.

### New tickets filed

None. The one finding was minor enough to fix inline.
