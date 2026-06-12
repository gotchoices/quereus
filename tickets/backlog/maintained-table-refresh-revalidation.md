description: Validate declared CHECK/FK over the rows `refresh materialized view` writes into a table-form maintained table — the one derivation write path that still bypasses declared-constraint validation (stale-refresh only in practice).
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (replaceContents caller; carries the deferral comment)
  - packages/quereus/src/vtab/backing-host.ts                        # replaceContents contract (committed-state swap — no pending-layer rollback)
  - packages/quereus/src/core/derived-row-validator.ts               # per-row evaluator that could validate the recomputed rows pre-swap
difficulty: medium
----

# Refresh re-validation for constraint-bearing maintained tables

`maintained-table-derivation-check-fk-validation` validates declared CHECK and
child-side FK constraints on every derivation write path EXCEPT manual
`refresh materialized view` of a table-form maintained table: `rebuildBacking`
re-runs the body and swaps the result in via `BackingHost.replaceContents`,
which replaces COMMITTED contents and validates nothing (see the deferral
comment at the `rebuildBacking` call site).

## Why the gap is narrow

For a continuously-maintained table the refresh re-derives a row set every
member of which already entered through a validated boundary (create-fill /
attach reconcile / steady-state maintenance), so refresh cannot introduce a
violator. The real exposure is a **stale** maintained table: when a source
schema change marks the table stale, its row-time plan is released, so
subsequent source writes do NOT maintain (or validate against) it; a later
`refresh` then recomputes from source state that was never validated against
the declared constraints — and commits it unvalidated.

(Pre-existing FK rows admitted under `pragma foreign_keys = off` are NOT this
ticket's concern: pragma flips deliberately do not retro-validate, matching
ordinary tables.)

## Expected behavior

- `refresh materialized view mt` on a maintained table declaring ≥1 applicable
  CHECK or ≥1 FK must fail with the maintained-table-attributed CONSTRAINT
  diagnostic when the recomputed row set contains a violator, leaving the
  pre-refresh contents intact (no partial swap, no committed violators).
- Because `replaceContents` swaps committed state (no pending-layer rollback),
  validation must happen BEFORE the swap — either by evaluating the recomputed
  `rows` array against the per-row derived-row validator
  (`core/derived-row-validator.ts`, already compiled per registered table), or
  by converting refresh to a pending-layer `'replace-all'` + the bulk scan
  validators, mirroring the attach core.
- Zero overhead for MV-sugar backings and constraint-less maintained tables
  must be preserved.

## Use cases

- Stale table (source ALTER released the plan) → source rows drift into
  violation → `refresh` → must error, not commit violators.
- Constraint-clean refresh → unchanged behavior, including the
  `backingShapeMatches` data-only fast path.
