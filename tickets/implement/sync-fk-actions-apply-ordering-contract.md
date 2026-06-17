description: Fix the sync docs that claim inbound foreign-key cascades on a replica need a "parents-before-children" ordering — they don't — and add a test proving the order doesn't matter for the realistic cases.
prereq:
files:
  - packages/quereus/src/core/database.ts                     # ingestExternalRowChanges seam docstring (~1953-1992): "order is semantic for FK actions ... parents-before-children"
  - packages/quereus/src/core/database-external-changes.ts    # ingestExternalRowChangeBatch — per-change FK-actions loop (the facet under audit); add the ordering contract comment
  - packages/quereus/src/core/database-internal.ts            # IngestExternalChangesOptions.applyForeignKeyActions doc
  - packages/quereus-sync/src/sync/store-adapter.ts           # seamBatch construction (~182-212): table-grouped first-appearance order
  - docs/sync.md                                              # § Apply-time validation (~434-446) — the self-contradictory "order-independent by construction" / "lone order-sensitive consumer" passage
  - docs/materialized-views.md                                # § External row-change ingestion — scan for any parents-before-children claim
  - packages/quereus/test/external-row-change-ingestion.spec.ts  # "foreign-key actions facet" describe — add the order-independence regression
difficulty: easy
----

# FK-actions apply path: correct the ordering contract (no reorder needed)

## Verified conclusion (do not re-litigate)

The opt-in parent-side FK-actions facet on the external-row-change seam
(`applyForeignKeyActions: true`) is **order-independent for every realistic
batch shape**, and the residual order-sensitive cases **cannot be fixed by any
seam-batch ordering**. The remaining work is therefore a documentation
correction plus a regression test — **not** a topological sort and **not** the
"defer RESTRICT to batch end" approach the original plan ticket floated (that
approach is broken — see below).

### Why it is order-independent in practice

The production adapter (`createStoreAdapter`) writes **every** table's inbound
rows straight to module storage (`StoreTable.applyExternalRowChanges`) and only
**then** makes a single `db.ingestExternalRowChanges` seam call. So by the time
the FK-actions facet runs, storage already reflects **all** direct writes in the
batch. Both facet primitives re-read current storage:

- `assertTransitiveRestrictsForParentMutation` — read-only RESTRICT walk.
- `executeForeignKeyActionsAndLens` — issues cascade/set-null/set-default DML
  that re-reads current child state.

Consequently these realistic shapes are provably order-independent:

- **single parent delete/update → cascade** (one change; nothing to order);
- **multiple independent parent mutations** over disjoint child subtrees;
- **a direct child write alongside a parent mutation** (the child's final state
  is already in storage before the facet runs);
- **parent re-key → cascade-update**.

### The two residual cases — exotic AND unfixable by ordering

- **(E) cross-change RESTRICT relief.** A child row referenced by **two** FKs —
  `RESTRICT → P` and `CASCADE → Q` — with both `P` and `Q` mutated in the same
  inbound batch. Whether `P`'s RESTRICT throws depends on whether `Q`'s cascade
  has already removed the shared child. The origin only committed because it ran
  `delete Q` before `delete P`; the seam batch (table-grouped, first-appearance
  `opSeq` order) does not preserve that intra-transaction DML order.
- **(F) divergent cascade-action overlap.** A child of two parents where one FK
  is `cascade-delete` and the other `set-null`; the final child state depends on
  which parent's action runs last.

Neither is fixable by reordering the seam batch:

- A **topological table sort** orders *tables*, not the cascade-vs-RESTRICT
  *evaluation* that case (E) hinges on, and cannot order self-referential or
  cyclic FK graphs at all.
- **"Defer all RESTRICT checks to the batch boundary" is wrong.** The transitive
  RESTRICT walk discovers a *deeper* RESTRICT by scanning
  `select * from child where fk = oldParentValues` and recursing. Run after the
  cascades, those child rows are already deleted, so the walk finds nothing and
  **silently misses the transitive RESTRICT**. The mirror ("all RESTRICT before
  all cascade") is the opposite error — it evaluates `P`'s RESTRICT before `Q`'s
  relieving cascade and throws spuriously.

Both (E) and (F) stem from the seam batch not carrying the origin's
intra-transaction DML order — which it fundamentally cannot reconstruct from a
table-grouped change set. The correct guidance for deployments with such
topologies is the one the architecture already prescribes:

- keep `applyForeignKeyActions` **off** (the default) and let the replication
  stream carry the origin's cascade effects; or
- declare the referential invariant as a **global assertion** on the receiver —
  evaluated over the merged state at the batch boundary, order-independent by
  construction, and able to cover self-referential / cyclic FK shapes.

### What is actually wrong today (the defect to fix)

The docs **overclaim an ordering requirement that is neither met nor needed**,
and `docs/sync.md` contradicts itself:

- `database.ts` seam docstring: *"`changes` is a flat ORDERED array (order is
  semantic for FK actions and capture: origin order = parents-before-children
  etc.)"* — the FK-actions facet does **not** require parents-before-children,
  and the producer (`store-adapter`) does not deliver it (it delivers
  table-grouped first-appearance `opSeq` order).
- `docs/sync.md` § Apply-time validation (~434-446) calls FK actions both
  *"order-independent by construction"* **and** *"the lone order-sensitive
  consumer."* Reconcile to the verified truth: order-independent for realistic
  shapes; the only order-sensitivity is the exotic (E)/(F) topologies above,
  which no ordering fixes and which the FK-actions-off default / global
  assertions handle.

The RESTRICT-throws-and-deadlocks-retry concern (a genuine RESTRICT failure on
apply leaves the batch un-appliable and the consumer re-resolves it forever) is
a **separate failure-policy question**, tracked in
`tickets/backlog/sync-fk-actions-restrict-failure-policy.md` — do **not** fold
it into this ticket.

## Edge cases & interactions

- **Insert ordering is irrelevant** — the facet skips inserts (`change.op !==
  'insert'`) and child-side FK existence is never checked (trust boundary). The
  classic "child fact before parent fact" hazard does not exist on this path.
- **`pragma foreign_keys = off`** — facet is a full no-op even when opted in
  (existing test covers this; keep it green).
- **Atomicity on a genuine RESTRICT throw** — a throw still unwinds the batch's
  derived effects via the batch savepoint (existing `FK RESTRICT mid-batch`
  test). The externally-applied storage rows are the caller's and are not
  unwound — unchanged.
- **Capture facet** — do not assert an FK-style ordering requirement onto
  `captureChanges`; same-row changes are already collapsed to one op by
  `store-adapter`, and cross-row capture order does not change final watch sets.
  Only correct the FK-actions claim; leave capture wording accurate.
- **`store-atomic-multi-store-commit`** — if multi-store atomic commit later
  changes per-table coordinator topology, the seam-batch order may change, but
  the order-independence conclusion above is unaffected (global DML order is
  still not a parent-before-child guarantee — a txn may legitimately write
  child-first under deferred constraints).

## TODO

- Correct the `database.ts` `ingestExternalRowChanges` seam docstring: drop the
  "origin order = parents-before-children" claim for the FK-actions facet; state
  that the facet reads the merged post-write state and is order-independent for
  realistic shapes, naming (E)/(F) as the documented exotic limitations handled
  by FK-actions-off / global assertions. Keep any accurate same-row before-image
  ordering note for capture.
- Reconcile `docs/sync.md` § Apply-time validation (~434-446): remove the
  internal contradiction; replace with the verified contract + the (E)/(F)
  limitation note + the guidance (stream-carries-cascades default, or global
  assertion). Update the stale forward-reference that points at
  `tickets/backlog/sync-cross-table-apply-ordering.md`.
- Scan `docs/materialized-views.md` § External row-change ingestion for any
  parents-before-children / ordering claim on the FK-actions facet and reconcile
  it to the same contract.
- Add a short ordering-contract comment at the FK-actions block in
  `database-external-changes.ts` (the loop already documents the
  post-application RESTRICT timing — extend it to state cross-change
  order-independence + the (E)/(F) caveat) and a one-line note at the
  `seamBatch` construction in `store-adapter.ts` that the order is not a
  dependency order and is not required to be.
- Add a regression test in `external-row-change-ingestion.spec.ts` →
  `foreign-key actions facet` describe: build `p(id pk)`,
  `c(id pk, pid → p on delete cascade)` with two parent rows and a child each;
  `directWrite` both parent deletes; call `ingestExternalRowChanges` with the
  two parent-delete changes in **both** orders and assert `c` ends empty with no
  error either way (multi-parent cascade order-independence). Add a second case:
  a direct child delete plus its parent delete in both orders, both succeed.
- (Optional) Add a `it.skip`/documented test pinning case (E)'s known
  order-sensitive behavior so the limitation is discoverable in the suite; skip
  rather than assert, since the "wrong" order legitimately throws.
- Run `yarn test` for `@quereus/quereus` and `@quereus/quereus-sync`, and
  `yarn lint` in `packages/quereus`. Stream output per AGENTS.md.
