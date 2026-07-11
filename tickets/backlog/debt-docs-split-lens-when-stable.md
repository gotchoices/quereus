description: The lenses design document is long enough to drift, but the feature it describes is still being designed, so splitting it now would just create churn. Revisit once the lens feature settles.
prereq:
files:
  - docs/lens.md (~17,900 words)
  - docs/.doc-budget.json (grandfathered ratchet entry: docs/lens.md = 17934)
  - docs/.stability.json (docs/lens.md = Experimental)
  - docs/doc-conventions.md, scripts/check-docs.mjs, docs/invariants.md (the split machinery, when the time comes)
----

## Why this is parked, not queued

`docs/lens.md` is one of the docs still over the 12,000-word documentation cap (recorded as
a grandfathered entry in `docs/.doc-budget.json`: it may not grow, but has not shrunk). The
sibling effort `debt-docs-shrink-remaining-megadocs` split its two peers — the SQL reference
and the view-updateability doc — but deliberately left lenses for later, for one reason:

**Lenses (layered logical schemas) are the most speculative subsystem in the repo.** The
doc is classified `Experimental` in `docs/.stability.json`, and it is still actively being
designed. Splitting a document whose subject is still moving produces churn, not clarity —
you split along today's seams and re-split when the design shifts next month. An
experimental design that is still moving is also the one place narrative *history* genuinely
earns its keep (per `docs/doc-conventions.md`, history is normally deleted): the "why we
tried X and moved to Y" record is load-bearing while the shape is unsettled.

So this is real work, deferred on a **condition**, not a dependency on another ticket.

## The condition that unparks it

Promote this into `plan/` (or `implement/`) when **either** holds:

- `docs/lens.md` graduates out of `Experimental` in `docs/.stability.json` (to `Beta` or
  `Stable`) — i.e. the design has settled enough to stop moving; **or**
- the doc grows to the point where its grandfathered ceiling becomes a genuine obstacle
  (someone needs to add material and the ratchet blocks them).

Until then, the grandfathered ratchet entry does its job: the doc cannot grow, so it cannot
get worse.

## What the future pass will do

By then the split machinery will be well-proven (it will have shipped on the optimizer,
materialized-view, view-updateability, and SQL-reference docs). Follow the same recipe,
which is written down in `docs/doc-conventions.md`:

- Decide it is a **design doc** (it is) → split **and** add invariants. Split along the
  boundaries `lens.md`'s own outline already suggests — the natural seams are roughly:
  *What a Lens Is / Schema Kinds / The Lens Slot*, *The Default Mapper + module mapping
  advertisement*, *Sparse Overrides*, *Constraint Attachment*, *Computed and Generated
  Columns + round-trip proving*, *Deployment Is a Compile Step*. Measure before committing
  to file boundaries.
- Cut at headings, promote depth by one, leave a stub + link, sort prose into
  invariant / rationale / history, delete the history (keeping the rejected-alternatives
  rationale).
- Repoint inbound doc anchors and the `docs/lens.md § …` markers in source comments — the
  checker (`scripts/check-docs.mjs`) names them all. Note `lens.md` is referenced by several
  `packages/quereus/src` comments (e.g. `planner/mutation/decomposition.ts`,
  `schema/lens-prover.ts`) and by `docs/migration.md`, `docs/schema.md`,
  `docs/view-updateability.md`.
- Lower or remove the `docs/lens.md` entry in `docs/.doc-budget.json`.
- Add a `LENS-*` invariant area to `docs/invariants.md`. Unlike `VU`, the `LENS` area **is**
  already reserved: `docs/invariants.md` carries a `## LENS — Lens` placeholder header
  (`Reserved.`) and `scripts/check-docs.mjs`'s `INVARIANT_HEADING` regex already lists
  `LENS`. The `VU` area, by contrast, had to be added to that regex by
  `docs-invariants-vu` — do not assume the same is needed here; confirm against the checker
  at the time.

The round-trip / lens-law prover (`schema/lens-prover.ts`, `analyzeRoundTrip` /
`emitRoundTrip`) and the deploy-time GetPut/PutGet verdicts are the strongest `LENS-*`
invariant candidates, analogous to how the view round-trip laws anchor the `VU` area.
