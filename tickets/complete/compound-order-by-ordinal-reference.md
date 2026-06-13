description: Compound ORDER BY ordinal reference — fixed and reviewed
files:
  - packages/quereus/src/planner/building/select-ordinal.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic
----

# Compound `ORDER BY <ordinal>` reference

## Summary

`ORDER BY <n>` over a compound set operation (UNION / UNION ALL / INTERSECT / EXCEPT / DIFF)
was silently compiled as a constant sort key (a no-op) instead of ordering by the compound's
Nth output column. Root cause: `applyOuterOrderBy` in `select-compound.ts` called
`buildExpression` directly on the ordinal literal, yielding `LiteralNode(1)` rather than a
column reference.

The fix adds `resolveCompoundOrdinalColumn(expr, setNode, scope)` in `select-ordinal.ts`,
which maps a bare integer ordinal to the set node's Nth output `ColumnReferenceNode`
(index `n-1`), inheriting that column's cross-input-resolved type and collation so the ordinal
ORDER BY stays in lockstep with dedup — identical to the column-name form. `applyOuterOrderBy`
now tries the ordinal resolver first and falls back to `buildExpression` for any non-ordinal
expression. `extractOrdinalValue` is reused unchanged, so `order by 1 + 0` keeps constant
semantics. Out-of-range / zero / negative ordinals raise the standard prepare-time error.

## Review findings

Reviewed the implement-stage diff (landed in commit `af7b73c7`) with fresh eyes against the
codebase, then cross-checked the handoff. The change is small, well-commented, and correct.

### Checked — verified correct

- **Constructor parity** — `new ColumnReferenceNode(scope, colExpr, column.type, attr.id, index)`
  matches the `(scope, expression, columnType, attributeId, columnIndex)` signature in
  `reference.ts`, and mirrors exactly what `createSetOperationScope` builds for the
  column-name path. Both paths read the resolved type from `setNode.getType().columns[i]`, so
  ordinal and column-name ORDER BY are guaranteed to agree.
- **Index alignment** — `SetOperationNode.getType().columns` and `.getAttributes()` are built
  from the same `[data] ++ [L flags] ++ [R flags] ++ [own flags]` layout (`buildAttributes` /
  `getType`), so `columns[index]` and `getAttributes()[index]` are positionally paired. The
  ordinal resolver's `column`/`attr` pairing is sound.
- **Wiring** — `input` passed to `applyOuterOrderBy` is the bare `SetOperationNode` (before
  SORT/LIMIT) and `selectContext.scope` is the `createSetOperationScope` output, so the resolver
  operates on the compound's true output columns/attributes.
- **Error message** — `ORDER BY position <n> is not in the SELECT list (1..<len>)` matches
  `resolveOrdinalReference`'s wording exactly (location info propagated identically).
- **DRY** — `extractOrdinalValue` is shared (module-private, reused), no copy-paste drift.
- **Collation lockstep test (09.1 §9)** — the new `order by 1` assertion IS genuinely
  discriminating: `o1.n COLLATE NOCASE union o2.p` resolves the output column to NOCASE; the
  expected order (`apple, banana, Cherry`) only holds under NOCASE — under BINARY `Cherry`
  (C=67) would sort first. Had the resolver picked the wrong (unresolved/left-raw) type, this
  would fail while the column-name form passed. Meaningful independent coverage.
- **Docs** — `docs/sql.md` §3.5 already documents positional ordinals generically (1-based,
  out-of-range raises) with NO compound carve-out. The pre-fix behavior was simply a silent
  bug against the documented contract; the code now conforms. No doc change required.

### Found and fixed (minor, this pass)

- **No dedicated DIFF + ordinal test** (flagged in the handoff). Verified DIFF + ordinal works
  (`(1,2,3) DIFF (2,3,4) order by 1 desc` → `[4,1]`) and added a dedicated case to
  `28-set-ops-sort-edge-cases.sqllogic` so the structural `(A EXCEPT B) UNION (B EXCEPT A)`
  expansion is exercised directly with a positional key, not just indirectly.

### Noted — no action (acceptable)

- **Minor construction duplication** — the `ColumnReferenceNode` build in
  `resolveCompoundOrdinalColumn` overlaps with `createSetOperationScope`'s registered closure.
  Left as-is: the ordinal→index mapping is the resolver's whole purpose and routing it through
  the name-keyed scope would be more indirection, not less. One constructor call is not worth a
  shared helper.
- **Bounds check spans flag columns** — the out-of-range check uses
  `getType().columns.length`, which for a membership-flagged set op includes appended flag
  columns, so `order by N` could in principle reference a flag column. This is **not a
  divergence**: `createSetOperationScope` registers all columns (flags included) for the
  column-name path too, so ordinal and name forms behave identically. Referencing a flag column
  by ordinal is exotic and consistent with the existing surface; not worth a special case here.
- **Negative ordinal** — `order by -1` is handled (the `value < 1` branch raises the same error
  as `0`). Untested but structurally covered by the zero-ordinal case.

### Out of scope (pre-existing, unrelated)

- **Parenthesized-left compound trailing ORDER BY** — `(A union B) union C order by n` is a
  parser error ("got 'order'"), independent of ordinal resolution. Not introduced or worsened
  by this change; file a separate ticket if it matters.

## Validation

- `28-set-ops-sort-edge-cases.sqllogic` (incl. new DIFF ordinal case) and
  `09.1-set-op-cross-collation.sqllogic`: **pass**
- Broader set-op regression (`--grep "set-op|set-ops|09|28|compound"`): **111 passing**
- `yarn typecheck`: **clean**
- `yarn workspace @quereus/quereus run lint`: **clean**
