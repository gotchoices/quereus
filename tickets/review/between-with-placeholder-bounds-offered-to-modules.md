description: A query such as "x between ? and ?" now offers its bounds to the storage module exactly as "x >= ? and x <= ?" does, so indexes can seek on it instead of scanning and filtering. Review the change to the engine's predicate analysis that does this.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # classifyValueBinding (new, after extractBinaryConstraint); extractBinaryConstraint tail; extractBetweenConstraints
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('extractBetweenConstraints')
  - packages/quereus/test/vtab/module-seek-filters.spec.ts           # placeholder box test, now spelled with between
  - docs/module-authoring.md                                         # "Module-listed seek arguments", BETWEEN sentence (~line 393)
----
# Review: offer BETWEEN with placeholder or correlated bounds to modules

## What changed

Before this change, `extractBetweenConstraints` produced range constraints only when both BETWEEN bounds were plan-time literals. `x between ? and ?` stayed a residual `Filter` over a full scan, while `x >= ? and x <= ?` reached `getBestAccessPlan` as two seekable constraints.

- **`classifyValueBinding(valueSide, tableInfo)`** (new, in `constraint-extractor.ts`) is the value-side classification that used to sit inline at the end of `extractBinaryConstraint`. A literal gives `{ value, bindingKind: 'literal' }`. A non-literal gives `{ valueExpr (cast kept), bindingKind, correlated }`, where `bindingKind` is `'parameter'`, `'correlated'` (a column of another table) or `'expression'`. It returns null for a column of the constrained table itself, which can never be a seek key. The caller must already have accepted the value side as `isLiteralConstant || isDynamicValue`.
- **`extractBinaryConstraint`** builds its constraint and spreads the helper's result into it. The only change is that a non-literal constraint no longer carries an explicit `value: undefined` key. No code checks for the key (I grepped `'value' in` / `hasOwnProperty` across `packages/*/src`), and the full suite passes.
- **`extractBetweenConstraints`** now accepts each bound that passes `isLiteralConstant || isDynamicValue`, the same test the comparison path applies, and classifies each bound with the helper. Both halves keep the BETWEEN node as `sourceExpression`, and each half's collation comes from `effectiveBetweenBoundCollation`, as before. A literal NULL bound still leaves the whole BETWEEN residual, as does a same-table column bound. The NULL check now reads `binding.value === null`, which only a literal NULL can produce. A mixed `x between 1 and ?` yields one literal and one parameter constraint.
- **Docs**: in `docs/module-authoring.md`, the BETWEEN sentence now says BETWEEN reaches the module as its two bounds, `>=` then `<=`, whenever each bound is a literal, a placeholder or an outer-query column. Any other expression bound (`? + 1`) or a same-table column keeps it residual, as it would the comparison spelling.

Nothing downstream changed. The planning ticket established that `rangeSeekKey`, OR_RANGE collapse, residual de-duplication by node identity, `rule-grow-retrieve` roles and the OR collation gate already handle range constraints with `valueExpr`, because the comparison spelling produces them.

## Tests

Added or changed:

- `constraint-extractor.spec.ts` › `BETWEEN with parameter bounds → two parameter constraints`: checks that the ops come out as `>=`, `<=` in order; that each half has `bindingKind: 'parameter'`, a `valueExpr` that is the same parameter node object, `correlated: false` and `sourceExpression === expr`; and that no residual is left.
- `… › BETWEEN with a literal and a parameter bound → one constraint of each kind`: the `>=` half is literal with `value` 1 and no `valueExpr`; the `<=` half is a parameter.
- `… › BETWEEN with an outer-table column bound → correlated constraint`: the `>=` half has `bindingKind: 'correlated'` and `correlated: true`, and still targets the BETWEEN column's own table. Both tables are in the map, following the existing correlated tests.
- `… › BETWEEN with a same-table column bound → residual`: the existing 'non-literal bounds' test, renamed. Its assertions are unchanged.
- `module-seek-filters.spec.ts` box test: the SQL is now `x between ? and ? and y between ? and ?`. The assertions are unchanged and pass: listed constraints in the order x>=, x<=, y>=, y<=; arguments per execution; an `IndexSeekNode` and no `FilterNode`. This is the end-to-end check that a module receives the bounds.

Existing tests that now cover new behaviour without edits:

- `null-bound-seek.spec.ts` `id BETWEEN ? AND 5` now runs as a real seek. Before, it passed through the residual filter. A NULL-bound parameter must give 0 rows, and it does.
- `json-parameter-equality.spec.ts` 'applies the same coercion to BETWEEN bounds' (a converting cast around a parameter bound) passes.
- `parameter-array-scalar.spec.ts` 'name between ? and ?' passes.
- `cast-seek-blocking.spec.ts` 'converting CAST inside a BETWEEN' still stays residual.

## Validation run

- `yarn workspace @quereus/quereus run lint` (eslint plus the test-file type check): clean.
- `yarn test` (all workspaces): passes, exit 0, about 10 minutes; quereus reports 11183 passing and 26 pending. Log at `tickets/.logs/between-with-placeholder-bounds-offered-to-modules.test.log`.
- I did not run `yarn test:store`. It runs the `.sqllogic` files against the store module, and sqllogic cannot bind placeholders, so it never runs `between ?`. The quereus-store package's own Vitest specs ran inside `yarn test` and passed.

## Known gaps and things to check

- No plan or snapshot test pinned the old scan + filter shape for a placeholder BETWEEN, so no plan expectation changed. The only plan-shape check of the new seek is the module-seek-filters box test (a test module). No test asserts the memory or store plan shape for `between ?`; I relied on the comparison spelling already seeking there.
- By inspection only, as the planning ticket stated:
  - A correlated BETWEEN inside a correlated subquery (`x between o.lo and o.hi`) becomes a correlated range seek. It goes through the same `correlated` checks as the comparison spelling: index-nested-loop's gate on `c.correlated` and `IndexSeekNode`'s `assertSeekKeysRowIndependent`.
  - An OR of placeholder BETWEENs now collapses to OR_RANGE with dynamic bounds.
  - When a module consumes only one half, the BETWEEN is reattached whole as a residual. That is correct, because the consumed half is implied by it.

  None of these has a dedicated test. A reviewer may want one sqllogic or spec case for the correlated subquery shape, where a wrong answer would be easiest to miss.
- In `classifyValueBinding`, the `'expression'` arm cannot be reached by either caller today: `isDynamicValue` only admits parameters and column references once casts are looked through. It was moved over unchanged from `extractBinaryConstraint`. Widening the accepted values (e.g. `? + 1`) is out of scope for both spellings.
