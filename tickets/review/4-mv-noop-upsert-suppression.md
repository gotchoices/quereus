description: Review — value-identical (no-op) MV maintenance write suppression in the bounded-delta arms: arm-level equal-image short-circuit, host-level skip-identical upsert (normative contract), residual-arm keyed-diff apply. One deliberate deviation from the implement ticket's text (byte-faithful vs collation-aware compare) needs reviewer sign-off.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # equal-image short-circuit; forward/lookup/prefix-delete keyed diffs; backingPkEqual
  - packages/quereus/src/vtab/backing-host.ts                  # NORMATIVE contract: value-identical upsert writes/reports nothing
  - packages/quereus/src/vtab/memory/layer/manager.ts          # host backstop in applyMaintenanceToLayer 'upsert'
  - packages/quereus/src/util/comparison.ts                    # rowsValueIdentical (byte-faithful identity), exported via index.ts
  - packages/quereus-store/src/common/backing-host.ts          # store host aligned to rowsValueIdentical (was collation-aware)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # § no-op write suppression probes (per arm + cascade)
  - packages/quereus/test/vtab/backing-host.spec.ts            # host-level skip / pending-compare / NOCASE non-skip pins
  - docs/materialized-views.md                                 # § Value-identical (no-op) write suppression; arm tables updated; limitation bullet removed
  - docs/incremental-maintenance.md                            # arm annotations updated; delete-by-prefix "no longer produced" note
  - docs/migration.md                                          # pending bullet removed
----

# Review: no-op maintenance write suppression

A maintenance write whose recomputed backing image is value-identical to the effective
existing row now writes nothing and reports nothing — no backing op, no effective
`BackingRowChange`, no MV-over-MV cascade — across all four bounded-delta arms. The
normative statement lives in `vtab/backing-host.ts` (`MaintenanceOp` `upsert` bullet +
`applyMaintenance` doc); both hosts implement it.

## ⚠ Deliberate deviation from the implement ticket — reviewer must confirm

The implement ticket said the skip should be **collation-aware**, "follow
`replace-all`'s existing skip-identical semantics exactly (one discipline, not two)".
That is **not implementable** under the ticket's own oracle requirement: the harness
compares byte-exactly (`canonRow`), and two pre-existing pinned behaviors conflict —
`maintenance-equivalence.spec.ts` "case-only base-PK rewrite re-keys the whole fan-out
slice" (NOCASE suite, byte-exact) vs `maintenance-replace-all.spec.ts` "collation-equal
rows skip" (stored casing retained). A collation-aware point-op skip reds the NOCASE
suite (suppression would retain stale bytes the live body no longer produces).

Resolution implemented: the point-op skip is **byte-faithful** —
`rowsValueIdentical` (`util/comparison.ts`): per-column `compareSqlValues` under
BINARY, numeric-storage-class tolerant (bigint 5n ≡ number 5), byte-exact text. A
collation-equal / byte-different upsert is a REAL change (re-keys stored bytes, reports
`update`). Collation still governs key *identity* everywhere (which row an upsert
replaces; keyed-diff pairing). `replace-all` keeps its pinned collation-aware skip —
two disciplines, documented in the contract comment and in materialized-views.md § no-op
suppression. The divergence is itself a latent floor bug (confirmed repro: floor over a
NOCASE body + case-only rewrite leaves the backing byte-stale) — filed as
`fix/full-rebuild-replace-all-byte-fidelity` with the repro and a proposed direction.
The store host's `rowsEqual` skip (landed by `store-backing-host` as collation-aware)
was aligned to `rowsValueIdentical`; its `replace-all` keeps collation-aware `rowsEqual`
for memory parity.

## What changed, per layer

- **Inverse-projection arm**: an UPDATE with both images in scope and value-identical
  projections returns `[]` before any backing-connection work (the dominant echo:
  unprojected-column update / same-value rewrite). Real same-key changes still emit
  delete-old-image + upsert-new-image and report `delete`+`insert` **exactly as
  before** (deliberately untouched to keep reporting stable).
- **Forward residual (aggregate + join driving side)**: no delete-first. Non-empty
  recomputed slice → upserts only (backing key = affected key, so the upsert replaces
  wholesale; host suppresses identical → zero changes); empty slice → point delete.
  **Reporting change**: a real same-key recompute now reports one `update` instead of
  `delete`+`insert`. Cascade consumers handle all three ops, and an update dispatches
  the consumer once instead of twice.
- **Lookup residual, delete-capable (P-referencing WHERE)**: keyed diff — deletes only
  membership keys the in-scope recompute no longer produces (byte-canonical set; exact
  because both residuals read the same live state); upserts every in-scope row (host
  suppresses identical). Formerly delete-every-member + re-upsert (churn per member on
  every in-scope P write). Upsert-only lookup side: unchanged kernel; the host backstop
  alone suppresses.
- **Prefix-delete arm**: keyed diff against the existing effective slice
  (`scanEffective` with the base prefix — same binary prefix scan + build-time
  collation gate the wholesale `delete-by-prefix` relied on; the gate comment was
  re-targeted). Deletes only disappeared keys (collation-aware pairing via
  `backingPkEqual` so a collation-equal recomputed key replaces, never delete+insert),
  upserts the slice. Host/connection now resolved **up front** (the diff reads before
  ops exist) — no net change in connections resolved (this arm always emitted ops).
  Grown/shrunk fan-outs now report exactly the appeared/disappeared rows.
- **Memory host** `applyMaintenanceToLayer` `upsert`: skip when `rowsValueIdentical`
  vs `lookupEffectiveRow` (pending over committed — the same-transaction
  prior-write edge is honored and pinned by test).
- **`'delete-by-prefix'` is no longer produced by the engine** (verified by grep). It
  stays in the host contract — implemented by both hosts, pinned by
  `maintenance-prefix-delete.spec.ts` — for future consumers (fanning-keyed-join arm).
  Noted in incremental-maintenance.md.

## Validation performed

- `yarn build` (all packages), `yarn lint` (quereus) — clean.
- `yarn test` — all workspaces green (quereus 5775 passing / 9 pre-existing pending).
- `yarn test:store` — 5771 passing (run because the store host's skip discipline
  changed; exercises MV maintenance over store-hosted backings end-to-end).
- Full maintenance-equivalence harness green, including the NOCASE fan-out property +
  deterministic re-key suites, the P-WHERE membership-flip suites, rollback phases,
  and the OR FAIL paths.

## New tests (use these as the review entry points)

- `maintenance-equivalence.spec.ts` § "no-op write suppression": instruments
  `applyMaintenancePlan` (the cascade's input seam) and pins, per arm:
  (a) unprojected-column update → zero effective changes; (b) same-value rewrite →
  zero; (c) MV-over-MV: suppressed producer write → consumer never dispatched, real
  change → consumer maintained; (d) regressions — real change reports (inverse-
  projection: delete+insert as today; aggregate: exactly one `update`), key-changing
  update reports, emptied group → one `delete`, emptied fan-out → all deletes,
  shrunk/grown fan-out → exactly one delete/insert, scope exit/entry → exact
  deletes/inserts (incl. delete-capable join members).
- `backing-host.spec.ts`: value-identical upsert reports nothing + leaves state
  untouched; the skip compares against the EFFECTIVE row (pending-prior-write then
  upsert-back-to-committed must report); NOCASE collation-equal byte-different upsert
  is NOT suppressed (re-keys bytes).

## Known gaps / notes for the reviewer

- **Reporting-shape change is observable to cascade consumers** (update vs
  delete+insert for residual-arm same-key changes). All consumers in-tree handle it
  (the equivalence suites prove convergence); anything external consuming
  `BackingRowChange[]` semantics (e.g. future change-log emission) should prefer the
  new shape, but confirm nothing depends on the old delete+insert pairing.
- **Inverse-projection real same-key changes still report delete+insert** (kept
  as-is per the ticket's "report exactly as today"). Unifying it to `update` (emit
  upsert-only when keys are equal) would be a small follow-up if desired.
- **No store-level unit test pins the byte-faithful (NOCASE non-skip) upsert** in the
  store host specifically — parity is asserted only structurally (same shared helper)
  plus the store suite + test:store staying green. The memory host pin lives in
  `backing-host.spec.ts`; a mirrored store-host case would close this.
- The numeric tolerance of `rowsValueIdentical` (bigint ≡ number) can in principle
  suppress a representation-only rewrite (stored 5n, recomputed 5) that the byte-exact
  oracle would distinguish — same tolerance `replace-all` has always had; no in-tree
  path produces unstable representations (both sides come from the same evaluation
  pipeline), and all suites are green.
- The O(|existing|·|recomputed|) pairing in the prefix-delete diff is linear-scan per
  slice; fine for realistic fan-outs, quadratic for pathological ones (the wholesale
  delete was linear). If that ever matters, a collation-aware keyed map fixes it.
- Spawned: `fix/full-rebuild-replace-all-byte-fidelity` (the floor's latent
  collation-aware-skip byte divergence, confirmed repro included).
