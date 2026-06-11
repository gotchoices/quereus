description: COMPLETE — value-identical (no-op) MV maintenance write suppression across all four bounded-delta arms: arm-level equal-image short-circuit (inverse projection), host-level skip-identical upsert (normative BackingHost contract, both hosts), keyed-diff apply in the residual/prefix arms. Byte-faithful skip discipline reviewed and approved.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # equal-image short-circuit; forward/lookup/prefix-delete keyed diffs; backingPkEqual
  - packages/quereus/src/vtab/backing-host.ts                  # NORMATIVE contract: value-identical upsert writes/reports nothing
  - packages/quereus/src/vtab/memory/layer/manager.ts          # host backstop in applyMaintenanceToLayer 'upsert'
  - packages/quereus/src/util/comparison.ts                    # rowsValueIdentical (byte-faithful identity)
  - packages/quereus-store/src/common/backing-host.ts          # store host aligned to rowsValueIdentical
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # § no-op write suppression probes (per arm + cascade)
  - packages/quereus/test/vtab/backing-host.spec.ts            # memory host skip / pending-compare / NOCASE non-skip pins
  - packages/quereus-store/test/backing-host.spec.ts           # store host skip + NOCASE byte-faithful pin (added in review)
  - docs/materialized-views.md                                 # § Value-identical (no-op) write suppression
  - docs/incremental-maintenance.md                            # arm annotations; delete-by-prefix "no longer produced" note
----

# Complete: no-op maintenance write suppression

A maintenance write whose recomputed backing image is value-identical to the effective
existing row writes nothing and reports nothing — no backing op, no effective
`BackingRowChange`, no MV-over-MV cascade — across all four bounded-delta arms. The
normative statement lives in `vtab/backing-host.ts` (`MaintenanceOp` `upsert` bullet);
both hosts implement it. Suppression operates at two layers: the inverse-projection
arm short-circuits an equal-image update before any backing-connection work, and the
host-level skip-identical upsert backstops every path that emits ops. The residual
arms were converted from delete-then-reupsert to keyed-diff apply (forward: upsert
replaces wholesale / point-delete on empty; lookup delete-capable: diff membership vs
in-scope; prefix-delete: diff recomputed fan-out vs `scanEffective` slice), so the
host skip turns unchanged members into zero effective changes. `'delete-by-prefix'`
is no longer produced by the engine but stays in the host contract (both hosts, pinned)
for future prefix-slice consumers.

## Review findings

Reviewed the implement diff (`5ac6ca3a`) fresh, then the handoff. All four arms traced
end-to-end for correctness, ordering hazards, collation behavior, and host parity.

**Deviation sign-off (the ticket's open question) — APPROVED.** The implement ticket
asked for a collation-aware skip mirroring `replace-all`; the implementation made the
point-op skip **byte-faithful** (`rowsValueIdentical`: per-column BINARY compare,
numeric-storage-class tolerant). This is the right call: `select` returns stored
bytes, so suppressing a collation-equal / byte-different write would leave the backing
observably divergent from the live body — exactly the latent floor bug the implementer
confirmed and filed as `fix/full-rebuild-replace-all-byte-fidelity` (collation-aware
`replace-all` skip leaves a NOCASE floor backing byte-stale). Collation correctly
still governs key *identity* everywhere (which row an upsert replaces; keyed-diff
pairing via `backingPkEqual`); only value *fidelity* is binary. The "one discipline"
aspiration is restored going forward by that fix ticket aligning `replace-all` to the
byte-faithful side, not by loosening the point op.

**Correctness checks performed (clean):**
- *Ordering hazards*: verified no arm can emit an upsert that a later delete kills.
  OLD entries always precede NEW (`addFrom` order, Map insertion order preserved);
  deletes precede upserts within each key pass; collation-equal recomputed/existing
  keys pair (never delete + replace); duplicate upserts across collation-equal OLD/NEW
  passes are idempotent (first re-keys, second is value-identical → suppressed).
- *NOCASE case-only base-PK rewrite (prefix arm)*: traced through both hosts. Memory's
  binary prefix scan finds the stored slice via the OLD-prefix pass (stored prefix
  bytes always equal the OLD image's) and finds nothing for the NEW byte-variant;
  the store's NOCASE-encoded prefix scan finds the slice in both passes — both
  converge via collation-aware pairing + host idempotence. Equivalence NOCASE suites
  are the oracle and are green.
- *Lookup delete-capable diff exactness*: membership and in-scope residuals project
  the same columns from the same live rows through the same pipeline, so the
  byte-canonical `canonKeyValues` set lookup is exact (in-scope ⊆ membership row-wise);
  a stale-stored-key scenario can't arise on the P-write path (a P write can't change
  T's key bytes — that's the forward path's job).
- *Effective-row compare*: both hosts compare against pending-over-committed
  (memory `lookupEffectiveRow`, store `readEffectiveRowByKey` with pending overlay),
  pinned by the upsert-back-to-committed-must-report tests.
- *Cascade consumers*: `maintainRowTime` is the only in-tree consumer of
  `applyMaintenance` results; it dispatches all three ops, so the residual arms'
  reporting change (one `update` instead of delete+insert) is handled — and halves
  consumer dispatches. `ingestExternalRowChanges` is inbound-only, unaffected.
- *Type safety / lint*: no `any`; `compareSqlValues` defaults undefined collation to
  BINARY (so `backingPkEqual`'s optional `d.collation` is sound); lint clean.

**Minor findings — fixed in this pass:**
- `vtab/backing-host.ts` `delete-by-prefix` bullet still said "used by the lateral-TVF
  fan-out arm" — stale since that arm now diffs. Rewrote to note the engine currently
  produces no `delete-by-prefix` and why it stays in the contract (matching the
  incremental-maintenance.md note).
- The handoff's flagged gap — no store-level pin of the byte-faithful (NOCASE
  non-skip) upsert — closed: added a store backing-host test in the DESC/NOCASE block
  pinning byte-identical → suppressed, collation-equal byte-different → `update` that
  re-keys the stored bytes. Passes.

**Major findings — none.** No correctness, soundness, or resource issues found.

**Follow-up tickets:**
- `fix/full-rebuild-replace-all-byte-fidelity` (spawned by implement, confirmed repro):
  align the floor's `replace-all` skip to byte-faithful.
- `backlog/inverse-projection-update-reporting-unification` (spawned by this review):
  the inverse-projection arm still reports delete+insert for a real same-key change
  (deliberately untouched by the implement ticket); unifying it to one `update` would
  complete the reporting-shape consistency and cut cascade dispatches/index churn.

**Accepted, documented limitations (no action):**
- `rowsValueIdentical`'s numeric-storage-class tolerance (bigint 5n ≡ number 5) could
  in principle suppress a representation-only rewrite — the same tolerance
  `replace-all` has always had; no in-tree path produces unstable representations.
- The prefix-arm pairing is O(|existing|·|recomputed|) per slice — linear scan, fine
  for realistic fan-outs; a collation-aware keyed map is the fix if it ever matters.
- The arm-level equal-image short-circuit trusts the maintenance invariant (backing
  row = old image's projection) rather than reading the backing; the host-level skip
  remains the effective-state backstop for every path that emits ops.

## Validation (review pass)

- `yarn build` (all packages) — clean.
- `yarn lint` (quereus) — clean.
- `yarn test` (all workspaces) — green: quereus 5775 passing / 9 pre-existing pending;
  store, isolation, sync, loader, CLI/web suites all passing. Includes the full
  maintenance-equivalence harness (NOCASE property + re-key suites, P-WHERE
  membership flips, rollback, OR FAIL) and the new per-arm no-op probes.
- Store backing-host spec re-run with full reporter including the new NOCASE
  byte-faithful pin — 27 passing.
- Grep-verified the engine no longer constructs `'delete-by-prefix'` (host
  implementations + contract/doc references only).
