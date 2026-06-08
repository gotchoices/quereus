description: Mutation testing infrastructure + killing tests across 4 subsystems
prereq: none
files:
  packages/quereus/stryker.config.mjs
  packages/quereus/.mocharc.stryker.cjs
  packages/quereus/register-cjs-compat.mjs
  packages/quereus/mutation-subsystem.mjs
  packages/quereus/test/planner/predicate-normalizer.spec.ts
  packages/quereus/test/optimizer/expression-fingerprint.spec.ts
  packages/quereus/test/optimizer/binding-collector.spec.ts
  packages/quereus/test/optimizer/const-pass.spec.ts
  packages/quereus/test/logic/100-predicate-normalization-edge-cases.sqllogic
  packages/quereus/test/logic/101-builtin-mutation-kills.sqllogic
  packages/quereus/test/logic/104-emit-mutation-kills.sqllogic
  packages/quereus/test/logic/105-vtab-memory-mutation-kills.sqllogic
  docs/zero-bug-plan.md
  .gitignore
----

## Summary

Stryker mutation testing infrastructure configured for the quereus package with per-subsystem
scoping via `yarn mutation:subsystem <alias>`. Four subsystems targeted: planner/analysis,
runtime/emit, func/builtins, vtab/memory. 140 net new tests added (1728 → 1868) specifically
designed to kill surviving mutants identified by Stryker runs.

## Key files

- `stryker.config.mjs` — Stryker config (mocha runner, typescript checker, per-run --mutate scoping)
- `mutation-subsystem.mjs` — CLI wrapper with aliases: analysis, emit, builtins, memory
- `.mocharc.stryker.cjs` + `register-cjs-compat.mjs` — Mocha config for Stryker's sandboxed runs

## Testing notes

- 1915 tests passing, 2 pending, 0 failures
- Typecheck clean
- Test files cover: OR-to-IN collapse, De Morgan, expression fingerprinting, binding collection,
  constant folding, cast null passthrough, bigint filter truthiness, null arithmetic, builtin
  null guards, IS NULL on NOT NULL columns, index planning, composite PK, savepoints
- Baseline mutation scores documented in docs/zero-bug-plan.md §6

## Usage

```bash
cd packages/quereus
yarn mutation:subsystem analysis    # src/planner/analysis/
yarn mutation:subsystem emit        # src/runtime/emit/
yarn mutation:subsystem builtins    # src/func/builtins/
yarn mutation:subsystem memory      # src/vtab/memory/
```

## Review notes

- Code quality is solid across all test files — good helper abstractions, focused assertions
- SQLLogic tests are well-commented with explicit mutation targets
- Infrastructure is minimal and extensible (add aliases to mutation-subsystem.mjs)
- Docs updated with baseline scores and next steps (constraint-extractor.ts, temporal paths)
