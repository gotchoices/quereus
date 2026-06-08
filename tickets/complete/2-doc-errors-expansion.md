---
description: Review expanded docs/errors.md error reference
prereq: docs/errors.md, packages/quereus/src/common/errors.ts, packages/quereus/src/common/types.ts
files:
  - docs/errors.md
---

## Summary

Expanded `docs/errors.md` from a 56-line overview into a full error reference. Changes:

- **ParseError entry** — Added constructor signature, `token` property documentation, and a catch/inspect example.
- **StatusCode reference table** — Complete table of all 31 `StatusCode` enum values, split into "Commonly Used" (12 codes seen in the codebase) and "Reserved/Rare" (remaining SQLite-compat codes).
- **Error Chain Examples** — Code samples for `unwrapError()`, `formatErrorChain()`, `getPrimaryError()`, and the pattern for wrapping external errors with context.
- **Common Error Patterns** — Five categories organized by error phase: syntax errors (ParseError), semantic errors (planner QuereusError), constraint violations (ConstraintError), API misuse (MisuseError), and runtime UDF/VTab errors (wrapped QuereusError with cause chain).

## Validation

- `yarn build` passes
- `yarn test` passes (all 103 tests in sync-coordinator, plus quereus core tests)
- No code changes, documentation only
