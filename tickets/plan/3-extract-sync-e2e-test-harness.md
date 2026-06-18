description: The sync engine's end-to-end tests each copy the same ~150-line setup boilerplate; pull it into one shared helper so future tests don't keep cloning it.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts
difficulty: easy
----

# Extract the shared real-engine sync test harness

Six sync test files (and counting) each carry their own verbatim copy of the
same real-engine peer harness: `createInMemoryProvider`, `collect`, `settle`,
the `Peer` interface, `makePeer` / `closePeer`, `localWrite`, `relay`,
`changesFor`, `flattenSets`, `hasOrders`, and the `COLUMNS_PER_FRESH_INSERT`
constant. The two e2e suites (`store-and-forward-relay-e2e.spec.ts` and
`sync-drain-e2e.spec.ts`) are near-identical for ~200 lines.

This is straightforward copy-paste tech debt that predates the drain-integration
ticket (which simply added the latest copy). It violates the repo's DRY rule and
means a harness fix (e.g. tightening `settle`, or a `Peer` field change) must be
applied in N places.

## Goal

Move the common harness into a single test-only module — e.g.
`packages/quereus-sync/test/sync/_peer-harness.ts` — and have each suite import
it. Keep per-suite divergence as **options**, not forks:
- `makePeer` already varies by `{ createOrders, disposition, ordersDdl }` — keep
  those as the shared signature.
- The drain suite's `reviveOrders(peer, ddl?)` helper is drain-specific; decide
  whether it lives in the shared module or stays local to that spec.

## Acceptance

- No e2e spec defines its own `createInMemoryProvider` / `makePeer` / `relay` /
  `settle` etc.; all import from the shared module.
- `node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-sync/test/**/*.spec.ts"`
  stays green (was 412 passing).
- `tsc -p packages/quereus-sync/tsconfig.test.json` stays exit 0.

## Notes

Not urgent and not a correctness risk — purely maintainability. Touches five
currently-passing suites, so it was deliberately *not* done inline during the
drain-integration review (too broad a blast radius for a review pass); filed
here instead.
