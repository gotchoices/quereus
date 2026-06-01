description: Per-row identity-capture RETURNING for multi-source (inner-join) view UPDATEs. Replaced the old loud rejection of "update rewrites its own WHERE predicate column" with capture-base-PK-identities-pre-mutation + re-query-by-identity-post-mutation. DELETE path unchanged (pre re-query). Reviewed and completed.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, docs/view-updateability.md

## What shipped

`update <join-view> set <pred-col> = … where <pred-col> = … returning …` now returns
the post-mutation, view-projected rows for exactly the updated rows — matching the
single-source NEW path and Postgres — instead of being loudly rejected.

### Mechanism (multi-source UPDATE RETURNING)

1. **Capture (pre):** `buildMultiSourceUpdateReturning` builds a capture SELECT
   `select s0.pk0 as k0, s1.pk1 as k1 from <body FROM clone> where <idPredicate>` —
   the affected view rows' base-PK identities, by the same identifying predicate the
   base ops route on (`preserveInputColumns=false` ⇒ output is exactly `[k0, k1]`).
2. The emitter materializes the capture rows into `rctx.tableContexts` under a shared
   `TableDescriptor` **before** draining the base ops, removing the entry in `finally`.
3. Base UPDATE ops run unchanged (`decomposeUpdate`).
4. **Re-query (post):** the join body is re-queried, projecting the view-spelled,
   base-term RETURNING columns (incl. `*` expansion), filtered by `exists (select 1
   from __vmret_keys k where k.k0 = s0.pk0 and k.k1 = s1.pk1)` via an
   `InternalRecursiveCTERefNode` carrying the same descriptor. The re-query keeps only
   the structural join ON-condition; it does **not** re-apply the body/user WHERE.

`ViewMutationNode` gained a `returningCapture?: { source, descriptor }` field threaded
through `getChildren` / `withChildren` / `toString` / `getLogicalAttributes` (excluded
from `getRelations`, mirroring the envelope source — it is a context side-input, not
forwarded output). DELETE path unchanged (`pre` re-query of the view by user predicate).
The old loud-rejection guard and its `collectColumnRefNames` helper were removed.

## Review findings

Adversarial pass over the implement diff (commit `0e12b3f1`). Reviewed from SPP / DRY /
modularity / type-safety / resource-cleanup / error-handling / scalability angles; read
every touched file plus the integration points (`InternalRecursiveCTERefNode`,
`buildSelectStmt`, `emitInternalRecursiveCTERef`, the fork-contract allowlist).

### Checked — correctness / mechanism
- **Descriptor identity through optimization** — the capture descriptor is shared between
  `returningCapture.descriptor` and the re-query's `InternalRecursiveCTERefNode`.
  `withChildren` preserves both (the ref node is a `ZeroAry` leaf → returns `this`; the
  capture descriptor is threaded explicitly). Confirmed sound; end-to-end tests exercise
  the context read/write match.
- **Fork-contract** — the new `tableContexts.set/delete` lives in `view-mutation.ts`,
  already on `TABLE_CONTEXTS_MUTATION_ALLOWLIST`; set-before-drain / delete-in-finally
  means no parent mutation while forks are alive (same pattern as the insert envelope).
- **`getRelations` exclusion of the capture source** — correct, not a defect: the
  capture's `k0/k1` attrs are never forwarded as node output (the `returning` re-query
  is); mirrors the envelope source.
- **`collectColumnRefNames` removal** — clean; the surviving copies in `lens-compiler.ts`
  / `lens-prover.ts` are independent private helpers.
- **DELETE path** — unchanged (`pre` view re-query), verified.
- **Lint** clean; **full `yarn workspace @quereus/quereus test`** green (4260 passing, 0
  failing, 9 pending).

### Found — minor, fixed inline (this pass)
- **Tests were a floor.** The implementer's 93.4 § RETURNING (d) covered the core
  predicate-clash capture cases but left the *headline* claims untested. Added 93.4
  § RETURNING (e):
  - **push-out-of-filter NEW semantics** — a join view *with a body WHERE* where an
    update moves a row out of the filter: the row is still RETURNED (match-by-identity,
    body WHERE not re-applied) yet vanishes from a subsequent view SELECT. This was the
    central correctness claim and had **zero** coverage.
  - **renamed + computed view columns** (`id←cid`, `quantity←qty`, `dbl=qty*2`,
    `label←lbl`) through the new `buildReturningProjection` — surface under view spelling,
    computed re-evaluated post-update.
  - **empty-match → empty RETURNING** (EXISTS over zero captured identities; no error).
- **Composite-PK scope change locked.** Per-row capture stitches on BOTH sides'
  single-column PKs, so a multi-source `update … returning` through a join view whose
  **non-written** side has a composite PK is now rejected — whereas the old view-re-query
  path (no both-PK requirement) would have returned rows for a non-clash predicate. This
  is an intentional, narrow scope reduction (the capture mechanism is strictly more
  correct), but it is a real behavior change, so it is now locked with a 93.2 rejection
  test plus a companion confirming the same update **without** RETURNING still works
  (identified by the written side's PK alone). Nit (not fixed): the diagnostic reuses the
  shared single-column-key message rather than a RETURNING-specific one — acceptable; a
  dedicated message would require either a pre-check or branching `requireSingleColumnPk`.

### Found — major, filed (out of scope for this RETURNING ticket)
- **Both-sides + parent-predicate-clash base-decomposition ordering bug.** A multi-source
  update assigning **both** sides while predicating on the **FK-parent's reassigned
  column** drops the FK-child's base mutation (the parent op rewrites the predicate column
  before the FK-child op's live identifying subquery runs). Reproduces **without**
  RETURNING — it is a `decomposeUpdate` ordering defect orthogonal to RETURNING capture
  (the capture re-projects correctly). Confirmed genuinely out of scope; the existing
  `tickets/fix/view-mutation-multisource-both-sides-predicate-clash.md` captures it
  faithfully (repro, Postgres-expected behavior, up-front-capture fix direction,
  acceptance incl. restoring the parent-predicate-clash assertion in 93.4 (d)). 93.4 (d)
  statement 3 is correctly predicated on the child column to avoid this until the fix.

### Checked — noted, no action (acceptable as-is)
- **`analyzeJoinView` runs twice** per update-with-returning (once via `decomposeUpdate`,
  once in `buildMultiSourceUpdateReturning`). A perf nit matching the prior pattern; not a
  correctness issue.
- **Synthetic `k` alias / `__vmret_keys` name** in the EXISTS could in principle collide
  with a base table a view aliases as `k` (or named `__vmret_keys`). Extremely unlikely;
  the double-underscore name is collision-safe by convention. Left as a latent edge.
- The emitter's `update without capture` branch is unreachable today (update always sets a
  capture) but is a clearly-commented defensive guard — kept.

### Follow-up tickets (already present, not created here)
- `tickets/fix/view-mutation-multisource-both-sides-predicate-clash.md` (the major finding
  above).
- `tickets/implement/view-roundtrip-laws-multi-source.md` (a separate property-harness
  ticket the implementer spawned to give the multi-source backward walk mechanical
  round-trip coverage — independent of this RETURNING work).

## Validation
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 4260 passing / 0 failing / 9 pending.
- Targeted: `--grep "93\."` — all four view-mutation logic files pass with the added
  93.4 (e) and 93.2 rejection cases.
