description: |
  Quereus tags its own foreign-key cascade child writes (cascade DELETE/UPDATE, SET NULL,
  SET DEFAULT) with a transient flag so a host virtual-table module can tell a cascade re-entry
  apart from a direct user write on the same child table. Implemented, reviewed, shipped.
prereq:
files:
  - packages/quereus/src/core/database.ts                       # _fkCascadeReentry field + _set/_is accessors
  - packages/quereus/src/runtime/foreign-key-actions.ts         # withFkCascadeReentry helper + 8 wrapped cascade sites
  - packages/quereus/test/runtime/fk-cascade-reentry.spec.ts    # test suite (5 tests)
difficulty: medium
----

## What shipped

A per-write, nesting-safe `_fkCascadeReentry` flag on `Database`, mirroring the existing
`_fkRestrictSuppressed` trio exactly:

- `core/database.ts` — `private _fkCascadeReentry = false;`, `_setFkCascadeReentry(value): boolean`
  (returns the **prior** value for nesting-safe restore), `_isFkCascadeReentry(): boolean`, placed
  directly after the `_fkRestrictSuppressed` trio.
- `runtime/foreign-key-actions.ts` — a module-private `withFkCascadeReentry(db, fn)` helper
  (set → run → restore prior in `finally`) wraps **all 8** cascade child-DML re-entry sites: physical
  `executeSingleFKAction` (cascade DELETE, cascade UPDATE, SET NULL, SET DEFAULT) and lens
  `issueLensFkAction` (the same four, logical variants).

Nothing inside Quereus reads the flag; it exposes the signal the external **lamina** host consumes.
Behavior-neutral for Quereus's own suite.

## Review findings

Adversarial pass over commit `6c0fee44`. Read the implement diff, all three touched files, the
sibling `_fkRestrictSuppressed` pattern, and every cascade re-entry site before the handoff summary.

**Checked**

- **Coverage of re-entry sites** — `find_references(_execWithinTransaction)` over
  `foreign-key-actions.ts`: every cascade child write (4 physical + 4 lens) is wrapped; zero bare
  `_execWithinTransaction` cascade sites remain. All other callers (external-changes seam, MV
  maintenance) reach child writes *through* `executeSingleFKAction` / `issueLensFkAction`, so they
  inherit the wrapping — the flag is set at the leaf write, the correct chokepoint.
- **Mirror fidelity** — accessor shape, save-prior/restore contract, and docstrings match
  `_fkRestrictSuppressed` exactly. `withFkCascadeReentry` restores in `finally` (throw-safe) and
  never blind-resets to `false` (nesting-safe).
- **Independence** — the two flags are separate fields; setting one never touches the other
  (asserted by test 2).
- **Lint + tests** — `yarn lint` exit 0 (eslint + `tsc -p tsconfig.test.json`). Full memory-backed
  `node test-runner.mjs`: **6469 passing, 0 failing, 9 pending**. Targeted suite: 5/5 green.
- **Docs** — grepped `packages/**/*.md`: no doc references either flag. Symmetric with the untracked
  sibling; no doc update warranted (nothing internal reads the flag, it is a host-facing seam).
- **Downstream** — `packages/lamina*` is not in this repo; the consumer is external and out of scope.

**Found / done**

- **Minor, fixed inline** — the flag is per-`Database` mutable state held across the `await fn()`
  window by synchronous save/restore. Correct today (per-connection statement serialization), but
  unlike the sibling restrict flag (only ever set under the apply-path mutex) this flag is set on the
  general user-DML cascade path, giving it broader exposure to any future concurrent-statement
  execution. Genuinely conditional → recorded as a greppable `NOTE:` tripwire at the
  `withFkCascadeReentry` site (`runtime/foreign-key-actions.ts`), not a ticket. If Quereus ever runs
  concurrent statements on one Database, scope the flag to the executing statement/connection.
- **Tripwire (pre-existing, from implementer)** — the two integration tests depend on a deterministic
  zero-arg CHECK function NOT being constant-folded at plan time. Already parked as a `NOTE:` at the
  probe site in the spec; if that folding ever lands, switch the probe to a custom vtab module reading
  `_isFkCascadeReentry()`. Left as-is.

**Not done (deliberate, no ticket)**

- **Lens cascade sites tested only transitively.** Tests 3/5 sample the flag through the *physical*
  cascade path; the 4 lens sites in `issueLensFkAction` are wrapped with the identical shared helper,
  so the physical tests already exercise the wrapper's logic — the lens sites differ only in the SQL
  they build. Marginal added value from a lens-routed sample test; existing lens-enforcement tests
  still pass. Not worth a ticket; a future reviewer wanting belt-and-suspenders coverage could add a
  lens child view that samples the flag.
- **Unused `parentTable` param in `executeSingleFKAction`.** Pre-existing (predates this ticket,
  untouched by the diff), `yarn lint`-clean. Cosmetic; out of scope. Prefix `_parentTable` if it ever
  bothers anyone.
- **`test:store` not run.** Only the memory-backed suite was exercised (here and by the implementer).
  The plumbing wraps the same `_execWithinTransaction` sites and is store-agnostic; a reviewer wanting
  LevelDB-path coverage can run `yarn test:store`. Not a defect — a deferred coverage choice.

**No major findings → no new tickets filed.**

## How it works

`withFkCascadeReentry` uses save-prior/restore, never a blind reset-to-false:
- **Nesting** — inner cascade's `finally` restores to the outer's `true`; the outermost restores to
  `false`.
- **Throwing cascade** — the `finally` restores the prior value even when the child write throws, so
  the flag never latches on across statements.
- **Independence** — setting `_fkCascadeReentry` never touches `_fkRestrictSuppressed`.

## Validation

- `yarn lint` — exit 0.
- `node test-runner.mjs` (full memory-backed suite) — 6469 passing, 0 failing, 9 pending.
- `test/runtime/fk-cascade-reentry.spec.ts` — 5 tests, all green (accessors, independence,
  cascade-vs-direct, throwing-restores, nested-cascade).

## Downstream (not this repo's work)

After this lands, two lamina golden-vector fixtures (`general-body-mv-maintenance`,
`overflow-leaf-inplace-update`) reach the byte-compare and are expected to show a byte-hash mismatch
(lamina's committed bytes predate its edition-13 regeneration). That drift is lamina-side and is the
lamina owner's re-bless — not a Quereus concern.
