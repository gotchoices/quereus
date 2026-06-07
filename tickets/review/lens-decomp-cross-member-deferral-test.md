description: |
  Test-only: pinned the lens decomposition per-op constraint gate's CHECK deferral-vs-enforcement
  split. Added three `it`s to the `surrogate-keyed optional-member UPDATE` block in
  `lens-put-fanout.spec.ts`, reusing the `Doc_core`/`Doc_body`/`Doc_meta` decomposition fixture
  (title on Doc_core, note on Doc_meta — a genuine cross-member pair). A cross-member
  `check (title <> note)` UPDATE that violates across members PASSES (the gate threads it onto no
  member op → deferred, the documented weaker contract), while a single-member
  `check (length(title) < 5)` UPDATE that violates ABORTs (it rides the Doc_core op). An INSERT
  parity case anchors the UPDATE deferral against the decomposition INSERT baseline. No source
  changes.
prereq:
files:
  - packages/quereus/test/lens-put-fanout.spec.ts                   # the 3 new tests + setupSurrogateWithChecks helper, in the surrogate describe block (~L1571+)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # constraintsForOp gate (~L880) + the deferral log (~L200) — the behavior under test
  - docs/lens.md                                                    # § Enforcement by constraint class (~L286) — documents the deferral the tests pin
  - docs/view-updateability.md                                     # decomposition write semantics — cross-reference
----

# Cross-member CHECK deferral-vs-enforcement behavioral coverage (review handoff)

## What shipped

Three tests added to `test/lens-put-fanout.spec.ts`, appended inside the existing
`describe('lens decomposition put: surrogate-keyed optional-member UPDATE', …)` block (so they
reuse that block's `surrogateOptionalAd()` factory) via a new `setupSurrogateWithChecks(db)`
helper. The helper deploys the same `Doc_core`(title)/`Doc_body`(body)/`Doc_meta`(note, optional)
surrogate decomposition, but declares two row-local CHECKs on the logical `Doc` table and seeds
short titles (`'aaa'`/`'bbb'`) so the starting state satisfies both:

```sql
declare logical schema x { table Doc {
  docKey text primary key, title text, body text, note text,
  constraint xmember  check (title <> note),    -- title∈Doc_core, note∈Doc_meta → cross-member
  constraint titlelen check (length(title) < 5) -- title∈Doc_core only → single-member
} }
```

The behavior pinned (gate = `constraintsForOp` in `view-mutation-builder.ts`; a lens CHECK rides a
member fan-out op iff every **write-row** column it references resolves on that op's target table):

| Test | Operation | Expected | Why |
|---|---|---|---|
| `defers a cross-member CHECK (title <> note)` | `update x.Doc set title='z', note='z' where docKey='k1'` | **PASSES**, violating row persisted at both base members + via the view | write-row `{title,note}` resolves on neither the Doc_core nor the Doc_meta op → rides none → deferred |
| `enforces a single-member CHECK (length(title) < N)` | `update x.Doc set title='toolong' where docKey='k1'` | **ABORTs** (`/check\|constraint\|titlelen/i`), Doc_core title unchanged (`'aaa'`) | write-row `{title}` resolves on the Doc_core op → rides it → fires |
| `decomposition INSERT parity` | `insert into x.Doc values('k9','q','b9','q')` (title==note) | **PASSES**, violating row persisted | decomposition INSERT defers cross-member CHECK too (baseline the UPDATE matches) |

The cross-member UPDATE is the *combined-constraint-never-rides-a-single-member* demonstration the
ticket asked for: both members get an op (title→Doc_core, note→Doc_meta), yet neither carries the
full `{title,note}` pair, so the deferral is not an artifact of a single-sided fan-out.

## Validation

- `lens-put-fanout.spec.ts` (full file): **63 passing** (the 3 new + 60 prior).
- Full `@quereus/quereus` suite: **4979 passing, 9 pending, 0 failing** — no regressions.
- `eslint test/lens-put-fanout.spec.ts`: clean.
- Type-checked implicitly via the ts-node/type-stripping mocha run (import would fail otherwise).

## Honest gaps & what the reviewer should scrutinize

- **Non-vacuity not mechanically pinned.** The single-member test genuinely ABORTs (otherwise
  `expectThrows` fails) and the cross-member test genuinely persists, so both are non-trivial. But
  I did **not** add a mutation-style "break the gate, confirm the test flips" check. If you want to
  be certain the cross-member test would catch a regression, temporarily make `constraintsForOp`
  thread every constraint onto every op (or drop the `resolvable` guard) and confirm the
  cross-member test then ABORTs — then revert. (I judged this sufficient by reasoning; flagging so
  you can verify rather than trust.)

- **Deferral `log` not asserted.** Skipped per ticket guidance — there is no clean log-capture
  harness in the spec, and the ticket said not to build a heavyweight rig. The persisted-row /
  ABORT assertions are the load-bearing pins; the `log` at `view-mutation-builder.ts` ~L200 is a
  debug trace, not a contract surface. If you want it covered, a small capture around
  `createLogger('planner:view-mutation')` would do it, but it's optional.

- **The decomposition INSERT path defers ALL lens row-local CHECKs, not just cross-member ones.**
  Observed from the code path: `buildDecompositionInsert` returns at `view-mutation-builder.ts`
  L69, *before* `extraConstraints` is collected (L147+), so a decomposition INSERT threads no
  lens-synthesized row-local CHECK onto any member op — a **single-member** CHECK
  (`length(title) < 5`) is therefore *also* unenforced on the decomposition INSERT path, not only
  the cross-member one. The INSERT-parity test only asserts the cross-member deferral (correct and
  in-scope; `'q'` satisfies `length` anyway), so it does not depend on this. But note the wording
  in `docs/lens.md` ~L286 ("the decomposition INSERT path, which also defers cross-member row-local
  / set-level enforcement") reads as if *only* cross-member is deferred on INSERT, whereas the code
  defers the whole class. This is a possible **docs/code discrepancy or a real single-member-CHECK
  enforcement gap on decomposition INSERT** — I did **not** assert it (out of scope for this
  test-only ticket) and did **not** file a ticket, since whether it's a doc fix or a code fix is a
  judgment call. Recommend the reviewer decide: tighten the doc wording, or file a `fix/` ticket if
  single-member INSERT enforcement is intended. (The UPDATE path *does* gate per-op, which is what
  this ticket pins.)

- **Did NOT touch the shared `setupSurrogateOptional` fixture.** The new tests use a sibling
  `setupSurrogateWithChecks` helper (distinct module name `docchkmod`, CHECKs added, short seed
  titles) so the 5 pre-existing tests in the block are untouched. Slightly duplicates the base-table
  DDL of `setupSurrogateOptional`; acceptable per the file's per-block fixture style, but a reviewer
  preferring DRY could factor the three `create table` calls into a shared helper.

- **Child-FK deferral dual: out of scope.** Per the ticket, the FK dual needs a
  decomposition-with-logical-FK fixture that does not yet exist; not built here. If a
  logical-FK-over-decomposition fixture later lands trivially, a backlog follow-up could add the FK
  analogue of the cross-member deferral.

## Reviewer's adversarial checklist

- Confirm the cross-member test is non-vacuous (gate-flip experiment above).
- Sanity-check that `title='z', note='z'` truly fans out to two ops (Doc_core + Doc_meta) and not
  one — the cross-member claim rests on it.
- Decide the docs-vs-code INSERT-deferral wording question (single-member CHECK unenforced on
  decomposition INSERT): doc fix, fix ticket, or accept as-is.
