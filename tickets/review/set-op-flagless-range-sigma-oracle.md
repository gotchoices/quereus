description: Review the range-σ write-branch oracle fix — a range/BETWEEN σ on a *projected* set-op leg column is now fed to `checkSatisfiability` so a provably-out-of-range INSERT skips the leg (no phantom base row).
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md, packages/quereus/src/planner/analysis/sat-checker.ts
difficulty: medium
----

## What shipped

The flag-less set-op write oracle (`legConsistency` → `checkSatisfiability`) previously saw only
the leg's *planned physical* `constantBindings`/`domainConstraints` plus the synthesized literal
discriminators. A **range** σ (`where x < 5`) on a **projected** column forwards as neither (filter
passes domains through unchanged; a non-equality emits no `ConstantBinding`), so an out-of-range
INSERT routed into the leg and landed a phantom base row that the view's σ then hides on read-back.

Fix (Option A, "feed the leg's σ conjuncts to the oracle"), all in `set-op.ts`:

- **`interface FlaglessLeg`** gained `sigmaConjuncts: readonly ScalarPlanNode[]` (`set-op.ts:1442`).
- **`collectFilterConjuncts(root)`** (`set-op.ts:1587`) — a small recursive DFS over
  `RelationalPlanNode.getRelations()` that `splitConjuncts(node.predicate)` for every `FilterNode`
  in the planned leg body. `buildFlaglessLeg` populates `sigmaConjuncts` from `legRoot`
  (`set-op.ts:1570`).
- **`legConsistency`** (`set-op.ts:1615`) now passes `[...conjuncts, ...leg.sigmaConjuncts]` to
  `checkSatisfiability`.

**No `sat-checker.ts` change.** The soundness rests on two of its pre-existing properties (verified
during implement, worth re-confirming in review):
1. It never emits a false `unsat` (`sat-checker.ts:70-74`), so adding conjuncts only moves the
   verdict toward `unsat` on a *real* contradiction.
2. A conjunct on a column the leg does **not** project resolves to `attrIndex → undefined`;
   `absorbBinary`/`markUnknownForColumns` only touch accumulators for a *valid* index
   (`sat-checker.ts:321-322, 425-433`), so it contributes nothing — not even a `sawUnknown`. This is
   why every existing 93.6 assertion (legs with `where color='red'` on a *non-projected* `color`)
   stays green.

The **attr-id load-bearing fact**: `ProjectNode` reuses the base column's attribute id for a plain
`ColumnReferenceNode` projection (`project-node.ts:198-208`), so the σ `FilterNode.predicate`
(`x < 5`, referencing base `x`) and the projected output `x` column share an attr id → both fold
onto the same `checkSatisfiability` accumulator with **no manual base→output remap**. The mutation
predicate `x = 7` (built against `leg.scope`, same attr id) folds onto it too:
`x = 7 ∧ x < 5 ⇒ unsat ⇒ skip the leg`.

Docs: `docs/view-updateability.md` § Set Operations v1-limitation parenthetical updated — a range σ
on a projected column is now honored (out-of-range INSERT skips the leg, no phantom); a σ on a
**non-projected** column (`where f(color)`) still routes include-on-unknown.

## Validation performed (this is a FLOOR, not a ceiling)

- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus test` — **6285 passing, 0 failing, 9 pending**.
- 93.6 in isolation — passing, including the new "Range-σ write-branch oracle" section.

### New 93.6 coverage (`93.6-set-op-flagless-write.sqllogic`, appended section)

- **`RV`** — two legs over **different** base tables, complementary ranges `x<5` (`rlo`, `'lo'`) /
  `x>=5` (`rhi`, `'hi'`). A literal `bucket` discriminator keeps the body writable; the INSERTs
  **omit it** so the *range* drives routing:
  - out-of-range `insert (id,x) values (10,100)` → `rlo` gets **no phantom**, `rhi` gets the row,
    read-back through the view confirms (`bucket='hi'`). **This is the bug the ticket fixes.**
  - complementary in-range `insert (id,x) values (11,2)` → routes to `rlo` only.
  - `delete from RV where x < 3` → fan **narrows** to `rlo` (the `hi` leg is `x<3 ∧ x>=5` ⇒ unsat),
    member-exists capture restricts to the resident matching rows; `rhi` untouched.
- **`GV`** — gapped legs `x<5` / `x>=10`; an in-gap `insert ... values (9,7)` → both legs `unsat` ⇒
  `consistent with no writable leg` reject; base tables asserted untouched.
- **`BV`** — BETWEEN σ (`x between 0 and 4`) vs `x>10`; out-of-band `x=50` skips the `in` leg,
  in-band `x=3` routes into it.

## Honest gaps — where the reviewer should push

These were reasoned sound during implement but are **not** directly asserted; treat them as the
first places to add coverage or poke holes:

1. **No data-UPDATE-through-range assertion.** The ticket asked to verify *delete/update* over a
   range-discriminated view hits exactly the resident rows. Only **DELETE** is asserted (`RV`,
   `where x < 3`). An `update RV set x = … where <range>` path is untested — the same fan-narrowing
   + member-exists self-correction *should* apply, but confirm it (watch for a range predicate that
   also touches the SET column, Halloween-wise).
2. **σ-column-omitted-from-INSERT default path untested.** When the supplied row carries **no
   value** for the σ column, `sigmaConjuncts` (`x<5`) alone is `sat` (x *could* be <5) ⇒ leg
   included ⇒ base column defaults. The ticket lists this as correct-by-design, but every new INSERT
   here supplies `x`. Note `rlo`/`rhi` columns are NOT NULL (engine default), so a literal-discriminator
   route that omits `x` would hit a NOT-NULL violation, not a clean default — a dedicated nullable-`x`
   view would be needed to exercise this cleanly. Worth a targeted test if the reviewer wants it
   nailed down.
3. **TEXT range σ under a non-BINARY collation untested.** `leg.getCollation(col)` already feeds the
   output column's declared collation to the checker (unchanged wiring), so a `where name < 'm'`
   leg *should* be handled, but there is no assertion. Cheap to add if desired.
4. **`collectFilterConjuncts` over a multi-filter / derived-table leg body untested.** It collects
   **every** `FilterNode` in the leg subtree (sound: each is a must-hold conjunct; over-collection
   only pushes toward `unsat`/`unknown`). Real leg bodies here are leaf `Project(Filter(Scan))` with
   exactly one filter (`isWritableLeafLeg` rejects join bodies). A single-source **derived-table**
   leg (`from (select … where …) where …`) would surface two filters — sound by the same argument,
   but unexercised. Confirm `getRelations()` never descends into a scalar subquery's filter (it
   returns only relational children, so a correlated subquery's WHERE is *not* collected — verify
   this reasoning holds for an EXISTS/IN-bearing leg σ).
5. **Over-collection vs. an OR/function σ.** A non-AND σ (`where f(x)` / `x<5 or x>20`) splits to a
   single non-conjunctive node that `absorb` routes to `markUnknown` ⇒ include-on-unknown (no false
   `unsat`). Asserted indirectly by the pre-existing `U6`/`U7` `length(color)`/`like` legs staying
   green, but not with a range-OR specifically.

## Suggested review focus

- Re-confirm the two `sat-checker.ts` invariants above against the actual code (the whole fix leans
  on "never false `unsat`" + "undefined-index conjunct is inert").
- Sanity-check that feeding **all** leg-body filters (not just the top σ) can never wrongly drop a
  real target leg in any admitted shape.
- The data-UPDATE-through-range gap (#1) is the most material missing assertion — consider adding it
  inline (minor) rather than spawning a ticket.
