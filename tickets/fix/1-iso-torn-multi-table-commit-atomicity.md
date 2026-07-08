description: When a transaction changes rows in more than one table and something fails partway through committing, some tables can be left permanently saved while others are lost, leaving the data half-applied.
prereq: store-atomic-batch-capability
files:
  - packages/quereus-isolation/src/isolated-connection.ts  # commit/flush orchestration (line ~49)
  - packages/quereus-isolation/src/isolated-table.ts        # per-table flush (line ~315)
  - packages/quereus-isolation/src/isolation-module.ts      # line ~106
  - docs/design-isolation-layer.md
difficulty: hard
----

## Problem

When an isolated transaction has touched multiple tables, each table flushes its
pending changes in its **own** underlying transaction at commit time. If table A
flushes successfully and then table B's flush fails, table A's changes are already
**durably committed** while table B's are rolled back. The multi-table transaction is
torn: the store is left in a state that never existed logically, and the caller gets
a failure after some of its writes already persisted.

This is distinct from the (deliberately not-implemented) snapshot-isolation concern —
it is a straightforward atomicity defect in how commit coordinates the per-table
flushes.

## Expected behavior

A commit that spans multiple tables must be all-or-nothing from the caller's
perspective: either every table's pending changes land, or none do. A failure while
flushing any table must not leave earlier tables' changes durably committed.

## Direction and scope

True cross-table atomic durability ultimately depends on the underlying store's
ability to apply a **single atomic batch** across all the affected tables. That
capability was added under `2-store-atomic-batch-capability` (complete). This ticket
should:

- Investigate whether the isolation layer can route all per-table flushes for one
  commit through a **single underlying transaction / atomic batch** rather than one
  transaction per table, using the store's atomic-batch capability where the
  underlying advertises it.
- Where the underlying store exposes atomic multi-table batching, coordinate the whole
  commit through it so a mid-flush failure rolls back everything.
- Where the underlying store cannot guarantee cross-table atomicity, the isolation
  layer cannot manufacture it — in that case the goal is **fail-safe** behavior: detect
  partial-flush failure and surface it unambiguously (and, where possible, avoid
  leaving earlier tables committed), rather than silently tearing. Document clearly
  that full atomicity is contingent on the underlying store's capability.

Keep the fix scoped to what the isolation layer can control: commit orchestration and
its use of the underlying atomic-batch seam. Do **not** attempt to build a distributed
two-phase commit across independent stores.

## Investigation to do

- Trace the current commit/flush path: `isolated-connection.ts` commit → per-table
  flush in `isolated-table.ts`. Confirm each table opens its own underlying
  transaction and identify where a single coordinated batch could be substituted.
- Determine how the underlying store's atomic-batch capability
  (`2-store-atomic-batch-capability`) is discovered and invoked, and whether the
  isolation layer already has access to that seam.
- Build a reproducing test: a transaction writing to two tables where the second
  table's flush fails (e.g. injected error or UNIQUE violation), asserting the first
  table's changes did **not** durably commit.
- Decide and document the fallback contract for stores lacking atomic batching.
