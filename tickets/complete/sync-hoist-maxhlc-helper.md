----
description: DRY hoist of the duplicated maxHLCFromChangeSets helper into a shared maxHLC in @quereus/sync's clock layer
files:
  - packages/quereus-sync/src/clock/hlc.ts
  - packages/quereus-sync/src/index.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync-client/src/sync-client.ts
  - packages/quereus-sync/test/clock/hlc.spec.ts
  - docs/sync.md
----

## Summary

An identical `maxHLCFromChangeSets(changeSets: ChangeSet[]): HLC | undefined` helper
was copied in `@quereus/sync` (`change-applicator.ts`) and `@quereus/sync-client`
(`sync-client.ts`), violating DRY. The work hoisted it into a single pure HLC
utility `maxHLC(hlcs: Iterable<HLC>): HLC | undefined` in the clock layer
(`clock/hlc.ts`), exported on the `@quereus/sync` public surface. Both consumers
now call `maxHLC(changeSets.map(cs => cs.hlc))`; the local copies were removed.

The signature is `Iterable<HLC>` rather than `ChangeSet[]`, which keeps the helper
in the clock layer with no protocol-type dependency and accepts the `Array.map()`
results that all call sites already produce.

## Review findings

Reviewed the implement-stage diff (commit `519e0591`) with fresh eyes, then the
handoff. The refactor is correct, minimal, and genuinely DRY. Findings by aspect:

**Correctness — clean.** The shared `maxHLC` reproduces both originals exactly:
strict greater-than (`compareHLC(hlc, max) > 0`) so the *first* of equal maxima is
retained, `undefined` on empty, single element returned unchanged. Uses the full
HLC total order (wallTime → counter → siteId → opSeq), not just wallTime.

**DRY / dead code — clean.** Both local copies removed; `find_references` for
`maxHLCFromChangeSets` returns 0 matches across the tree. No dangling private
functions.

**Type safety / imports — clean.** Verified each removed import is genuinely
unused: `compareHLC` and `type ChangeSet` no longer referenced in
`sync-client.ts`; `type HLC` no longer referenced as a bare type in
`change-applicator.ts` (only `compareHLC`/`maxHLC`/`*HLC`-suffixed identifiers
remain). The `maxHlc` local-variable rename in `handleChanges` correctly avoids
shadowing the new `maxHLC` import. No `any`, no inline `import()`.

**Export surface — clean.** `maxHLC` surfaces via `clock/index.ts` (`export *`,
no edit needed — confirmed) *and* `src/index.ts` (explicit named list, correctly
amended). The handoff's note that `src/index.ts` uses an explicit list (contra the
plan's `export *` assumption) is accurate; the plan was right that `clock/index.ts`
needs no edit.

**`Iterable<HLC>` breadth (handoff's flagged question)** — kept as-is. It is a
supertype of `HLC[]`, costs nothing, is idiomatic, and lets the helper live in the
clock layer free of the `ChangeSet` protocol type. Trimming to `HLC[]` would be a
strict downgrade. New `maxHLC` lazy-generator test pins this contract.

**Tests — GAP found, fixed in-pass (minor).** The implementer added no dedicated
unit test for the new shared helper (relied on integration coverage only). Added
`describe('maxHLC')` to `test/clock/hlc.spec.ts` with 6 cases: empty → undefined,
single element, max in middle/end/start (position-independence), full total-order
tiebreak via siteId (not just wallTime), first-of-equal-maxima retention, and a
lazy generator (`Iterable` contract). All pass.

**Docs — STALE reference found, fixed in-pass (minor).** `docs/sync.md` § Delta
Sync Optimization still named the now-deleted `maxHLCFromChangeSets`. Updated to
reference "the shared `maxHLC` clock helper". (The two `tickets/complete/*.md` hits
are archived historical records and were intentionally left untouched.)

**Error handling / resource cleanup / SPP / performance — N/A.** Pure
side-effect-free reduction over an iterable; nothing to clean up, no error paths,
single responsibility, single pass.

## Validation

- `yarn workspace @quereus/sync build` — clean.
- `yarn workspace @quereus/sync test` — **253 passing, 0 failing** (includes the 6
  new `maxHLC` cases; the `[Sync] Error...` console lines are deliberate
  error-path test fixtures, not failures).
- `yarn workspace @quereus/sync-client build` — clean (exit 0), confirming the
  downstream consumer still type-checks against the rebuilt `@quereus/sync`.
