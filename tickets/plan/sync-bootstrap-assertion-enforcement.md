description: HUMAN SIGN-OFF NEEDED — pick the global-assertion contract for snapshot bootstrap. Trust-the-origin (current; redundant for an honest single-origin snapshot, consistent with the rest of the seam) vs. re-validate every assertion over the converged state at finalize (defense-in-depth vs. corrupt/hostile snapshots; needs a new engine primitive). Plan resolved feasibility + both designs; only the contract choice remains.
blocked-reason: design question needing human sign-off (contract / data-integrity posture)
recommendation: Option 1 (trust-the-origin) — see rationale below
files:
  - packages/quereus-sync/src/sync/store-adapter.ts            # bootstrap flush skips the seam; finalizeBootstrap() refreshes MVs + coarse-notifies; would host the Option-2 sweep
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # footer issues bootstrapFinalize
  - packages/quereus-sync/src/sync/snapshot.ts                 # one-shot path issues bootstrapFinalize
  - packages/quereus/src/core/database.ts                      # runGlobalAssertions() (delta-driven, line ~1769); refreshAllMaterializedViews() (line ~1918); would host the Option-2 primitive
  - packages/quereus/src/core/database-assertions.ts           # runGlobalAssertions() short-circuits on changedBases.size===0 (:186); executeViolationOnce() full-state eval (:378); no-dep branch (:199)
  - packages/quereus/test/external-row-change-ingestion.spec.ts# pins commit-time assertion eval over an inbound batch (delta path)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # "assertion failure propagates" — incremental seam DOES evaluate assertions
difficulty: medium
----

# Snapshot bootstrap: assertion enforcement over the converged state

## Why this is blocked (and not decided)

This is a **contract / data-integrity posture** decision, not an implementation
detail. The source ticket explicitly flagged it "needs human sign-off," and the
two options encode genuinely different threat models (honest-origin redundancy
vs. corrupt/hostile-snapshot defense). The plan pass below resolves everything
*except* that one call: feasibility is confirmed, the engine seam is understood,
a recommendation is made, and **both** outcomes are pre-specified so that on
unblock this converts to a one-line promotion (either close as docs-only, or
emit the ready-made implement ticket in the appendix).

**To unblock:** record the chosen option in this file (or a one-line note) and
move it back to `plan/`. The plan pass will then either (Option 1) emit a small
docs/contract-pinning implement ticket, or (Option 2) emit the implement ticket
already drafted in the appendix.

## Background (established by research)

The engine ingestion seam `Database.ingestExternalRowChanges` routes inbound
batches through the commit path, which calls `runGlobalAssertions()`. So the
**incremental** sync path enforces `create assertion` invariants on every applied
batch — deliberately, pinned by `store-adapter-seam.spec.ts` and
`external-row-change-ingestion.spec.ts`.

The snapshot-bootstrap work (`sync-bootstrap-defer-mv-maintenance`) makes a
bootstrap flush **skip the seam call** (`store-adapter.ts:184`) so MV maintenance
and watch capture defer to a single end-of-snapshot `bootstrapFinalize`
(`refreshAllMaterializedViews()` + coarse `notifyExternalChange`). Side effect:
the finalize refreshes MVs but **never evaluates global assertions**, so
bootstrapped data is not assertion-checked at all. (The pre-bootstrap behavior
also never checked correctly — each flush evaluated assertions over **partial**
snapshot data, e.g. children before parents, which could spuriously fail a valid
snapshot. So neither old nor new behavior checks assertions over the *complete*
snapshot.)

### Feasibility finding — the existing path cannot serve bootstrap

`runGlobalAssertions()` is **delta-driven**: it short-circuits when no base
tables changed in the current transaction (`database-assertions.ts:186-187`,
`if (changedBases.size === 0) return;`) and dispatches each assertion on
dependency overlap, evaluating per-tuple/per-group residuals over *captured
delta tuples*. Bootstrap skips the seam, so no deltas are captured — calling
`runGlobalAssertions()` at finalize would no-op.

The full-state primitive already exists privately: `executeViolationOnce(name,
violationSql)` (`database-assertions.ts:378`) runs an assertion's complete
violation query against current committed storage, independent of any delta —
exactly what the "assertion with no table dependencies" branch already uses
(`:199-204`). So **Option 2 is feasible**, but it is a genuinely *new* public
entry point (a full sweep over all active assertions), not a reuse of the seam.

## The contract choice (the only open question)

### Option 1 — Trust the origin, do not re-validate (current behavior)  ← recommended

A complete snapshot already satisfied the **origin's** assertions; the receiver
installs it **wholesale (replace, not merge)**, so no new cross-row/cross-table
violation can be *introduced* by the load. Re-checking is therefore redundant
for an honest origin, and it is consistent with the seam's documented
trust-the-origin posture: the seam re-validates **no** CHECK / NOT NULL / UNIQUE
/ FK on inbound rows either.

The asymmetry with the incremental path is **correct, not a bug**, and the
recommendation rests on making that explicit:

- **Incremental = merge.** Deltas from multiple origins are merged into the
  receiver's existing state; a cross-origin merge can produce a global-invariant
  violation that *no single origin ever saw*. That is *why* the incremental path
  enforces assertions — it is about the merge, not about distrusting the origin.
- **Bootstrap = replace.** A snapshot is one origin's already-converged state,
  installed wholesale. No merge happens, so the merge-introduced-violation class
  cannot arise. Trust-the-origin applies cleanly.

Soundness note that reinforces this: the incremental path's per-tuple residual
optimization *assumes the pre-existing baseline already satisfies the
assertion* (it only re-examines changed tuples). That assumption is itself the
trust-the-origin assumption — a valid baseline. So enforcing only on increments
while trusting the bootstrap baseline is internally consistent.

Residual risk: a **corrupt or hostile** snapshot silently installs
invariant-violating data. But that risk is **already unguarded for every other
constraint type** (CHECK/NOT NULL/UNIQUE/FK are not re-validated on any inbound
path). Re-validating *only* global assertions would be inconsistent
defense-in-depth — a false sense of security while row-level garbage still flows
through untouched. If the project does not trust origins, the fix is a separate,
broader integrity layer, not a one-off assertion sweep.

**Cost if chosen:** ~zero. Keep the docs/comments honest (largely already done
in `store-adapter.ts:36-46`) and pin the contract with a test asserting bootstrap
does **not** throw on an assertion-violating snapshot. See appendix A.

### Option 2 — Re-validate at finalize over the converged state

After `refreshAllMaterializedViews()` in `finalizeBootstrap`, evaluate every
active global assertion **once** against the now-complete data (the correct
point: full data present, no partial-flush false positives). A violation
propagates like any finalize throw — leave the snapshot checkpoint in place /
do not emit `synced`, so the load is retriable.

This buys defense-in-depth against corrupt/hostile snapshots and makes the two
paths agree on "assertions are enforced." Cost: a new engine primitive plus a
full-table scan of every assertion's violation query on every bootstrap (one
time per load, not per flush). See appendix B for the full design, which is
implement-ready if this option is chosen.

### Decide too

Whether the two paths should *agree* on enforcement. Recommendation: they should
agree on **intent** (trust-the-origin everywhere) while differing in
**mechanism** because they do different things (merge vs. replace) — i.e. Option
1 with the merge-vs-replace rationale documented, so a future reader does not
re-file the asymmetry as a bug.

---

## Appendix A — implement ticket if Option 1 is chosen (docs + contract pin)

> Promote to `implement/` as `sync-bootstrap-assertion-trust-origin` (or fold
> into a docs pass). Small / easy.

Scope:
- In `store-adapter.ts`, upgrade the existing open-question note
  (`:44-46`) to a settled statement of the contract, with the **merge vs.
  replace** rationale spelled out (incremental enforces because it merges;
  bootstrap trusts because it replaces). Cross-reference the seam's
  trust-the-origin posture for the other constraint types.
- In `docs/materialized-views.md` § External row-change ingestion (the section
  the store-adapter comment already cites), add a short subsection: "Snapshot
  bootstrap does not re-validate global assertions — trust-the-origin; see
  rationale." Keep DRY with the seam's general trust-the-origin statement.
- Add a sync test pinning the contract: stream a bootstrap snapshot whose
  converged state **violates** an active `create assertion`, run through
  `bootstrapFinalize`, and assert the load **succeeds** (no throw, checkpoint
  cleared, `synced` emitted, rows present). This is the inverse of the
  incremental `store-adapter-seam.spec.ts` "assertion failure propagates" test
  and documents the deliberate divergence.

### Edge cases & interactions (Option 1)
- Assertion with **no table dependencies** (`check (1=0)`): trust-the-origin
  means bootstrap does **not** evaluate it either — the test should confirm even
  this is not run at finalize (otherwise the contract is inconsistent).
- **Bootstrap-then-incremental sequence:** after a trusted bootstrap, the first
  incremental batch enforces assertions over its delta assuming the bootstrapped
  baseline is valid. Document that this is the trust boundary.
- **MV-backed assertions:** assertions referencing a materialized view see the
  MV only after `refreshAllMaterializedViews()`; under Option 1 they are not
  evaluated at all, so MV-refresh ordering is moot for assertions (still matters
  for MV correctness).

---

## Appendix B — implement ticket if Option 2 is chosen (engine primitive + finalize hook)

> Promote as TWO `prereq:`-chained implement tickets (engine primitive first,
> sync hook second) so each is one agent run. Medium.

### Ticket B1 — engine primitive `Database.evaluateAllGlobalAssertions()`

Add a public method on `Database` (delegating to `AssertionEvaluator`) that
evaluates **every** active global assertion's full violation query once against
current committed state, throwing the same `QuereusError` (CONSTRAINT) on the
first violation that the commit path throws.

- Reuse `executeViolationOnce(name, violationSql)` — iterate
  `schemaManager.getAllAssertions()`, `getOrCompilePlan(assertion)` for each
  (under `withSuppressedAssertionHoist`, as the existing path does), then
  `executeViolationOnce`. Do **not** gate on `getChangedBaseTables()` (that gate
  is the delta optimization — full sweep must ignore it).
- Serialize via the exec mutex like `refreshAllMaterializedViews()`; do not call
  from within statement execution / vtab callbacks (deadlock — same constraint).
- Return void; throw on first violation (fail fast, matching commit semantics).

Tests:
- Active assertion satisfied by current state → no throw.
- Active assertion violated by directly-written (out-of-band) storage rows →
  throws the CONSTRAINT `QuereusError` naming the assertion, with violating-row
  samples (mirror `external-row-change-ingestion.spec.ts` assertions block).
- No-table-dependency assertion (`check (1=0)`) → throws (the full sweep must run
  it; the delta gate would have skipped it).
- Zero assertions → no-op, no mutex contention.

### Ticket B2 — call it from `finalizeBootstrap` (prereq: B1)

In `store-adapter.ts` `finalizeBootstrap`, after
`refreshAllMaterializedViews()` and **before** returning (and before the caller
clears the checkpoint), call `db.evaluateAllGlobalAssertions()`. A throw
propagates out of the callback exactly like a `refreshAllMaterializedViews`
throw — the caller leaves the checkpoint in place and the transfer retries.
Update the store-adapter doc block (`:44-46`) to state the converged-state
re-validation contract and remove the open-question note.

### Edge cases & interactions (Option 2)
- **Ordering:** assertions must run **after** MV refresh (MV-backed assertions
  read converged MV backings) and after all base-table storage writes. Finalize
  already guarantees both — pin with a test using an assertion over a
  materialized view.
- **Retriability / partial finalize:** `refreshAllMaterializedViews()` is not
  atomic across the sweep; if assertions throw *after* some MVs refreshed, the
  checkpoint survives and the retry re-refreshes idempotently then re-checks.
  Confirm the retry path converges (no double-apply, value-identical upserts
  suppress) and eventually either passes or stays a poison load.
- **Poison snapshot:** a snapshot that always violates retries forever (same
  poison-batch posture as the incremental path). Test that the checkpoint is
  *not* cleared and `synced` is *not* emitted on the failing finalize.
- **No-table-dependency assertion** must be evaluated (the delta gate skipped it;
  the full sweep must not).
- **Empty schema / zero assertions:** finalize still runs MV refresh + notify;
  the assertion sweep is a no-op (B1 returns immediately) — no new mutex/txn.
- **Cost surface:** every active assertion's full violation query scans its
  source tables once per bootstrap. Acceptable for a wholesale load; note it in
  docs so it is not mistaken for per-flush cost.
- **Cross-path agreement:** with B2 landed, bootstrap and incremental both
  enforce assertions; update any doc that currently states bootstrap does not.

## End

---

## Triage decision (2026-06-13, human sign-off): Option 1 — trust the origin

Take **Option 1**. Bootstrap installs one origin's already-converged state
wholesale (replace, not merge), so the merge-introduced-violation class the
incremental path guards against cannot arise; re-checking is redundant for an
honest origin and consistent with the seam not re-validating CHECK/NOT NULL/
UNIQUE/FK on any inbound row. The plan pass emits the small **Appendix A**
implement ticket (`sync-bootstrap-assertion-trust-origin`, easy): settle the
store-adapter contract comment with the merge-vs-replace rationale, add the
docs/materialized-views.md § External row-change ingestion subsection, and pin
the contract with a test that a bootstrap snapshot whose converged state violates
an active assertion **succeeds** (no throw, checkpoint cleared, `synced` emitted).
The two paths agree on intent (trust-the-origin everywhere) and differ in
mechanism because they do different things (merge vs replace) — documented so the
asymmetry is not re-filed as a bug. Appendix B (Option 2) is not taken.
