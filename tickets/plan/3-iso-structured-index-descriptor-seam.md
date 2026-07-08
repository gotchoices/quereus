description: The isolation layer figures out which index a query will use by parsing a private text string produced by the storage module, a brittle coupling that silently falls back to slow full scans when it cannot read the string; give the engine a proper structured way to describe the chosen index instead.
files:
  - packages/quereus-isolation/src/isolated-table.ts   # lines ~449, ~1022 — parses "idx=name(n);plan=2"; UNIQUE checks full-scan
  - packages/quereus/src/vtab/                          # FilterInfo / BestAccessPlanResult (public access-planning types)
  - packages/quereus-isolation/test/                    # only ~4 specs today — thin
  - docs/design-isolation-layer.md
difficulty: hard
----

## Problem

The isolation layer needs to know which underlying index a scan will use so it can merge
its per-connection overlay correctly. Today it gets that by **string-parsing a private
wire format** the storage module emits — a string shaped like `"idx=name(n);plan=2"`
(`isolated-table.ts:449,1022`). This couples the two packages through an **unversioned,
undocumented string**: if the store changes the format, or emits a shape the isolation
layer does not recognize, parsing silently fails and the layer **degrades to a full
scan** with no error — a quiet performance cliff.

The root cause is a missing public seam in the engine: there is no **structured index
descriptor** on the access-planning result. The isolation layer is forced to reverse-
engineer the store's internal `idxStr` because the engine gives it nothing better.

Two related weaknesses live in the same area:

- **UNIQUE checks full-scan the underlying.** The merged UNIQUE-constraint checks scan
  the whole underlying table instead of pushing an equality predicate. On a large table
  every constrained write pays a full scan.
- **The isolation layer has only ~4 test specs** — far too thin for a module that sits
  in the transactional read/write path and does subtle merge logic.

## Expected behavior / direction

**Add a small, public, structured index descriptor to the engine's access-planning
seam.** When the planner/store resolves an access path, the chosen index should be
describable through a typed structure on `FilterInfo` / `BestAccessPlanResult` (in
`packages/quereus/src/vtab/`) — index name, the columns/key it covers, the plan kind,
direction, etc. — rather than only as an opaque `idxStr` string. Consumers like the
isolation layer read that structure instead of parsing text.

Design questions to resolve in this plan before emitting implement tickets:

- What is the minimal descriptor shape that satisfies the isolation layer's needs
  (identify exactly what it currently extracts from `"idx=name(n);plan=2"`) without
  over-fitting to one consumer?
- How does the descriptor coexist with the existing `idxStr` (stores still need their
  private encoding for their own `xFilter`)? Likely: the store continues to produce
  `idxStr` for itself, and *additionally* populates a structured descriptor the engine
  surfaces publicly.
- Unrecognized/absent descriptor: full-scan fallback must be an **explicit, logged**
  decision, not a silent parse failure.

Separately (can be a sibling implement ticket): make the merged UNIQUE checks push an
**equality FilterInfo** to the underlying instead of full-scanning, and **broaden the
isolation test suite** to cover the merge/scan/constraint paths (index selection,
bigint/collation keys, tombstone revival, multi-table commit) rather than the current
~4 specs.

## Notes

- This is a cross-package API design task (engine `vtab` seam + isolation consumer), so
  resolve the descriptor shape here and hand off concrete implement tickets.
- Coordinate with `1-iso-modified-pk-bigint-collation-tombstone-unique` — the UNIQUE-
  check improvements touch adjacent code; sequence to avoid collisions.
