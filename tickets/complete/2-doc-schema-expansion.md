---
description: Review expanded docs/schema.md API documentation
prereq: docs/schema.md
files:
  - docs/schema.md
---

## Summary

Expanded `docs/schema.md` with missing API documentation. All additions are documentation-only (no code changes).

### What was added

- **`defineTable()`** — Added to DDL Operations section. Documents the Database-level method for programmatic table registration, including its `main`-schema-only restriction.

- **Schema Path section** — New section documenting `db.setSchemaPath()` and `db.getSchemaPath()` with usage example and cross-reference to usage.md.

- **Database Options Affecting Schema** — Brief cross-reference section for `schema_path` and `default_column_nullability` options, pointing to usage.md for the full reference.

- **DeclaredSchemaManager API** — New subsection under Declarative Schema with a full method table covering all 8 methods (set/get/has/remove declared schemas, set/get/getAll/clear seed data).

- **Declarative schema semantics** — Three new subsections:
  - Migration Order: drops first, creates second, alters third
  - Seed Data: clear-then-insert semantics, happens after structural migrations
  - Schema Hashing: `explain schema` usage with version example

### Validation

- Build passes
- All tests pass (103 passing across sync-coordinator)
- Content verified against source code in database.ts, declared-schema-manager.ts, schema-differ.ts, and schema-declarative.ts
