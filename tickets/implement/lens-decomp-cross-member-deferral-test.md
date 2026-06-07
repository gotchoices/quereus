description: Add behavioral coverage for the lens decomposition per-op constraint gate's CHECK deferral-vs-enforcement split. The shipped behavior — a row-local logical CHECK whose write-row columns span more than one member of a decomposition resolves on no single member op and is silently deferred (matching the decomposition INSERT path), while a single-member-resolvable CHECK rides its member and ABORTs — is verified today only by reasoning + a debug `log`. Only the set-level key-routing arm has a test. Add a test that pins the CHECK deferral boundary: a cross-member `check (title <> note)` UPDATE that violates across members PASSES (deferral), while a single-member `check (length(title) < N)` UPDATE that violates ABORTs.
prereq:
files:
  - packages/quereus/test/lens-put-fanout.spec.ts                   # surrogate-keyed decomposition fixtures (~L1429) — add the new describe/its near the existing "docKey re-key routes the commit-time uniqueness CHECK" test (~L1549)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # constraintsForOp / the deferral `log` (~L198) — the behavior under test
  - docs/lens.md                                                    # § Enforcement by constraint class — already documents the deferral; the test pins it
  - docs/view-updateability.md                                     # decomposition write semantics — cross-reference
----

# Add cross-member CHECK deferral-vs-enforcement behavioral coverage

## Background

The per-op resolvability gate (`constraintsForOp` in `view-mutation-builder.ts` ~L880) threads each
lens-synthesized constraint onto the member ops of a decomposition fan-out whose target tables resolve
every write-row column it references. The shipped, documented behavior (`docs/lens.md`
§ Enforcement by constraint class; `docs/view-updateability.md`):

- a logical row-local CHECK whose write-row columns span **more than one** member resolves on no single
  member op and is **deferred** — silently not enforced, matching the decomposition INSERT path (a debug
  `log` at ~L198 traces the drop);
- a **single-member-resolvable** CHECK rides its member op and still **fires** (ABORTs on violation).

Only the set-level key-routing arm is currently pinned by a test (`a docKey re-key routes the commit-time
uniqueness CHECK onto the Doc_core anchor op`, ~L1549). The CHECK deferral-vs-enforcement split is verified
only by reasoning + the debug `log`. This ticket adds a behavioral test so a future change to the gate
cannot silently flip the deferral boundary.

This is a **test-only** ticket. It asserts a deliberate non-enforcement (the cross-member deferral is a
weaker contract by design), so it is belt-and-suspenders — but it nails the boundary in place. It is
independent of `lens-decomp-row-local-subquery-metadata-gate`: both the `check (title <> note)` and
`check (length(title) < N)` shapes are subquery-free bare-ref CHECKs, which the existing walker and the
metadata path handle identically, so the test passes the same before and after that ticket.

## What to build

Add a `describe` (or extend the existing surrogate-keyed block) in `test/lens-put-fanout.spec.ts`, reusing
the `Doc_core` / `Doc_body` / `Doc_meta` decomposition fixture (`title` on `Doc_core`, `note` on `Doc_meta`
— a genuine cross-member pair). Declare the logical CHECKs on the logical `Doc` table in the
`declare logical schema x { table Doc { … } }` DDL.

### Cross-member CHECK is deferred (the residual)

- Logical table carries `check (title <> note)` — `title` (Doc_core member) and `note` (Doc_meta member)
  span two members. The synthesized row-local CHECK's write-row set is `{title, note}` (basis terms), which
  resolves on no single member op, so the gate threads it onto none → deferred.
- An `update x.Doc set …` that makes `title == note` across members currently **passes** (the violation is
  not caught). Assert the UPDATE succeeds and the violating row is persisted — documenting the deferral.
- If a log-capture harness is available in the spec, assert the deferral `log` fires (the
  `lens constraint … references write-row columns no base op of the … fan-out carries` line). If no
  capture harness exists, skip the log assertion — do **not** add a heavyweight logging-capture rig for
  this; the persisted-violation assertion is the load-bearing one.

### Single-member CHECK still ABORTs

- Logical table carries `check (length(title) < N)` (e.g. `< 5`) — `title` lives on `Doc_core` only, so
  the synthesized CHECK's write-row set is `{title}`, resolvable on the Doc_core member op → it rides that
  op and fires.
- An `update x.Doc set title = '<too-long>' where …` must **ABORT** (the CHECK rides the Doc_core op). Use
  `expectThrows(… , /check|constraint/i)` and assert the row was **not** mutated.

Put both CHECKs on the same logical table if convenient, or use sibling fixtures — whichever keeps the DDL
readable. The two assertions together pin that the gate *enforces* a single-member CHECK and *defers* a
cross-member one — the exact boundary.

## Edge cases & interactions

- **Decomposition INSERT parity.** A decomposition INSERT that violates the cross-member CHECK is *also*
  deferred (the documented baseline this UPDATE behavior matches). Optionally add an INSERT case asserting
  the same deferral, so the UPDATE deferral is anchored against the established INSERT behavior rather than
  read as a one-off. Keep it light if it complicates the fixture.
- **Key-changing vs value-only UPDATE.** The cross-member CHECK rides on `note` and `title` write-row
  columns, not the key — so a `set note = …` fan-out (Doc_meta only) and a `set title = …` fan-out
  (Doc_core only) each see only one of the two columns. Pick assignments that actually exercise the
  cross-member span (the violation must require both `title` and `note` to be compared) — a single-side
  UPDATE that touches only `note` still can't resolve `title` on the Doc_meta op, so the CHECK is deferred
  regardless; the point is to show the *combined* constraint never rides any single member.
- **Don't over-assert the log.** The `log` is a debug trace, not a contract surface. The persisted-row /
  ABORT assertions are the real pins. Treat the log assertion as optional and only if the spec already has
  a clean capture mechanism.
- **No source changes.** This ticket adds tests only. If, while writing it, the deferral does **not** hold
  (the cross-member CHECK unexpectedly ABORTs or crashes), that is a real defect — file a `fix/` ticket
  with the repro rather than weakening the test, and note it in the review handoff.
- **child-FK dual (out of scope).** The ticket's optional child-FK deferral dual needs a
  decomposition-with-logical-FK fixture, which does not yet exist. Do **not** build that fixture here; if
  the CHECK coverage lands cleanly and a logical-FK-over-decomposition fixture is trivially reachable, note
  it as a backlog follow-up instead of expanding this ticket.

## TODO

- Add the cross-member `check (title <> note)` deferral test (UPDATE violates across members → passes,
  violating row persisted) to `test/lens-put-fanout.spec.ts`, reusing the surrogate-keyed decomposition
  fixture.
- Add the single-member `check (length(title) < N)` enforcement test (UPDATE violates → ABORTs, row
  unmutated).
- Optionally add the INSERT-parity deferral case if it does not complicate the fixture.
- Optionally assert the deferral `log` fires only if a clean log-capture harness already exists in the spec.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` (the new tests are the
  primary signal). No build/lint changes expected beyond the spec.
