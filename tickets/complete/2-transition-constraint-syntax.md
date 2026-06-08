---
description: Transition constraints using committed.* pseudo-schema in CHECK constraints and assertions
prereq: committed-state-snapshot-access (provides schema resolution and snapshot connections)
---

## Summary

Wired the committed.* pseudo-schema into constraint evaluation so users can write transition constraints comparing before/after state within CHECK constraints and CREATE ASSERTION.

### Key Changes

1. **constraint-builder.ts**: Added `containsCommittedRef()` tree walker that detects `TableReferenceNode` with `readCommitted === true`. Auto-deferral logic: `needsDeferred = containsSubquery(expression) || containsCommittedRef(expression)`.

2. **database-assertions.ts**: No changes needed — `collectTables()` already resolves `committed.tablename` to the base table name via schema resolution, so impact analysis correctly triggers re-evaluation.

3. **Deferred constraint queue**: No changes needed — evaluators have committed-snapshot routing via `readCommitted` flag on `TableReferenceNode` → `_readCommitted` option on module connections.

### Review Cleanup

- Renamed `ConstraintCheck.containsSubquery` → `needsDeferred` across the interface, builder, FK builder, and emitter — the field now accurately reflects its purpose (deferred due to subquery, committed ref, or FK semantics).

### Test Coverage

Test file: `packages/quereus/test/logic/43-transition-constraints.sqllogic`

- CHECK constraint with committed subquery (auto-deferred, catches violations on UPDATE)
- CHECK constraint passes when constraint holds (increase/equal allowed)
- New rows with no committed counterpart use COALESCE default
- Assertion with count preservation (cardinality can only grow)
- Multiple committed refs in same assertion (two tables)
- Deleted rows detection (exist in committed but not current)
- CHECK constraint + assertion together with committed refs
- All tests verify rollback on violation (state unchanged)

### Usage

```sql
-- CHECK constraint: balance can only increase
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  balance INTEGER,
  CONSTRAINT no_decrease CHECK (
    balance >= coalesce((SELECT balance FROM committed.accounts ca WHERE ca.id = new.id), 0)
  )
) USING memory;

-- Assertion: no rows may be deleted
CREATE ASSERTION no_deletes CHECK (NOT EXISTS (
  SELECT 1 FROM committed.protected cp
  WHERE NOT EXISTS (SELECT 1 FROM protected p WHERE p.id = cp.id)
));
```

### Validation

- Build passes
- All 496 tests pass (including 43-transition-constraints.sqllogic)
- Documentation in README up-to-date (lines 266, 293)
