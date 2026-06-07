description: Extend `inner-join-existence-recovery` to also fire on a POSITIVE no-right-col probe (`where <flag>`) when R fans out (non-unique on the join column) — the leftover case `semijoin-existence-recovery` abstains on via its fan-out guard. An inner join is sound there (K matches stay K rows, no collapse) and dropping the flag re-opens physical join selection the live flag pins shut. The two recovery rules now partition the entire positive-probe space and are disjoint independent of registration order (both consult `rightMatchesAtMostOne`).
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts (gate change + docstring), packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (export rightMatchesAtMostOne + Q5 docstring), packages/quereus/src/planner/optimizer.ts (registration comment), packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts (new fan-out-fallback block + large-fixture payoff test + resultsNoEitherRecovery helper), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (fan-out guard block flipped to inner + resultsNoEitherRecovery helper), packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic (no-right-col fan-out cases), docs/optimizer.md (both rule bullets)
----

## What changed

Before this ticket, three positive-probe shapes over a flag-bearing
`left join … exists right as`:

| Probe (`where flag`) | Right col demanded? | R unique on join col? | Handled by | Result |
|----------------------|---------------------|-----------------------|------------|--------|
| positive             | NO                  | yes (≤1 match)        | `semijoin-existence-recovery` | `semi(L,R,c)` |
| positive             | YES                 | any                   | `inner-join-existence-recovery` | `inner join` |
| positive             | NO                  | **no (fan-out)**      | **neither (before)** → `inner-join-existence-recovery` (now) | `inner join` |

The third row is this ticket. The change is a **one-predicate gate flip** in
`ruleInnerJoinExistenceRecovery`: the old right-col-only gate

```ts
const rightAttrIds = join.right.getAttributes().map(a => a.id);
if (!rightAttrIds.some(id => demanded.has(id))) return null;   // OLD
```

became an explicit "defer to semi only where semi can actually fire" abstention:

```ts
const rightAttrIds = join.right.getAttributes().map(a => a.id);
const rightColDemanded = rightAttrIds.some(id => demanded.has(id));
if (!rightColDemanded && rightMatchesAtMostOne(join)) return null;   // NEW
```

`rightMatchesAtMostOne` was made `export`ed from `rule-semijoin-existence-recovery.ts`
(no logic change) and imported into the inner rule, so both rules read R's
uniqueness surface through the **same** function — the unique/fan-out boundary
cannot drift between them.

Everything else in the inner rule is unchanged: the positive-probe guard
(`probe.polarity === 'semi'`), `!demanded.has(flagId)`, the impure-R guard, the
condition-carried-verbatim inner-join construction, and the probe-stripping
chain rebuild.

## Why it is sound (recap for the reviewer to re-derive)

`emitLoopJoin` drives `left join … exists right as` as a normal left join + one
appended flag bit: a matched left row with K right matches → K output rows each
`flag=true`; an unmatched left row → 1 null-extended row `flag=false`. A positive
`where flag` keeps exactly the K matched rows per left row; an **inner join** on
the same condition yields exactly those K rows — identical row-for-row for ANY
condition and ANY fan-out, because an inner join does not collapse K→1 (this is
precisely why the *semi* rule needs a fan-out guard and the inner rule does not,
for soundness). So `rightMatchesAtMostOne` is consulted in the inner rule **only**
to locate the abstention boundary (cede the unique-R/no-right-col case to the
leaner semi join), never as a correctness precondition.

Disjointness on the positive-probe space (anti excluded upstream by
`probe.polarity === 'semi'`), order-independent because both gates use the same
predicate:
- semi fires iff `!rightColDemanded && unique-R`
- inner fires iff `rightColDemanded || !unique-R`
- intersection = ∅

## Use cases / behaviors to verify (test floor — treat as a starting point)

Plan-shape + row-equality assertions (memory vtab, exact row counts):

- **no-right-col + fan-out (small 2×3 fixture)** ⇒ `joinType inner`, flag dropped,
  rows `[1,1,1]`, byte-identical to a **both-rules-disabled** baseline. Stays
  nested-loop at 2×3 (nl 2.6 < hash 2.8) — isolates the joinType flip, not the
  physical-join payoff.
- **`where h is true` (semi probe) + fan-out** ⇒ same inner recovery.
- **`where not h` (anti probe) + fan-out** ⇒ stays handled by the *semi* rule as an
  **anti** join (anti is fan-out-immune); inner rule does not fire (positive-only).
- **no-right-col + fan-out, large fixture (8 left × 24 right)** ⇒ `joinType inner`
  AND `hasPhysicalJoin === true` (hash/merge). This is the payoff: dropping the
  flag re-opens `join-physical-selection`, which picks a physical join because
  nested-loop cost is quadratic. **The 8×24 sizing is empirical (cost-constant-
  dependent)** — if the join cost model changes, this assertion is the one most
  likely to need a re-size. See `setupLargeFanOut`.
- **no-right-col + UNIQUE R (`seedExisting`, exp.pp is PK)** ⇒ stays `semi`
  (disjointness regression; the inner rule defers via the new gate).

The semi spec's "fan-out guard" block was flipped: the two SEMI cases (`where h`,
`where h is true`, no right col) that previously asserted `joinType left` + flag
retained now assert `joinType inner` + flag dropped, rows still `[1,1,1]`, equal
to a both-rules-disabled baseline. The ANTI case is unchanged (`joinType anti`).

SQL-level (`08.3-...sqllogic`): added no-right-col fan-out rows `[1,1,1]` (bare
probe + `is true`) and the anti `[2]` case. `08.2` left unchanged per the plan
(it asserts only rows, which the inner join preserves — verified still green).

Both specs gained a `resultsNoEitherRecovery` helper (disable BOTH recovery rules)
for the genuine nested-loop+flag baseline; the existing right-col inner test in the
semi spec was refactored onto it (removing an inline duplicate).

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- Two recovery spec files — **52 passing**.
- `08.1`/`08.2`/`08.3` sqllogic (`--grep "08\."`) — **4 passing**.
- Full `yarn workspace @quereus/quereus test` — **5142 passing, 9 pending, 0 failing**.
- `documentation.spec.ts` re-run after the docs edits — 6 passing.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test:store` (LevelDB store path) — **NOT run** (default agent suite is
  memory-backed; store mode is slower). The change is a pure logical rewrite with
  no store-specific surface, but a reviewer wanting belt-and-suspenders could run
  `yarn test:store --grep "08\."`.

## Known gaps / things for the reviewer to scrutinize

- **Large-fixture cost coupling.** `setupLargeFanOut` (8×24) is sized empirically
  so hash < nested-loop; the `hasPhysicalJoin === true` assertion depends on the
  current cost constants. It passed when written, but it is the most brittle new
  assertion if cost tuning shifts. (The joinType-flip assertions do not depend on
  cost and are robust.)
- **Order-independence claimed but not exercised by a reversed-registration test.**
  The disjointness proof is by construction (shared `rightMatchesAtMostOne` +
  empty intersection), and the unique-R-stays-semi regression locks the boundary,
  but there is no test that literally reverses the two rules' registration order to
  prove the fixpoint is identical. Considered out of scope (the gate predicates are
  provably non-overlapping); flagging in case the reviewer wants a belt test.
- **`rightMatchesAtMostOne` now on the inner rule's gate path** for every
  no-right-col positive probe — it extracts equi-pairs and runs `isUnique`. This is
  the same work the semi rule already does on the same shape; negligible, but noted.
- **Anti + no-right-col fan-out** is routed through the *semi* rule (anti path), not
  the inner rule — verified by test, but it is the one positive-vs-negative routing
  subtlety worth a second look.
- **Docs:** both `docs/optimizer.md` rule bullets were rewritten for the new
  partition (fan-out dimension + order-independent disjointness), plus in-file
  docstrings on both rules and the optimizer registration comment. Prose-only; no
  doc test covers optimizer.md content, so a careful read is the only check.
