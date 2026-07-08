description: The isolation layer's documentation promises a stronger consistency guarantee than the code actually provides, which will mislead anyone relying on it; correct the docs to describe what really happens.
files:
  - packages/quereus-isolation/README.md            # line ~10 claims "Snapshot isolation — Consistent reads throughout the transaction"
  - docs/design-isolation-layer.md                  # line ~5 claims "snapshot isolation"; sweep whole doc for the same claim
  - packages/quereus-isolation/src/isolated-table.ts # lines ~315, ~1325 — merge reads live shared underlying
  - packages/quereus-isolation/src/isolated-connection.ts # line ~49
difficulty: easy
----

## Problem

The isolation layer (`@quereus/isolation`) is documented as providing **snapshot
isolation**: `packages/quereus-isolation/README.md:10` says *"Snapshot isolation —
Consistent reads throughout the transaction"* and `docs/design-isolation-layer.md:5`
says the layer provides *"read-your-own-writes, snapshot isolation, and savepoint
support."*

The implementation does **not** deliver snapshot isolation. Reads merge the
connection's overlay with the **live, shared underlying table**
(`isolated-table.ts:315,1325`), so another connection's committed writes become
visible mid-transaction. There is also no write-write conflict detection — the last
connection to flush wins. In database terms the actual behavior is closer to
**read-committed with read-your-own-writes**, not snapshot isolation.

This is a documentation defect, not a code defect. The team has decided **not** to
implement true snapshot isolation or write-write conflict detection in this layer:
providing a stable snapshot of the underlying data is the responsibility of whatever
storage module is layered *beneath* the isolation layer. If a future consumer needs
true snapshot semantics, the intended path is an optional snapshotting pass-through
module inserted below isolation — not changes here.

## Expected behavior

The documentation in **both** packages should state the guarantee the code actually
provides:

- **Read-your-own-writes**: a connection always sees its own uncommitted changes.
- **Read-committed-style reads of shared state**: reads see the *live* underlying
  table, so other connections' committed writes can appear mid-transaction. Reads are
  **not** a stable snapshot.
- **No write-write conflict detection**: concurrent writers are not detected; the last
  flusher wins.
- **Snapshotting is delegated downward**: true snapshot isolation, if required, is the
  job of the module layered beneath this one. Note that an optional snapshotting
  pass-through module may be added later if a consumer needs it.

Do **not** implement snapshot isolation or conflict detection as part of this ticket.
This is purely a docs correction so the promised guarantee matches reality.

## Use case

A developer reads the README, assumes their long-running read transaction sees a
frozen snapshot, and builds logic on that assumption. Under the real behavior their
reads shift under them when another connection commits — a correctness surprise the
docs actively caused. Corrected docs prevent that mistake.

## TODO

- Rewrite the "Snapshot isolation" bullet in `packages/quereus-isolation/README.md`
  to describe read-committed + read-your-own-writes, live shared reads, and no
  write-write conflict detection.
- Update `docs/design-isolation-layer.md` (line ~5 and anywhere else it claims
  snapshot isolation) to the same actual guarantee; keep the savepoint/read-your-own-
  writes claims that are true.
- In both places, state that stable-snapshot semantics are delegated to the
  underlying module, and note the possible future optional snapshotting pass-through.
- Grep both packages (and `docs/`) for any other "snapshot isolation" / "consistent
  reads" phrasing and reconcile it.
