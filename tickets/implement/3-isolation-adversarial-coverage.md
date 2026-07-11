description: The transaction-isolation layer guards subtle correctness (read-your-own-writes, write-write conflict behavior) and deserves adversarial tests. It already has substantial coverage — this ticket audits for the specific hard-case gaps and fills them, asserting the layer's intended semantics rather than whatever it happens to do today.
prereq:
files:
  - packages/quereus-isolation/src/isolated-connection.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/overlay-rows.ts
  - packages/quereus-isolation/src/merge-iterator.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts (161 cases — the main suite)
  - packages/quereus-isolation/test/merge-iterator.spec.ts (23 cases)
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts (5)
  - packages/quereus-isolation/test/attach-seam-forwarding.spec.ts (5)
  - packages/quereus-isolation/test/collation-resolver.spec.ts (11)
difficulty: medium
----

## Reality check (the plan's premise was stale)

The parent plan claimed the isolation layer has "**4 specs**" and is thinly tested.
As of this writing it has **5 spec files and ~205 test cases** (161 in
`isolation-layer.spec.ts` alone). So this is **not** a build-coverage-from-scratch
job — the layer is substantially tested. This ticket is a **targeted adversarial-gap
audit**: read the existing suite, identify which of the hard boundary behaviors below
are genuinely uncovered, and add tests only for the real gaps. Do **not** pad the
count with duplicates of what's already there.

## Semantics caveat — assert intended, not current

There is a known tension in what "isolation" means here:

- `AGENTS.md` describes the layer as **"read-your-own-writes; not snapshot
  isolation."**
- The IndexedDB plugin's user-facing settings help text advertises **"snapshot
  isolation."**

That documented-vs-implemented divergence is tracked separately (the review's
strategic rec #3). **Coordinate with it:** where you add a test whose outcome depends
on which semantics is intended, assert the **intended** semantics (read-your-own-writes
per AGENTS.md, unless that rec resolves otherwise), and if the current implementation
diverges, do **not** loosen the test to match the code — leave the test asserting the
intended behavior and flag the mismatch in the handoff so the semantics ticket owns
the fix. A test that documents a bug is more valuable than one that blesses it.

## Adversarial surface to audit (add tests only where a real gap exists)

- **Read-your-own-writes within a transaction**: insert/update/delete then read back
  in the same txn sees the local change; a sibling connection does not, until commit.
- **Write-write conflict**: two connections write overlapping keys — define and assert
  the intended resolution (last-writer, conflict-error, or per the semantics decision).
  This is the highest-value gap if absent.
- **Overlay merge boundaries** (`overlay-rows.ts` / `merge-iterator.ts`): a local
  delete shadowing a base row, a local insert ordering correctly among base rows, an
  update that changes the sort key, and range/bounded iteration that must stay
  incremental (not full-materialization) across the overlay seam.
- **Empty-overlay and all-overlay extremes**: iterate with no local writes (pass-through)
  and with every base row shadowed.
- **Commit / rollback**: rollback discards the overlay entirely (base unchanged);
  commit makes local writes visible to subsequent readers; double-commit / commit-then-write
  is rejected or well-defined.
- **ALTER / schema seam under an open overlay**: an ALTER while uncommitted writes exist
  (interacts with `alter-table-conformance.spec.ts` and `attach-seam-forwarding.spec.ts`).
- **Collation**: key comparison in the overlay uses the same collation as the base
  (interacts with `collation-resolver.spec.ts`) — a mismatched collation must not split
  logically-equal keys across the seam.

## Edge cases & interactions

- **Iteration laziness**: assert range scans over the overlay yield incrementally and
  respect bounds — a regression to full-materialization is exactly the kind of drift
  the sibling KVStore conformance work (`test-kvstore-conformance-suite`) also guards;
  keep the isolation-level assertion here, don't defer it.
- **Concurrency shape**: this layer is single-writer-per-connection but multiple
  connections share a base — test cross-connection visibility, not literal parallel
  threads.
- **Cleanup**: each new test must close its connections/engines so overlay state can't
  bleed into the next case.

## TODO

- Read the 5 existing specs and build a coverage map of the adversarial surface above;
  mark each item covered / partial / missing.
- Add tests only for the missing/partial items, asserting **intended** semantics.
- For any assertion that current code fails (semantics divergence), keep the test and
  document the mismatch in the review handoff; reference strategic rec #3 rather than
  weakening the assertion.
- Run `yarn workspace @quereus/isolation test`; confirm green except for any
  intentionally-failing semantics-divergence tests, which must be called out explicitly.
