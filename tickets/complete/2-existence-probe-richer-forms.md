description: Existence-flag probe matcher now recognizes the four `IS [NOT] TRUE/FALSE` probe normal forms (semi: `is true`/`is not false`; anti: `is false`/`is not true`) in `classifyProbe`, widening the set of `left join … exists … as` queries that recover a semi/anti access path. `IS [NOT] NULL` over the never-null flag is deliberately NOT a probe (constant); CASE-wrapped probes remain out of scope.
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (classifyProbe UnaryOpNode branch L370-377; Q2 doc table L59-76), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, docs/optimizer.md (rule entry L495)
----

## What shipped

A single new branch in `classifyProbe` (the only behavioral change) matching a
`UnaryOpNode` whose operand is the flag `ColumnReferenceNode`:

- `IS TRUE` / `IS NOT FALSE` → `semi`
- `IS FALSE` / `IS NOT TRUE` → `anti`

placed after the `NOT`-over-colref branch (so it never sees `NOT`) and before the
`= true|false` binary branch. Any other unary operator over the flag (`IS NULL`,
`IS NOT NULL`, `-`, `+`, `~`) enters the `if`, matches no `case`, and falls through
to `return null` ⇒ the rule abstains. No change to the fan-out guard, demand
analysis, `analyzeChain`, `referencesAttr`, or chain rebuild — the new forms ride
the existing machinery. SEMI forms flow through the same `rightMatchesAtMostOne`
guard; ANTI forms are fan-out immune.

## Review findings

**Implement-stage diff reviewed first, with fresh eyes**, before reading the
handoff. The implementation is **correct and sound**; one documentation staleness
defect was found and fixed inline. Detail by category:

### Soundness / correctness — verified, no defects
- **The load-bearing non-null invariant holds.** The `is not false ≡ = true` /
  `is not true ≡ = false` collapses are exact only because the flag is provably
  non-null. Independently confirmed end-to-end: `EXISTENCE_FLAG_TYPE.nullable ===
  false` (`join-utils.ts`); `buildJoinAttributes` / `buildJoinRelationType` append
  the flag with that type and **never** mark it nullable; the runtime
  (`runtime/emit/join.ts` L46-47) computes `matchedFlags = all true`,
  `unmatchedFlags = side==='left'` (⇒ `false` for a `right` spec) — so the flag is
  always `true`/`false`, never `null`.
- **No intervening null-extension.** `walkChain` passes through only
  `Filter`/`Sort`/`LimitOffset`/`Distinct`/`Alias` (none null-extend rows) and stops
  at the *first* `JoinNode`, so the flag reaches the probe Filter exactly as
  `emitLoopJoin` emitted it. The invariant therefore holds at *runtime*, not merely
  statically — closing the one place unsoundness could have hidden.
- **Runtime polarity mapping is exact** (`runtime/emit/unary.ts` L43-72): for a
  non-null flag, `IS TRUE`/`IS NOT FALSE` keep matched rows (→ semi) and
  `IS FALSE`/`IS NOT TRUE` keep unmatched rows (→ anti). Matches the classifier.
- **Parser/AST shape matches the matcher.** `parser.ts` L1350-1356 emits
  `{type:'unary', operator:'IS TRUE'|'IS NOT TRUE'|'IS FALSE'|'IS NOT FALSE'}` — the
  exact strings the `switch` cases test.
- **`normalizePredicate` leaves IS forms intact.** It only pushes `NOT` down and
  flips `>,>=,<,<=,=`; a non-`NOT` `UnaryOpNode` recurses into its (unchanged
  colref) operand and returns the same node. So `f is not true` stays unary — the
  new branch is necessary and fires.
- **Branch ordering is safe.** The prior `NOT` branch returns for every `NOT`
  unary first, so the new branch only ever sees the IS operators.
- **Sole-conjunct guard still bites the new forms.** `referencesAttr` descends via
  `UnaryOpNode.getChildren() === [operand]` (verified `scalar.ts` L70), so
  `f is true and f = x` registers two flag conjuncts and disqualifies.
- **`not (f is true)`** normalizes to `NOT(IS TRUE(f))` (an outer `NOT` over a
  non-colref unary) ⇒ the `NOT` branch returns null ⇒ rule abstains. Unoptimized but
  byte-correct via the surviving `left join`. Acceptable per ticket scope.

### Docs — one defect, fixed inline (minor)
- **`docs/optimizer.md` L495 was stale.** It still listed `flag is [not] true`
  under *Deferred* and omitted the IS forms from the accepted-forms enumeration.
  Fixed: added the four IS forms (with the non-null-collapse caveat and the
  `is [not] null`-is-a-constant note) to the accepted list, and narrowed the
  Deferred clause to `case`-wrapped probes only.
- The source-file Q2 header table (L59-76) and `classifyProbe` agree exactly
  (8 forms) — verified.

### Tests — adequate; one conscious, independently-verified omission
- Added: parameterized spec over all four IS forms (asserts joinType semi/anti,
  flag dropped, correct rows, equals no-recovery baseline); `is not null` / `is
  null` rejection specs (flag retained, `joinType==='left'`); `is true` fan-out
  SEMI abstention spec; matching `.sqllogic` result + rejection + fan-out rows.
- **No dedicated ANTI fan-out test for `is false`/`is not true`.** Confirmed
  redundant: ANTI is fan-out-immune by construction (unmatched rows never
  duplicate) and `is false`/`is not true` share the *identical* code path as bare
  `where not f`, which already has a fan-out spec (`ANTI still fires under
  fan-out`). Left as-is — a conscious, verified choice, not an oversight.

### Validation
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn` lint (packages/quereus) — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — **5105 passing, 9 pending, 0
  failing**. Memory vtab only; the rewrite is byte-identical rows so `test:store`
  was not run (consistent with the rule being a pure row-preserving optimization).
- No pre-existing failures surfaced.

### Disposition
No major findings → no new tickets filed. The lone minor finding (doc staleness)
was fixed in this pass. `case`-wrapped probes remain explicitly out of scope per
the source ticket's value/complexity decision; file a fresh backlog ticket only if
a real workload produces them.
