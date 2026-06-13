----
description: Code review — compound ORDER BY ordinal fix
files:
  - packages/quereus/src/planner/building/select-ordinal.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic
difficulty: easy
----

# Review: compound `ORDER BY <ordinal>` fix

## What landed

`ORDER BY <n>` over a compound set operation (UNION / UNION ALL / INTERSECT / EXCEPT / DIFF)
was silently compiled as a constant sort key (a no-op) instead of ordering by output column n.
Root cause: `applyOuterOrderBy` in `select-compound.ts` called `buildExpression` directly on
the ordinal literal, producing `LiteralNode(1)` instead of a column reference.

### New exported function — `select-ordinal.ts:79`

`resolveCompoundOrdinalColumn(expr, setNode, scope)` maps a bare integer ordinal to the set
node's Nth output `ColumnReferenceNode` (index `n-1`), inheriting that column's resolved type
and collation.  Non-ordinal expressions return `null` (caller falls through to `buildExpression`).
Out-of-range / zero / negative ordinals raise the standard prepare-time error with the same
message shape as `resolveOrdinalReference`.  `extractOrdinalValue` is reused unchanged, so
`order by 1 + 0` stays a constant expression.

### Wiring — `select-compound.ts:166`

`applyOuterOrderBy` now calls `resolveCompoundOrdinalColumn` first, then falls back to
`buildExpression`.  The `input` passed is the bare `SetOperationNode` (before SORT/LIMIT),
so `getType().columns` and `getAttributes()` are the compound's output columns.

### Tests

`28-set-ops-sort-edge-cases.sqllogic` — ordinal section (lines 215–275) covers:
- Plain ordinal over UNION (was the regression case)
- Descending ordinal over UNION ALL (bag semantics preserved)
- Ordinal over INTERSECT and EXCEPT
- Mixed ordinal + column-name keys
- `order by 1 + 0` — non-ordinal expression keeps constant semantics
- Out-of-range and zero ordinal error cases

`09.1-set-op-cross-collation.sqllogic` §9 — adds the ordinal form (`order by 1`) alongside the
column-name form to confirm both produce identical NOCASE collation-aware ordering.

## Validation

- Both touched sqllogic files: **pass** (2/2)
- Full `yarn test`: **6042 + 126 + 62 + 17 passing, 9 pending, 0 failing**
- `yarn typecheck`: **clean**
- `yarn workspace @quereus/quereus run lint` on changed source files: **clean**

## Known gaps / intentionally out of scope

- **Parenthesized-left compound trailing ORDER BY** — `(A union B) union C order by n` is a
  parse error ("got 'order'"), unrelated to ordinal resolution.  Not part of this change; file
  a separate ticket if it matters.
- **DIFF ordinal** — DIFF expands to `(A EXCEPT B) UNION (B EXCEPT A)`.  The ordinal resolves
  over the outer `SetOperationNode` whose output columns mirror the arms' schema — ordinal
  ordering works correctly, but it is exercised only indirectly (the DIFF empty-input tests in
  the edge-cases file exercise DIFF + column-name ORDER BY; no dedicated DIFF + ordinal case).
  Low risk: the expansion is structural and the column layout is identical.

## Review checklist

- [ ] `resolveCompoundOrdinalColumn` comment accurately describes the collation lockstep guarantee
- [ ] Error message for out-of-range ordinal matches `resolveOrdinalReference` wording exactly
- [ ] `extractOrdinalValue` shared without duplication — no copy-paste drift
- [ ] No DIFF + ordinal dedicated test (flagged above — gap or intentional?)
- [ ] `09.1` §9 ordinal assertion actually exercises a different collation than the column-name form (same query, so any regression here would already break the column-name branch too — verify)
