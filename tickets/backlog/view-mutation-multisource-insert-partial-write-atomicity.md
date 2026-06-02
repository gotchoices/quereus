description: The View Round-Trip Law harness gained a "directly-supplied insert key colliding with an existing base key is rejected atomically" test (`describe('multi-source inner join')` in `packages/quereus/test/property.spec.ts`), but as written it cannot falsify a NON-atomic engine. The seed inserts each key into BOTH bases together, so a colliding supplied key is present in both — the per-base fan-out fails on the FIRST member op and the second base is never touched, so "both bases unchanged" is satisfied trivially by first-op-failure, not by rollback of a partial write. The genuinely interesting atomicity path — a supplied key present in EXACTLY ONE base, so the first insert succeeds and the second fails, forcing a rollback of the already-written base — is never constructed. Add coverage that exercises true partial-write rollback.
prereq:
files: packages/quereus/test/property.spec.ts
----

## Background

The multi-source-join directly-supplied INSERT (`insert into dkv (k, av, bv) values (...)`
where `dkv = dk_a a join dk_b b on b.k = a.k`) fans the row out to both base tables. The
collision test asserts that on a PK collision the insert is "rejected atomically" — both
bases left intact.

The test seeds via:

```
for (const r of seed) {
  await db.exec(`insert into dk_a values (${r.k}, ${r.av})`);
  await db.exec(`insert into dk_b values (${r.k}, ${r.bv})`);   // same key into BOTH
}
const collides = seen.has(K);                                    // ⇒ K is in dk_a AND dk_b
```

So a colliding `K` violates the PK of whichever base the fan-out writes first; that op
throws and the second base is never reached. "Both unchanged" then holds even for an
engine that does NOT roll back a partial write — the partial-write scenario simply never
arises. The atomicity claim in the test name/comment is therefore not actually exercised.

## What to cover

Construct a supplied key present in **exactly one** base so the fan-out's first member
insert succeeds and the second fails (anchor base PK violation), and assert the
**already-written** base is rolled back — i.e. neither base retains a row after the
rejection. Concretely:

- Seed `dk_a` and `dk_b` with overlapping-but-not-identical key sets (a row only in
  `dk_a`, a row only in `dk_b`, plus shared rows), tracking each base's model
  independently rather than the current single `kept` list that assumes identical keys.
- Pick a supplied `K` that hits one base's key but not the other's. Whichever base the
  fan-out writes first determines which arm fails; the test should assert rejection +
  **both bases byte-for-byte unchanged from their pre-insert state** regardless of
  fan-out order (so it does not over-fit the engine's member ordering).
- Keep the existing fresh-key (both-gain) and both-collide arms; this adds the
  one-base-collide arm. Guard that the new arm actually fires.

Note: rows that exist in only one base are invisible through the inner-join view; the
oracle must model each base's image directly (not the view image) for these assertions.

## Why backlog (not a defect)

The shipped engine behavior is believed correct (multi-base writes execute under a
transaction, so a partial failure rolls back) — this is a **test-coverage** gap, not a
known engine bug. No production code is suspected. Promote to `plan`/`implement` when
hardening the view round-trip law harness; the engine path was empirically exercised
when the collision test was written, only the rollback-of-partial-write assertion is
missing.
