description: Make the lens prover's `proveRoundTrip` seam a computed deploy-time GetPut/PutGet predicate over the view-complement object, for the single-source projection-and-filter fragment, agreeing with the operational round-trip harness and degrading to the safe verdict outside it.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Goal

Replace the encapsulated no-op `proveRoundTrip(ctx)` stub (`schema/lens-prover.ts:493`,
`return []`) with a **computed deploy-time predicate** over the predicate-honest
complement, closing the lens prover's round-trip seam for the fragment the
complement currently covers (single-source projection-and-filter). Today the
round-trip laws are enforced only *operationally* — non-invertibility reds at
mutation time via view-updateability's `no-inverse` diagnostic, and a
non-reconstructible key via `checkKeyReconstructibility`. Because Quereus resolves
the Bancilhon–Spyratos ambiguity by predicate-honest fan-out, the complement is
**determined, not chosen**, which makes GetPut/PutGet *decidable* for the supported
fragment with no theorem prover. We compute them at deploy.

This is purely a tightening of an existing, already-encapsulated seam: `proveLens`
already calls `errors.push(...proveRoundTrip(ctx))`. No call-site or wiring change
is needed beyond the body of `proveRoundTrip` (plus the logical-plan helper it
needs). The diagnostic surface (`lens.non-invertible`, sited `{table, column}`)
already exists in `LensErrorCode` and is thrown atomically before catalog mutation
by the compile-first loop (`lens-compiler.ts:235`).

## Architecture

### The two laws as complement predicates

`viewComplement(node)` (`analysis/view-complement.ts`) exposes the complement as
`{ hiddenColumns, residualPredicate? }`: the projected-away base columns (present
in a base relation, absent from the view image) plus the conjunction of the body's
σ predicates, carried verbatim (no normalization — an out-of-envelope `not`/`<>`
conjunct is passed through as-is, which is the signal that the complement is *not*
honestly determined). With it the round-trip check becomes computed:

- **GetPut** ("read a row, write the same values back → base unchanged") holds iff
  `put` leaves the complement **fixed**: no writable column's backward write path
  touches a base column the complement lists as hidden, and the residual predicate
  is invariant under the write-back. Over the single-source projection-filter
  fragment this holds *structurally* — writable columns map to in-image base
  columns and a write-back stores the same value — so the check is the guard that
  reds the day a shape (or a future fragment) violates it.
- **PutGet** ("write a value through the view, read it back → get the written
  value") holds iff, for every column the lens presents as **writable** (a `base`
  `UpdateSite` — identity / passthrough / inverse, read via `resolveBaseSite`), the
  composed `get ∘ put` is the identity on the writable value, and any `domain`
  restriction the column's inverse carries is **entailed by the residual
  predicate** (else a value admitted by the view could be stored that `get` cannot
  reproduce). For the shipped law-gated registry (`x ± k`, unrestricted domain;
  identity / passthrough / no-op cast) this is faithful by construction, so it
  emits nothing today — it is the seam that stays correct as the registry grows a
  domain-restricted or composed profile.

### The firing rule for `lens.non-invertible`

`lens.non-invertible` (severity `error`) is emitted **only** for a column the lens
**presents as writable** (resolves to a `base` `UpdateSite`) whose round-trip the
analysis cannot prove faithful — the genuine GetPut/PutGet violation. It is sited
`{ table, column }` and names the obstructing operator, reusing the same vocabulary
as the mutation-time `no-inverse` diagnostic so the two verdicts read identically.

**A `computed`/opaque output column is NOT a deploy error.** In the lens model a
computed column is an intentional derived/read-only column (there is no
`generated as` at the logical layer — `docs/lens.md` § Computed and Generated
Columns; the `upper(who) as label` example is read-only and *legitimate*). It is
**outside** the writable fragment, so the laws impose no obligation on it and it
emits no `lens.non-invertible`. This is the conservative reading mandated by the
prover's governing principle (soundness over completeness — "a false error blocks a
sound deploy") and by expected-behaviour #3 (no over-block).

> **Design decision (documented tradeoff).** Ticket seed test #2 reads "an opaque-
> step computed column *declared writable* is rejected at apply schema." We
> interpret "declared writable" as *the lens presents a write path* (a `base`
> site), **not** "any override column with an opaque step" — because the latter
> would hard-block the documented, sound `upper(who) as label` derived-column
> pattern and contradict the no-over-block requirement. Under our rule an opaque
> column is faithfully read-only (its write reds `no-inverse` at mutation time, as
> today); the deploy error fires for the genuinely-unfaithful *writable* case. The
> operational harness is the oracle (seed test #1): it rejects computed-column
> *writes*, never *deploys* a computed-column body, so per-column agreement is the
> sound reading. If the project later wants opaque columns in a name-matched
> (would-be-writable) position to hard-block at deploy, that needs a read-only/
> generated *intent* signal at the logical layer — out of scope here; see the
> backlog note below.

### Degrade-to-safe (no spurious error)

`proveRoundTrip` returns `[]` (the safe verdict, today's behaviour preserved)
whenever the complement cannot characterize the body — so the existing
mutation-time / key-reconstructibility nets still govern:

- the body fails to plan, or is not the single-source projection-and-filter shape
  the complement covers (multi-source / join / aggregate / set-op / `VALUES` /
  recursive-CTE / `LIMIT`/`OFFSET`/`DISTINCT`);
- `updateLineage` is absent on the planned root (lineage not threaded);
- the residual predicate is present but **not negation-free** (carries
  `not`/`<>`/`is not` — `viewComplement` carries these verbatim; their presence
  means the complement is not honestly determined).

### Planning the body — read the LOGICAL tree, not `ctx.root`

`viewComplement` walks the tree for `FilterNode` / `TableReferenceNode` instances
and reads `node.physical.updateLineage`. `ProveContext.root` is the **optimized**
body (`db.getPlan(astToString(body))`), where structure-rewriting operators
(physical joins, fused seeks) can drop both the Filter/TableReference structure and
the threaded `updateLineage` (`docs/view-updateability.md` § The Update Site Model,
surface-authority note). `proveRoundTrip` must therefore plan the body
**logically** — the same path `view_info`/`column_info` and the mutation substrate
use (`buildSelectStmt(ctx, sel)` in `planner/mutation/backward-body.ts`
`analyzeBodyLineage`), which preserves the Project/Filter/Join/TableReference
operator tree that threads lineage. Add a small logical-plan helper (or reuse the
existing one) rather than relying on `ctx.root`. Reading `resolveBaseSite` off that
logical root's `updateLineage` is exactly how `column_info` derives per-column
writability, so the round-trip verdict and the introspection surface stay in
agreement by construction.

### Extension point (do not build now)

The complement is defined for single-source projection-and-filter. Extending the
computed predicate to the join/decomposition fragment depends on the complement
being defined there, which tracks with `view-write-through-shape-gaps` (no hard
`prereq` — they advance independently). Shape `proveRoundTrip` so the join/
decomposition fragment is a later widening behind the same law: keep the
single-source path behind a fragment gate that returns the safe verdict for shapes
the complement does not yet cover, and keep the GetPut hidden-column /
PutGet inverse-domain checks expressed against the n-way `resolveBaseSite` reader
(which already generalizes across single-source, join, and decomposition) rather
than a single-source-only reader. North-star: keep the check composable with the
eventual mechanical `put`-from-`get` auto-derivation (the load-bearing invariant:
no backward rule auto-derivation could not reproduce — `docs/view-updateability.md`
§ Round-Trip Laws).

## Tests (TDD)

Add to `test/lens-prover.spec.ts` (deploy-time scenarios go through the full
`apply schema` pipeline) and `test/property.spec.ts` § View Round-Trip Laws (the
operational harness — the oracle).

- **Harness agreement (property; the primary correctness gate).** For each body in
  the single-source round-trip zoo (`SHAPES` × filter in `property.spec.ts`), the
  **computed** per-column GetPut/PutGet verdict from `proveRoundTrip` agrees with
  the operational law's pass/red verdict: a column the operational law allows a
  write to (PutGet/GetPut green) is writable-and-faithful under the computed
  predicate, and a column whose write the operational law rejects (`no-inverse`) is
  classified non-writable by the computed predicate. Include the injected-violation
  negative self-test: an injected unfaithful inverse (a forward/inverse pair that
  is not `get ∘ put = id`) makes the computed predicate red, mirroring the
  harness's existing injected-widening / injected-getput self-tests. (The shipped
  registry is faithful, so the error path is reachable only via this injection —
  exercise it explicitly.)
- **Deploy-time, all-invertible chain passes.** A body with an invertible computed
  column declared writable — `(speed + 1) * 2 as adjusted` over a single basis
  table — passes the deploy-time round-trip check, deploys writable, and a write
  round-trips. (Confirms the inverse-chain composition path is admitted, not
  over-blocked.)
- **Safety / no over-block (out-of-fragment).** A body the complement cannot
  characterize — e.g. a two-table join body, or a single-source body with a
  non-negation-free residual (`where a <> 1`) — deploys with **no**
  `lens.non-invertible` (assert the deploy succeeds and the prover emits no
  round-trip error), and mutation-time nets still govern. Assert against today's
  documented `upper(who) as label` derived-column body: deploys, `label` is
  read-only, no `lens.non-invertible`.
- **Verdict agrees with runtime truth (both directions).** Anything the deploy-time
  check passes does not later red at mutation time for an invertibility reason, and
  a body the deploy-time check would red (the injected-unfaithful case) also reds at
  mutation time — over the supported fragment. (This is the cross-check the
  harness-agreement test formalizes; keep an explicit assertion of the contract.)

## Docs

- `docs/lens.md` § Coverage checklist, the **Round-trip (lens laws)** row + the
  "Round-trip detection" callout: replace "the deploy-time check adds no *new*
  error today / `proveRoundTrip` sits behind a single swappable function" with the
  computed form — GetPut = `put` leaves the complement fixed, PutGet = `get ∘ put`
  reproduces the written image, computed over `viewComplement`, with the firing
  rule (writable-presented column only; computed columns stay read-only) and the
  degrade-to-safe conditions.
- `docs/view-updateability.md` § The predicate-honest complement: note that the
  prover now **consumes** `viewComplement` at deploy (the `proveRoundTrip` consumer
  is live, not planned), retaining the single-source-fragment scope and the
  extension note.

## Backlog note to file

If the work surfaces real demand for hard-blocking opaque columns in a
name-matched (would-be-writable) position at deploy — the stronger reading of seed
test #2 — file a `backlog/` ticket for a logical-layer read-only/generated *intent*
signal (so the engine can distinguish an intentional derived column from a
broken writable one), since the current model has no such signal and our rule
deliberately treats all opaque columns as intentional. Do not grow this ticket.

## TODO

- Add a logical-plan helper to `lens-prover.ts` (or reuse `analyzeBodyLineage`'s
  `buildSelectStmt` path) that yields the logical body root with `updateLineage`
  threaded — distinct from `ctx.root` (optimized). Guard it with the same
  graceful-degradation `try/catch` as `planBody`.
- Implement the fragment gate: detect single-source projection-and-filter (reuse
  the existing shape classifier `classifyViewBody` / `isDecomposableJoinBody`
  shadow where possible); return `[]` for anything else.
- Implement the determinacy gate: return `[]` when `updateLineage` is absent or the
  residual predicate is not negation-free (a small reflective negation-free walk
  over the residual AST — reuse `collectColumnRefNames`-style traversal).
- Implement GetPut: for each writable column (`resolveBaseSite(...).writable`),
  assert its resolved base column is not in `complement.hiddenColumns`.
- Implement PutGet: for each writable column, assert `get ∘ put` is identity over
  the writable value and the inverse `domain` (if any) is entailed by the residual
  predicate; emit `lens.non-invertible` sited at the column, naming the operator,
  on failure.
- Wire nothing else — `proveLens` already pushes `proveRoundTrip(ctx)` errors.
- Add the four test groups above; ensure the property test reuses the existing zoo
  and injected-violation pattern so it is the same oracle.
- Update `docs/lens.md` and `docs/view-updateability.md` as described.
- `yarn workspace @quereus/quereus run build`, then `yarn test` (lens-prover.spec +
  property.spec), and lint (single-quoted globs on Windows). Stream long output with
  `tee` per AGENTS.md.
- File the backlog note ticket if warranted.
