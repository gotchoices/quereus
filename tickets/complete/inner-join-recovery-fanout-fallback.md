description: Extended `inner-join-existence-recovery` to also fire on a POSITIVE no-right-col probe (`where <flag>`) when R fans out (non-unique on the join column) — the leftover case `semijoin-existence-recovery` abstains on via its fan-out guard. One-predicate gate flip; the two recovery rules now partition the entire positive-probe space and are disjoint independent of registration order (both consult the shared, now-exported `rightMatchesAtMostOne`).
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic, docs/optimizer.md
----

## What shipped

`ruleInnerJoinExistenceRecovery` now fires on a positive probe (`where flag`) over
a flag-bearing `left join … exists right as` whenever **a right column is demanded
OR R fans out** (non-unique on the join column). The change is a one-predicate gate
flip — the old right-col-only gate

```ts
if (!rightAttrIds.some(id => demanded.has(id))) return null;   // OLD
```

became

```ts
const rightColDemanded = rightAttrIds.some(id => demanded.has(id));
if (!rightColDemanded && rightMatchesAtMostOne(join)) return null;   // NEW
```

`rightMatchesAtMostOne` was `export`ed from `rule-semijoin-existence-recovery.ts`
(no logic change) and imported into the inner rule, so both rules read R's
uniqueness surface through the same predicate. Result:

- semi fires iff `!rightColDemanded && unique-R`
- inner fires iff `rightColDemanded || !unique-R`
- intersection = ∅ — disjoint independent of registration order.

Soundness of the new (fan-out) case: `emitLoopJoin` drives the flag-bearing left
join as one output row per matching right row (`flag=true`) plus a null-extended row
per unmatched left (`flag=false`); `where flag` keeps the K matched rows per left
row, and an inner join on the same condition yields exactly those K — row-for-row
identical for ANY condition and ANY fan-out, because an inner join does not collapse
K→1. `rightMatchesAtMostOne` is consulted in the inner rule only to locate the
abstention boundary, never as a correctness precondition.

## Review findings

**Method.** Read the implement diff (`97452beb`) with fresh eyes before the handoff
summary; re-derived the soundness/disjointness argument from the source; read the
full inner rule, the exported `rightMatchesAtMostOne` / `classifyProbe`, the
`JoinNode` constructor signature, the optimizer registration, and both sqllogic
files (08.2 and 08.3). Ran build, both recovery specs, all 08.x sqllogic, lint, and
the full suite.

**Correctness / soundness — checked, no defects.** The gate flip is correct; the
disjointness partition holds by construction (verified both rules call the same
`rightMatchesAtMostOne` on the same `join` node, and the common guards —
`existence.length===1`, `condition` present, `polarity==='semi'`,
`!demanded.has(flagId)`, no-side-effects — match). The inner-`JoinNode` construction
(`new JoinNode(scope, left, right, 'inner', condition)`, no usingColumns/existence)
reuses the same left/right node instances, so `buildJoinAttributes` emits identical
left+right attribute ids (flag dropped) and downstream key-based resolution is
unaffected — the construction is the one already validated by the prior
`outer-to-inner-join-under-flag-probe` ticket; this ticket only widened the gate.
Non-equi and ≤1-row-R edge behavior of `rightMatchesAtMostOne` (empty equi-pairs ⇒
empty-key uniqueness) routes correctly in both directions.

**Registration order — checked.** Confirmed semi (line 415) registers before inner
(line 441), both priority 23; the order-independence claim is real (disjoint per-node
⇒ same fixpoint either order), so "registered after semi" is now correctly downgraded
to conventional in the docstrings.

**Tests — checked, comprehensive.** Happy path, the new no-right-col fan-out cases
(bare probe + `is true`), anti routing through the semi rule (`where not h`), the
disjointness regression (unique-R/no-right-col stays `semi`), the physical-join
payoff (8×24 fixture ⇒ `hasPhysicalJoin`), star expansion, sibling-prune cascade,
and row-equality against a both-rules-disabled baseline (`resultsNoEitherRecovery`).
The semi spec's fan-out block was correctly flipped from `left`+flag to `inner`+flag-
dropped with anti unchanged. All pass.

**Minor — fixed inline.** The 08.2 fan-out comments (header block + the two semi-
probe line comments) still described only the semi-rule abstention and no longer
reflected that `inner-join-existence-recovery` now recovers those positive cases to a
fan-out-safe inner join (rows identical, so the assertions stayed green but the prose
was stale). Updated the three comments to state both halves and that the row counts
are what the assertions pin. Re-ran 08.2 — green. (08.2 was otherwise left unchanged
per plan, as it asserts only rows, which the inner join preserves.)

**Minor — noted, not actioned.** The three fan-out queries now appear verbatim in
both 08.2 and 08.3 over the same `fc`/`fp` fixture. Acceptable redundancy — each file
documents a different rule's perspective on the same shape; de-duplicating would lose
that framing for no correctness gain.

**Major — none.** No new fix/plan/backlog tickets filed.

**Implementer-flagged gaps — assessed, accepted (no ticket).**
- *Large-fixture cost coupling* (8×24 sized empirically so hash < nested-loop): the
  only cost-dependent assertion; passes now and is clearly documented as the one to
  re-size if cost constants change. The joinType-flip assertions are cost-independent.
- *No reversed-registration-order test*: disjointness is provable by construction and
  the unique-R-stays-semi regression locks the boundary; a literal order-swap test
  would add little. Out of scope, agreed.
- *`rightMatchesAtMostOne` now on the inner gate path for every no-right-col positive
  probe*: same work the semi rule already does on the same shape; negligible.

## Validation performed (review)

- `yarn workspace @quereus/quereus run build` — exit 0.
- Both recovery specs (`--grep ExistenceRecovery`) — **52 passing**.
- `08.1`/`08.2`/`08.3` sqllogic (`--grep "08\."`), plus 08.2 re-run after the comment
  edit — green.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- Full `yarn workspace @quereus/quereus test` — **5142 passing, 9 pending, 0 failing**.
- `yarn test:store` not run (memory-backed default; pure logical rewrite with no
  store-specific surface — same deferral the implementer documented).
