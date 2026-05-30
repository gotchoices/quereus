description: Tier-A View Round-Trip Laws property block (PutGet / GetPut / forward-backward lineage agreement) over the shipped single-source projection-and-filter view write-through path. Pure test code + doc sync; no engine surface touched. Reviewed and completed.
files: packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/architecture.md, docs/optimizer.md

# What landed

A `describe('View Round-Trip Laws', …)` block in
`packages/quereus/test/property.spec.ts` (§ 16, after Key Soundness) — the
**backward-direction** soundness net dual to the forward-direction Key Soundness
block, over the single-source projection-and-filter shape the Phase-1 view-mutation
rewrite admits today (`building/view-mutation.ts` → `analysis/update-lineage.ts` →
`analysis/scalar-invertibility.ts`). Implements Tier A of the
`bx-operator-model-and-roundtrip-laws` spike (canonical spec:
`docs/view-updateability.md` § "Round-Trip Laws and the Derived Backward Walk").

Five `it`s: a negative self-test (the law cores red on injected violations), a
deterministic computed-read-only + LIMIT/OFFSET/DISTINCT-reject test, and three
`numRuns: 50` property laws — **PutGet** (a mutation never escapes the view
predicate; post-state view image cross-read against the base), **GetPut** (writing
read values back is a base no-op), and **forward/backward lineage agreement**
(`deriveViewColumns` backward vs `keysOf`/`isUnique` forward). Shared view-body zoo:
bare `select *`, explicit/rename projection, computed column, key-dropping, and
alias-qualified bodies, each optionally equality-filtered on `a`.

Docs synced: `architecture.md` test catalog (planned → landed), `view-updateability.md`
"Landed (Tier A)" back-reference, and (added in review) `optimizer.md` § Singleton
equivalence, which still called the harness "planned".

# Review findings

## What was checked

- **Read the implement diff (`b3da761e`) first**, then the engine surfaces the test
  actually leans on: `deriveViewColumns` (update-lineage), `classifyProjectionExpr`
  (scalar-invertibility), `keysOf` / `isUnique` / `deriveKeysFromFds` / `isSuperkey`
  (fd-utils), the view-mutation rewrite + diagnostics (`view-mutation.ts`,
  `mutation-diagnostic.ts`, `propagate.ts`), and the Key Soundness block the new one
  mirrors.
- **Validation**: ran the new block in isolation (5 passing), the full
  `property.spec.ts` (50 passing), `yarn typecheck` (clean), `eslint test/property.spec.ts`
  (clean). Re-ran the new block after edits — still green.
- **Adversarial angles**: vacuity / false-pass robustness of each law, `fc.pre`
  discard pressure, oracle independence, positional alignment between the backward
  model and the forward plan output, branch coverage of the assertion cores, doc
  drift, and the flagged pre-existing failure.

## Findings — fixed inline (minor)

1. **Law (B)'s throw branch was dead code.** `assertLineageAgreement`'s "forward key
   does not reconstruct base PK" branch was exercised by *neither* the negative
   self-test *nor* any real property run (every forward key in the zoo traces to
   `id`, and `basePk` is `['id']`, so the branch can never fire on shipped shapes).
   A soundness assertion never shown to red is unverified. **Fixed**: added an
   `injected-unreconstructed-pk` self-test pinning that branch (key traces to `a`
   only, base PK `id`, no filter constant → must throw `/does not reconstruct base PK/`).

2. **Positional model↔plan alignment was only arity-checked.** The lineage law feeds
   model-derived column indices straight into `isUnique` (law C), which reads them as
   *forward-output* indices — a name/order skew between `deriveViewColumns` and the
   plan output would silently check the wrong columns while staying green. The code
   only asserted `model.length === cols.length` (its own comment claimed
   "column-aligned"). **Fixed**: added an exact positional name-agreement assertion
   (`model[i].name ≡ cols[i]`, case-insensitive) so future ordering drift reds loudly.

3. **`docs/optimizer.md` § Singleton equivalence still called the harness "planned".**
   The implementer synced `architecture.md` and `view-updateability.md` but missed
   this third reference, which described the now-shipped block as the "planned
   `bx-roundtrip-law-harness`". **Fixed**: updated to point at the landed **View
   Round-Trip Laws** block.

## Findings — not actioned (with reasons)

- **No major findings → no new fix/plan/backlog tickets filed.** The handoff's honest
  gaps are all *coverage scoping* of a deliberately by-construction PoC law harness,
  not correctness defects, and the substrate work that widens them is already
  ticketed:
  - *Zoo is representative, not exhaustive* (multi-source / join / aggregate / set-op
    bodies out of scope; the backward walk rejects them today) — extended by
    `view-mutation-plan-node-substrate`, which the docs already name as the consumer
    that threads each operator's backward method against this same block.
  - *`filterConstBase` hard-coded as `['a']`* — faithful for a zoo that only filters
    on `a`; the maintenance hazard is documented in-code, and the substrate ticket
    must re-extract the real constant set when it widens the filter shapes. Not worth
    pre-generalizing now.
  - *PutGet INSERT only on PK-exposing shapes, supplies only the `a` filter-column,
    skips the constant-FD-append / VALUES-default path* — the omitted-column defaulting
    path is already covered by the `93.x` view-mutation logic corpus; re-covering it as
    a property here is additive, not a gap in the shipped law.
  - *PutGet oracle re-encodes the conjoin-the-filter model in JS* (not an independent
    rewrite oracle) — acknowledged; the independent leg is the view-image cross-read
    against the live engine, which is present and exercised.

- **`expectReject` message-regex fallback is dead in practice.** Every rejection
  routes through `raiseMutationDiagnostic` → `ViewMutationError`, which always carries
  `.mutationDiagnostic.reason`, so the strict `reason`-equality branch always runs and
  the three SQLs pin `no-inverse` / `unsupported-limit` / `unsupported-distinct`
  exactly (confirmed green). The fallback is harmless defensive code; left as-is.

- **GetPut `fc.pre` discard pressure** — with up to 10 rows and an optional filter,
  the read-then-writeback body executes on the large majority of the 50 runs; not a
  vacuity risk in practice. Left as-is.

## Pre-existing failure

The implementer flagged a 2000ms timeout in `property-planner.spec.ts` (a different
file; resource contention under the parallel full-monorepo run; green in isolation
and in the sequential package run). That `tickets/.pre-existing-error.md` was already
consumed by the runner's triage pass (commit `4423eae7`), so nothing remains to flag
here.

# Validation (final state)

- `node --import ./packages/quereus/register.mjs mocha "packages/quereus/test/property.spec.ts" --grep "View Round-Trip Laws"` → **5 passing**.
- Full `property.spec.ts` → **50 passing**.
- `yarn typecheck` (quereus) → clean. `eslint test/property.spec.ts` → clean.
