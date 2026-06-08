description: Unit tests for plan-validator and determinism-validator covering untested validation paths
files:
  - packages/quereus/src/planner/validation/plan-validator.ts
  - packages/quereus/src/planner/validation/determinism-validator.ts
  - packages/quereus/test/planner/validation.spec.ts
----

## What was built

48 unit tests covering the previously-untested validation logic in `planner/validation/`. Tests construct mock PlanNodes directly (no SQL parsing) to isolate validator logic.

### plan-validator.ts (33 tests)
- Attribute ID uniqueness (unique accepted, duplicates rejected across/within nodes)
- Column reference validation (unknown attribute rejected, valid accepted)
- Physical property checks (boolean flags, estimatedRows, idempotent, side-effect consistency)
- Logical-only node rejection (Aggregate, Retrieve)
- DDL node special-casing (CreateTable, DropTable, AlterTable, Transaction, Pragma)
- Ordering validation (out-of-range/negative indices, valid ordering)
- Attribute validation (non-number ID, empty name, empty sourceRelation)
- ValidationOptions toggles (requirePhysical, validateAttributes, validateOrdering)
- DAG/shared-child edge case
- quickValidate boolean returns

### determinism-validator.ts (15 tests)
- checkDeterministic return shape for deterministic/non-deterministic
- validateDeterministicExpression throws with context, expression, and mutation-context suggestion
- validateDeterministicConstraint includes constraint and table name
- validateDeterministicDefault includes column and table name
- validateDeterministicGenerated includes column and table name
- NULL literal and function determinism classification

## Testing notes

- All 48 tests pass (13ms)
- Full suite passes (1412+ tests)
- Typecheck passes
- Tests are interface-level mocks, not coupled to implementation internals

## Review notes

- Code is clean and well-structured
- Minor: `!node.physical` branch in plan-validator is unreachable (getter always returns), two type-guard ordering branches untested (TypeScript-enforced) — neither warrants changes
