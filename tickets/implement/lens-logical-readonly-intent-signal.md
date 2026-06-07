description: Add a per-logical-column "writable intent" signal (reserved tag `quereus.lens.writable`) so the lens prover can hard-block at deploy an *opaque* column the author declared writable — distinguishing a deliberate derived/read-only column (admitted, as today) from a column meant to be writable whose `get` is non-invertible (an authoring error).
prereq:
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/column.ts, docs/lens.md, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts
----

## Summary

The round-trip prover (`proveRoundTrip` in `lens-prover.ts`) today fires
`lens.non-invertible` **only** for a column the lens *presents as writable* (a
`base` `ResolvedBaseSite`) whose round-trip it cannot prove faithful. An
*opaque*/`computed` output column (e.g. `upper(who) as label`) emits nothing —
it is treated as an intentional read-only/derived column (sound, no over-block;
its write reds `no-inverse` at mutation time). That is correct **but it cannot
tell apart** two authoring situations that look identical at the logical layer:

1. a column the author *meant* to be derived/read-only (the documented pattern), and
2. a column the author *meant* to be writable but whose body is non-invertible —
   an authoring mistake that today is silently accepted as read-only.

This ticket adds the missing **intent** input: a per-logical-column reserved tag
`quereus.lens.writable`. Absent ⇒ today's conservative behaviour (opaque ⇒
admitted read-only). `= true` ⇒ the author asserts this column must have a
faithful write path, so an opaque/non-faithful column carrying it becomes a
deploy error (`lens.non-invertible`). `= false` ⇒ explicit read-only/derived
intent (documentation; same behaviour as absent).

The `computeRoundTrip` GetPut/PutGet predicate and the single-source fragment
gate are **unchanged** — only the *classification* of an opaque column in
`proveRoundTrip` gains the intent input.

## Why a reserved tag (design decided)

`ColumnSchema.tags` already exists (`column.ts`), the parser already parses
column-level `WITH TAGS` (`parser.ts` `columnDefinition`), `columnDefToSchema`
already threads `def.tags → schema.tags` (`table.ts:281`), and the DDL generator
already emits column tags (`ddl-generator.ts:314`). So a logical column's
`WITH TAGS` reaches `slot.logicalTable.columns[i].tags` and survives
export/round-trip with **zero new plumbing**. Using the reserved-tag registry
keeps the signal version-controlled, visible in review, and consistent with the
lens layer's "intent in the declaration" stance (the same channel as
`quereus.lens.ack.*` / `quereus.lens.policy.*`).

Rejected alternatives: a dedicated `read only` / `generated as` SQL modifier
(there is deliberately *no* `generated as` at the logical layer — a column is
"generated" precisely when its body computes it with no inverse;
`docs/lens.md` § Computed and Generated Columns), and a new field on
`ColumnSchema` (the tag namespace is the established intent surface; a field
would duplicate it).

## Design

### The tag

A boolean reserved tag valid only at a new `logical-column` site:

```
quereus.lens.writable : boolean   @ logical-column
```

- `true`  — the author asserts a faithful write path is required.
- `false` — explicit read-only/derived intent (no behaviour change vs absent).
- absent  — conservative default: opaque ⇒ admitted read-only (today's behaviour).

Add `LENS_WRITABLE_INTENT_TAG = 'quereus.lens.writable'` as an exported const in
`reserved-tags.ts`; the prover imports it (single source of truth, no string
drift). The stored value is a real JS boolean after validation
(`validateTagValue`'s `'boolean'` schema), so the prover tests `=== true`.

### Site model (`reserved-tags.ts`)

- Add `'logical-column'` to the `TagSite` union (alongside `logical-table` /
  `logical-constraint`). It is distinct from `physical-column`: the latter is the
  basis/declared-table differ position; `quereus.lens.writable` is meaningful
  **only** on a logical column, so a dedicated site gives correct mis-site
  rejection in both directions.
- Add the spec entry to `RESERVED_TAG_SPECS` (`valueSchema: 'boolean'`,
  `sites: siteSet('logical-column')`).
- Add the `siteLabel` case (`'logical-column' → 'a logical column'`).
- Extend the `unknownReservedTag` suggestion string to list the new key.

### Validation wiring (`lens-compiler.ts` `validateLensTags`)

Currently validates `logical-table` and `logical-constraint` tags only. Add a
loop validating **each logical column's** tags at the `logical-column` site:

```ts
for (const col of slot.logicalTable.columns) {
  if (col.tags) diagnostics.push(...validateReservedTags(col.tags, 'logical-column'));
}
```

This also closes a pre-existing gap (a typo'd/mis-sited `quereus.*` key on a
logical column is currently never validated). Severity policy is unchanged
(shared `raiseReservedTagDiagnostics`): an error throws atomically before catalog
mutation; warnings log.

### Prover classification (`lens-prover.ts` `proveRoundTrip`)

`computeRoundTrip` already returns one `ColumnRoundTrip` per output column (or
`undefined` to degrade-to-safe). Extend ONLY the per-column emission loop in
`proveRoundTrip`:

- existing: `v.writable && !v.faithful` ⇒ `lens.non-invertible` (unchanged).
- **new**: `!v.writable && intentWritable(column)` ⇒ `lens.non-invertible` with a
  distinct message: the column is declared writable (`quereus.lens.writable`) but
  its lens body is computed/opaque with no invertible write path — the round-trip
  law's stronger reading makes this an authoring error, not a derived column.
- `!v.writable && !intentWritable` ⇒ nothing (admit; today's behaviour).

`intentWritable(column)` resolves the logical column from the output-column name
(`ctx.outputColumns[i]`) via `ctx.logicalColIndex`, then reads
`col.tags?.[LENS_WRITABLE_INTENT_TAG] === true`. Keep `computeRoundTrip` and
`roundTripObstruction` untouched — the intent is a deploy-policy input, not a
property of the body's complement, so it belongs in the diagnostic-emitting
wrapper.

**Soundness / degrade-to-safe.** When `computeRoundTrip` returns `undefined`
(body fails to plan, out of the single-source projection-and-filter fragment,
lineage not threaded, or non-negation-free residual), there are no per-column
verdicts and the intent block does **not** fire — consistent with the prover's
soundness-over-completeness principle. Such a writable-intent column still reds
`no-inverse` at mutation time, exactly as today. This completeness gap is
intentional; document it.

**Why the round-trip verdict, not `isReconstructibleColumn`.** The intent block
keys off `v.writable` from `computeRoundTrip` (which classifies an invertible
*composed* expression — `(speed + 1) - 2` — as writable via the invertibility
registry), **not** `isReconstructibleColumn` (the bare-column test, which would
flag `(speed + 1) - 2` as non-reconstructible and FALSE-FIRE the intent block).
Using the verdict is what keeps the invertible-chain column (its own passing
test at `lens-prover.spec.ts:669`) from regressing when tagged writable.

## Edge cases & interactions

- **Opaque column + `writable=true`, in-fragment body** (the core new case): e.g.
  `upper(who) as label`, `label` tagged writable ⇒ deploy THROWS `lens.non-invertible`.
- **Opaque column + no tag** ⇒ admit read-only (unchanged; the existing
  `lens-prover.spec.ts:729` test must stay green).
- **Opaque column + `writable=false`** ⇒ admit read-only (explicit documentation,
  no error).
- **Invertible composed column (`(speed+1)-2`) + `writable=true`** ⇒ NO error
  (`v.writable && v.faithful`); the write still round-trips. Guards against
  false-fire.
- **Bare/renamed column + `writable=true`** ⇒ no error (writable & faithful).
- **Writable-presented but unfaithful column + `writable=true`** ⇒ existing error
  path fires (the new branch is only for `!v.writable`); no double-emit.
- **Out-of-fragment body (join / aggregate / set-op / VALUES / recursive-CTE /
  LIMIT / OFFSET / DISTINCT) + `writable=true` on an opaque column** ⇒
  degrade-to-safe, NO deploy error; reds at mutation time. (Mirror the existing
  join / `<>`-residual no-over-block tests.)
- **`writable=true` on a non-reconstructible PK column** ⇒ the table is read-only
  (`lens.pk-not-reconstructible` warning from `checkKeyReconstructibility`) AND
  the intent block errors on that column. The error blocks the deploy (more
  informative than silent read-only). Both channels may carry an entry; that is
  acceptable (warning vs error, error wins). Add a test asserting the deploy
  throws `lens.non-invertible`.
- **Bad value: `quereus.lens.writable = 'yes'`** (TEXT, not boolean) ⇒
  `invalid-tag-value` error via the `'boolean'` schema.
- **Mis-site**: `quereus.lens.writable` on a logical *table* / *constraint*, or on
  a physical (basis) column ⇒ `tag-not-allowed-here` error.
- **Unknown key** on a logical column (e.g. `quereus.lens.writabl`) ⇒
  `unknown-reserved-tag` error (newly reachable now that logical columns are
  validated — confirm no existing logical-schema test accidentally relies on an
  unvalidated `quereus.*` column tag).
- **Case-insensitivity**: logical column-name lookup in the prover must lowercase
  (reuse `ctx.logicalColIndex`).
- **Multiple opaque writable-intent columns**: one `lens.non-invertible` per
  column (the existing `forEach` over verdicts).
- **Export/DDL round-trip**: a logical column's `WITH TAGS (...)` survives
  `formatColumnDef` (`ddl-generator.ts:314`); confirm a re-applied exported logical
  schema preserves the signal (and thus still blocks).
- **Atomicity**: validation and proving both run in the lens compiler's
  compile-first loop before catalog mutation, so a thrown error leaves prior lens
  state untouched (existing property — no new wiring).

## Docs

Update `docs/lens.md`:
- § **Computed and Generated Columns** — note the intent signal: a computed
  column is read-only by default; `quereus.lens.writable = true` declares it
  *must* be faithfully writable, turning a non-invertible body into a deploy
  error rather than a silent read-only column.
- § **Coverage checklist** → the round-trip row / "Round-trip detection" callout
  — extend the firing rule: `lens.non-invertible` now also fires for an opaque
  column carrying `quereus.lens.writable = true`; the default (absent/`false`)
  preserves the no-over-block admit. Note the degrade-to-safe gap (out-of-fragment
  bodies do not deploy-block; they red at mutation time).
- The reserved-tag table / namespace summary that lists `quereus.lens.*` keys —
  add `quereus.lens.writable` (boolean, logical-column site).

## Tests

`packages/quereus/test/lens-prover.spec.ts` (extend the round-trip describe):
- **blocks**: `upper(who) as label` with `label int null with tags ("quereus.lens.writable" = true)`
  ⇒ `apply schema x` THROWS `/lens\.non-invertible|writable|no.?invertible/`. (Mirror
  the structure of the `:729` over-block test, adding the tag.)
- **still admits (no tag)**: the existing `:729` case stays green (regression
  guard) — opaque `label` with no intent tag deploys read-only.
- **explicit read-only**: same body with `"quereus.lens.writable" = false`
  deploys clean, `label` read-only.
- **no false-fire on invertible chain**: `(speed + 1) - 2 as adjusted` with
  `adjusted ... with tags ("quereus.lens.writable" = true)` deploys writable, no
  error, and the write still round-trips (extends the `:669` test).
- **degrade-to-safe**: an opaque writable-intent column inside a two-table join
  body deploys without `lens.non-invertible` (out-of-fragment), then reds at
  mutation time.
- **non-reconstructible PK + writable intent**: PK column mapped to a computed
  expression and tagged writable ⇒ deploy THROWS `lens.non-invertible`.

`packages/quereus/test/schema/reserved-tags.spec.ts`:
- `quereus.lens.writable = true` valid at `logical-column`; `= 'yes'` ⇒
  `invalid-tag-value`; same key at `logical-table` / `physical-column` ⇒
  `tag-not-allowed-here`; a typo at `logical-column` ⇒ `unknown-reserved-tag`.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens-test.log; tail -n 60 /tmp/lens-test.log`
and `yarn workspace @quereus/quereus lint` (single-quote globs on Windows). The
round-trip property harness (`test/property.spec.ts` § View Round-Trip Laws)
should be unaffected — `computeRoundTrip` is untouched — but confirm it passes.

## TODO

- `reserved-tags.ts`: add `'logical-column'` to `TagSite`; add the
  `quereus.lens.writable` spec (`'boolean'`, `siteSet('logical-column')`); add the
  `siteLabel` case; export `LENS_WRITABLE_INTENT_TAG`; extend the
  `unknownReservedTag` suggestion list.
- `lens-compiler.ts` `validateLensTags`: validate each logical column's tags at
  the `logical-column` site.
- `lens-prover.ts` `proveRoundTrip`: add the `!v.writable && intentWritable` branch
  emitting `lens.non-invertible` with a distinct message; add the
  `intentWritable(column)` helper (resolve via `ctx.logicalColIndex`, read
  `col.tags?.[LENS_WRITABLE_INTENT_TAG] === true`). Leave `computeRoundTrip` /
  `roundTripObstruction` untouched.
- Update `docs/lens.md` (three sections above).
- Add the prover tests and reserved-tag tests above.
- Run the quereus test suite + lint; confirm the property harness still passes.
