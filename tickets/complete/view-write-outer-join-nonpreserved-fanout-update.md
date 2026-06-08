description: Non-preserved (outer-join null-extended) column UPDATE fan-out — a non-preserved partner shared by multiple preserved rows. The matched read-back `min`-de-dups per partner and the null-extended materialization INSERT `group by`s the join key with `min` value projections, so a shared-partner write applies once instead of erroring `Scalar subquery returned more than one row` (matched) or `UNIQUE constraint failed` (materialization). Reviewed, extended, and validated; build, full test suite (5367 passing, 9 pending), and lint all green.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What this change delivers

Two surgical edits in `multi-source.ts`, both keyed off the existing pre-mutation
`__vmupd_keys` capture (no new runtime substrate):

1. `capturedValueSubquery` gained an optional `dedupAggregate?: string`; the matched
   non-preserved read-back passes `'min'`, wrapping the projected captured value so the
   correlated scalar stays single-valued when a shared partner PK matches N capture rows.
2. `buildNullExtendedInsert` wraps each value projection in `min(...)` and adds
   `groupBy: [k.<jkAlias>]`, so one partner row materializes per distinct dangling join key.

The other three `decomposition.ts` callers and the cross-source `stripSideQualifier` caller
stay byte-identical (default-off param). Docs `§ Outer Joins` updated with a new fan-out
paragraph and the realized `group by … / min(…)` INSERT shape.

## Review findings

Adversarial pass over the implement-stage diff (commit `5bb6dffe`), read first with fresh
eyes before the handoff summary. The implementation is correct, DRY, and minimal. Scrutinized
from correctness, semantics, type safety, resource cleanup, error handling, and test coverage
angles.

**What was checked, and the disposition:**

- **`min` semantic decision (the one design call to confirm).** Confirmed correct and the
  right scope. The implement stage deliberately did NOT add a plan-time *reject* of the
  divergent-value case (mirroring `cross-source-ambiguous-cardinality`), because "np side
  joins ≥2 preserved rows" is the normal parent→child cardinality and a gate there would
  over-reject the common 1:1 case. Deterministic `min` resolution of an inherently-ambiguous
  case, applied consistently to BOTH branches, is the non-over-rejecting choice and matches
  the fix-stage recommendation. **Accepted — no change.**

- **Cross-branch consistency (matched vs materialization on the same partner).** Verified a
  single partner can never be half-matched / half-materialized within one statement: the
  captured np PK is null iff the join key has no parent row, which is all-or-nothing per key
  value. Matched and materialization always apply to *disjoint* partners, so the two `min`s
  never need to agree on the same row. **No issue.**

- **Capture is filtered to affected rows.** Confirmed the divergent `min` excludes the
  unselected sibling (e.g. `cc=5` reads the physically-updated parent but is not in the
  capture, so `min` is over the affected children only). Pinned by the divergent-value test
  expecting `1000`, not a value pulled toward `5000`. **Correct.**

- **Test-coverage gaps the handoff flagged — FIXED INLINE (minor):**
  - Added a **divergent-value MATERIALIZATION fan-out** test (LEFT `npv`): two dangling
    children (`cv` 6000/7000) sharing one missing key — confirms the materialization `min`
    mints the partner once with `pv=6000` (the create-branch mirror of the matched divergent
    case, which previously had **zero** coverage on the materialization `min`).
  - Added the **RIGHT mirror** of both the divergent matched read-back and the divergent
    materialization (`rnpv`), confirming the de-dup keys off `JoinSide.preserved`, not source
    order. All pass; predicted values matched actual, validating the documented semantics.

- **Multi-column divergent SET (`min` is per-column independent) — DOCUMENTED (minor).**
  Each assigned non-preserved column carries its own `min`, so a *divergent* multi-column
  SET resolves each column independently; the materialized/updated partner can reflect
  per-column minimums that need not all originate in one preserved row. This only matters in
  the already-arbitrary divergent case (a constant / np-only SET is identical across the
  group regardless). Added a sentence to `docs/view-updateability.md § Outer Joins` naming
  the per-column independence and the "single winning row would correlate to one
  discriminator" future-work path. **Documented, not gated** — a row-coherent winner is a
  larger design change unjustified for an undefined-by-construction case.

- **`min` over non-numeric / mixed-type / NULL captured values — NOT a defect.** `min`
  collation/ordering and null-skipping follow the engine's `min`; this only surfaces in the
  divergent case (a no-op de-dup otherwise, since all grouped values are equal regardless of
  type). Left untested by design — it is the engine's documented `min` behavior, not new
  surface introduced here. **Noted; no ticket.**

- **Performance of the now-aggregate correlated read-back — no regression.** The matched
  read-back was already a correlated scalar subquery over the small `__vmupd_keys` capture
  (affected rows only); adding `min` does not change its structural complexity. Functional
  correctness proven by the full suite; not separately profiled. **Noted; no ticket.**

- **Composite-key fan-out — out of scope, unchanged.** A composite non-preserved join key
  already rejects `unsupported-outer-join-update` upstream (single-column-key path is the only
  materializable one). Confirmed in the boundaries doc and untouched. **No issue.**

**Major findings: none.** No new fix/plan/backlog tickets filed — every probe resolved to
either "accepted as designed", "fixed inline", or "documented behavior, not a defect".

## Validation performed (this review pass)

- `yarn workspace @quereus/quereus lint` → exit 0 (re-run after editing `property.spec.ts`).
- Full `yarn workspace @quereus/quereus test` → **5367 passing, 9 pending** (re-run after the
  added assertions; count unchanged because they live inside existing `it` blocks).
- Targeted: property `--grep "non-preserved"` (7 passing, including the new divergent
  materialization + RIGHT-mirror assertions) and logic `--grep "93.4"` (1 passing).

## Acceptance (all met)

- Shared existing non-preserved partner: applies once, no scalar-subquery multi-row error,
  with and without `returning`. ✓
- Shared dangling key: materializes the partner once, no double-insert / PK conflict, with
  and without `returning`. ✓
- LEFT (`npv` / `fofv`) and RIGHT (`rnpv` / `rfofv`) mirrors both covered. ✓
- Divergent-value semantics pinned for BOTH branches (matched + materialization) on BOTH
  mirrors. ✓
- No regression in the existing non-preserved-update / RETURNING / existence-flag suites
  (full suite green). ✓
