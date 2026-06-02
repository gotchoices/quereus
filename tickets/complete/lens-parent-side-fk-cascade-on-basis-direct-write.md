description: Scope the runtime lens parent-side FK machinery (cascade walker, RESTRICT pre-check, divergent-basis-FK suppression) to lens-routed writes only, via a plan-time `lensRouted` marker on `DmlExecutorNode`. Basis-direct DML now bears solely physical (basis-declared) FK semantics. COMPLETE — reviewed, lint + full suite green.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Summary

A plan-time `lensRouted: boolean` marker on `DmlExecutorNode` distinguishes the basis-table
spine of a write *routed through a lens view* from a basis-direct write. The runtime
parent-side **logical** FK machinery now fires only when `lensRouted === true`:

1. **Cascade walker** (`executeLensForeignKeyActions`) — fired from
   `executeForeignKeyActionsAndLens` only when `lensRouted`.
2. **Lens RESTRICT pre-check** (`assertLensRestrictsForParentMutation`, step 1b of
   `assertTransitiveRestrictsForParentMutation`) — gated on `lensRouted`.
3. **Divergent-basis-FK suppression** (`basisFksOverriddenByDivergentLensFk`) — computed
   (else empty set) only when `lensRouted`, at all three call sites.

This makes the runtime side consistent with the already-lens-scoped plan-time lens RESTRICT
collector and logical CHECK collector. The headline gap (a basis-direct `delete from y.parent`
firing the logical cascade) is closed, and the site-3 soundness hole (a basis-direct write
suppressing its physical basis FK into a no-op) is closed (suppression set is empty when not
lens-routed, so the physical action runs).

The marker is threaded by `buildViewMutation` (`isLensWrite = !!getSchema(view.schemaName)
?.getLensSlot(view.name)` — the same predicate the lens collectors use) through `buildBaseOp`
into the single-source-spine `buildInsert/Update/DeleteStmt`. Multi-source / decomposition
insert builders intentionally leave it `false` (no single basis spine). The runtime
`emitDmlExecutor` passes `plan.lensRouted` to all insert/update/delete FK sites; the two
`processEvictions` calls keep the `false` default.

The nested transitive recursion in `assertTransitiveRestrictsForParentMutation` carries
`lensRouted` UNCHANGED (a deliberate deviation from the plan's "pass false" instruction) — the
transitive closure of a lens-routed write inherits logical FK semantics. See Review findings.

## Review findings

**Verdict: APPROVED. No major findings; no new tickets filed.** Lint clean; targeted suite
(145) and full quereus suite (4409 passing, 9 pending, 0 failing) green at review SHA.

### What was checked

- **Implement diff read first, fresh** (`git show 756292c0`), before the handoff summary.
- **Signature-change safety** — `executeForeignKeyActions`, `assertTransitiveRestrictsForParentMutation`,
  and `assertNoRestrictedChildrenForParentMutation` all gained `lensRouted` *before* an existing
  trailing `visited*` param. Audited every call site: `executeForeignKeyActions` does not
  self-recurse (it delegates to `executeSingleFKAction` with `visited`), so no positional
  misalignment; the transitive recursion passes `(…, lensRouted, visitedSet)` correctly; the two
  emit-side `assertTransitive…` eviction calls use the `false` default intentionally. The three
  builder signatures gained a trailing defaulted `lensRouted = false`, so all pre-existing
  callers are unaffected. `buildBaseOp` passes args in the correct order to each builder
  (verified against each full signature, incl. insert's `preBuiltSource` slot via `undefined`).
- **Predicate consistency** — `isLensWrite` uses the identical `getSchema(...)?.getLensSlot(...)`
  predicate as `propagate.ts`, `single-source.ts`, and the other view-mutation-builder sites, so
  the runtime marker and the plan-time lens collectors agree on what "lens-routed" means.
- **All `new DmlExecutorNode(...)` sites** (3 builders + `withChildren`) thread/carry `lensRouted`;
  `withChildren` carry-forward is regression-tested.
- **The deliberate deviation** (recursion carries `lensRouted` unchanged, contra the plan) —
  CONFIRMED CORRECT. Anchored by the pre-existing test `transitive — a lens RESTRICT two hops
  down (through a basis cascade) ABORTs the top-level parent delete` (lens-enforcement.spec.ts
  :2753). Reasoning verified: for a lens-routed top write, an *agreeing* basis cascade runs as a
  basis-direct nested write (correctly not firing the deeper lens RESTRICT) and the agreeing lens
  cascade is elided, so the pre-walk recursing with the flag still set is the sole enforcer of a
  logical RESTRICT below an agreeing basis cascade. Passing `false` would silently orphan the
  leaf (test would fail). The pre-walk is a pure check (no mutation), so carrying the flag cannot
  double-act; and a basis-direct top write already has `lensRouted = false`, so its recursion
  stays basis-only. This also exactly matches pre-change behavior for lens-routed writes (before
  this ticket the walker was un-gated ⇒ always full logical), narrowing only the basis-direct case.
- **Tests** — happy path, the headline gap + lens contrast, the divergent-suppression soundness
  hole, UPDATE re-key variants, transitive cascade, regression guard, and a plan-node regression
  (marker set + surfaced in `getLogicalAttributes` + preserved across `withChildren`). Coverage is
  appropriate for the change surface.
- **Docs** — `docs/lens.md` gains an accurate "Logical constraints are enforced at the lens
  boundary only" subsection describing the marker and the consistency across CHECK / parent-side
  RESTRICT / parent-side CASCADE classes. Reflects the new reality.

### Findings & disposition

- **(Minor, accepted — no action) REPLACE-eviction FK semantics.** `processEvictions`
  (dml-executor.ts:599, :603) fires both `assertTransitiveRestrictsForParentMutation` and
  `executeForeignKeyActionsAndLens` with `lensRouted = false`, so an internal REPLACE eviction
  (a row at *another* PK the substrate removed to resolve a non-PK UNIQUE conflict) bears
  basis-only FK semantics, even under a lens-routed `insert or replace`. This is a deliberate,
  documented behavior change (pre-ticket the un-gated walker fired the lens cascade here). Judged
  **correct by construction**: the eviction is triggered by a *basis* non-PK UNIQUE that has no
  faithful logical-view analog — if the lens carries no matching logical UNIQUE, no logical
  replace is occurring and firing the logical cascade would wrongly cascade children for a row
  that logically was not replaced; if the lens *does* carry a logical UNIQUE, the proper enforcer
  is the separate lens set-level UNIQUE channel, not this physical eviction path. **Caveat:** this
  exact combination (lens over a basis with a non-PK UNIQUE + `insert or replace` eviction + a
  logical-only FK) has no dedicated test. Left as an optional future coverage gap rather than a
  fragile review-time test; behavior is sound and the combination is narrow.
- **(Minor, accepted — no action) DRY.** The `lensRouted ? basisFksOverriddenByDivergentLensFk(…)
  : new Set<…>()` ternary appears 3× in foreign-key-actions.ts. Each carries distinct contextual
  comments and is a one-line expression; inlining reads clearly. Not worth extracting.
- **(Noted — no action) `getLogicalAttributes` surfaces `lensRouted` only when true.** Intentional
  to avoid plan-dump golden churn (full plan-test suite confirms no churn). A reviewer preferring
  always-present for EXPLAIN symmetry could change it in 1 line with no behavior impact.
- **Bugs / error handling / type safety / resource cleanup:** none found. The added param is a
  plain boolean with safe defaults; no new resources, no swallowed exceptions, no `any`.

### Not run (inherited deferral, acceptable)

- `yarn test:store` (LevelDB store path) and other workspaces' suites — the change is
  quereus-internal planner/runtime FK code; no store-specific code was touched. The transitive
  RESTRICT pre-walk that rowid-chained backends (lamina) rely on is exercised by the memory-vtab
  suite, which passed. A store-path sanity check remains a reasonable out-of-band confirmation but
  is not gating for this ticket.

## Validation performed (review)

- `eslint` (quereus `lint` script) — clean.
- `lens-enforcement.spec.ts` + `runtime/fk-restrict-runtime.spec.ts` — 145 passing.
- Full quereus suite (`node packages/quereus/test-runner.mjs`, memory vtab) — 4409 passing,
  9 pending, 0 failing.
