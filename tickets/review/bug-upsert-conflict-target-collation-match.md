---
description: |
  An "insert … on conflict (column) do update/nothing" that collides with an existing row only
  because of collation ('abc' vs stored 'ABC' under case-insensitive comparison) or affinity ('1'
  vs stored integer 1) now runs the update/skip instead of wrongly aborting with a uniqueness
  error. Implemented; ready for an adversarial review pass.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # matchUpsertClause rewrite + conflictTargetValuesMatch helper + RuntimeUpsertClause fields + emit-time collation resolution
  - packages/quereus/src/planner/building/insert.ts           # resolveConflictTargetEnforcement + buildUpsertClausePlans wiring
  - packages/quereus/src/planner/nodes/dml-executor-node.ts   # UpsertClausePlan.conflictTargetCollations / conflictTargetTypes
  - packages/quereus/src/schema/unique-enforcement.ts         # uniqueEnforcementCollations (used, unchanged)
  - packages/quereus/src/util/affinity.ts                     # affinity model (unchanged)
  - packages/quereus/src/types/validation.ts                  # validateAndParse — the storage-layer coercion reused for proposed-value affinity
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic   # collation-variant coverage (runs BOTH modes)
  - packages/quereus/test/logic/47.4-upsert-conflict-target-affinity.sqllogic    # affinity coverage (memory-only; see finding)
  - packages/quereus/test/logic.spec.ts                       # MEMORY_ONLY_FILES entry for 47.4
  - docs/sql.md                                               # Conflict-target matching note
---

# ON CONFLICT (cols) DO UPDATE/NOTHING matches collation-equal & affinity-coerced conflicts

## What was wrong and what changed

`matchUpsertClause` (`runtime/emit/dml-executor.ts`) decided whether a UNIQUE violation matched a
statement's `on conflict (cols)` target by comparing the proposed row against the stored row with
`sqlValueIdentical` — byte/identity semantics. When the conflict existed only under the
constraint's *enforcement* comparison (a NOCASE case-variant, an RTRIM trailing-space variant, or
a pre-affinity value like text `'1'` vs a stored integer `1`), the comparison reported "not equal",
no clause matched, and the insert aborted with `UNIQUE constraint failed` instead of running the
DO UPDATE / DO NOTHING arm.

The fix makes the match compare the way the constraint enforces:

1. **Planner** (`insert.ts`, `resolveConflictTargetEnforcement` + `buildUpsertClausePlans`):
   for each `conflictTargetIndices` entry, resolve the column's affinity (its `logicalType`) and
   the *enforcement collation name* of the constraint the target names — the PK column def's
   collation for a PK target, or `uniqueEnforcementCollations` (which prefers an index-derived
   per-column `COLLATE`) for a UNIQUE target, falling back to the declared column collation. Two
   index-aligned arrays (`conflictTargetCollations`, `conflictTargetTypes`) are attached to
   `UpsertClausePlan`. Column order in the target may differ from the constraint's, so each
   target index is mapped back to its own column's collation, never positionally.
2. **Emit** (`emitDmlExecutor`): the collation NAMES are resolved to functions once via
   `ctx.resolveCollation(...)` (recording the collation dependency so a redefined collation
   re-emits) and carried on `RuntimeUpsertClause` alongside the logical types.
3. **Match** (`conflictTargetValuesMatch`): apply the column's affinity to the proposed value
   with `validateAndParse` (the same coercion the vtab storage layer runs), then compare against
   the already-coerced stored value with `compareSqlValuesFast` under the enforcement collation.
   BINARY + byte-identical still compares 0, so seed idempotency and the existing passing cases
   are unaffected; `compareSqlValuesFast` preserves `sqlValueIdentical`'s numeric-storage-class
   tolerance.

## How to validate

- `cd packages/quereus && yarn test` — full memory suite (6879 passing, 9 pending, 0 failing).
- `yarn build` and `yarn lint` are clean.
- Targeted: the two new logic files pin the behavior. Run one file:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "47[.][34]-upsert"`.

### What the tests cover (review these as a floor, not a ceiling)

`47.3-upsert-conflict-target-collation.sqllogic` (runs in **both** memory and store modes):
- NOCASE single-column UNIQUE — DO UPDATE runs on a case-variant conflict.
- NOCASE DO NOTHING arm — case-variant conflict skipped, not aborted; plus a control that a
  genuinely different NOCASE value inserts as a new row (no false match).
- RTRIM trailing-space variant matches.
- Byte-identical BINARY key still matches (regression control) **and** a conflict on a *different*
  unique constraint than the one named still aborts (matching not widened).
- Composite target with per-column collations (`a` exact, `b` NOCASE), plus a control that a
  partial collision on only one target column inserts as a new row.
- Index-derived UNIQUE with a per-column `COLLATE NOCASE` on a BINARY column — enforcement uses
  the index collation, not the column's declared BINARY.

`47.4-upsert-conflict-target-affinity.sqllogic` (**memory-only** — see finding below):
- Affinity coercion `'1'` → INTEGER PK holding `1`: DO UPDATE runs, and DO NOTHING skips.
- Affinity coercion on a non-PK INTEGER UNIQUE (`'7'` vs stored `7`): DO UPDATE runs.

### Suggested extra probing for the reviewer

- REAL/NUMERIC affinity variants (e.g. `'1.0'` / `1.0` vs stored `1`), and BLOB/JSON target
  columns, are not explicitly pinned — the coercion path is `validateAndParse`, so behavior should
  follow the storage layer, but it is untested here.
- Multi-row INSERT mixing a collation-variant conflict row with clean rows under one statement.
- The `where` guard on DO UPDATE combined with a collation-variant conflict.

## Review findings

- **Discovered latent bug in the isolation layer, filed as `fix/bug-store-isolation-upsert-affinity-coerced-pk`.**
  The affinity corner ('1' vs stored INTEGER 1) is correct on the memory backend and on the plain
  `StoreModule`, but the isolation overlay (`createIsolatedStoreModule`, the store-mode harness)
  mishandles a cross-storage-class proposed PK value — the just-inserted row wins and the existing
  row is lost (DO NOTHING keeps the proposed value; DO UPDATE loses its update). This is
  pre-existing isolation code that the engine fix merely *exposes* (the old byte-identity match
  aborted before that path ran). Because of it, `47.4` is listed in `MEMORY_ONLY_FILES` in
  `logic.spec.ts`; the fix ticket's acceptance criterion is to remove that entry and pass in store
  mode. Confirmed the split cleanly: `47.3` passes in both modes, `47.4` passes in memory and is
  correctly skipped in store.
- **Out of scope (documented, not a ticket): multi-constraint coincidence.** If an insert violates
  the targeted constraint AND another unique constraint at once and the vtab returns the targeted
  constraint's existingRow, the row is still suppressed though the uncovered conflict should abort.
  Value comparison cannot disambiguate this; the NOTE in `matchUpsertClause` documents it.
- **Tripwire (parked as a `// NOTE:` at the site, `conflictTargetValuesMatch`):** the per-target
  `validateAndParse` coercion runs per conflicting row, but only on the cold
  UNIQUE-violation-with-upsert-clause path — off the happy-path insert. If a workload ever hammers
  ON CONFLICT on a wide composite target, precompute per-target coercion closures at emit.
- **Cross-repo coordination (not chainable via `prereq:`):** the Lamina-side assertion flip is
  tracked by the Lamina ticket `bug-upsert-conflict-target-collation-match`. A test there currently
  pins the abort with a `rejects` assertion that should become a successful update; coordinate that
  flip when this lands.
