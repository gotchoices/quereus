description: The IndexedDB storage plugin is tested with a Node stand-in for the browser's IndexedDB, which is fast but not the real thing; this asks whether to add a small test that runs it in an actual browser to catch behavior the fake can't reproduce.
files:
  - packages/quereus-plugin-indexeddb/test (8 specs, all on fake-indexeddb today)
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/manager.ts (open/upgrade lifecycle — most likely to diverge from real IndexedDB)
----

## Decision already made (do not re-open in this ticket)

The parent plan (`test-coverage-and-build-tooling`) and the KVStore conformance work
(`test-kvstore-conformance-suite`) settled the **default test harness** for IndexedDB:
**Node `fake-indexeddb`**. It is already in use — the plugin ships 8 specs importing
`fake-indexeddb/auto`, and the plugin's `test` script runs them under mocha in Node.
That stays the primary, fast, CI-friendly path. This ticket is **only** the optional
real-browser supplement.

## What this ticket asks

Whether to stand up a **small real-browser smoke run** (Playwright / headless-Chromium,
or a Karma-style runner) that executes a subset of the IndexedDB store tests against a
**real** IndexedDB implementation — catching the things `fake-indexeddb` can't fully
model: actual `onupgradeneeded` / version-change transaction semantics, real
`objectStore` key ordering and structured-clone edge cases, and browser
quota/blocking behavior.

## Why it is backlog, not active work

- `fake-indexeddb` already covers the behavioral contract the conformance suite pins;
  the marginal bugs a real browser would additionally catch are lifecycle/quirk edge
  cases, not the common path.
- Standing up a browser runner adds real tooling weight (a headless browser in the test
  pipeline) for that marginal gain. Not worth it until a `fake-indexeddb`-invisible bug
  actually bites, or the plugin's browser lifecycle logic grows more complex.
- CI is explicitly out of scope by product decision (per the parent plan), and a
  browser smoke run is most valuable wired into CI — so it is premature now.

## When to promote

Promote when **either** a real-IndexedDB-only bug ships (something green under
`fake-indexeddb` but broken in a browser), **or** a CI pipeline exists to host a
headless-browser job. Keep it a *smoke* run (a handful of round-trip + upgrade cases),
not a full re-run of the suite — the fake-env suite remains the exhaustive one.
