description: Audit (and if needed, order) the seam batch handed to the opt-in parent-side FK *actions* path on apply. The originally-feared hazard — a child fact applied before its parent tripping a child-side FK-existence check — cannot occur: the apply path is trust-the-origin and re-validates no declared constraint. The residual, narrower concern is cross-table ordering for `applyForeignKeyActions: true` cascades.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts          # createStoreAdapter — direct storage write + one ingestExternalRowChanges seam call; builds seamBatch table-grouped
  - packages/quereus/src/core/database-external-changes.ts   # ingestExternalRowChangeBatch — trust-the-origin seam; FK actions consume the ordered batch
  - packages/quereus/src/runtime/foreign-key-actions.ts      # executeForeignKeyActionsAndLens / assertTransitiveRestrictsForParentMutation
----

# Cross-table ordering on apply (FK-actions path only)

## Premise correction (was: parent-before-child FK-existence hazard)

The original ticket assumed the apply path "enforces FK at fact granularity in opSeq
order", so a child column-change carrying a lower `opSeq` than its parent could
transiently reference a not-yet-written parent. **That cannot happen on the production
apply path.** Tracing `createStoreAdapter` (the `applyToStore` implementation):

1. Inbound data is written **straight to module storage** via
   `StoreTable.applyExternalRowChanges`, bypassing the DML executor — so there is **no**
   per-row CHECK / NOT NULL / UNIQUE / child-side FK-existence check at write time.
2. A single end-of-invocation seam call, `db.ingestExternalRowChanges`, drives the
   post-write pipeline (capture, commit-time global assertions, MV maintenance, opt-in
   FK actions). The seam is **trust-the-origin**: it re-validates *nothing* — explicitly
   including child-side FK existence (`database.ts` `ingestExternalRowChanges` doc;
   `docs/materialized-views.md` § Trust boundary; `docs/sync.md` § Apply-time validation).

So there is no fact-granular FK check anywhere on the path for cross-table opSeq order
to break. The two facets that *are* enforced run over the **merged state at the batch
boundary**, after every fact has landed, and are therefore order-independent:

- **Global assertions** — the natural home for referential invariants you want the
  *replica* to enforce. Being boundary-evaluated, they also handle **self-referential**
  and **cyclic** FK shapes that no topological *table* sort can order (the original
  motivation for preferring apply-then-validate over topo-sort).
- **Opt-in parent-side FK actions** (`applyForeignKeyActions`, default **off**).

## Residual concern (the actual remaining work)

When a deployment turns **`applyForeignKeyActions: true`** on, the seam consumes
`changes` as a flat ORDERED array whose order is semantic (the seam doc states
"origin order = parents-before-children"). But `createStoreAdapter` builds `seamBatch`
by iterating `groupChangesByTable(...)` — i.e. **table-grouped in first-appearance
`opSeq` order**, which is exactly the per-coordinator commit order (not the global DML
interleave, and not a dependency order). A cross-table transaction whose child table
happens to sort first would feed the FK-actions/RESTRICT logic child-before-parent.

This is a different, narrower concern than child-side FK existence:
- It only bites with `applyForeignKeyActions: true` (off by default; a replication
  stream usually already carries the origin's cascade effects).
- It concerns parent-side **actions** (cascade / set-null / RESTRICT) and the
  transitive-RESTRICT assertion, not existence checks.

## What a fix would specify

- Decide whether the FK-actions path actually requires parent-before-child seam-batch
  order, or whether `executeForeignKeyActionsAndLens` /
  `assertTransitiveRestrictsForParentMutation` are already order-insensitive (they
  re-read current state). **Verify before ordering anything** — the simplest correct
  outcome may be "no change needed; document the contract".
- If ordering is required: build `seamBatch` in a dependency-respecting order
  (consumer-side topological table sort using the receiver's FK graph), OR have the
  FK-actions facet defer its RESTRICT/transitive checks to the end of the batch
  (apply-then-validate), consistent with how local cross-table constraints defer to
  commit. Prefer the defer approach — it is robust to self-referential and cyclic FKs
  that a table sort cannot order.
- Consumer-side (receiver has its own schema) is the right home regardless; do **not**
  push this onto producer opSeq assignment.

## Test to add (only if a real ordering dependency is confirmed)

- Two-replica integration test with `applyForeignKeyActions: true`: a transaction
  inserting `parent(id)` and `child(parent_id FK→parent.id)` plus a parent
  delete/key-update that should cascade; assert the cascade applies correctly
  regardless of the per-table commit order on the origin.

## Interactions

- `store-atomic-multi-store-commit` — if multi-store atomic commit lands, the per-table
  coordinator topology may change; revisit whether opSeq can then capture true global
  DML order directly (a fidelity nice-to-have, but note: global DML order is still **not**
  a parent-before-child guarantee — a transaction may legitimately write child-first
  under deferred constraints).
- `docs/sync.md` § Transactional Integrity During Sync → *Apply-time validation* and
  `docs/materialized-views.md` § Trust boundary are the authoritative statements of the
  trust-the-origin contract this ticket now rests on.
