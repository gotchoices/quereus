description: Fire inner-join existence recovery on a POSITIVE no-right-col probe (`where <flag>`) when the right side fans out (R non-unique), the case `semijoin-existence-recovery` abstains on its fan-out guard. An inner join is sound there (K matches stay K rows) and re-opens physical join selection the live flag pins shut.
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic
----

## Summary

Today three positive-probe shapes exist over a flag-bearing `left join … exists right as`:

| Probe (`where flag`) | Right col demanded? | R unique on join col? | Handled by | Result |
|----------------------|---------------------|-----------------------|------------|--------|
| positive             | NO                  | **yes** (≤1 match)    | `semijoin-existence-recovery` | `semi(L,R,c)` |
| positive             | YES                 | any                   | `inner-join-existence-recovery` | `inner join` |
| positive             | NO                  | **no** (fan-out)      | **neither (today)** | stays flag-bearing `left` join |

The third row is this ticket. When R is **not unique** on the join column a left
row matches K>1 right rows, so `semijoin-existence-recovery` abstains (a semi join
collapses K→1, dropping duplicates — unsound). The plan stays a nested-loop `left`
join with a live flag, which pins `join-physical-selection` shut. An **inner join**
is sound here — it does not collapse (K matches stay K rows, identical to `where
flag` over the flag-bearing left join for ANY condition, exactly the soundness
argument already documented in `rule-inner-join-existence-recovery.ts`) — and
dropping the flag re-opens hash/merge join selection.

This ticket extends `inner-join-existence-recovery` to also fire on this leftover
fan-out case, making the two recovery rules partition the **entire** positive-probe
space.

## Resolved design decisions (do not re-litigate)

### Q1 — gate: explicit "semi would have abstained" predicate (NOT a bare gate-drop)

Replace the inner rule's current right-col gate

```ts
const rightAttrIds = join.right.getAttributes().map(a => a.id);
if (!rightAttrIds.some(id => demanded.has(id))) return null;
```

with: **abstain only when there is no right column demanded AND the semi rule could
have handled it (R is unique ⇒ no fan-out).** Fire otherwise.

```ts
const rightAttrIds = join.right.getAttributes().map(a => a.id);
const rightColDemanded = rightAttrIds.some(id => demanded.has(id));
// Defer to semijoin-existence-recovery ONLY where it can actually fire: no right
// column demanded AND R unique on the join column (≤1 match ⇒ the leaner semi join
// is sound and strictly better — collapses to L, folds via the IND cascade). When R
// fans out, semi abstains and the sound inner join is the only win available here.
if (!rightColDemanded && rightMatchesAtMostOne(join)) return null;
```

Chosen over the alternative (simply deleting the gate and relying on registration
order so the semi rule wins the unique-R/no-right-col case first) because the
explicit predicate makes the two rules **provably disjoint independent of
registration order**, rather than coupling correctness-of-optimization to the fact
that `semijoin-existence-recovery` is registered first. Disjointness proof on the
positive-probe space (anti polarity already excluded by the existing
`probe.polarity !== 'semi'` guard above this point):

- semi fires iff: `!rightColDemanded && unique-R`
- inner fires iff: `rightColDemanded || !unique-R`
- intersection = `!rightColDemanded && unique-R && (rightColDemanded || !unique-R)` = ∅

`rightMatchesAtMostOne` already exists (private) in
`rule-semijoin-existence-recovery.ts`; **export it** and import it into the inner
rule. It reads R's full uniqueness surface (declared + FD-derived keys via
`physical`) exactly as the semi rule's fan-out guard does, so the two rules agree on
the unique/fan-out boundary by construction (same function, no drift).

### Q2 — no cost guard

The fallback fires **unconditionally** within its gate; it does NOT consult whether
`join-physical-selection` would actually pick a physical join. Reasons:

- **Symmetry.** The existing right-col half of this same rule has no cost guard — it
  fires even on tiny fixtures where physical selection leaves a nested-loop inner
  join (e.g. the existing `setupFanOut` 2×3 fixture: nl=2.6 < hash=2.8, so it stays
  nested-loop). Adding a cost gate to only the fan-out half would make the rule
  asymmetric and harder to reason about.
- **Never worse than baseline.** A nested-loop inner join is not more expensive than
  the flag-bearing nested-loop left join it replaces — it drops the appended flag
  bit and the null-extension of unmatched rows. So "no physical-join win" ≠ "harm";
  worst case is a structurally cleaner, row-identical plan.
- **Layering / DRY.** Recovery is a logical rewrite; `join-physical-selection` owns
  the cost call. Replicating its three-way cost comparison (estimatedRows, equi-pair
  extraction, nl/hash/merge formulas) inside the recovery rule would duplicate cost
  logic and invert that separation.

### Q3 — payoff is real on the plain memory vtab (premise corrected)

The plan ticket worried this might be a no-op on the memory vtab "where
`expectedLatencyMs === 0` makes several cost gates inert". **That premise is wrong
for this rule.** `join-physical-selection` (`rule-join-physical-selection.ts`) gates
on `node.left/right.estimatedRows` through the cost constants
(`nestedLoopJoinCost` / `hashJoinCost` / `mergeJoinCost`), **not** on
`expectedLatencyMs`. The `expectedLatencyMs`-inert rules are the *parallel* ones
(eager-prefetch, async-gather, batched-outer). The memory vtab reports exact row
counts (`getBaseLayerStats().rowCount`), and because nested-loop cost is quadratic,
hash beats nested-loop for all but the smallest/most-balanced inputs (the existing
`re-enables physical join selection` test already gets a hash join at 4×2 rows:
hash 3.2 < nl 4.8). So the fan-out fallback yields a **real** hash/merge plan on the
plain memory vtab once the fixture is large enough — no latency-bearing module
needed.

Fixture sizing (cost = `outer*1.0 + outer*inner*0.1` for nl vs
`min*0.8 + max*0.4` for hash): keep the tiny `setupFanOut` (2×3) for the
joinType-flip + row-equality assertions (it stays nested-loop), and add a larger
fan-out fixture (e.g. ~6+ distinct left rows, right fanning ≥2 per match) sized so
hash < nl to assert `hasPhysicalJoin === true`. Verify the exact counts empirically
when writing the test rather than trusting the back-of-envelope numbers.

### join-elimination interaction (confirmed safe)

Under the fallback's domain (no right col, R **non-unique**), `join-elimination`
(priority 24) cannot fire on the recovered inner join: inner-join elimination
requires an at-most-one (unique) FK→PK alignment with NOT-NULL FK, which contradicts
the fan-out (non-unique R) precondition. So the right side survives and the win is
hash/merge join only — exactly the plan ticket's reasoning, confirmed. (The
unique-R/no-right-col case where elimination *would* apply is handled by the semi
rule, never by this fallback.)

## Edge cases & interactions

- **Disjointness with the semi rule** — no-right-col + unique-R + positive probe
  must still recover a **semi** join (not inner). Lock with a regression test.
- **Anti polarity untouched** — `where not flag` (no right col, any fan-out) stays a
  `left` join (anti rows have an all-NULL right side; inner would drop them). Already
  guarded by `probe.polarity !== 'semi'`; the `setupFanOut` ANTI test must stay
  green and still go through `semijoin-existence-recovery` (anti is fan-out-immune).
- **Row equality under fan-out** — the recovered inner join must keep ALL K fanned
  rows (`[1,1,1]` for the cc=1×3 fixture), byte-identical to the flag-bearing
  baseline. Baseline must disable **both** recovery rules (mirroring the existing
  right-col inner test at `rule-semijoin-existence-recovery.spec.ts:404`), because
  the default `resultsNoRecovery` helper in the inner spec disables only the inner
  rule and the semi rule cannot fire under fan-out anyway.
- **Residual ON / non-equi conditions** — carried verbatim (no condition-shape
  restriction; same as the existing inner rule). A fan-out with a residual conjunct
  still keeps all surviving matches.
- **Impure R** — `subtreeHasSideEffects(join.right)` guard still applies (dropping
  the flag re-enables a hash join that scans R once total). Unchanged.
- **Multi-flag / flag-also-demanded / star expansion / OR-probe / sorted-on-flag** —
  all already covered by `analyzeChain` and the existing inner-rule tests; the gate
  change touches none of them. The unqualified `select *` case still retains the flag
  (the flag lands in `demanded`).
- **Termination** — output is an inner join with no existence spec ⇒ the anchor's
  `joinType === 'left'` check no-ops on re-run. Unchanged.
- **Existing tests that flip** — `rule-semijoin-existence-recovery.spec.ts` "fan-out
  guard" block (the two SEMI cases, `where h` and `where h is true`, both no right
  col) currently assert `joinType === 'left'` + flag retained. With this change they
  recover to `inner`. Update them (see TODO). The `08.2-...sqllogic` fan-out section
  asserts only rows (`[1,1,1]`), which the inner join preserves — it stays green, no
  edit required (but add the plan-shape coverage in `08.3` instead, see TODO).

## Key tests (expected outputs)

- `select cc from fc c left join fp p on p.pp = c.cc exists right as h where h`
  over fan-out (cc=1 matches 3 rows) ⇒ plan: `inner` join, no existence flag; rows
  `[{cc:1},{cc:1},{cc:1}]` == both-rules-disabled baseline.
- Same shape on a fan-out fixture large enough that hash < nl ⇒ `hasPhysicalJoin`
  true (BLOOMJOIN/MERGEJOIN/HASHJOIN present).
- `where h is true` (semi probe) over fan-out ⇒ same inner recovery (rides the same
  classification).
- `where not h` over fan-out ⇒ stays `left` (anti via the semi rule's anti path).
- no-right-col + unique-R (`seedExisting`, exp.pp is PK) ⇒ stays `semi` (regression
  locking disjointness).

## TODO

### Rule change
- Export `rightMatchesAtMostOne` from `rule-semijoin-existence-recovery.ts`.
- In `rule-inner-join-existence-recovery.ts`: import `rightMatchesAtMostOne`; replace
  the right-col gate with the `!rightColDemanded && rightMatchesAtMostOne(join)`
  abstention (Q1 snippet above).

### Docs (in-file)
- Update the inner rule's header docstring: the "complement of the semi rule" framing
  and the partition table now have a fan-out dimension — the rule fires on a positive
  probe when a right column is demanded **OR** R fans out (semi unsound). State the
  order-independent disjointness explicitly (replaces the "registered after so semi
  wins" reliance).
- Adjust the semi rule's Q3 docstring note that says no-right-col positive probes are
  picked up only when a right col is demanded — now: unique-R → semi here; fan-out →
  inner fallback.

### Tests
- Update `rule-semijoin-existence-recovery.spec.ts` "fan-out guard" block: the two
  SEMI cases (`where h`, `where h is true`, no right col) now assert
  `joinExistence === undefined` and `joinTypeOf === 'inner'`, rows still `[1,1,1]`,
  equal to a **both-rules-disabled** baseline. Reframe the comments: the SEMI rule
  still abstains (joinType is not `semi`), and the inner fallback recovers a
  fan-out-safe inner join. Keep the ANTI case asserting `left`.
- Add to `rule-inner-join-existence-recovery.spec.ts`:
  - no-right-col + fan-out (small `setupFanOut`) ⇒ inner recovery, flag dropped, rows
    `[1,1,1]` == both-rules-disabled baseline.
  - no-right-col + fan-out, large fixture sized so hash < nl ⇒ `hasPhysicalJoin`
    true (the payoff assertion; pick counts empirically).
  - no-right-col + unique-R (`seedExisting`) ⇒ stays `semi` (disjointness regression).
- Add plan-shape coverage to `08.3-existence-flag-inner-recovery.sqllogic` for the
  no-right-col fan-out inner recovery (rows `[1,1,1]`), so the SQL-level path is
  asserted alongside the unit tests. (`08.2` stays unchanged.)

### Validation
- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/inner-fanout.log; tail -n 60 /tmp/inner-fanout.log`
  (focus first on the two recovery spec files + `08.2`/`08.3` sqllogic, then full run).
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
