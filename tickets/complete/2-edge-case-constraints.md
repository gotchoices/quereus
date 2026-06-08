description: Edge-case sqllogic tests for constraints, FK cascades, and assertions
files:
  packages/quereus/test/logic/29-constraint-edge-cases.sqllogic
----
## Summary

Added `29-constraint-edge-cases.sqllogic` covering 10 edge-case interaction scenarios for
constraints, FK cascades, and assertions. All 1697 tests pass.

## Test Scenarios

- **Multi-row DELETE with cascading FKs**: multi-parent delete, verify all children cascade
- **CASCADE across three levels**: grandparent → parent → child chain delete
- **SET NULL cascade on multi-row delete**: multi-parent delete with SET NULL children
- **Multiple assertions in same transaction**: two assertions, verify failing one identified by name
- **Deferred CHECK + assertion in same transaction**: both evaluated at COMMIT independently
- **Multiple child tables with different cascade actions**: CASCADE + SET NULL on same parent
- **Savepoint interaction with deferred constraints**: rollback savepoint restores violation, COMMIT fails
- **Constraint violation in multi-statement transaction**: violate then fix, COMMIT succeeds
- **FK cascade triggering NOT NULL violation**: SET NULL cascade conflicts with NOT NULL, DELETE rejected
- **Assertion referencing multiple tables**: count equality across two tables checked at COMMIT

## Review Notes

- 8 of 10 scenarios are novel edge cases not covered by existing test files
- 2 scenarios (multiple assertions, fix-before-commit) have minor overlap with `95-assertions.sqllogic`
  and `40-constraints.sqllogic` but test interaction patterns rather than individual features
- Cross-schema FK with CASCADE was not included due to parser limitations with schema-qualified
  REFERENCES; replaced with "multiple child tables with different cascade actions"
- All tests are self-contained with proper setup/cleanup (DROP TABLE/ASSERTION)
