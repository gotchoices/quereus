description: Review the Tier-A View Round-Trip Laws property block (PutGet / GetPut / forward-backward lineage agreement) added to property.spec.ts over the shipped single-source projection-and-filter view write-through path. Pure test code; no engine surface touched.
files: packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/architecture.md, tickets/.pre-existing-error.md

# What landed

A new `describe('View Round-Trip Laws', …)` block in
`packages/quereus/test/property.spec.ts` (section 16, immediately after § Key
Soundness), structured exactly like Key Soundness: pure positional/structural law
cores + a single negative self-test that proves each core reds on an injected
violation. It is the **backward-direction** soundness net — the dual of the
forward-direction Key Soundness block — over the shape the Phase-1 view-mutation
rewrite admits today (single-source projection-and-filter,
`building/view-mutation.ts` → `analysis/update-lineage.ts` →
`analysis/scalar-invertibility.ts`).

Implements Tier A of the `bx-operator-model-and-roundtrip-laws` spike, whose
canonical spec is `docs/view-updateability.md` § "Round-Trip Laws and the Derived
Backward Walk" (that section now carries a "Landed (Tier A)" back-reference; the
property-test catalog in `docs/architecture.md` was updated from its "(planned)"
placeholder to describe the landed block).

## The five `it`s

- **`the round-trip law cores fail loudly on injected violations`** — the negative
  self-tests (no DB). Feeds crafted-bad inputs to the two pure cores
  (`assertRowsEqual`, `assertLineageAgreement`) and asserts each throws; also asserts
  the honest case does not. This is the `checkNoOverClaim('injected', …)` analogue.
- **`computed view columns are read-only, and LIMIT/OFFSET/DISTINCT bodies reject
  rather than widen`** — deterministic behavioral. A write to a computed column reds
  with the `no-inverse` diagnostic (not silently dropped); the base column under it
  stays writable; `limit` / `limit…offset` / `distinct` bodies reject with
  `unsupported-limit` / `unsupported-distinct` (the write-widening regression made a
  law).
- **PutGet** (`numRuns: 50`) — for a generated insert/update/delete over the view-body
  zoo and random base seeds: the base post-state matches a predicate-honest JS oracle
  (rows outside the conjoined predicate are byte-identical / still present), and the
  post-state **view image** (`get(baseAfter)` over writable columns) matches what the
  view actually returns.
- **GetPut** (`numRuns: 50`, PK-exposing shapes only) — read a row, write its writable
  non-PK values back keyed on the view PK, assert the base table is unchanged.
- **forward/backward lineage agreement** (`numRuns: 50`) — plan the body standalone,
  then cross-check `deriveViewColumns` (backward) against `keysOf` / `isUnique`
  (forward): (A) every forward key column is `base`-writable; (B) a forward key traced
  to base columns + σ filter-constants reconstructs the base PK; (C) a fully-surviving
  base PK is advertised as a forward key.

## View-body zoo (shared by all three laws)

Base table `t(id integer primary key, a integer null, b integer null)`; shapes:
bare `select *`, explicit `id,a,b`, rename `id as vid…`, computed `b + 1 as bp`,
key-dropping `a, b`, and alias-qualified `select x.id as aid … from t as x`. Each is
optionally given an equality filter `where a = K`. The model for each shape is read
from the **real** `deriveViewColumns` surface (not hardcoded), so the block exercises
the shipped lineage, not a copy of it.

# How to validate

```
# the new block only
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/property.spec.ts" --grep "View Round-Trip Laws"

# whole property suite / package
yarn workspace @quereus/quereus run test
```

Done during implement:
- New block: 5 `it`s green; re-ran the `--grep` 5× → no flake.
- `yarn typecheck` (quereus): clean. `npx eslint test/property.spec.ts`: clean.
- `yarn workspace @quereus/quereus run test`: **3924 passing, 9 pending, 0 failing**.

# Honest gaps / things for the reviewer to probe (your tests are a floor)

- **The laws are TRUE by construction over a chosen zoo, not exhaustive.** I picked
  shapes + bounded the generators so the laws hold over shipped Phase-1 behavior (the
  spike's PoC posture: a red here is a genuine regression). A reviewer should confirm
  the zoo is *representative*, not that it's complete — multi-source / join / aggregate
  / set-op bodies are explicitly out of scope (the backward walk rejects them today;
  the substrate ticket extends this block).
- **Lineage law (C) leans on forward `isUnique` being complete enough** to recognize a
  fully-surviving base PK as a key. This held across the zoo + 5 reruns, but it is a
  soundness-vs-completeness edge: if a future forward-walk change stopped advertising a
  preserved single-column PK as a key, (C) would red. That is the intended signal, but
  worth a sanity read that (C) cannot false-fail on a legitimately-incomplete forward
  key set for these shapes. (B)/(A) are sound regardless.
- **σ filter-constants are hard-coded as `['a']`** in the lineage law (the zoo only
  filters on `a`), rather than re-extracted from the body WHERE. Faithful for this zoo;
  a reviewer extending the filter shapes must thread the real constant set.
- **PutGet oracle re-derives the predicate-honest rewrite in JS.** It catches widening
  and get∘put disagreement, but it is not an independent oracle of the *rewrite's*
  correctness — it encodes the same conjoin-the-filter model. The independent check is
  the view-image cross-read against the live engine.
- **PutGet INSERT** is exercised only on PK-exposing shapes (a PK is needed to mint the
  row); key-dropping inserts are `fc.pre`-discarded. INSERT also only supplies the `a`
  filter-column as a literal `= K` (avoiding the constant-FD-append / VALUES-source
  path) — the omitted-column constant-FD defaulting path (`93.4` GreenMen/AdultsBare)
  is **not** re-covered here as a property.
- **Computed-write rejection** asserts on `mutationDiagnostic.reason` when present and
  falls back to a message regex otherwise — confirm the structured reason is the one
  you want pinned.

# Pre-existing failure flagged (not mine)

The full-monorepo `yarn test` surfaced a 2000ms **timeout** in
`packages/quereus/test/property-planner.spec.ts` (a different file; resource
contention under the parallel run). It is green in isolation (27 passing, 46s) and in
the sequential package run. Documented in `tickets/.pre-existing-error.md` for the
triage pass; no workaround/skip was applied.
