---
description: Review cross-references between docs and DRY consolidation
files:
  - docs/usage.md
  - docs/types.md
  - docs/functions.md
  - docs/schema.md
  - docs/plugins.md
  - docs/errors.md
  - docs/architecture.md
---

## Summary

Added cross-references between documentation files so readers can discover related content.

### Cross-References Added

- **types.md → functions.md**: Link to conversion functions reference after the built-in conversion functions list
- **functions.md → types.md**: Intro paragraph links to type system documentation
- **functions.md → plugins.md / usage.md**: New "Registration and Plugin-Based Functions" section linking to plugin system and usage guide for custom function registration
- **usage.md → schema.md**: Declarative Schema section links to DeclaredSchemaManager API
- **schema.md → usage.md**: Schema path section updated to mention declarative schema workflow
- **usage.md → errors.md**: Error handling section links to full error reference
- **errors.md → usage.md**: Links to practical error handling patterns in usage guide
- **plugins.md → functions.md**: Function Plugins section links to built-in functions reference
- **plugins.md → types.md**: Collation Plugins section links to LogicalType interface and type-specific collation docs
- **types.md → plugins.md**: Plugin System section links to full plugin packaging/loading workflow
- **README.md → usage.md**: Transaction support bullet links to usage guide transactions section

### DRY Assessment

The README.md transaction mentions were already brief contextual references (bullet points, inline storage plugin examples) — no substantial duplicated how-to content existed to consolidate. A cross-reference was added to the transaction feature bullet.

### Validation

- Docs-only changes, no code modified
- All cross-reference anchors verified against actual section headings
