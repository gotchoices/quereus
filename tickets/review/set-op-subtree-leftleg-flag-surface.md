description: Review the fix for `column_info` over-claiming `is_updatable = YES` on a membership flag declared on the LEFT leg of a subtree operand of a nested set-op view. The static `surfacedInnerFlagNames` enumeration was rewritten to mirror the plan's recursive `[L flags] ++ [R flags] ++ [own flags]` layout across BOTH legs (unwrapping left-compound wrappers), so the static `column_info` surface now reports every surfaced inner flag `is_updatable = NO`, agreeing with the dynamic `set-op-membership-nested` reject — for a flag on either leg of a left- or right-side subtree operand at any depth.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What changed

A static surface-authority bug: `column_info('V')` claimed a membership flag declared on the
**LEFT leg of a subtree operand** was writable (`is_updatable = YES`) while the dynamic write
correctly deferred it (`set-op-membership-nested`). Surface authority requires `column_info` to
never claim writable what `propagate()` rejects. The dynamic path was already correct (its
`surfacedInnerFlagNames` is derived positionally from the plan); only the **static** AST-only
enumeration was wrong.

### Root cause (now fixed)

`packages/quereus/src/planner/mutation/set-op.ts` — `collectSubtreeFlagNames` (the recursion
behind exported `surfacedInnerFlagNames`, consumed by `schema.ts`'s `column_info`) had two
defects vs. the plan layout `SetOperationNode.buildAttributes` produces
(`[data] ++ [L flags] ++ [R flags] ++ [own flags]`, recursive):

1. It pushed an operand's OWN flags **before** descending, but the plan appends own flags
   **after** both operands' surfaced flags.
2. It descended only the RIGHT leg (`compound.select`), never the left leg, and never unwrapped
   a `select * from (compound)` left-leg wrapper.

So it happened to be correct only for the already-tested right-spine shape
(`A union[inA,inSub] (B union[inB,inC] C)`) and broke the moment a subtree operand had a flagged
LEFT leg or own flags alongside a flagged left leg.

### The fix

Rewrote `surfacedInnerFlagNames` + `collectSubtreeFlagNames` to mirror the plan's recursive layout:
descend the LEFT leg, then the RIGHT leg, THEN append the node's own flags; unwrap each operand's
`select * from (compound)` wrapper INSIDE the recursion (via the existing `unwrapBranchSelect`), so
the caller passes the raw `leftBranchSelect(selectAst)` and unwrapping happens uniformly at every
level. Both functions' doc comments were rewritten to describe the recursive left→right→own order
and the wrapper unwrap. No new helpers (`leftBranchSelect` / `unwrapBranchSelect` already existed).

The result lands element-for-element on the plan-derived `analysis.surfacedInnerFlagNames`
(`viewColNames.slice(dataColCount, length - flags.length)`), pinning static == dynamic.

## Validation performed (a floor, not a ceiling)

All green at handoff:
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus run lint` → clean.
- `property.spec.ts` → **221 passing** (4 new tests below + all 9 pre-existing nested set-op
  surface tests unchanged).
- `yarn workspace @quereus/quereus test` (full suite) → **5393 passing, 9 pending**, no regressions.

### New tests added (in the `Nested / subtree set-operation membership writes` describe block, after the `Key Soundness under write` test)

- **RIGHT subtree operand with a flagged left leg** — the confirmed repro
  `V = A union[inL,inR] ( (B union[inP,inQ] C) union D )`. Asserts plan column order
  `[id, x, inP, inQ, inL, inR]`, `column_info` reports `inP`/`inQ` = NO and
  `id`/`x`/`inL`/`inR` = YES, and cross-checks `update V set inP = true` rejects with
  `/set-op-membership-nested/`.
- **LEFT (parallel-sibling) subtree operand with a flagged left leg** — the symmetric mirror
  `VL = ( (B union[inP,inQ] C) union D ) union[inL,inR] A` (parser lifts the parenthesized LEFT
  compound into a `select * from (compound)` wrapper). Asserts `inP`/`inQ` = NO + the same dynamic
  reject.
- **Deeper ≥3-level subtree with own flags alongside a flagged left leg** —
  `VD = A union[inL,inR] ( ( (B union[inP,inQ] C) union[inM,inN] D ) union E )`. Asserts plan order
  `[id, x, inP, inQ, inM, inN, inL, inR]` and all four inner flags `inP`/`inQ`/`inM`/`inN` = NO —
  exercises the order fix (own flags appended after both legs descend).
- **Right-spine regression** — the existing supported shape
  `A union[inA,inSub] (B union[inB,inC] C)` still reports `inB`/`inC` = NO, `inA` = YES.

**Key regression guard:** every new test asserts an **order-parity cross-check** —
`surfacedInnerFlagNames(parse(body))` equals the plan-derived slice
(`findSetOp(body).getType().columns.map(c => c.name).slice(2, len - 2)`) element-for-element. This
is what pins the static surface to the dynamic write for these shapes; if either drifts, it reds.

## Reviewer attention / known gaps (honest floor)

- **Operator coverage of the surfaced enumeration is union-only in the new tests.**
  `collectSubtreeFlagNames` is operator-agnostic (descends any non-`diff` compound and collects
  flags regardless of `union`/`unionAll`/`except`/`intersect`), so a flagged-LEFT-leg
  **except/intersect** subtree is handled by the same code path — but no new test exercises a
  flagged-LEFT-leg except/intersect subtree's *static surface order parity*. The existing
  `outer intersect / except over a flagged subtree` test only uses right-leg flags. Worth a glance
  if you want operator breadth on the new surface.
- **LEFT-side depth ≥3 surface order parity is not explicitly asserted.** The VL test is one level
  of LEFT wrapper; VD's depth-3 is on the RIGHT spine. The dynamic `Parenthesized LEFT-compound
  operand writes` block has a `depth-3 LEFT nest` *write* test, and the recursion unwraps uniformly,
  so a LEFT-of-LEFT-of-LEFT surface would work — but the order-parity cross-check at LEFT depth-3
  isn't pinned by a test.
- **Scope:** this is purely the per-column `column_info` static surface. `view_info`'s aggregate
  `is_updatable`/`is_deletable`/`is_insertable_into` are unaffected (the insertability gate already
  walks both legs via `setOpHasSubtreeOperand`), and the dynamic write was already correct — this
  ticket only closed the static-vs-dynamic disagreement.

## Docs

`docs/view-updateability.md` (§ Static surfaces gate on branch writability, ~line 592) now states
that the surfaced-inner enumeration mirrors the plan's recursive `[L flags] ++ [R flags] ++
[own flags]` layout across BOTH legs of every subtree operand (unwrapping left-compound wrappers),
so `column_info` reports every surfaced inner flag `is_updatable = NO` for a flag on either leg of a
left- or right-side subtree operand at any depth, landing element-for-element on the plan-derived
`analysis.surfacedInnerFlagNames`.
