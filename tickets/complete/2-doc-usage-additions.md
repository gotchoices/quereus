---
description: Review event system, instruction tracing, and database options sections added to docs/usage.md
prereq: docs/usage.md
files:
  - docs/usage.md
---

## Summary

Added three new sections to `docs/usage.md`:

### Event System (after Transactions, before Database API Reference)
- `db.onDataChange(listener)` — subscribe to data change events, returns unsubscribe function
- `db.onSchemaChange(listener)` — subscribe to schema change events, returns unsubscribe function
- Full `DatabaseDataChangeEvent` and `DatabaseSchemaChangeEvent` interface tables
- Transaction batching semantics (events delivered after commit, discarded on rollback)
- Savepoint layer support noted
- Cross-reference to module-authoring.md for module-level integration

### Database Options (after Event System)
- `db.setOption(key, value)` and `db.getOption(key)` programmatic API
- SQL `pragma` equivalence
- Complete table of all registered options with types, defaults, aliases, and descriptions
- Type-safe getter pattern documented

### Instruction Tracing (expanded in Database API Reference)
- Expanded the existing `db.setInstructionTracer()` one-liner into a full subsection
- `CollectingInstructionTracer` usage example
- Debug TVF table: `query_plan()`, `scheduler_program()`, `execution_trace()`, `row_trace()`, `stack_trace()`
- Code examples for plan inspection and execution analysis
- Cross-reference to functions.md

## Validation
- Build passes (`yarn build`)
- All 731 tests pass (`yarn workspace @quereus/quereus test`)
- Content sourced directly from `database-events.ts`, `database-options.ts`, `database.ts`, and `func/builtins/explain.ts`
