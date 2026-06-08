description: Fixed findColumnPKDefinition ignoring DESC direction for non-INTEGER column-level PKs
prereq: none
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## What was fixed

In `findColumnPKDefinition` (table.ts:475), the `desc` flag was incorrectly gated on
`col.logicalType.name === 'INTEGER'`, silently dropping DESC direction for TEXT, REAL,
and other non-INTEGER column-level PKs. Removed the type guard so `desc` is now
`col.pkDirection === 'desc'` — matching the table-level constraint path in
`findConstraintPKDefinition` (table.ts:444).

## Key files

- `packages/quereus/src/schema/table.ts:475` — the one-line fix
- `packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic` — 5 test cases

## Testing

`40.1-pk-desc-direction.sqllogic` covers:
1. INTEGER PK DESC column-level (baseline)
2. TEXT PK DESC column-level (was broken, now fixed)
3. TEXT PK DESC table-level constraint (confirms parallel path)
4. REAL PK DESC column-level (was broken, now fixed)
5. Composite PK with INTEGER DESC (baseline)

All pass. Full test suite: no regressions.

## Review notes

- Both PK definition paths (`findColumnPKDefinition` and `findConstraintPKDefinition`) now handle DESC identically
- No doc changes needed — internal schema behavior
