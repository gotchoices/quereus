description: Range-σ write-branch oracle fix — a range/BETWEEN σ on a *projected* set-op leg column is fed to `checkSatisfiability` so a provably-out-of-range INSERT skips the leg (no phantom base row). Reviewed and completed.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md, packages/quereus/src/planner/analysis/sat-checker.ts
difficulty: medium
----

## What shipped

The flag-less set-op write oracle (`legConsistency` → `checkSatisfiability`) previously saw only the
leg's planned physical `constantBindings`/`domainConstraints` plus the synthesized literal
discriminators. A **range** σ (`where x < 5`) on a **projected** column forwards as neither, so an
out-of-range INSERT routed into the leg and landed a phantom base row that the view's σ then hid on
read-back.

Fix (Option A), all in `set-op.ts`:

- `interface FlaglessLeg` gained `sigmaConjuncts: readonly ScalarPlanNode[]` (`set-op.ts:1442`).
- `collectFilterConjuncts(root)` (`set-op.ts:1587`) — a recursive DFS over `getRelations()` that
  `splitConjuncts(node.predicate)` for every `FilterNode` in the planned leg body.
  `buildFlaglessLeg` populates `sigmaConjuncts` from `legRoot` (`set-op.ts:1570`).
- `legConsistency` (`set-op.ts:1615`) now passes `[...conjuncts, ...leg.sigmaConjuncts]` to
  `checkSatisfiability`. No `sat-checker.ts` change.

Soundness rests on two pre-existing `sat-checker.ts` properties (re-confirmed in review against the
actual code) plus one attr-id fact (re-confirmed):
1. The checker never emits a false `unsat` (`sat-checker.ts:70-74`, decision loop `134-167`), so
   adding conjuncts only moves the verdict toward `unsat` on a *real* contradiction.
2. A conjunct on a non-projected column resolves to `attrIndex → undefined`; `absorbBinary`
   (`425-433`) and `markUnknownForColumns` (`320-322`) only touch accumulators for a *valid* index,
   so it contributes nothing — not even `sawUnknown`.
3. `ProjectNode` reuses the base column's attribute id for a plain `ColumnReferenceNode` projection
   (`project-node.ts:198-208`), so the σ `FilterNode.predicate` and the projected output column
   share an attr id → both fold onto the same accumulator with no manual base→output remap.

Docs: `docs/view-updateability.md` § Set Operations updated — a range σ on a projected column is now
honored; a σ on a non-projected column still routes include-on-unknown.

## Review findings

**Verdict: implementation is correct and sound. One minor coverage gap fixed inline; no major
findings; no new tickets filed.**

### Checked — code soundness (every claim re-verified against source, not the handoff)
- **`sat-checker.ts` never-false-`unsat` invariant** — confirmed: the decision loop (lines 134-167)
  returns `unsat` only on a proven per-column contradiction (empty allowed-set, empty/pinched range,
  excluded singleton); otherwise `sat`/`unknown`. Adding conjuncts is monotone toward `unsat`.
- **Undefined-index inertness** — confirmed: `columnOf` returns `attrIndex(attrId)` (`298-305`);
  `absorbBinary` short-circuits to `markUnknownForColumns` when `col === undefined` (`425-433`), and
  `markUnknownForColumns` only sets `sawUnknown` for refs whose `attrIndex` is defined (`320-322`).
  A non-projected-column conjunct is fully inert — this is why every pre-existing 93.6 assertion
  (legs with `where color='red'` on a non-projected `color`) stays green.
- **Attr-id reuse** — confirmed at `project-node.ts:198-208`: a plain `ColumnReferenceNode`
  projection preserves the underlying attribute id (and its type/collation via
  `effectiveProjectionType`), so the σ predicate's base-column ref and the output column fold onto
  the same accumulator, and `getCollation(col)` returns the base column's declared collation.
- **Over-collection (handoff gap #4) — no regression, verified empirically.** `collectFilterConjuncts`
  gathers *every* `FilterNode` in the leg subtree. Two cases probed with throwaway sqllogic:
  - A single-source **derived-table** leg (`from (select…where inner) where outer`) surfaces two
    filters — both are must-hold conjuncts on a linear chain, so over-collection is sound and in fact
    *improves* correctness.
  - A **union-derived-table** leg (`from (… where x<5 union all … where x>100) …`), the only shape
    where collecting contradictory branch filters could over-reject, is rejected at *leg-propagate*
    (`ViewMutationError: 'SetOperation' is not updateable`) **independent of this fix** — the
    over-collection never gets a chance to matter.
  - `FilterNode.getRelations()` returns only `[this.source]` (`filter.ts:46-48`), so the DFS never
    descends into a predicate's scalar subqueries — a correlated EXISTS/IN leg σ stays a single
    conjunct → `splitConjuncts` keeps it whole → `absorb` routes it to `markUnknown` →
    include-on-unknown. Sound.
- **Imports** — `FilterNode`, `splitConjuncts`, `RelationalPlanNode`, `ScalarPlanNode` all properly
  imported (`set-op.ts:6,8,12`). Lint (eslint + `tsc -p tsconfig.test.json`) clean.

### Found + fixed inline (minor) — handoff gap #1
The ticket asked to verify delete/**update** over a range-discriminated view hits exactly the
resident rows; only DELETE was asserted. Added a validated **UPDATE-through-range** assertion to the
`RV` section of `93.6-set-op-flagless-write.sqllogic` (validated against the engine in a scratch run
before committing the expected output):
- `update RV set id = id + 100 where x >= 9` — the WHERE is provably `unsat` with the `lo` leg
  (`x>=9 ∧ x<5`) → fan narrows to `rhi`; member-exists capture restricts to resident matching rows
  (rhi id 4 & 10); `rlo` untouched (its leg skipped at routing). SET target (`id`) does not touch the
  range column, so no Halloween reclassification — the clean fan-narrowing case.

### Checked — coverage gaps judged acceptable (NOT blocking; no latent bug)
- **#2 σ-column-omitted-from-INSERT default path** — correct-by-design and *unchanged by this fix*:
  when no value is supplied for the σ column, `x<5` over an unconstrained `x` is `sat` whether or not
  the conjunct is added, so the leg is included exactly as before. Adding the conjunct only changes
  the verdict when a *supplied* value contradicts the range. Exercising it cleanly needs a dedicated
  nullable-`x` view; not worth a ticket.
- **#3 TEXT range σ under non-BINARY collation** — wiring is pre-existing and correct (`getCollation`
  feeds the output column's declared collation, which a plain projection inherits from the base
  column). Low-risk, untested; not worth a ticket.
- **#5 OR/function σ → include-on-unknown** — follows directly from the never-false-`unsat`
  invariant; asserted indirectly by the green `U6`/`U7` `length(color)`/`like` legs.

### Empty categories
- **No major findings** — nothing warranting a new fix/plan/backlog ticket. The fix is small,
  localized, and each soundness claim was independently re-derived from source.
- **No docs drift** — `view-updateability.md` § Set Operations reflects the new reality; no stale
  "backlog"/"deferred" reference to the slug remains (grep-verified across `docs/`).

### Validation performed
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — **6285 passing, 0 failing, 9 pending** (the added UPDATE
  assertion lives inside the 93.6 file, which passed; file count unchanged because each sqllogic file
  is one mocha case).
- 93.6 in isolation — passing.
