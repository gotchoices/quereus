description: Fix `column_info` over-claiming `is_updatable = YES` for a membership flag declared on the LEFT leg of a subtree operand of a nested set-op view. The static `surfacedInnerFlagNames` helper (`collectSubtreeFlagNames`) descends only a subtree operand's RIGHT leg and pushes own flags in the wrong order, so deeper-left surfaced inner flags are missed (or mis-ordered) by the static surface even though the plan surfaces them and the dynamic write correctly rejects writing them. Symmetric on both operand sides; pre-existing (`nestable-flagged-set-ops`), independent of `set-op-leftwrap-write` but in the same surface family.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Problem (reproduced + root-caused; fix validated end-to-end during the fix stage)

A nested set-op membership view whose **subtree operand has a flagged left leg** mis-reports that
left-leg flag as writable on the static `column_info` surface, while the dynamic write correctly
defers it — a Round-Trip / surface-authority violation (`column_info` must not claim writable what
`propagate()` rejects).

### Confirmed repro (RIGHT subtree operand with a flagged left leg)

```sql
create table A (id integer primary key, x integer) using memory;
create table B (id integer primary key, x integer) using memory;
create table C (id integer primary key, x integer) using memory;
create table D (id integer primary key, x integer) using memory;

create view V as
  select id, x from A
  union exists left as inL, exists right as inR
  ( (select id, x from B union exists left as inP, exists right as inQ select id, x from C)
    union select id, x from D );
```

- Plan column order: `[id, x, inP, inQ, inL, inR]` — `inP`/`inQ` ARE surfaced inner flags.
- **Before fix:** `column_info('V')` reports `inP`/`inQ` = `YES` (wrong). Dynamic
  `update V set inP = true` correctly rejects with the `set-op-membership-nested` diagnostic.
- **After fix (validated):** `column_info('V')` reports `inP`/`inQ` = `NO`, order unchanged
  (`[id, x, inP=NO, inQ=NO, inL=YES, inR=YES]`), agreeing with the dynamic reject. All 9 existing
  nested set-op surface tests still pass.

## Root cause

`packages/quereus/src/planner/mutation/set-op.ts` — `collectSubtreeFlagNames` (the recursion behind
the exported `surfacedInnerFlagNames`, consumed by `schema.ts`'s `column_info`) has **two** defects
relative to the plan layout `SetOperationNode.buildAttributes` produces
(`[data] ++ [L flags] ++ [R flags] ++ [own flags]`, recursive — see
`packages/quereus/src/planner/nodes/set-operation-node.ts:117-147`):

```ts
function collectSubtreeFlagNames(operand: AST.QueryExpr, out: string[]): void {
	if (operand.type !== 'select' || !operand.compound || operand.compound.op === 'diff') return;
	for (const e of operand.compound.existence ?? []) out.push(e.name);   // (1) own flags FIRST — wrong order
	collectSubtreeFlagNames(operand.compound.select, out);                // (2) RIGHT leg only; left leg never visited/unwrapped
}
```

1. It pushes the operand's OWN flags **before** descending — but the plan appends a node's own flags
   **after** both operands' surfaced flags (`[L flags] ++ [R flags] ++ [own flags]`).
2. It descends only `compound.select` (the right operand), never the left leg
   (`leftBranchSelect`), and never unwraps a `select * from (compound)` left-leg wrapper.

The **dynamic** path has no gap: `analysis.surfacedInnerFlagNames` is derived **positionally from the
plan** (`viewColNames.slice(dataColCount, length - flags.length)`), so it includes every surfaced
inner flag in layout order regardless of which leg declared it. Hence static under-counts /
mis-orders and the two disagree.

The current code happens to be correct only for the already-tested shape `A union[inL,inR]
(B union[inP,inQ] C)` (right-spine, subtree's OWN flags are the only flags, no left-leg subtree). It
breaks the moment a subtree operand has a flagged LEFT leg, or own flags alongside a flagged left
leg.

## Fix (validated in the fix stage, then reverted for clean implement handoff)

Rewrite `collectSubtreeFlagNames` to mirror the plan's recursive layout — descend BOTH legs
(unwrapping each `select * from (compound)` wrapper via the existing `unwrapBranchSelect`), THEN
append the node's own flags — and let the caller stop pre-unwrapping (the recursion unwraps
uniformly at every level, including the top operands):

```ts
export function surfacedInnerFlagNames(selectAst: AST.QueryExpr): string[] {
	const out: string[] = [];
	if (selectAst.type === 'select' && selectAst.compound) {
		// Walk BOTH operands in plan layout order: `[L operand surfaced] ++ [R operand surfaced]`
		// (this node's OWN flags are `analysis.flags`, not surfaced-inner, and are excluded here).
		collectSubtreeFlagNames(leftBranchSelect(selectAst), out);
		collectSubtreeFlagNames(selectAst.compound.select, out);
	}
	return out;
}

/** Collect every membership-flag name declared on `operand` and its deeper subtree operands. */
function collectSubtreeFlagNames(operand: AST.QueryExpr, out: string[]): void {
	if (operand.type !== 'select') return;
	// Unwrap a parenthesized compound operand's `select * from (compound)` wrapper (a no-op on a
	// direct operand) so a left-wrapped subtree is descended too (`set-op-leftwrap-write`).
	const effective = unwrapBranchSelect(operand);
	if (!effective.compound || effective.compound.op === 'diff') return;
	// Mirror SetOperationNode.buildAttributes' `[L flags] ++ [R flags] ++ [own flags]` layout:
	// descend the left leg, then the right leg, THEN append this node's own flags. Matches the
	// plan-derived `analysis.surfacedInnerFlagNames` element-for-element.
	collectSubtreeFlagNames(leftBranchSelect(effective), out);
	collectSubtreeFlagNames(effective.compound.select, out);
	for (const e of effective.compound.existence ?? []) out.push(e.name);
}
```

Notes for the implementer:
- The `unwrapBranchSelect` call moves INTO `collectSubtreeFlagNames`, so the caller in
  `surfacedInnerFlagNames` passes the raw `leftBranchSelect(selectAst)` (no pre-unwrap). Keep it that
  way — uniform unwrapping at every recursion level is what lets a deeper-left wrapped subtree be
  reached.
- Update the doc comments on both functions (the existing comment claims a `[L flags] ++ [R flags]`
  walk but the body did neither correctly) — keep them honest about the recursive left-then-right-then-own
  order and the wrapper unwrap.
- `leftBranchSelect` and `unwrapBranchSelect` already exist in the same file; no new helpers needed.

## Verification (add to `packages/quereus/test/property.spec.ts`)

Place near the existing nested set-op static-surface tests (the `seedNested` block ~line 2537 and the
`static surface honesty` test ~line 3585). Cover both operand sides and ≥1 deeper level, and
cross-check the static order against the plan-derived order element-for-element.

- **RIGHT subtree operand with a flagged left leg** (the confirmed repro `V` above): assert
  `column_info('V')` reports `inP`/`inQ` = `NO` and `inL`/`inR`/`id`/`x` = `YES`; cross-check the
  dynamic `update V set inP = true` rejects with `/set-op-membership-nested/`.
- **LEFT (parallel-sibling) subtree operand with a flagged left leg** — the symmetric mirror
  (parser lifts the parenthesized LEFT compound into a `select * from (compound)` wrapper,
  `set-op-leftwrap-write`):
  ```sql
  create view VL as
    ( (select id, x from B union exists left as inP, exists right as inQ select id, x from C)
      union select id, x from D )
    union exists left as inL, exists right as inR
    select id, x from A;
  ```
  Plan order `[id, x, inP, inQ, inL, inR]`; assert `inP`/`inQ` = `NO`.
- **Deeper nesting (≥3 levels) + own flags alongside a flagged left leg** to exercise the
  order fix, e.g.:
  ```sql
  create view VD as
    select id, x from A
    union exists left as inL, exists right as inR
    ( ( (select id, x from B union exists left as inP, exists right as inQ select id, x from C)
        union exists left as inM, exists right as inN select id, x from D )
      union select id, x from E );
  ```
  Plan order `[id, x, inP, inQ, inM, inN, inL, inR]`; assert all four inner flags
  (`inP`/`inQ`/`inM`/`inN`) = `NO`.
- **Order parity cross-check (no surface drift):** for each shape, assert the static
  `surfacedInnerFlagNames(view.selectAst)` returns the SAME list, in the SAME order, as the
  plan-derived `analysis.surfacedInnerFlagNames` — i.e. equal to the planned root's attribute names
  sliced between the data columns and the body's own flags (`findSetOp` / `getType().columns`
  helpers are already used in this spec; see the `Key Soundness` test ~line 3606 for the
  `findSetOp(...).getType().columns` pattern). This is the regression guard that pins static ==
  dynamic for these shapes.
- **Regression:** confirm the existing right-spine `Vn` test (`A union[inA,inSub]
  (B union[inB,inC] C)`, `static surface honesty` ~line 3585) still reports `inB`/`inC` = `NO` and
  `id`/`x`/`inA` = `YES`.

## Docs

- `docs/view-updateability.md` — under the nested/set-op section, note that the static
  surfaced-inner-flag enumeration mirrors the plan's recursive `[L flags] ++ [R flags] ++ [own flags]`
  layout across BOTH legs of every subtree operand (unwrapping left-compound wrappers), so
  `column_info` reports every surfaced inner flag `is_updatable = NO` in agreement with the dynamic
  `set-op-membership-nested` reject — for a flag declared on either leg of a left- OR right-side
  subtree operand at any depth.

## TODO

- Apply the `collectSubtreeFlagNames` / `surfacedInnerFlagNames` rewrite in
  `packages/quereus/src/planner/mutation/set-op.ts` as shown above; update both functions' doc
  comments to describe the recursive left→right→own order and the wrapper unwrap.
- Add the verification property tests (RIGHT-side flagged-left-leg, LEFT-side parallel-sibling
  flagged-left-leg, deeper ≥3-level with own flags, the static-vs-plan order parity cross-check, and
  the right-spine regression) to `packages/quereus/test/property.spec.ts`.
- Update `docs/view-updateability.md` as above.
- Run `yarn workspace @quereus/quereus run typecheck`, `yarn workspace @quereus/quereus run lint`
  (single-quote globs on Windows), and the property spec
  (`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/property.spec.ts" --colors` from the repo root, or `yarn test`) — confirm
  the new tests pass and no nested set-op surface test regresses.
