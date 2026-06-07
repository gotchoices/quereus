description: `ruleJoinEliminationUnderAggregate` (the Aggregate anchor for FK→PK join elimination) was widened from `inner`-only to `left`/`right`/`inner`, mirroring the Project anchor (`ruleJoinElimination`) verbatim apart from the demand prologue (group-by + aggregate exprs) and the rebuild epilogue (reconstruct the `AggregateNode`). A cardinality-only aggregate (`count(*)`) over an FK→PK LEFT join now collapses to zero join ops, completing the "prune undemanded existence flag → eliminate flag-free join" cascade under an aggregate anchor. A new `hasExistenceColumns` guard keeps elimination from firing out from under a live `exists … as` flag (whose attr id is invisible to the column-demand scan). LEFT/RIGHT correctness is unconditional (`|L LEFT JOIN R| == |L|` under FK→PK alignment, needing neither a NOT-NULL FK nor a row-preserving R).
files: packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate), packages/quereus/src/planner/optimizer.ts (registration comments ~505/~515), packages/quereus/test/optimizer/rule-join-elimination.spec.ts (aggregate-anchored elimination block + 3 review-added tests), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (flipped count(*) cascade test), docs/optimizer.md (existence-pruning + Aggregate-entrypoint bullets)
----

## Outcome

The implement-stage change is **correct and sound**. The core widening (inner-only → left/right/inner)
is byte-identical to the already-shipped Project anchor's `switch`, the new `hasExistenceColumns`
guard is structurally sound, and the LEFT/RIGHT cardinality argument holds. Review found **no
correctness defects**. Coverage was the real gap: the handoff itself flagged three "suggested, not
required" omissions and one factually-wrong "Known gaps" claim about the RIGHT arm. All four were
addressed **inline** (minor disposition): three new tests added, plus a doc correction. No new fix/
plan/backlog tickets were filed. Typecheck, lint, and the full quereus suite are green
(**5114 passing**, 9 pending, +3 from the review-added tests).

## Review findings

### Checked

- **Implement diff, fresh eyes** — `rule-join-elimination.ts` (`ruleJoinEliminationUnderAggregate`:
  the demand prologue, the `hasExistenceColumns` guard, the widened type guard, the
  `switch (join.joinType)`, the parameterized `log`, the `AggregateNode` rebuild epilogue), the
  unchanged `tryEliminate` gating, `optimizer.ts` (comment-only edits), both spec files, and the two
  `docs/optimizer.md` bullets.

- **`hasExistenceColumns` soundness crux (the one genuinely new obligation)** — confirmed the guard
  (`join-node.ts:202`) is **purely structural**: `!!this.existence && this.existence.length > 0`,
  with zero dependence on demand analysis. The reviewer-posed question ("is there a demand shape that
  keeps a flag id off both side-column sets AND off `hasExistenceColumns`?") is therefore answered
  **no by construction** — the guard abstains on the mere *presence* of any flag, demanded or not, so
  no demand shape can evade it. The cascade (prune undemanded flags at priority 22 → flag-free →
  eliminate at priority 26) is what recovers the optimization. Both directions tested
  (live-flag-demanded retains; undemanded-flag cascades to elimination).

- **`switch` parity with the Project anchor** — diffed `ruleJoinElimination` (lines 91–109) against
  `ruleJoinEliminationUnderAggregate` (lines 369–387): the `left`/`right`/`inner` arms are
  **byte-identical**, and confirmed via `git show 6f230943^` that the Project anchor's `switch`
  (including the outer arms) is **pre-existing**, not introduced here. The `inner` arm is unchanged →
  no regression risk to existing inner coverage (re-confirmed green).

- **LEFT/RIGHT cardinality argument** — `|L LEFT JOIN R| == |L|` holds whenever R yields ≤1 match per
  L row; `checkFkPkAlignment` (full-PK-coverage + positional FK→PK + `pkColSet` defensive check) caps
  matches at ≤1, and LEFT preserves every L row (matched → 1, unmatched → 1 null-padded). The
  NOT-NULL-FK and `isRowPreservingPathToTable` checks are correctly gated behind
  `joinType === 'inner'` in `tryEliminate`, so the outer path runs only FK→PK alignment + the
  side-effect guard — the correct gate. FK *direction* is enforced by `tryEliminate` choosing
  `fkSchema`/`pkSchema` by side, so `parent LEFT JOIN child` (fan-out shape) correctly abstains.

- **Column-index-mapping robustness (outer arms skip `isRowPreservingPathToTable`)** — the inner
  guard partly exists to keep equi-pair indices (positions in `join.right.getAttributes()`) aligned
  with base-table column indices that `checkFkPkAlignment` assumes. The outer arms skip it. Probed a
  column-reordering subquery on the non-preserved side of a LEFT `count(*)`
  (`… LEFT JOIN (SELECT region, id AS cid, name FROM customers) c ON orders.customer_id = c.cid`):
  result is **conservative abstain** (HASHJOIN survives), correct result `[{n:3}]`. The imprecision
  manifests only as a missed optimization, never a wrong result, because no single-relation wrapper
  reachable by `extractTableSchema` can *duplicate* PK rows — the ≤1-match invariant holds regardless
  of index-mapping precision. (Same pre-existing property as the Project anchor's outer arms.)

### Found & fixed inline (minor)

- **RIGHT arm is NOT "untestable dead code" — the handoff's "Known gaps" claim is wrong.** The
  handoff asserts *"any RIGHT query errors at execution before results are produced"* and that the
  `right` arm is *"unreachable-via-SQL parity dead code."* This is incorrect: when the rule **fires**
  on a RIGHT join it removes the join entirely, so emit never sees `'right'` and no throw occurs.
  Verified empirically: `count(*) FROM customers RIGHT JOIN orders ON orders.customer_id = customers.id`
  eliminates to a join-free plan (`INDEXSCAN` over orders) and returns the **correct** `[{n:3}]`;
  with the rule disabled, the same query throws `RIGHT JOIN is not supported yet`. So this ticket
  silently converts a class of previously-throwing RIGHT aggregates into correct results — a sound
  improvement that was undocumented and untested. **Fix:** added a RIGHT test asserting elimination +
  correct result + the disabled-rule throw contrast, and a `docs/optimizer.md` note explaining that
  eliminating an FK-covered RIGHT join is what lets a `count(*)` over it return a result at all.

- **Wrapper-chain LEFT under the aggregate anchor was untested** (handoff gap #2). Added
  `count(*) … LEFT JOIN … WHERE orders.total > 20` → eliminates (joinCount 0), `[{n:2}]`,
  byte-equal to the disabled-rule baseline. Exercises `walkChain` folding a left-side predicate into
  `demanded` while `usesRight` stays false on the outer path.

- **Composite-FK LEFT success path was untested** (handoff gap #3). Added an aligned composite FK
  `(fa, fb) REFERENCES pcomp(a, b)` under `count(*) … LEFT JOIN …` → eliminates, `[{n:2}]`,
  baseline-equal. The misaligned-composite *abstain* was already covered for inner (Project anchor);
  this confirms the multi-column `checkFkPkAlignment` *success* path on the aggregate-LEFT anchor.

### Filed as new tickets

- **None.** No defect rose to the "major → new ticket" bar; all findings were coverage/documentation
  gaps fixed in this pass.

### Not done / deferred (with reason)

- **RIGHT-JOIN *execution* coverage** — still genuinely absent and out of scope: `emit/join.ts:59`
  throws `RIGHT JOIN is not supported yet`, so only the *eliminated* RIGHT path is reachable (now
  tested). A RIGHT join the rule abstains on still throws at emit — unchanged, pre-existing
  limitation, correctly left alone.

- **Pre-existing LSP-only diagnostic** (`'globalRulesRegistered' is declared but never read` at
  `optimizer.ts:101`) — predates this ticket (the optimizer.ts edits here are comment-only),
  `tsc --noEmit` and eslint both pass clean, so it is a non-failing editor hint, not a build error.
  Left untouched, as the implementer flagged.

## Validation

- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0).
- `yarn eslint test/optimizer/rule-join-elimination.spec.ts` → clean (exit 0).
- Full suite `yarn workspace @quereus/quereus run test` → **5114 passing, 9 pending**, zero failures
  (was 5111 before the +3 review-added tests). No `.sqllogic` row shifts.
