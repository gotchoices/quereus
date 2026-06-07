description: Per-logical-column writable-intent signal (`quereus.lens.writable`). The lens prover hard-blocks at deploy an *opaque* column the author declared writable (`= true`), distinguishing a deliberate read-only/derived column (still admitted) from an authoring error (a writable-meant column whose `get` is non-invertible). Reviewed and completed.
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-compiler.ts, docs/lens.md, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts
----

## What shipped

A per-logical-column reserved tag `quereus.lens.writable` (boolean) supplies the *intent* input the round-trip prover lacked. In `proveRoundTrip`, the per-verdict classification now has two firing branches:

1. `v.writable && !v.faithful` — the original rule (a column the lens presents as writable whose round-trip cannot be proved faithful), unchanged.
2. `!v.writable && intentWritable(ctx, column)` — **new**: an opaque/read-only output column the author declared writable (`= true`) becomes a deploy error (`lens.non-invertible`) instead of a silent read-only admit.

`= false` / absent preserve the conservative admit-as-read-only behaviour. `computeRoundTrip` / `roundTripObstruction` (the GetPut/PutGet predicate and the single-source fragment gate) are untouched — the intent is a deploy-policy input layered in the diagnostic wrapper, so it keys off the round-trip *verdict* (`v.writable`, which admits an invertible *composed* expression like `(speed + 1) - 2`), not the bare-column `isReconstructibleColumn` test — which avoids a false-fire on invertible chains.

Supporting changes:
- **`reserved-tags.ts`** — new `'logical-column'` `TagSite`; exported `LENS_WRITABLE_INTENT_TAG`; spec entry (`valueSchema: 'boolean'`, `logical-column` site); `siteLabel` case; suggestion-list entry.
- **`lens-compiler.ts`** (`validateLensTags`) — validates each logical column's tags at the `logical-column` site (runs inside the compile-first loop, before catalog mutation → atomic). This also closed a pre-existing gap: a typo'd / mis-sited `quereus.*` key on a logical column was never validated before.
- **`docs/lens.md`** — § Computed and Generated Columns (intent signal), § Coverage checklist (two-branch firing rule + degrade-to-safe gap), reserved-tag namespace summary (key + site).

## Review findings

Adversarial pass over commit `64427142`. Read the full implement diff first, then verified against the live code paths.

### Verified correct (checked, no change needed)
- **Two-branch firing logic** (`lens-prover.ts:541-570`) — branch 1 unchanged; branch 2 fires only for `!v.writable && intentWritable`. An invertible chain is `v.writable && v.faithful` ⇒ neither branch fires (intent satisfied). A genuinely-writable-but-unfaithful column hits branch 1 regardless of intent. Correct.
- **Boolean type-safety seam** — `validateTagValue`'s `'boolean'` case requires `typeof value === 'boolean'` (`reserved-tags.ts:467-470`); `intentWritable` reads `=== true` (`lens-prover.ts:583`); the AST stringifier re-emits a real boolean (`ast-stringify.ts:1355`). The three agree end-to-end, so the tag cannot be silently coerced to `1`/`"true"` and miss. Pinned by a new export-round-trip assertion.
- **`intentWritable` resolution** — looks up `ctx.logicalColIndex` (lowercased keys, built from `ctx.table.columns`) then reads `ctx.table.columns[li].tags` — same column array, consistent. The positional `column = outputColumns[i] ?? v.name` aligns with the verdict order (both derive from the projection list in attribute order), so the name-based intent lookup and the positional verdict refer to the same column.
- **Degrade-to-safe** — when `computeRoundTrip` returns `undefined` (out of fragment / lineage not threaded / non-negation-free residual), `proveRoundTrip` returns `[]`; with no verdicts, neither branch fires. The documented completeness gap (out-of-fragment opaque writable-intent column does not deploy-block, still reds at mutation time) holds structurally.
- **Atomicity / wiring** — `validateLensTags` and `proveLens` run in the compile-first loop before any catalog mutation; errors aggregate and throw atomically (`lens-compiler.ts:193`, `formatProveErrors`). A blocked deploy leaves no report.
- **Docs** — re-read every changed file against the prose; the § Computed and Generated Columns intent paragraph, the two-branch Round-trip detection callout, and the namespace summary (`quereus.lens.writable` — boolean, logical column) match the code.
- **Type-laziness / DRY / SPP** — no `any`; `LENS_WRITABLE_INTENT_TAG` constant avoids re-spelling the literal; `intentWritable` is a small single-purpose helper; tests use `try/finally db.close()`.

### Minor — fixed inline (this pass)
Added three tests to `test/lens-prover.spec.ts` (round-trip describe) closing the highest-value coverage gaps the implementer flagged:
- **Export round-trip** (handoff gap #1, explicitly in ticket scope) — exports both the `declare logical schema` and the `declare lens` through `astToString` (the schema-export path: `columnDefToString → tagsClauseToString → tagValueToString`), asserts the boolean tag re-emits as `= true`, and re-applies the round-tripped text into a fresh DB → still throws `lens.non-invertible`.
- **Case-insensitive lookup** (gap #5) — a mixed-case `"Label"` writable-intent column still blocks; a regression dropping `intentWritable`'s `.toLowerCase()` would silently admit it read-only.
- **Multiple opaque writable-intent columns** (gap #4) — two tagged opaque columns ⇒ one error each, aggregated into `blocked by 2 error(s)`, and no report left behind (atomicity).

### Minor — assessed, no action (documented rationale)
- **Other out-of-fragment shapes** (gap #2) — degrade-to-safe is exercised for the two-table join shape; the remaining shapes (aggregate / set-op / VALUES / recursive-CTE / LIMIT / OFFSET / DISTINCT) are guarded by the existing fragment-gate tests and the structural `verdicts === undefined ⇒ []` path. Adding one more shape would be marginal; not worth the duplication.
- **Tag on the override projection vs the logical column declaration** (gap #3) — by design the signal reads the logical column declaration (`ctx.table.columns[...].tags`). A tag placed on an override view's result column lives at the distinct `projection` site, where `quereus.lens.writable` is not allowed ⇒ `tag-not-allowed-here`. This is correct (not a bug); it is a deliberate authoring-locus decision, already noted in the handoff.
- **`= false` is documentation-only** — same runtime behaviour as absent; the explicit-read-only test confirms it. Intentional.

### Major — none
No correctness, soundness, or design defects warranting a new fix/plan/backlog ticket. The completeness gap is intentional and the mutation-time net still governs.

## Validation (all green after the inline test additions)
- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus test` — **5079 passing, 9 pending, 0 failing** (was 5076; +3 new tests). The property harness § View Round-Trip Laws stays green (`computeRoundTrip` untouched).
- `yarn workspace @quereus/quereus lint` — clean.
- Targeted `lens-prover.spec.ts` round-trip describe: 12 passing (9 original + 3 new); `reserved-tags.spec.ts`: green.
