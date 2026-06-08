---
description: Review of tooling packages under packages/tools (planviz)
prereq: review-core-api

---

# Tools Package Review — Complete

## Scope

Reviewed `packages/tools/planviz/` — the only current tool under `packages/tools/`.

## Code Quality Fixes Applied

### DRY Violations Resolved
- Extracted `gatherChildren(node)` helper used by both `renderNodeTree` and `buildMermaidNodes` (previously duplicated child-gathering logic).
- Extracted `getNodeDescription(node)` helper used by both `formatNodeInfo` and `getMermaidNodeLabel`.
- Extracted `collectNodeProps(node)` from `formatNodeInfo` for clearer separation.

### Bugs Fixed
- **`toString()` fallback**: Removed unsafe `node.toString` fallback that would always evaluate to `[object Object]` on plain objects (every object inherits `Object.prototype.toString`).
- **Non-deterministic Mermaid IDs**: Replaced `Math.random()` with a sequential counter (`nextNodeId`), making Mermaid output deterministic and diff-friendly.
- **CLI `compile()` usage**: CLI was calling `stmt.compile()` which is `@internal`. Switched to public `stmt.getDebugPlan()` / `stmt.getDebugProgram()`.
- **Buffer type mismatch**: `readStdin` used `Buffer[]` then `Buffer.concat()`. Switched to `string[]` with `setEncoding('utf-8')`.
- **Windows `start` command**: `spawn('start', ...)` doesn't work since `start` is a shell built-in. Fixed to `spawn('cmd', ['/c', 'start', '', url])`.
- **`renderJson` crash on plain objects**: `serializePlanTree` expects internal PlanNodes with `.visit()`. Added guard to fall back to `JSON.stringify` for plain PlanNode-like objects.

### Type Safety
- Replaced `physical?: any` with typed `PhysicalProperties` interface.
- Removed unused `toString?()` from `PlanNode` interface.
- Introduced `isInstructionProgram` type guard replacing repeated `'type' in plan` checks.
- Introduced const tuples for valid phases/formats with derived types.

### Cleanup
- Removed empty `src/visualizer.spec.ts` (dead file).
- Fixed inconsistent indentation.
- Merged duplicate `readFileSync`/`writeFileSync` imports.
- Renamed `program` variable to `cliProgram` to avoid shadowing `commander.program` in `emitted` switch case.

## Test Coverage

22 tests covering `PlanVisualizer` from the public interface:
- `renderTree`: single node, phase labels, static children, method children, nesting, instruction programs, ordering, logical properties, toString safety
- `renderJson`: valid JSON output, instruction programs, nested structure preservation
- `renderMermaid`: header structure, node labels, deterministic IDs, explicit IDs, edges, instruction programs
- Edge cases: empty nodes, empty programs, method-over-static precedence, getLogicalProperties

## Documentation

- Updated README to use `yarn` (project convention) instead of `npm`.

