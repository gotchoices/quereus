description: Materialized views that track a min or max over grouped rows now update cheaply on insert instead of re-scanning, only falling back to a full re-scan of one group when a row is removed that might have been the extreme.
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/incremental/delta-aggregate.spec.ts, docs/mv-maintenance.md
----
## What this ticket added

A **tighten-only** delta class for incrementally-maintained aggregate materialized views: aggregates
that declare `merge` + `decode` but **no** `negate` — `min`, `max`, and any user-defined aggregate
whose `merge` is a join-semilattice (`bit_or`, `bool_or`). Before this ticket, a body containing
`min`/`max` fell wholesale to the plain per-group residual recompute; now it joins the
`'delta-aggregate'` arithmetic fast path.

The rule is the general **merge-without-inverse** rule, not a min/max special case. Detection is
structural (`algebra.merge` present, `algebra.negate` absent) — never an aggregate-name list.

**Behavior per group at the statement flush:**
- **Insert-only touch** → every column folds arithmetically. `min`/`max` `merge` toward the new
  extreme; an insert that does not beat the stored extreme rebuilds a value-identical row and is
  suppressed (MV-016).
- **Any retraction touching the group** (a delete, or the OLD image of an update) → the **whole
  group** re-derives from the key-filtered residual (live source state), because `merge` cannot
  recover the next-best after the current extreme leaves. This holds **whether or not a backing row
  is stored** — an intra-statement delete of the extreme poisons even a from-identity net-fold. The
  residual recomputes every column of that row (the sibling `count`/`sum` group columns included), so
  a **mixed** group+tighten row is maintained by exactly one path — no double-maintenance.

## Where the work lives

- `plans.ts` — `DeltaAggregateColumn.deltaClass: 'group' | 'tighten'`; `DeltaAggregateDescriptor.hasTighten`.
- `plan-builders.ts` — eligibility gate relaxed: a `decode`-without-`negate` column is admitted as
  `'tighten'` (no exact-numeric-domain gate — `merge` is idempotent selection, not accumulating
  arithmetic, so no float drift). `hasTighten` set on the descriptor. `count(*)` multiplicity witness
  still required. Cost: a `DELTA_TIGHTEN_FALLBACK_RATIO = 0.25` is fed into the gate for tighten bodies.
- `apply.ts` — `accumulateDeltaAggregates` skips the (non-existent) `negate` for a tighten column on a
  retraction; `computeDeltaAggregateOps` routes a retracted group to the residual when
  `hasTighten || (stored && !retractionSafe)`.
- `cost/index.ts` — `MaintenanceSourceStats.deltaTightenFallbackRatio`; the `'delta-aggregate'` cost
  blends `(1-f)·deltaPerGroup + f·residualPerGroup`. `f = 0` (pure-group body) reduces to the exact
  prior formula — non-tighten cost unchanged.
- `docs/mv-maintenance.md` — new **Tighten-only columns** subsection; eligibility + retraction-safety
  paragraphs updated; the forward-reference at the end of the delta-aggregate section landed.

## How to validate

```
yarn build && yarn test && yarn lint      # all green: 7154 passing, 0 failing, lint exit 0
```

Focused run:
```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/incremental/maintenance-equivalence.spec.ts" \
  "packages/quereus/test/incremental/delta-aggregate.spec.ts" --grep "tighten"
```

**Key test cases (the correctness floor, not a ceiling):**
- `maintenance-equivalence.spec.ts` → **"tighten class: min/max"** — white-box routing (`chosenStrategy
  === 'delta-aggregate'`, `hasTighten`), plus deterministic edges: insert beats extreme (tightens),
  insert inside range (no-op), delete of the extreme (residual recovers next-best), delete of a
  non-extreme (conservative fallback, still exact), emptied group (multiplicity delete), and a
  `fast-check` property (60 runs) over random mutations incl. extreme-relaxing deletes, in-txn + rollback.
- `maintenance-equivalence.spec.ts` → **"tighten class: a UDAF semilattice bit_or"** — proves the class
  is declaration-driven (a `bit_or` UDAF, `merge`+`decode`, no `negate`) mixed with a `sum(a)` group
  column, so the mixed group+tighten residual re-derive is exercised.
- The pre-existing AGGREGATE_SHAPES shape `select k, count(*), sum(a), min(b), max(b) ... group by k`
  (line ~202) now routes through the tighten arm and is driven by the shared mutation generator.
- `delta-aggregate.spec.ts` → **"min/max routes through delta via the tighten class"** — the flipped
  routing pin (was "disqualifies the whole MV"); asserts `deltaClass` tags `['group','group','tighten','tighten']`.

## Known gaps — reviewer, scrutinize these (your tests are a floor)

- **TEXT / REAL min/max are admitted but untested.** The tighten branch has no exact-value-domain gate,
  so `min`/`max` over a TEXT or REAL column *is* delta-eligible, and the docs claim byte-exactness. All
  tests use an INTEGER argument. The builtins compare with `BINARY_COLLATION` in both `step` and `merge`,
  and the oracle live-evaluates the same builtin, so it *should* hold — but a TEXT `min(x)` under a
  column declared `collate NOCASE` is an untested interaction worth an equivalence shape. (min/max's use
  of hard-coded `BINARY_COLLATION` vs a declared column collation is a pre-existing builtin question, not
  introduced here, but it surfaces on this path.)
- **`DELTA_TIGHTEN_FALLBACK_RATIO = 0.25` is a hand-picked heuristic**, not stats-derived. It only shifts
  the create-time argmin (tighten body costs more than pure-group, still below always-residual). A
  retraction-heavy workload could legitimately prefer plain residual; no runtime re-cost happens. Confirm
  the constant is defensible and the blend math is right (`f=0` must be a no-op — verified by the
  unchanged non-tighten suites).
- **The demotion-crossover test premise was updated, not masked.** `maintenance-equivalence.spec.ts`
  "per-statement degrade-to-rebuild demotion" used `min(b)` as a proxy for "a body that stays on the
  plain residual" — a proxy this ticket *intentionally* invalidates. Swapped to `group_concat(b)` (no
  declared algebra → genuinely residual-only; all rows write `b=0` so it is order-independent). Verify
  this still tests the crossover it is named for, and is not hiding a real regression.
- **Conservative fallback is a tripwire, not a ticket.** A delete of a *provably non-extreme* value still
  rescans the group. Parked as a `NOTE:` at the fallback branch in `apply.ts` (~line 959) and a bullet in
  `docs/mv-maintenance.md` § Tighten-only columns. A future secondary-index "is this the current extreme?"
  probe could skip it; do not build now.
- **Property-test coverage is `numRuns: 60`** on the tighten suites — a floor. The mutation generator
  (`decMutationArb`) covers insert / non-key update / group-key+arg update / key-changing update / delete /
  multi-insert / predicate update / predicate delete, but with a small id/key space; rare interleavings may
  be under-sampled.

## Interactions confirmed sound (spot-check if in doubt)

- Forward residual key is collected first and always for every change (`collectForwardResidualKeys` before
  `accumulateDeltaAggregates`), over the identical canonical key, so the tighten fallback's
  `entry.forward.get(dedupKey)` never misses (the INTERNAL throw is genuinely unreachable). `forward ⊇`
  delta keys because forward collects without the body predicate.
- MV-over-MV cascade unchanged: the delta upsert/delete emits the same `BackingRowChange`s.
- Rollback / OR FAIL poisoning: a tighten body still routes poisoned entries through the residual over the
  always-accumulated keys (unchanged from the group case).
