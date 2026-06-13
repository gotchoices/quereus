description: Characterization test + documented-limitation note for the collation-sensitive-CHECK corner of the `refresh materialized view` reshape arm. No production behavior change — a 3-case characterization test, a docs note, and two cross-reference code comments. Reviewed and completed.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch + reshapeBackingInPlace post-reconcile phase (comments only)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # describe 'reshape arm: collation-sensitive CHECK (documented limitation)'
  - docs/materialized-views.md                                            # 'Known limitation — collation-sensitive CHECK on the reshape arm' note in the REFRESH section
----

# Complete: collation-sensitive CHECK on the refresh reshape arm — characterize + document

## Summary

The reshape arm of `refresh materialized view` (`reshapeBackingInPlace`) sequences a
constraint-bearing `rebuildBacking` scan that **validates and commits** reconciled
rows in their **pre-recollate** physical form, then applies `recollate` as a
*post-reconcile* data-validating op. A collation-sensitive declared CHECK whose truth
flips under that recollate (`v <> 'abc'`, `v` recollated `BINARY → NOCASE`, row
`'ABC'`) passes the scan, commits, and is recollated into a violating state. Resolved
at plan as a **documented limitation, not a fix** (commit-first ordering is
load-bearing; the attach-reshape path shares the identical ordering). This ticket
landed a 3-case characterization test, a docs note, and two cross-reference code
comments — **zero production logic change**.

## Review findings

**Stage:** review (adversarial pass over implement commit `59c9328c`).

### What was checked

- **Implement diff read first, fresh eyes** (`git show 59c9328c`): the only `.ts`
  edits are comments (confirmed — `rebuildBacking` constraint branch + the
  `reshapeBackingInPlace` post-reconcile NOTE); plus the 3-case test and the docs note.
- **Pinned behavior is ACTUAL, not aspirational** — ran the full spec file
  (`node --import register.mjs mocha …maintained-table-refresh-revalidation.spec.ts`):
  **20/20 pass**, including the core corner (`v` flips `BINARY → NOCASE`, the
  CHECK-violating-under-NOCASE row **survives**), the collation-insensitive control
  (`id > 0` genuine violator still **rejected** over the same reshape), and the
  three-way next-maintenance blast radius (frozen on no-delta touch; rejected on
  genuine update delta; rejected on fresh insert). The core test asserts the row
  **survives** (the limitation), not that it is rejected — correct framing.
- **Limitation rationale is honest, not fabricated** — verified via code-search that
  the **attach-reshape path** (`materialized-view-helpers.ts` ~1089: the
  `set maintained` reshape) does `validateDeclaredConstraintsOverContents` → `commit`
  → post-reconcile recollate, the **identical** pre-recollate ordering the docs/comments
  cite as why closing only the refresh arm would diverge the two paths. The "commit-first
  is load-bearing" and "attach-reshape parity" justifications are accurate.
- **Blast-radius claims** — the docs note's "does not silently spread; frozen until
  corrected" is pinned by the test's update-delta + fresh-insert rejection cases
  (both run `buildDerivedRowValidator` under the NEW collation).
- **Docs reflect new reality** — the REFRESH-section note accurately describes the
  pre-recollate scan ordering and is cross-referenced from both code comments; heading
  matches the comment references.
- **Lint + typecheck**: `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p
  tsconfig.test.json`) — **exit 0**.

### Findings & disposition

- **MINOR (fixed inline):** the implement commit spliced the new `recollate` NOTE
  into the **middle of an existing sentence** in `reshapeBackingInPlace`
  ("…not the stale rows. Re-register" / NOTE / "the catalog after EACH op…"),
  breaking the original comment's flow. Relocated the NOTE to its own paragraph
  after the original block. Comment-only; lint re-run clean (exit 0).
- **MAJOR (new ticket filed):** the analogous **`retype`-flips-CHECK** corner is
  uncharacterized and undocumented. `retype` sits in the **same** `postReconcileOps`
  batch as `recollate`, so the same pre-validate / post-convert window exists
  structurally — but whether a CHECK's truth is actually flippable by a retype was not
  verified. Filed `tickets/backlog/maintained-table-refresh-retype-revalidation-check.md`
  to probe reachability and either characterize+document it as a sibling limitation or
  record that it does not arise. Backlog (future characterization, mirroring how this
  ticket began), not blocking.

### Categories explicitly clear

- **Store coverage** — out of scope here (engine-level corner in store-agnostic
  `reshapeBackingInPlace`/`rebuildBacking`); already tracked by
  `tickets/implement/maintained-table-refresh-revalidation-store-parity`. No
  duplicate filed.
- **Production behavior / regressions** — none possible: the only source edits are
  comments. The 20-test file (including the 11 pre-existing cases) stays green.
- **Resource cleanup / error handling / type safety** — N/A to a comments+test+docs
  change; the validation paths exercised are unchanged from prior tickets.
- **Pre-existing failures** — none surfaced; `.pre-existing-error.md` not written.

### Residual gaps accepted as-is

- The core test confirms the reshape-with-recollate ran **by outcome** (collation
  flip), not by instrumenting the `ReshapeColumnOp` list — a faithful proxy, judged
  sufficient (stronger pin would unit-test `classifyBackingReshape`, out of scope).
- Memory backing only (store parity tracked separately, above).
- "Frozen until corrected" is pinned for update-delta + fresh-insert re-derivation
  shapes; other re-derivation shapes rest on the documented steady-state contract.
