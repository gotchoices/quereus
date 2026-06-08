---
description: COMPLETE — `correlated` row-scope-escape flag on `PredicateConstraint` plus rewritten cover guard in `computeCoveredKeysForConstraints`. Closes the singleton correlated-`IN` latent cover bug (`p.id IN (outer.id)` was wrongly covering the PK) and handles cast-wrapped correlated column refs for both the `=` and `IN` paths via a free-reference child walk. The general-expression equality shape (`p.id = outer.id + 1`) is confirmed never extracted (stays residual) and was already safe; the flag mechanism is future-proof for that path but currently unreachable through it.
files:
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/test/planner/constraint-extractor.spec.ts
----

# Complete: correlated-binding cover guard — outer-ref `'expression'` and singleton-IN

## Summary of landed change

`computeCoveredKeysForConstraints` previously gated only `op === '=' && bindingKind === 'correlated'`. That missed singleton correlated `IN` (`p.id IN (outer.id)`) and cast-wrapped correlated column refs. The fix introduces an orthogonal `correlated?: boolean` on `PredicateConstraint`, computed at extraction time by a free-reference walk (`collectColumnRefAttributeIds` / `bindingReferencesOuterTable`) over the value subtree, and rewrites the cover guard to `if (c.correlated) continue;` before adding `=`/singleton-`IN` columns.

- Source: `constraint-extractor.ts` — new field (~L52), helpers (~L287/307), `result.correlated` set in `extractBinaryConstraint` (~L414) and `extractInConstraint` (~L516), cover guard rewritten (~L979).
- Tests: `constraint-extractor.spec.ts` — parent fix's two synthetic cover tests updated to set `correlated = true`; new cover-guard unit tests and a `describe('correlated flag (row-scope escape)')` extraction block.

## Review findings

### Scope of review
Read the implement diff (`44c3f6b0`) before the handoff. Audited the source change against the live code paths, traced every consumer of the new flag and of `bindingKind`, and checked the reachability claims in the handoff. Ran targeted spec, full quereus suite, typecheck, lint.

### Correctness — verified, no defects
- **Behavioral equivalence for the parent case.** Real extraction sets both `bindingKind = 'correlated'` and `correlated = true` (lines 406 + 414), so swapping the guard from `bindingKind !== 'correlated'` to `if (c.correlated) continue;` preserves the parent fix exactly. Confirmed.
- **The new flag has exactly one consumer** (`computeCoveredKeysForConstraints`, L979). Verified via grep across `packages/quereus/src`: no other code reads `.correlated`, so the flag is genuinely orthogonal and cannot perturb other planner decisions.
- **`change-scope.ts:505`** (`extractScopeTuples`) reads `bindingKind`/`valueExpr`, not `correlated`, and resolves only params via `scopeValueFromExpr` (column-ref value sides → `return []`). Unaffected by this change.
- **No production code constructs `bindingKind: 'correlated'` constraints outside the extractor** (grep confirmed only the two synthetic spec constraints do). Those were correctly updated to carry `correlated = true`. So no real constraint slips past the flag-based guard.
- **Over-flagging is conservative-safe.** `bindingReferencesOuterTable` could in principle over-collect (e.g. refs inside a scalar-subquery value side via `getChildren()`), but over-flagging only *removes* a cover (loses an optimization), never introduces incorrectness. And it is unreachable anyway: subquery/general-expression value sides fail `isDynamicValue`/`allUsable` and are never extracted.
- **Honest-gap claim confirmed.** The `else { bindingKind = 'expression'; }` branch at L408 is unreachable for the equality path: any non-literal value side reaching it must have passed `isDynamicValue`, whose inner (post single `unwrapCast`) is necessarily a Param or ColumnReference — contradicting the else's precondition. This dead branch is **pre-existing** (not introduced by this ticket; the diff only appended the `correlated` assignment after it). The only reachable "wrapped correlated" shape is a single `cast(bareColumn)`, which is flagged correctly. `p.id = outer.id + 1` stays residual → already safe. All as the handoff states.

### Test coverage — starting point extended
The implementer's tests cover happy path, the bare/cast-wrapped/param/literal value-side matrix, the singleton-IN bug, and cover integration. Edge/error paths (empty IN, residual fallthrough, no-table-info) were already covered by the pre-existing suite.

- **Minor — fixed inline:** the handoff (#3) admitted the cast-wrapped *IN element* (`p.id IN (cast(outer.id))`) was reachable but untested. Added a test asserting `correlated = true` and that it does NOT cover the PK. Spec now 230 passing (was 229).

### Findings disposition
- **Major:** none filed. No correctness defect, no architectural concern, no missing-prereq path. The general-expression extraction broadening raised as handoff open-question #1 was explicitly out of scope per the parent ticket and is not needed for correctness (residual handling is already safe); no live caller surfaces such expressions as covering constraints. No new ticket warranted.
- **Minor:** one — the cast-wrapped-IN coverage gap, fixed inline (above).
- **Docs:** no doc updates needed. The change is internal to the constraint extractor; behavior is documented in-code via the (accurate, expanded) cover-guard comment and the field doc-comment. No `docs/optimizer.md` / `docs/architecture.md` statement contradicts the new reality (the cover guard is an implementation detail not surfaced there).

### Validation run
- Targeted spec: `test/planner/constraint-extractor.spec.ts` — **230 passing**.
- Full quereus suite (`yarn test`) — **3197 passing**.
- `yarn typecheck` — clean. `yarn lint` — clean.

## How to run

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/planner/constraint-extractor.spec.ts" --colors
cd packages/quereus && yarn typecheck && yarn lint
```
