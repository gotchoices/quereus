description: Support schema-qualified foreign-key parent references (child schema ≠ parent schema).
files:
  - packages/quereus/src/parser/parser.ts            # foreignKeyClause() — consumes a single unqualified identifier
  - packages/quereus/src/parser/ast.ts               # ForeignKeyClause.table: string (no schema field)
  - packages/quereus/src/schema/constraint-builder.ts # referencedSchema hardcoded to child schema (lines 96, 185)
  - packages/quereus/src/schema/manager.ts           # buildReverseFkIndex keys under fk.referencedSchema ?? childSchema
difficulty: medium
----

# Cross-schema foreign-key parent references

## Problem

A foreign key cannot currently reference a parent table in a *different* schema
than the child. Two layers enforce this:

1. **Parser** — `foreignKeyClause()` (`parser.ts:4534`) calls
   `consumeIdentifier()` for the parent table name: a single bare identifier,
   with no support for a `schema.table` qualifier. `references s2.m(id)` cannot
   be expressed.

2. **Schema builder** — even setting that aside, `constraint-builder.ts:96`
   (and `:185` for ADD COLUMN) hardcodes `referencedSchema: childSchemaName`.
   The whole engine then resolves the parent as `fk.referencedSchema ?? childSchema`
   (~12 call sites, incl. `manager.ts:1291` reverse-FK index, `multi-source.ts:2772`,
   `derived-row-validator.ts:265`, `catalog.ts:250`). So an unqualified
   `references m` from a child in `s2` always keys under `s2.m`, never `main.m`.

Consequence: a child in schema A referencing a parent in schema B silently keys
its FK under `A.B-table` and parent-side enforcement for the real `B.table`
never finds it. This surfaced while adding parent-side FK coverage for
maintained tables (ticket `maintained-parent-fk-residual-arm-coverage`), where
the originally-specified "child in s2, parent maintained-table in main" scenario
was found to be inexpressible and the test was redesigned to keep both child and
parent in `s2`.

## Desired behavior

- FK syntax accepts an optional schema qualifier on the parent table:
  `references main.m(id)`.
- `ForeignKeyClause` carries the parsed parent schema (e.g. `schema?: string`).
- `referencedSchema` is populated from the qualifier when present, falling back
  to the child's schema only when unqualified (preserving today's default).
- The reverse-FK index, derived-row validator, multi-source planner, and ALTER
  paths key/resolve consistently off the resolved `referencedSchema` (most
  already use `fk.referencedSchema ?? childSchema`, so they need no change once
  the field is set correctly).
- Parent-side referential-action enforcement (RESTRICT/CASCADE/SET NULL/SET
  DEFAULT) then fires correctly when child and parent live in different schemas,
  including the maintained-table-as-parent case.

## Notes

- `ddl-generator.ts:346` already documents that its output "cannot encode
  `c.referencedSchema`" — round-tripping a cross-schema FK through generated DDL
  must be handled (qualify the emitted reference).
- Add coverage: an ordinary cross-schema FK (RESTRICT + CASCADE), plus the
  maintained-table-in-`main` / child-in-`s2` parent-side enforcement case that
  `maintained-parent-fk-residual-arm-coverage` could not express.
