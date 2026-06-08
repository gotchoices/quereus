---
description: FD/key propagation through ProjectNode/ReturningNode for projections that are injective in a single source attribute (e.g. `id + 1`, `-id`, `5 - id`, same-logical-type `CAST`). Landed via `planner/util/key-utils.ts:deriveProjectionColumnMap` and the Project/ReturningNode wiring.
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/scalar.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
  - tickets/backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md
---

## Summary

`ProjectNode` and `ReturningNode` now propagate `uniqueKeys`, `fds`, and `equivClasses` through projections that are injective in a single source attribute, not only bare column references. The recognition lives in a shared helper:

- `deriveProjectionColumnMap(sourceAttrs, projections)` in `planner/util/key-utils.ts` — walks each projection's leaves, requires exactly one source attribute (other leaves must be `LiteralNode` / `ParameterReferenceNode`), and consults `expr.isInjectiveIn(attrId)` to decide whether the output column is a synonym of the source attribute.

Built-in injectivity covers unary `±x`, `x ± const`, `const ± x` (via `UnaryOpNode` / `BinaryOpNode.isInjectiveIn`), and same-logical-type `CAST` (new `CastNode.isInjectiveIn`). Scalar functions opt in via the existing `injectiveOnArgs` trait on `FunctionSchema`.

## Key files

- **`planner/util/key-utils.ts`** — `deriveProjectionColumnMap` + `InjectiveProjectionEntry` / `ProjectionMappingResult`. Bare columns win the `map` slot; injectively-derived columns fill any remaining slots and are recorded in `injectivePairs` for callers that need to emit `{bare} ↔ {derived}` FDs and key-substitution.
- **`planner/nodes/project-node.ts`** — both `computePhysical` and `getType()` use the helper. Physical-pass: key substitution on the `injectivePairs`, bi-directional FDs emitted only when both ends are in the projection list (single-derivation skipped via `bareOut === outIdx` guard); `monotonicOn` still only flows through bare-column projections (attribute identity must survive).
- **`planner/nodes/returning-node.ts`** — same shape, in both `buildOutputType()` (logical keys) and `computePhysical()` (physical keys/FDs/ECs/bindings).
- **`planner/nodes/scalar.ts`** — `CastNode.isInjectiveIn`: returns the operand's injectivity when the cast is a logical-type no-op; otherwise `{ injective: false }`. Wider-cast injectivity intentionally deferred.

## Tests

- `packages/quereus/test/optimizer/keys-propagation.spec.ts`
  - Unit tests in `describe('deriveProjectionColumnMap', …)`: bare passthrough, injective derivation, both-forms collision, two-source-attrs negative case, non-injective negative case, unary minus.
  - SQL-level tests in `describe('Injective-projection key propagation', …)`: `id + 1`, `-id`, `5 - id`, `id, id+1`, two-source-attr negative, `*` negative, DISTINCT elimination over `id + 1`.
- `packages/quereus/test/optimizer/fd-propagation.spec.ts`
  - `SELECT id + 1 AS k, v FROM t` — source FD `id → v` survives as `{0} → {1}`.
  - `SELECT id, id + 1 AS k FROM t` — both `{0} → {1}` and `{1} → {0}` present.
  - Existing "non-injective expressions drop out" test now uses `v * 2` (`v + 1` correctly survives).

Validation: `yarn workspace @quereus/quereus run lint` and full `yarn test` both clean (2791 passing, 2 pending).

## Use cases unlocked

- DISTINCT elimination across trivial arithmetic (`SELECT DISTINCT id + 1 FROM t`).
- Join-key coverage when the join key is a trivial derivation (`u JOIN (SELECT id + 1 AS k FROM t) ON u.k = t.k`).
- Better cardinality estimates downstream of projections that wrap PK columns.

## Out of scope (deferred)

- Multi-input joint injectivity (`f(a, b)` injective in the pair).
- Wider-cast injectivity (requires "wider with no value collisions" check from the type system).
- New `injectiveOnArgs` annotations on built-ins (string functions, datetime conversions).
- The sargable-range-rewrite half of `tickets/backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md` (its description was updated to note the key-preservation half landed here).

## Review notes

- `deriveProjectionColumnMap` edge cases verified: constant-only projections drop out via the `attrIds.size !== 1` guard; identical bare/bare collisions preserve first-occurrence; bare-and-derived collisions keep `map[src] = bareOut` and record the derived column in `injectivePairs` only.
- Bi-directional FD only emitted when `bareOut !== outIdx` — single-derivation `SELECT id+1` does not generate `{0}↔{0}`.
- `uniqueKeys` substitution guarded by `!key.includes(outIdx)` so duplicates don't accumulate when the derived column is already in the key.
- `monotonicOn` propagation explicitly restricted to bare-column projections via `preservedAttrIds`.
- `CastNode.isInjectiveIn` strictly conservative: same logical type → operand's injectivity; otherwise `{ injective: false }`.
- No regressions in existing FD/key propagation tests.
