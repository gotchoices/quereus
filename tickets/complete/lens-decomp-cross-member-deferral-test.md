description: |
  Test-only: pinned the lens decomposition per-op constraint gate's CHECK deferral-vs-enforcement
  split. Three `it`s added to the `surrogate-keyed optional-member UPDATE` block in
  `lens-put-fanout.spec.ts` via a new `setupSurrogateWithChecks` helper, reusing the
  Doc_core/Doc_body/Doc_meta decomposition fixture (title on Doc_core, note on Doc_meta — a genuine
  cross-member pair). A cross-member `check (title <> note)` UPDATE that violates across members
  PASSES (deferred — the documented weaker contract); a single-member `check (length(title) < 5)`
  UPDATE that violates ABORTs (rides the Doc_core op); an INSERT parity case anchors the UPDATE
  deferral against the decomposition INSERT baseline. No source changes. Reviewed and accepted; one
  major finding spun out to fix/.
files:
  - packages/quereus/test/lens-put-fanout.spec.ts                   # the 3 tests + setupSurrogateWithChecks helper (~L1571+)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # constraintsForOp gate (~L880), extraConstraints (~L147), deferral log (~L200) — behavior under test
  - docs/lens.md                                                    # § Enforcement by constraint class (~L273, ~L286)
----

# Cross-member CHECK deferral-vs-enforcement behavioral coverage — COMPLETE

## What shipped

Three tests in `test/lens-put-fanout.spec.ts`, appended inside the existing
`describe('lens decomposition put: surrogate-keyed optional-member UPDATE', …)` block via a new
`setupSurrogateWithChecks(db)` helper that deploys the Doc_core(title)/Doc_body(body)/Doc_meta(note,
optional) surrogate decomposition with two row-local logical CHECKs:

| Test | Operation | Expected | Mechanism |
|---|---|---|---|
| defers a cross-member CHECK (`title <> note`) | `update x.Doc set title='z', note='z'` | PASSES, violation persisted at both members + via view | write-row `{title,note}` resolves on neither member op → rides none → deferred |
| enforces a single-member CHECK (`length(title) < 5`) | `update x.Doc set title='toolong'` | ABORTs, Doc_core title unchanged | write-row `{title}` resolves on Doc_core op → rides it → fires |
| decomposition INSERT parity | `insert into x.Doc values('k9','q','b9','q')` (title==note) | PASSES, violation persisted | decomposition INSERT defers the cross-member CHECK too |

The behavior under test is the `constraintsForOp` per-op resolvability gate in
`view-mutation-builder.ts`: a lens-synthesized CHECK rides a member fan-out op iff every write-row
column it references resolves on that op's target table.

## Review findings

**Verdict: the test work is sound and shipped as-is — no changes to the test code were needed.** One
pre-existing source/docs gap the implementer flagged was confirmed real and spun out to a `fix/`
ticket. No source or doc edits were made during review (working tree restored clean after
experiments).

### Checked — and what was found

- **Test correctness (happy/violating paths).** Read the implement diff fresh. The seed satisfies
  both CHECKs (`title='aaa'`/`'bbb'`, len 3 < 5; note `'m1'` ≠ title). Each assertion's SQL and
  expected state verified by hand against the fixture; the cross-member UPDATE genuinely persists at
  both base members AND via the view (not merely "didn't throw"), and the single-member UPDATE's
  rollback leaves `'aaa'`. **No issue.**

- **Non-vacuity (the implementer's chief flagged gap — they reasoned it but did not mechanically
  verify).** Ran the recommended gate-flip experiment: defeated the `resolvable` guard in
  `constraintsForOp` so every constraint rides every op, then ran the CHECK tests. Both UPDATE tests
  flipped from passing to **failing** — the cross-member test throws `Column not found: title`
  (the cross-member CHECK is forced onto a member op that cannot build it) and the single-member
  test's error stops matching `titlelen`. This confirms both tests are non-vacuous and would catch
  a regression that stops deferring cross-member CHECKs. Guard restored; `git status` clean. **No
  issue — concern resolved.**

- **Gate / `writeRowColumns` correctness.** Read `constraintsForOp` (~L880) and `writeRowColumns`
  (~L917). The cross-member claim ("`title='z', note='z'` fans out to two ops, neither carrying the
  pair") holds: `writeRowColumns` collects bare top-level + `NEW/OLD`-qualified columns; `{title,
  note}` resolves on neither the Doc_core nor Doc_meta member's columns. **No issue.**

- **Lint + tests.** `eslint test/lens-put-fanout.spec.ts` clean. Full `lens-put-fanout.spec.ts`:
  **63 passing**. (Implementer's full-suite 4979-passing claim not re-run — the change is test-only
  and I made no source changes, so a single-file green plus clean tree is sufficient evidence.) **No
  issue.**

- **Docs.** Read docs/lens.md § Enforcement by constraint class (L271–L286). The tested UPDATE
  deferral matches L286. But see the MAJOR finding below: L273's blanket "fires on every
  insert/update through the lens" is contradicted by the decomposition INSERT path.

### Major (spun out to a new ticket — not fixed in this pass)

- **Lens row-local CHECK is not enforced at all on the decomposition INSERT path** — even a
  single-member CHECK one base member fully resolves. The implementer flagged this as a possible
  docs/code discrepancy and explicitly left the enforce-vs-document decision to review. **Confirmed
  it is a real behavioral gap, not just wording:** a throwaway repro (`insert into x.Doc (docKey,
  title, body) values ('k1','toolong','b1')` under `check (length(title) < 5)`) **succeeds and
  persists `'toolong'`**, whereas the same CHECK ABORTs on the UPDATE path and on a single-source
  lens INSERT. Root cause: `buildViewMutation` returns into `buildDecompositionInsert` (~L68)
  *before* `extraConstraints` is collected (~L147), so no lens obligation reaches the member inserts.
  This is an INSERT-vs-UPDATE / single-source-vs-decomposition inconsistency and contradicts
  docs/lens.md L273. Filed as **`tickets/fix/lens-decomposition-insert-row-local-check-not-enforced.md`**,
  which frames the enforce-or-document decision for the maintainer and carries the repro + acceptance
  criteria. The INSERT-parity test in this ticket is unaffected (it only asserts the cross-member
  deferral, and `'q'` satisfies `length` anyway), so it remains correct.

### Minor (considered, not changed — with reasons)

- **DRY: `setupSurrogateWithChecks` duplicates ~3 base-table `create table` lines from
  `setupSurrogateOptional`.** Left as-is: the file follows a per-block fixture style, the helper
  legitimately diverges (distinct module name, added CHECKs, shorter seed titles), and factoring out
  the shared DDL would touch the 5 pre-existing tests' fixture for marginal gain. Not worth the
  regression surface in a test-only ticket.

- **INSERT-parity test asserts only the view image, not the base members.** Acceptable: the
  cross-member UPDATE test already pins both-member persistence; the INSERT case is an anchor against
  the UPDATE deferral, and the view image is the load-bearing observation.

- **Deferral `log` (`view-mutation-builder.ts` ~L200) not asserted.** Agreed with the implementer:
  it is a debug trace, not a contract surface; the persisted-row / ABORT assertions are the
  load-bearing pins. No clean log-capture harness exists and the ticket said not to build one. Left
  uncovered intentionally.

### Empty categories

- **Error-path coverage beyond the above:** none missing — the two enforcement outcomes (defer-pass,
  enforce-abort) are both directly asserted, and the gate has no third outcome on this fixture.
- **Performance / resource cleanup / type safety:** N/A — test-only change; each test uses a fresh
  `Database` in a `try/finally` that closes it (matches the block's idiom). No leaks, no `any`.

### Out of scope (carried forward, not regressed)

- **Child-FK deferral dual** — needs a decomposition-with-logical-FK fixture that does not yet exist;
  noted by the implementer, no ticket filed (would be a test-coverage follow-up if such a fixture
  lands cheaply).
