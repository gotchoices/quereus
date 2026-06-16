description: Order cross-table changes within an applied transaction by table dependency (parent-before-child) on the apply side, rather than relying on the producer's per-table `opSeq` arrival order. Surfaced while planning per-transaction HLC/opSeq grouping.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts     # applyChanges — applies a ChangeSet's data via applyToStore
  - packages/quereus-sync/src/sync/sync-manager-impl.ts      # opSeq assignment order (per-table arrival at engine commit)
----

# Cross-table parent-before-child ordering on apply

## Context

The per-transaction HLC/opSeq work (`sync-per-transaction-hlc-tick`,
`sync-getchangessince-transaction-grouping`) gives every fact a total order
`(wallTime, counter, siteId, opSeq)` and preserves **intra-table** write order
exactly (a store coordinator buffers its table's events in DML order). But `opSeq`
across **different** tables reflects the per-table coordinator commit order at the
engine transaction boundary, **not** the global DML interleave — because the store
has one `TransactionCoordinator` per table and they fire at their own commit during
the engine's connection-commit loop.

For most workloads this is fine and fully deterministic. The gap is narrow: a single
transaction that writes a **parent row in table A and a child row (FK → A) in table
B**, where B's coordinator happens to commit before A's. On apply, the child column
change would carry a lower `opSeq` than the parent and, if the apply path enforces FK
at fact granularity in opSeq order, could transiently reference a not-yet-written
parent.

## Why it's parked (not in the critical path)

- The apply path (`change-applicator` → `applyToStore`) writes a whole ChangeSet's
  data via a batched callback; FK enforcement timing depends on the store adapter, and
  current sync tests do not exercise a cross-table FK inside one transaction.
- The headline contract (intra-transaction atomicity, intra-table ordering,
  determinism) is delivered without this.

## What a fix would specify

- On apply, sort a ChangeSet's `changes` by **table topological order** (FK
  dependency: parents before children) as a stable secondary sort under `opSeq`,
  using the table schema's foreign-key graph — OR defer/relax FK checks to the end of
  the ChangeSet apply (apply-then-validate), consistent with how local multi-table
  transactions defer constraints.
- Decide whether ordering belongs on the **producer** (assign opSeq in dependency
  order when building the engine group) or the **consumer** (re-sort on apply).
  Consumer-side is more robust (it has the receiver's schema and doesn't depend on
  producer commit order).
- Add a two-replica integration test: a transaction inserting `parent(id)` and
  `child(parent_id FK→parent.id)`; sync to a peer; assert the apply succeeds
  regardless of the per-table commit order on the origin.

## Interactions

- `store-atomic-multi-store-commit` — if multi-store atomic commit lands, the
  per-table coordinator topology may change; revisit whether opSeq can then capture
  true global DML order directly.
