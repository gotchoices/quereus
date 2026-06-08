description: Closed the static `column_info` over-claim where a membership flag on the LEFT leg of a subtree operand of a nested set-op view reported `is_updatable = YES` while the dynamic write deferred it (`set-op-membership-nested`). `surfacedInnerFlagNames` / `collectSubtreeFlagNames` were rewritten to mirror the plan's recursive `[L flags] ++ [R flags] ++ [own flags]` layout across BOTH legs (unwrapping left-compound wrappers), pinning the static surface to the dynamic write for a flag on either leg of a left- or right-side subtree operand at any depth.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/nodes/set-operation-node.ts
----

## Summary

The implement stage fixed a static surface-authority bug: `column_info('V')` claimed a
membership flag declared on the **LEFT leg of a subtree operand** writable (`is_updatable = YES`)
while the dynamic write correctly deferred it (`set-op-membership-nested`). The static AST-only
enumeration `collectSubtreeFlagNames` (behind exported `surfacedInnerFlagNames`, consumed by
`schema.ts`'s `column_info`) had two defects vs. the plan layout
`SetOperationNode.buildAttributes` produces (`[data] ++ [L flags] ++ [R flags] ++ [own flags]`,
recursive):

1. it pushed an operand's OWN flags **before** descending instead of after both legs; and
2. it descended only the RIGHT leg and never unwrapped a `select * from (compound)` left-leg wrapper.

The rewrite descends LEFT then RIGHT then appends own flags, unwrapping each operand's wrapper
inside the recursion (`unwrapBranchSelect`), landing element-for-element on the plan-derived
`analysis.surfacedInnerFlagNames` slice. The dynamic path was already correct; only the static
enumeration was wrong. The fix is sound and complete — verified by reading the implement diff,
the plan's `buildAttributes`/`getType` layout, and both the static (`column_info`) and dynamic
(`buildUpdate`) consumers.

## Review findings

**Diff reviewed first, fresh, before the handoff summary** — `git show eaaf430d` (set-op.ts,
property.spec.ts, view-updateability.md). Then cross-read `set-operation-node.ts`
(`buildAttributes`/`getType` — the layout source of truth), `schema.ts` (`column_info` consumer),
and the dynamic `analyzeSetOpView`/`buildUpdate` reject path.

### Correctness — no defects found
- **Recursion mirrors the plan.** `collectSubtreeFlagNames` descends left → right → own flags,
  exactly `surfaced(N) = surfaced(L) ++ surfaced(R) ++ ownFlags(N)`, which is what
  `buildAttributes` (`[data] ++ leftAttrs.slice(data) ++ rightAttrs.slice(data) ++ ownFlags`,
  recursive) produces. Verified against `set-operation-node.ts:129-180`.
- **Surface authority holds.** `column_info` builds a `Set` of the static names and reports every
  member `is_updatable = NO`; the dynamic `buildUpdate` rejects the same names (plan-derived slice).
  Because the static enumeration is exactly the plan-derived list (confirmed by the order-parity
  cross-checks), the static surface can neither miss (→ over-claim YES) nor over-include a flag.
- **Unwrap symmetry.** Both legs pass through `unwrapBranchSelect` inside the recursion; the
  shared `unwrapPassthroughSubquery` predicate is recursive/idempotent and stops at a compound
  inner, so doubly-wrapped and direct operands resolve identically to the build path. A non-pure
  wrapper (`select x from (compound)`) has no `.compound`, so the walk returns early — it surfaces
  no false flags (matching the plan, which doesn't make it a `SetOperationNode` operand).
- **Own-flag exclusion.** The outer body's own flags (`analysis.flags`) are correctly excluded —
  `surfacedInnerFlagNames` only descends operands; each descended inner operand contributes its
  own flags, the outer's do not.

### Tests — happy path solid; two implementer-flagged coverage gaps closed inline (minor)
The implementer's 4 tests (RIGHT subtree w/ flagged left leg, LEFT parallel-sibling, depth-3 RIGHT
spine w/ own flags, right-spine regression) all assert column-level `is_updatable`, plan column
order, the static==plan order-parity cross-check, and the dynamic reject. Two gaps were explicitly
flagged at handoff; both are now closed (shapes empirically verified via a scratch probe before
authoring, then removed):
- **`EXCEPT subtree operand with a flagged left leg`** — `V = A union[inL,inR] ( (B except[inP,inQ]
  C) union exists left as inSub D )`. This shape is fully branch-writable (the EXCEPT leg is gated
  by the subtree-union's `inSub` boundary flag), so it lands on the `column_info` branch-writable
  short-circuit — a *genuine surface-authority* check (data cols report YES, `inP`/`inQ`/`inSub`
  NO), not just internal parity. Proves the operator-agnostic claim the handoff left untested.
- **`LEFT depth-3 wrapped nest with own flags`** — `( ( (B union[inP,inQ] C) union[inM,inN] D )
  union E ) union[inL,inR] A`. Pins LEFT-of-LEFT-of-LEFT surface order parity (handoff's VD depth-3
  was on the RIGHT spine; VL was one LEFT level).

### Docs — accurate, no drift
`docs/view-updateability.md` §362-383 (read-half plan layout) and §592-601 (static surface) both
describe the recursive `[L flags] ++ [R flags] ++ [own flags]` layout across both legs at any depth,
matching the implementation. No other doc references the surfaced-inner enumeration behavior.
`schema.ts` (consumer) needed no change — it calls the exported function. No code paths that
*should* have been touched were missed.

### Lint / typecheck / tests — all green
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus run lint` → clean.
- `property.spec.ts` → **223 passing** (the 4 handoff tests + 2 added here, all pre-existing green).
- `yarn workspace @quereus/quereus test` (full suite) → **5395 passing, 9 pending**, no regressions.

### Disposition
No major findings — nothing spawned to `fix/`/`plan/`/`backlog/`. Two minor test-coverage gaps
(operator breadth on the new surface; LEFT depth-3 parity) fixed inline. The implementation is
correct, the surface-authority invariant (static `column_info` never over-claims vs. the dynamic
`propagate` reject) is restored and now guarded across union/except, left/right, and depth ≥3 on
both spines.
