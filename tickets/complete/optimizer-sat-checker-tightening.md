---
description: Two narrow tightenings of predicate-contradiction analysis — (a) `x IN ()` now folds to `unsat` via the sat-checker, and (b) `rule-filter-contradiction` short-circuits on the broader `lit-null|false|0|0n` set instead of dispatching to the sat-checker. Three new tests; tightened scope docs.
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
  - docs/optimizer.md
---

## Summary of landed changes

1. **`x IN ()` → `unsat` (sat-checker.ts)** — `absorb` for `InNode` now resolves the column first; if the values list is empty, it pushes an empty `allowedValues` set via `intersectAllowed(..., [], ...)`, which the existing decision loop's `filtered.length === 0 → unsat` step then catches. Non-column LHS (e.g. `(a+b) IN ()`) still bails to `markUnknownForColumns` — no false unsat.
2. **`Filter(_, lit-null|false|0|0n)` short-circuit (rule-filter-contradiction.ts)** — replaced the lit-`false`-only guard with `isLiteralFalsy`, which was already private to `rule-empty-relation-folding.ts`. Exported the helper from there rather than duplicating; both rules sit in `rules/predicate/`. Avoids wasted sat-checker dispatch for predicates the sibling `ruleFilterFoldEmpty` will collapse anyway. Pure perf/clarity (sat-checker would have returned `'sat'` for a bare `lit-null` with no column refs — no correctness change).
3. **Tests** — three additions in `predicate-contradiction.spec.ts`:
   - `detects empty IN-list: x IN () → unsat` (unit).
   - `NULL members do not rescue contradiction: x = 2 ∧ x IN (1, NULL) → unsat` (unit; pins three-valued-logic NULL-stripping in `intersectAllowed`).
   - `WHERE NULL folds to empty (lit-null short-circuit)` (end-to-end; pins the cascade now that the contradiction rule short-circuits earlier — `ruleFilterFoldEmpty` still collapses to `EmptyRelationNode`).
4. **Docs (review-stage tightening)** — added "the empty form `x IN ()` is recognized as trivially `unsat`" to both the `sat-checker.ts` module docstring and the in-scope list in `docs/optimizer.md § Predicate contradiction detection`, so the scope summaries match the new behavior.

## Review findings

Read the implement-stage diff (`35eb0504`) cold before the handoff, then re-checked the call sites and registration.

- **Correctness of `x IN ()` path** — checked. `intersectAllowed(acc, [], col, cmp)` with `acc.allowedValues === undefined` sets it to `[]` (slice of empty). The decision loop iterates accs and hits `filtered.length === 0 → unsat`. If the column already accumulated allowedValues (e.g. `x = 5 AND x IN ()`), the intersection is still `[]`. Path verified by tracing `checkSatisfiability` and the new unit test.
- **Behavior change for `values === undefined` (defensive case)** — noted but accepted. The `InNode` builder in `planner/building/expression.ts` throws when neither `source` nor `values` is set; `predicate-normalizer.ts` guards against `values.length === 0`. No production code path produces an InNode with `values === undefined`, so flipping the malformed-AST case from `unknown` to `unsat` is moot. Not worth a guard.
- **Non-column LHS preserved** — `(a + b) IN ()` exercises `columnOf` → undefined → `markUnknownForColumns`. Empty-list path is unreachable in that branch by construction (column check runs first now).
- **`literalOf` returns `null` for `lit(null)`, not `undefined`** — so the InNode loop pushes the NULL through, and `intersectAllowed` strips it. The new `x = 2 ∧ x IN (1, NULL) → unsat` test pins this. Considered adding a bare `x IN (NULL) → unsat` unit test but it's the same code path as the existing test plus the empty-IN case and adds no new coverage — left out intentionally.
- **Rule-ordering / cascade** — both `ruleFilterContradiction` and `ruleFilterFoldEmpty` register at Structural pass priority 27 with `nodeType: Filter`, both `phase: 'rewrite'`. Per-node fixed-point loop in `applyPassRules` cycles them, so:
  - If `ruleFilterContradiction` runs first and bails on lit-null, `ruleFilterFoldEmpty` fires and produces `EmptyRelationNode`.
  - If `ruleFilterFoldEmpty` runs first, the node is no longer `FilterNode` so `ruleFilterContradiction` skips. End-state identical. The new e2e test confirms `WHERE NULL` lands on `EMPTYRELATION` regardless.
- **`isLiteralFalsy` cross-package export** — both rules are siblings in `rules/predicate/`; the export is internal to this folder and DRY-correct. No import cycle (rule-filter-contradiction imports the helper but not vice versa).
- **Docs synchronization** — found `sat-checker.ts` module docstring and `docs/optimizer.md § Predicate contradiction detection` both said "Single-column IN (lit, lit, ...)" with no mention of the empty form. Updated both inline.
- **Type safety / `any` / unused vars** — none introduced.
- **Resource cleanup / error handling** — the changes are pure-function predicate analysis; no resources, no exceptions added/eaten.
- **Backwards compat** — N/A per repo conventions.
- **SQL keyword casing in tests** — the new e2e test uses `WHERE NULL` (uppercase keyword); the file's existing tests mix `SELECT`/`select`. The new entry is internally consistent with the surrounding test block. No churn applied.

### Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test --grep "Predicate contradiction|checkSatisfiability"` — 26 passing.
- `yarn workspace @quereus/quereus run test` — 3172 passing.
- Implement-stage handoff also flagged two pre-existing failures in `packages/sample-plugins/test/plugins.spec.ts` (key_value_store DELETE/UPDATE) reproducible on baseline — confirmed unrelated; not touched by this work.

### Disposition

- Minor docs gap (scope lists in two places not mentioning empty-IN) — **fixed inline**.
- No major findings — nothing to split out.
