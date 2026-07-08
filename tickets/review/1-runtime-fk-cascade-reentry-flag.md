description: |
  Quereus now tags its own foreign-key cascade child writes (cascade DELETE/UPDATE, SET NULL,
  SET DEFAULT) with a transient flag, so a host virtual-table module can tell a cascade re-entry
  apart from a direct user write on the same child table. Review the flag plumbing and its tests.
prereq:
files:
  - packages/quereus/src/core/database.ts                       # _fkCascadeReentry field + _set/_is accessors (~:1983-2013)
  - packages/quereus/src/runtime/foreign-key-actions.ts         # withFkCascadeReentry helper + 8 wrapped cascade sites
  - packages/quereus/test/runtime/fk-cascade-reentry.spec.ts    # new test suite (5 tests)
difficulty: medium
----

## What landed

A per-write, nesting-safe `_fkCascadeReentry` flag on `Database`, mirroring the existing
`_fkRestrictSuppressed` exactly:

- `core/database.ts` — `private _fkCascadeReentry = false;`, `_setFkCascadeReentry(value): boolean`
  (returns the **prior** value for nesting-safe restore), `_isFkCascadeReentry(): boolean`. Placed
  directly after the `_fkRestrictSuppressed` trio.
- `runtime/foreign-key-actions.ts` — a module-private `withFkCascadeReentry(db, fn)` helper
  (set → run → restore prior in `finally`) now wraps **all 8** cascade child-DML re-entry sites:
  physical `executeSingleFKAction` (cascade DELETE, cascade UPDATE, SET NULL, SET DEFAULT) and lens
  `issueLensFkAction` (the same four, logical variants). Grep confirms zero bare
  `_execWithinTransaction` cascade sites remain in that file — every one is wrapped.

Nothing *inside* Quereus reads the flag; it only exposes the signal the sibling **lamina** host
consumes (`packages/lamina-quereus/src/table.ts:1009` calls `_isFkCascadeReentry()` — which threw
`TypeError: ... is not a function` before this landed). This change is behavior-neutral for
Quereus's own suite.

## How it works

`withFkCascadeReentry` uses save-prior/restore, never a blind reset-to-false, so:
- **Nesting** — inner cascade's `finally` restores to the outer's `true`; the outermost restores to
  `false`.
- **Throwing cascade** — the `finally` restores the prior value even when the child write throws, so
  the flag never latches on across statements.
- **Independence** — setting `_fkCascadeReentry` never touches `_fkRestrictSuppressed`; a cascade
  path may legitimately have both in play.

## Validation / testing

- `packages/quereus/test/runtime/fk-cascade-reentry.spec.ts` — 5 tests, all green:
  1. **accessors** — default `false`, `_set` returns prior, save/restore nests (inner restore → `true`
     while outer active, outer restore → `false`).
  2. **independence** — setting the cascade flag leaves the RESTRICT flag untouched, and vice-versa.
  3. **cascade observes true / direct observes false** — a user scalar function sampled from a child
     CHECK records `true` during a cascade UPDATE re-entry and `false` during a direct user UPDATE;
     flag cleared after the statement.
  4. **throwing cascade restores** — cascade SET NULL onto a NOT NULL child trips NOT NULL mid-cascade;
     flag is `false` afterward.
  5. **nested cascade** — `gp → pa → ch` (each child's PK is its FK), re-keying `gp` cascades two
     levels; the deepest child write still samples `true`; flag cleared after.
- Commands run (from `packages/quereus`, all green):
  - `yarn lint` — exit 0.
  - single spec via mocha — 5 passing.
  - `yarn test` (full memory-backed suite) — **6469 passing, 0 failing, 9 pending**.

### How the integration tests observe the flag

The flag has no in-engine reader, so tests 3 and 5 sample it via a user-registered **deterministic**
scalar function referenced in a child CHECK constraint (non-deterministic functions are rejected in
CHECK; the deterministic one is evaluated per-row at write time, confirmed not constant-folded).
This is a test technique, not a product seam — see the tripwire below.

## Reviewer starting points (treat tests as a floor)

- **`test:store` not run.** Only the memory-backed `yarn test` was exercised. FK cascades under the
  LevelDB store path (`yarn test:store`) were **not** run here — the flag plumbing is store-agnostic
  (it wraps the same `_execWithinTransaction` sites), but a reviewer wanting store coverage should run
  it. The real downstream consumer is a rowid-chaining backend (lamina), which this repo's suite does
  not exercise at all.
- **Lens (logical-FK) cascade sites are wrapped but not directly asserted.** Tests 3/5 cover the
  physical cascade path; the 4 lens sites in `issueLensFkAction` are wrapped identically but only
  covered transitively (existing lens-enforcement tests still pass). A reviewer could add a lens-routed
  cascade that samples the flag through a logical child view.
- **`executeSingleFKAction` has an unused `parentTable` param** (editor/tsserver flags it; `yarn lint`
  does **not**). Pre-existing — the signature predates this ticket and I did not touch it. Left as-is to
  avoid scope creep; flag it only if you want it prefixed `_parentTable`.

## Review findings

- **Tripwire (test technique):** the two integration tests depend on a deterministic zero-arg CHECK
  function NOT being constant-folded at plan time. Parked as a greppable `NOTE:` at the probe site in
  `test/runtime/fk-cascade-reentry.spec.ts`; if that folding ever lands, switch the probe to a custom
  vtab module reading `_isFkCascadeReentry()`.
- **Observation (not a ticket):** pre-existing unused `parentTable` param in `executeSingleFKAction`
  (see reviewer starting points above); lint-clean, not touched.

## Downstream (not this repo's work)

After this lands, two lamina golden-vector fixtures (`general-body-mv-maintenance`,
`overflow-leaf-inplace-update`) reach the byte-compare and are expected to show a byte-hash mismatch
(lamina's committed bytes predate its edition-13 regeneration). That drift is lamina-side and is the
lamina owner's re-bless — not a Quereus concern.
