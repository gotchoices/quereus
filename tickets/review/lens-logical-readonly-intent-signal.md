description: Review the per-logical-column writable-intent signal (`quereus.lens.writable`). The lens prover now hard-blocks at deploy an *opaque* column the author declared writable (`= true`), distinguishing a deliberate read-only/derived column (still admitted) from an authoring error (a writable-meant column whose `get` is non-invertible).
prereq:
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-compiler.ts, docs/lens.md, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts
----

## What was built

A new per-logical-column reserved tag `quereus.lens.writable` (boolean) supplies an **intent** input the round-trip prover previously lacked. The classification of an opaque output column in `proveRoundTrip` now keys off it:

- `= true`  ⇒ the author asserts a faithful write path is required; an opaque / non-invertible column carrying it becomes a **deploy error** (`lens.non-invertible`).
- `= false` / **absent** ⇒ conservative, unchanged behaviour — the opaque column is admitted as read-only (its write reds `no-inverse` at mutation time).

`computeRoundTrip` (the GetPut/PutGet predicate) and the single-source fragment gate are **untouched** — only the diagnostic-emitting wrapper gained the intent branch. The intent is a deploy-policy input, not a property of the body's complement, which is why it lives in `proveRoundTrip`, not `computeRoundTrip`.

### Changes by file

- **`reserved-tags.ts`** — added `'logical-column'` to the `TagSite` union; exported `LENS_WRITABLE_INTENT_TAG = 'quereus.lens.writable'`; added the spec entry (`valueSchema: 'boolean'`, `sites: siteSet('logical-column')`); added the `siteLabel` case; extended the `unknownReservedTag` suggestion list.
- **`lens-compiler.ts`** (`validateLensTags`) — added a loop validating **each logical column's** tags at the `logical-column` site. This also closes a pre-existing gap: a typo'd / mis-sited `quereus.*` key on a logical column was never validated before.
- **`lens-prover.ts`** (`proveRoundTrip`) — restructured the per-verdict `forEach` into two branches: (1) `v.writable && !v.faithful` (the original rule, unchanged) and (2) `!v.writable && intentWritable(ctx, column)` (new). Added the `intentWritable(ctx, column)` helper (resolves the logical column case-insensitively via `ctx.logicalColIndex`, reads `col.tags?.[LENS_WRITABLE_INTENT_TAG] === true`). `computeRoundTrip` / `roundTripObstruction` left untouched.
- **`docs/lens.md`** — § Computed and Generated Columns (the intent signal); § Coverage checklist round-trip row + "Round-trip detection" callout (two-branch firing rule + the degrade-to-safe gap); the reserved-tag namespace summary (added the key + site).

### Why the round-trip verdict, not `isReconstructibleColumn`

The intent branch keys off `v.writable` from `computeRoundTrip` (which classifies an invertible *composed* expression — `(speed + 1) - 2` — as writable via the invertibility registry), NOT `isReconstructibleColumn` (the bare-column test, which would flag `(speed + 1) - 2` as non-reconstructible and **false-fire**). This is the subtle correctness point — see the no-false-fire test.

## How to validate

```
yarn workspace @quereus/quereus typecheck
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/lens-prover.spec.ts" "packages/quereus/test/schema/reserved-tags.spec.ts" --colors
yarn workspace @quereus/quereus test          # full suite
yarn workspace @quereus/quereus lint
```

Status at handoff: typecheck **clean**; targeted specs **104 passing**; full quereus suite **5076 passing, 9 pending, 0 failing** (the property harness § View Round-Trip Laws is green — `computeRoundTrip` was untouched); lint **clean**.

## Use cases / scenarios covered (tests)

`test/lens-prover.spec.ts` (round-trip describe):
- **blocks** — `upper(who) as label`, `label` tagged `= true` ⇒ `apply schema` THROWS `lens.non-invertible`.
- **still admits (no tag)** — the pre-existing `:729` opaque-column test stays green (regression guard).
- **explicit read-only** — same body, `= false` ⇒ deploys clean, `label` read-only.
- **no false-fire on invertible chain** — `(speed + 1) - 2 as adjusted`, tagged `= true` ⇒ deploys writable, write round-trips (`adjusted=5` stores `speed=6`, reads back 5).
- **degrade-to-safe** — opaque writable-intent column in a two-table join body ⇒ deploys without `lens.non-invertible`, then reds at mutation time.
- **non-reconstructible PK + writable intent** — PK mapped to `speed * speed` (opaque) and tagged `= true` ⇒ deploys THROWS `lens.non-invertible` (the error wins over the read-only `pk-not-reconstructible` warning).

`test/schema/reserved-tags.spec.ts`:
- `= true` valid at `logical-column`; `= 'yes'` ⇒ `invalid-tag-value`; mis-site at `logical-table` / `logical-constraint` / `physical-column` ⇒ `tag-not-allowed-here`; a typo ⇒ `unknown-reserved-tag`.
- Updated the `RESERVED_TAGS` length expectation 17 → 18 and the "seeds all documented keys" assertion.

## Known gaps / things for the reviewer to probe (your work is a floor, not a finish line)

1. **No explicit export → re-apply round-trip test for the tag.** The ticket called for confirming a re-applied *exported* logical schema preserves the signal (and thus still blocks). The plumbing is in place — `ddl-generator.ts` `formatColumnDef` emits column tags (line ~314) and `columnDefToSchema` threads `def.tags → schema.tags` — and the existing `declarative-equivalence.spec.ts` covers column tags *generically*, but **I did not add a lens-specific test** that exports a logical schema carrying `quereus.lens.writable`, re-parses/re-applies it, and asserts it still throws. Worth closing.
2. **Degrade-to-safe is tested only for the join shape.** The completeness gap (out-of-fragment ⇒ no deploy-block, reds at mutation time) is exercised for a two-table join. The other out-of-fragment shapes the gate rejects (aggregate / set-op / VALUES / recursive-CTE / LIMIT / OFFSET / DISTINCT) are **not** individually tested with a writable-intent tag — they rely on the existing fragment-gate tests plus the join case. This gap is intentional and documented, but the reviewer may want one more shape (e.g. DISTINCT or aggregate) for confidence.
3. **The signal belongs on the logical *column declaration*, not the override projection.** `intentWritable` reads `slot.logicalTable.columns[i].tags`, which is populated from the `declare logical schema` column DDL. A tag placed on the override view's result column (`select … as label with tags (…)`) would NOT be read here (and would validate at the `projection` site, where the key is not allowed → `tag-not-allowed-here`). No test pins this distinction; consider one if it matters for authoring ergonomics.
4. **Multiple opaque writable-intent columns** emit one error each (the `forEach`), but this is not explicitly tested with 2+ tagged columns in one table.
5. **Case-insensitive column-name lookup** is implemented (`logicalColIndex` is lowercased) but not pinned by a mixed-case test.
6. **`= false` is documentation-only** (same behaviour as absent). Confirmed by the explicit-read-only test, but note there is intentionally no distinct runtime effect for `false` vs absent — only `=== true` fires.
