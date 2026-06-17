description: A view that unions several branches each tagged with a constant label column can be written through by filtering on those labels; this documents that idiom as the way to get "product-coordinate" addressing, and fixes a rough edge where a delete/update whose filter matched no branch raised an internal error instead of doing nothing.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: medium
----

## What shipped

The bespoke product-coordinate model was **not** built (correctly — the plan pass found the
already-shipped flag-less predicate-honest write path serves the product *use case* via multiple
projected-constant discriminator columns). The delivered work:

1. **Bug fix** — a zero-leg flag-less DELETE / data-UPDATE (predicate provably `unsat` for every leg)
   is now a clean no-op (0 rows) instead of raising the internal
   `ViewMutationNode requires at least one base operation`.
2. **Tests** — `93.6-set-op-flagless-write.sqllogic`: a product-coordinate addressing matrix (`PC`
   view, `kind ∈ {red,large}` × `src ∈ {A,B}`) plus `intersect`/`except` zero-leg no-ops.
3. **Docs** — `docs/view-updateability.md` § Set Operations: the projected-constant idiom as the
   recommended product surface; the zero-leg no-op note; stale "shelved backlog ticket" framing
   removed.

### The fix (`buildSetOpMutation`)

After `writeFn` returns, when `req.op !== 'insert' && baseOps.length === 0 && (joinLegInserts?.length
?? 0) === 0`, return a void no-op `SinkNode(EmptyRelationNode([], voidRelation), op)` via the new
`buildNoOpMutationSink` helper, instead of constructing `ViewMutationNode([])`. Placed at the shared
boundary for both set-op write paths (membership + flag-less). INSERT is deliberately excluded — a
flag-less insert routing to no leg raises `consistent with no writable leg` in `buildFlaglessInsert`
before control returns here, and must stay an error.

## Review findings

**Process:** read the implement-stage diff (`e7ee107d`) with fresh eyes before the handoff, traced the
full set-op write decomposition (`set-op.ts`: `buildFlaglessSetOpWrite` / `fanLegsForFanOut` /
`fanBranchDelete` / `fanBranchDataUpdate` / `fanMultiSourceBranch` / `buildFlaglessInsert`,
`buildSetOpWrite` membership path), the new helper and its node types (`SinkNode`,
`EmptyRelationNode`, `RelationType`, `emitSink`, `block.ts`), and the consumers of `buildViewMutation`
(`delete.ts` / `update.ts` / `insert.ts`). Ran lint and the full suite.

### Correctness — verified, no issues
- **Guard cannot mask a real write.** For DELETE/UPDATE, the only route to empty `baseOps` + empty
  `joinLegInserts` is `fanLegsForFanOut` → `[]` (no leg consistent with the predicate) — a genuine
  no-op. `nestedCaptures` is correctly *excluded* from the condition: it is only ever pushed inside
  `fanMultiSourceBranch`, which runs solely when a leg is fanned and whose `decompose` (a join
  update/delete) yields ≥1 base op — so a non-empty `nestedCaptures` always implies non-empty
  `baseOps`. Empty `baseOps`+`joinLegInserts` therefore genuinely means "nothing to run".
- **INSERT exclusion is real.** `buildFlaglessInsert` throws `consistent with no writable leg` on an
  empty decomposition before returning, so the insert path never reaches the guard with a real reject;
  the `req.op !== 'insert'` clause is defensive belt-and-suspenders, never load-bearing for a reject.
- **No-op is the idiomatic shape.** `SinkNode` over a zero-row source is *exactly* what a regular
  base-table DELETE/UPDATE root is (`delete.ts:341`, `update.ts:450`) — more consistent than a
  `ViewMutationNode` would have been. `block.ts` treats `Sink` as void, same as a void `ViewMutation`.
- **View dependency preserved.** `buildViewMutation` records the `view` schema dependency (line 74)
  *before* dispatching to `buildSetOpMutation`, so the no-op plan still invalidates on an
  `ALTER VIEW … SET TAGS` exactly like a real write.
- **Void relation type literal is complete** (`typeClass`/`isReadOnly`/`isSet`/`columns`/`keys`/
  `rowConstraints`, all empty/consistent) and matches `RelationType`. Attribute-less
  `EmptyRelationNode` under `SinkNode` survives the optimizer (empty-relation folding rules act on
  Filter/Project/Join/Sort, not Sink) — confirmed by the green full suite.
- **Return-type shape.** `buildViewMutation` now returns a `SinkNode` (not `ViewMutationNode`) on this
  path; both are valid void statement roots and the only downstream consumer (`block.ts`) keys on
  `nodeType === Sink` generically, not on `ViewMutation` specifically.

### Tests — adequate floor
Happy path (pin/fan), edge cases (same-axis contradiction both axes, off-grid value), error paths
(INSERT no-leg reject, RETURNING reject precedes short-circuit), regression (positive DELETE/UPDATE
beside the no-ops proving the guard does not swallow real writes), and the `intersect`/`except` fan
paths (contradictory base-column predicate) are all covered. Zero-leg UPDATE is exercised via the `PC`
off-grid `src='zzz'` case; zero-leg DELETE via both grid and intersect/except — the guard is
op-agnostic for non-insert, so coverage is sufficient.

### Findings disposition
- **Major:** none → no new tickets filed.
- **Minor (fixed inline):** none — the implementation is clean; no inline fixes were warranted.
- **Deliberately not done (documented, not a defect):**
  - *Membership-path no-op test.* The shared guard is provably **inert** for the `exists`-membership
    path: a membership delete/update fans to all branches and relies on the runtime member-exists
    filter, so a no-match write produces *non-empty* `baseOps` and no-ops at runtime today,
    independent of this fix — never reaching the guard. A dedicated test would exercise pre-existing
    runtime behavior, not the changed code path, so it was not added. (A belt-and-suspenders
    membership no-match-delete assertion could be added if desired, but is not required.)
  - *`op: string` parameter typing* on `buildNoOpMutationSink` could be narrowed to the
    `MutationRequest['op']` union, but `SinkNode.operation` is itself `string` and every other
    `SinkNode` call site passes a string literal — left consistent rather than introducing a local
    divergence.

### Docs — verified current
`docs/view-updateability.md` § Set Operations reflects the new reality: the projected-constant
discriminator idiom (with the pin/fan/no-op table) is documented as the recommended product surface,
the zero-leg no-op vs. INSERT-reject contrast is explained, and the two stale "shelved
`set-op-product-coordinate-model` (backlog)" mentions are reframed (the lone genuine out-of-scope
residue — writable boolean membership over a non-literal σ-guard the sat-checker returns `unknown` on
— is called out, reopen-if-needed). The one remaining `set-op-product-coordinate-model` reference is
intentional (explaining whose use case is now served), not a stale "will build" claim.

## Validation
- `yarn workspace @quereus/quereus lint` — green (exit 0; eslint + test tsc).
- `yarn workspace @quereus/quereus test` — green, **6330 passing**, 9 pending, 0 failing.
- Focused `93.6-set-op-flagless-write.sqllogic` — 1 passing.

No pre-existing failures surfaced; no `.pre-existing-error.md` written.
