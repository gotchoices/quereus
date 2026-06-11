description: Fix for same-table col=col equality seek crash (reviewed)
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/test/logic/100.1-where-extras.sqllogic
  - packages/quereus/test/planner/constraint-extractor.spec.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts
----

# Same-table `col = col` equality seek crash — completed

## Summary

`extractBinaryConstraint` in `constraint-extractor.ts` treated `b = c` (both columns
of the same table) as a seekable `'='` constraint with `bindingKind = 'expression'`
and `correlated = false`. The `correlated` flag only checked whether the value column
was *outside* the constrained table, missing the case where the value column is
*inside* it. The constraint was then consumed as a seek key by `ruleSelectAccessPath`,
which emitted the value expression `c` in a context with no fetched row →
`QuereusError: No row context found for column c`. It also caused
`computeCoveredKeysForConstraints` to falsely claim unique-key coverage
(e.g. `where b = c and x = 1` over PK `(b, x)` claimed ≤1-row).

## Fix

`constraint-extractor.ts:424-431` — when the value side unwraps (via `unwrapCast`) to a
`ColumnReference` whose `attributeId` is in the constrained table's `columnIndexMap`,
return `null`. The conjunct stays as a residual `FilterNode` evaluated per-row after
the scan. Self-joins keep distinct `attributeId`s per table instance, so cross-instance
`t1.b = t2.b` remains a seekable correlated join.

## Review findings

**Implement-stage diff reviewed**: the fix commit (`e162694b`) — 1-line behavioral
change plus test updates. The implement commit (`283fb2df`) was a ticket-file move only.

### What was checked

- **Correctness of the decline condition** — The only declined shape is
  value-side-unwraps-to-same-table-`ColumnReference`, i.e. exactly `col = sameTableCol`
  (bare or cast-wrapped). No legitimate seek is lost. *No issue.*
- **Self-join regression** — `t1.b = t2.b` across distinct table instances uses
  different `attributeId`s, so `columnIndexMap.has(rhsAttrId)` is false → stays
  `'correlated'` and seekable. Verified live (results correct). *No issue.*
- **Implementer's stated "known gap" (`b = c + 1`)** — The handoff claimed it "won't
  crash" via hand-wavy reasoning. Verified the *real* mechanism: `isDynamicValue`
  accepts only `ParameterReference`/`ColumnReference`, so an arithmetic value side
  (`c + 1`, `c || ''`) fails *both* column-value pattern branches and returns `null`
  early at line 384 → residual. Conclusion (no crash) is correct; mechanism explanation
  in the handoff was inaccurate. Verified live with `b = c || ''` and `b = cast(c as text)`.
- **Coverage over-count** (`computeCoveredKeysForConstraints`) — Fixed at the source:
  the declined constraint never reaches the coverage computation. For
  `where b = c and x = 1` over PK `(b,x)`, only `x = 1` survives → column 1 alone →
  key `[0,1]` correctly NOT covered. *No issue.*
- **EC-driven ordering** (`rule-orderby-fd-pruning`) — The `WHERE a = b` equivalence
  class is derived independently of constraint extraction, so `ORDER BY` reduction
  still fires. Spec updated to use `DESC` to keep the Sort alive; passes. *No issue.*
- **Docs** (`docs/optimizer.md`) — The binding-model description (literal / parameter /
  correlated) at line 799 remains accurate; it never claimed same-table `col = col` is
  seekable, so no correction needed. *No change.*

### Findings

- **Minor (pre-existing, out of scope)** — The `else { result.bindingKind = 'expression'; }`
  branch at `constraint-extractor.ts:434` and its comment referencing `outer.id + 1` are
  effectively unreachable given `isDynamicValue`'s current definition (any value side
  reaching that block unwraps to `Parameter`/`Column`). Not introduced by this fix —
  noted only; left untouched to avoid scope creep. Not worth a follow-up ticket.

### Tests

- Existing tests reviewed and run; extended adversarially during review (reversed
  `c = b`, arithmetic `b = c || ''`, cast-wrapped, no-index table, self-join) — all
  passed. Adversarial cases were ad-hoc (temp sqllogic file, removed after the run);
  the committed `100.1-where-extras.sqllogic` cases plus the cast-wrapped/bare/composite
  unit tests already cover the regression surface.

### Validation

- `yarn lint` (quereus): clean.
- `yarn test` (all workspaces): 5867 + 126 + 62 + 17 passing (quereus + downstream),
  9 pending, no failures.

No major findings; no new tickets filed.
