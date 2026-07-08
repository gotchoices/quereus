description: The test coverage across the project's packages is uneven — some layers are barely tested, some end-to-end paths and browser-only code are never exercised — and the build is a long hand-maintained chain that ignores the faster tooling already half-configured; plan how to close the coverage gaps and modernize the build.
prereq: test-add-missing-scripts
files:
  - package.json (root — sequential 16-script build chain; test / lint fan-out)
  - packages/quereus-isolation/test (only 4 specs)
  - packages/quereus-sync/test (26 specs — comparative baseline)
  - packages/quereus-store/test (35 specs — comparative baseline)
  - packages/sync-coordinator/src (no end-to-end sync test through it)
  - packages/quereus-plugin-indexeddb (no browser-environment execution)
  - packages/*/tsconfig.json (composite: true set; tsc -b project references unused)
difficulty: medium
----

## Problem

Test coverage and build tooling across the monorepo are uneven. The mechanical
"every package has a script" gap is handled separately in
`test-add-missing-scripts` and the `yarn check` fan-out in
`test-yarn-check-runs-everything`; this ticket owns the **deeper** gaps that need
design, not just a script entry.

### Coverage unevenness

- **`quereus-isolation` is thinly tested**: 4 specs, for a snapshot-*isolation*
  layer, versus `quereus-sync` at 26 and `quereus-store` at 35. Isolation
  correctness (snapshot semantics, write-write conflict behavior) is exactly the
  kind of thing that needs adversarial tests, and 4 specs cannot be covering it.
  Note: the review also flags that the isolation layer's *documented* guarantees
  may not match its *implemented* guarantees (strategic rec #3, tracked elsewhere) —
  coordinate so new isolation tests assert the intended semantics, not the current
  ones, if those diverge.
- **`quoomb-cli` and `shared-ui` run `vitest --passWithNoTests` with no test
  files** — green while testing nothing. Decide whether each deserves real tests or
  is genuinely trivial (and mark the empty green with a `NOTE:` if kept).
- **No end-to-end sync test through the coordinator**: client and coordinator are
  tested in isolation, but no test drives a real sync round-trip through the
  `sync-coordinator`. Given the client/coordinator codecs have already drifted
  (strategic rec #4), an e2e test through the coordinator is the check that would
  catch protocol skew.
- **No browser-environment execution for the IndexedDB plugin**: it is only
  runnable in a browser/IndexedDB environment, and nothing runs it there. (Overlaps
  with `test-kvstore-conformance-suite`, which must also decide Node-fake vs.
  real-browser for IndexedDB — settle the approach once, shared between the two.)
- **No cross-package version-skew testing**: nothing checks that packages at
  slightly different versions still interoperate (relevant to the drifting sync
  protocol and shared serialization).

### Build tooling

- **The root build is a sequential 16-script `cd`-chain** (`build:engine &&
  build:loader && … && build:web`). It is hand-maintained and fully serial.
- **`composite: true` is set but `tsc -b` project references are unused**: the
  TypeScript project-reference machinery that would let the build understand
  inter-package dependencies (and build them incrementally / in the right order
  automatically) is half-configured and not driving the build. Wiring real project
  references would replace the hand-ordered chain with a dependency-aware
  incremental build.

## Goal

A plan (and, where the work is clearly scoped, follow-on implement tickets) that:

- Raises `quereus-isolation` coverage to match the weight of what it guards, with
  tests written against the *intended* isolation semantics.
- Adds an end-to-end sync test that drives a round-trip through the coordinator.
- Establishes browser-environment (or agreed fake-env) execution for the IndexedDB
  plugin, coordinated with the conformance-suite ticket.
- Decides whether cross-package version-skew testing is worth standing up, and if so
  the minimal form of it.
- Converts the sequential build chain to `tsc -b` project references (or documents
  why not), so the build is dependency-aware and incremental.

## Open questions to resolve before emitting implement tickets

- IndexedDB test environment: real browser (Playwright/Karma-style) vs. Node
  `fake-indexeddb`. Must agree with `test-kvstore-conformance-suite`.
- Whether version-skew testing earns its keep now or is a `backlog/` item.
- Scope of the `tsc -b` migration: whether all packages already have clean
  project-reference-able `tsconfig`s or whether several need fixing first (composite
  builds are strict about `references` and output layout).

## Non-goals

- Adding the missing `test`/`lint` *scripts* — that is `test-add-missing-scripts`.
- The `yarn check` fan-out and release reminder — that is
  `test-yarn-check-runs-everything`.
- Standing up a CI server — explicitly out of scope by product decision.
