description: Added an end-to-end test proving edits made while a table was missing really reappear in the re-created table — and that live queries and views react to them — by driving the real storage engine instead of a stub.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # the real-adapter drain (revival) e2e suite — now 6 its
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts    # harness cloned from here (unchanged)
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts      # the stub-store revival block this hardens (unchanged)
  - packages/quereus-sync/src/sync/change-applicator.ts                    # drainHeldChanges / drainTableGroup under test (unchanged)
  - packages/quereus-sync/src/sync/store-adapter.ts                        # createStoreAdapter → db.ingestExternalRowChanges seam (unchanged)
  - docs/sync.md                                                           # Revival / drain section cites the new e2e (unchanged this pass)
difficulty: easy
----

# Complete: real-store integration test for the held-change drain (revival)

## What shipped

A new **test-only** suite, `packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts`,
plus a one-paragraph update to `docs/sync.md` § Unknown-Table Disposition → Revival /
drain. **No production code changed.** The suite drives REAL `Database` + `StoreModule`
+ `createStoreAdapter` peers so the drain's `admitGroup` → store adapter →
`db.ingestExternalRowChanges(...)` seam actually runs — the path the in-memory stub in
`unknown-table-disposition.spec.ts` cannot exercise (the stub fires only
`onRemoteChange`; it never touches the engine, so it cannot prove watch capture or MV
maintenance).

Implement landed 5 `it`s; this review pass added a 6th (drain-before-revive no-op),
for **6 passing**.

## Review findings

**Method.** Read the implement diff (`git show f29d3892`) with fresh eyes before the
handoff summary, cross-read the cloned relay-e2e harness, and verified the production
seams the assertions pin (`drainHeldChanges` / `drainTableGroup` in
`change-applicator.ts:339-449`, the basis gate, the schema-drift filter, and the
`HeldChangesDrainedEvent {schema, table, drained, applied, skipped}` shape). Ran the
spec, the full sync suite, and the test type-check gate.

### Correctness — no defects found
- The 5 implement-stage assertions are real, not tautological: each would fail if the
  drain stopped materializing rows, lost S's origin HLC, stopped firing watch/MV, threw
  on absent-pk deletes, kept forwarding, or mis-counted the drift drop. Verified each
  against the source: `applied: 2, skipped: 1` matches `drainTableGroup`'s drift filter
  (column not in `columnSet` ⇒ `skipped++`, never sent to `resolveChange`); `drained ===
  group.changes.length`; idempotent re-drain returns 0 via the early `held.length === 0`
  guard and fires no event. All consistent with the code paths.
- Origin-identity, no-echo, and second-order-relay assertions mirror the relay e2e
  exactly and are sound (S-origin excluded from `changesFor`, present under a random
  exclusion siteId).

### Coverage — one gap closed inline (minor)
- **Added test:** `a drain BEFORE the table is re-created is a genuine no-op`. The suite
  as delivered always did relay → revive → drain; it never exercised the core safety
  invariant at the real-adapter level — that the basis gate (`columns === undefined ⇒
  return 0`, `change-applicator.ts:377-378`) keeps held changes durable and does NOT
  prematurely materialize (or conjure the table / consume the hold) when the table is
  still absent. New test asserts drain returns 0, fires no drained event, leaves the
  table undefined and the hold intact, and that a *subsequent* revive+drain still
  materializes (the entries were neither consumed nor corrupted). Passes.
- Deferred-by-design coverage the implementer flagged (crash/partial-failure invariant,
  LWW-against-fresh-data convergence, per-row watch `hits` shape) is genuinely
  unit-covered elsewhere on the same `resolveChange`/`admitGroup` functions; agreed these
  add low marginal value end-to-end and were correctly not duplicated.

### Maintainability — one major finding filed, not fixed inline
- **DRY violation (pre-existing, widespread):** six sync test files each carry a verbatim
  copy of the real-engine peer harness (`createInMemoryProvider` / `makePeer` / `relay` /
  `settle` / `Peer` / etc.); the two e2e suites are ~200 near-identical lines. This ticket
  added the latest copy but did not originate the debt. Extracting a shared module touches
  five currently-passing suites — too broad for a review pass — so filed as
  `tickets/backlog/extract-sync-e2e-test-harness.md` rather than fixed here.

### Docs — accurate
- The `docs/sync.md` revival/drain paragraph now correctly cites `sync-drain-e2e.spec.ts`
  for materialization, origin-HLC, watch+MV, absent-pk delete no-op, forwardable
  lifecycle, and schema-drift drop. Matches the suite. Read the touched section; no other
  doc references the drain claim as a "hardening follow-up" anymore.

### Type safety / cleanup
- No `any`, unused-arg, or eaten-exception issues. Tabs/idiom match the sibling suite.
  Resource cleanup is correct: per-test peers tracked and closed in `afterEach`; the
  test-2 watch sub is unsubscribed.

## Validation performed (this pass)
- `node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts"` → **6 passing**.
- Full sync suite (`packages/quereus-sync/test/**/*.spec.ts`) → **412 passing**, 0 failing.
  (The `failingKv.iterate` stack-trace in the log is deliberate failure-injection from
  `sync-manager.spec.ts`, not a failure — `0 failing`.)
- `tsc -p packages/quereus-sync/tsconfig.test.json` (strict, includes `test/**`) → exit 0.

## Follow-ups
- `tickets/backlog/extract-sync-e2e-test-harness.md` — dedupe the cloned real-engine sync
  test harness across the six suites.
