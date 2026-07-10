---
description: |
  An "insert … on conflict (column) do update" that collides with an existing row only because of
  collation (e.g. 'abc' vs stored 'ABC' under case-insensitive comparison) or affinity ('1' vs stored 1)
  wrongly aborts with a uniqueness error instead of running the update. A targetless "on conflict do
  update" works. Fix the conflict-target match to compare the way the constraint enforces.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # matchUpsertClause (~:309) + NOTE (~:322) spelling out the fix; RuntimeUpsertClause (~:35)
  - packages/quereus/src/planner/building/insert.ts           # buildUpsertClausePlans (~:270) — where affinity/collation is available to thread
  - packages/quereus/src/planner/nodes/dml-executor-node.ts   # UpsertClausePlan type (~:15) carries conflictTargetIndices
  - packages/quereus/src/schema/unique-enforcement.ts         # uniqueEnforcementCollations / resolveUniqueEnforcementCollations
  - packages/quereus/src/util/comparison.ts                   # compareSqlValuesFast, sqlValueIdentical
difficulty: medium
---

# ON CONFLICT (cols) DO UPDATE must match collation-equal (and affinity-coerced) conflicts

## What happens

`matchUpsertClause` in `runtime/emit/dml-executor.ts` (~:344) decides whether a uniqueness violation
matches the statement's `on conflict (cols)` target by comparing the proposed row against the stored
row at the target columns with `sqlValueIdentical` — byte/identity semantics. When the conflict exists
only under the constraint's *enforcement* comparison — a case variant under `COLLATE NOCASE`, a
trailing-space variant under `RTRIM`, or a pre-affinity-coercion value (`'1'` vs stored `1` on an
INTEGER key) — the comparison reports "not equal", no clause matches, and the insert aborts with
`UNIQUE constraint failed: …` instead of running the DO UPDATE / DO NOTHING arm.

A targetless `on conflict do update` matches any unique violation and behaves correctly. `insert or
replace` / `or ignore` are unaffected (they do not route through clause matching).

This affects **every** collated UNIQUE and collated single-column PK on any vtab reporting
collation-aware uniqueness violations (the Lamina backend among them). The defect is already documented
in a NOTE inside `matchUpsertClause` itself (~:322), which names the fix.

## Expected behavior

SQLite semantics: the conflict-target match compares the way the constraint *enforces*. Apply the
target column's affinity to the proposed value, then compare under the constraint's enforcement
collation — so a case-variant or affinity-coerced conflict on the targeted constraint runs the DO
UPDATE / DO NOTHING arm rather than aborting.

The NOTE (~:338) spells the ingredients: `uniqueEnforcementCollations` (from
`schema/unique-enforcement.ts`) to resolve per-column enforcement collation functions, and
`compareSqlValuesFast` (from `util/comparison.ts`) to compare under them, replacing `sqlValueIdentical`
at ~:344.

Key asymmetry the NOTE calls out: `proposedRow` reaches `matchUpsertClause` **pre-affinity-coercion**
(the insert pipeline defers type conversion to the vtab storage layer), while `existingRow` is the
already-coerced stored row. So affinity must be applied to the proposed value before comparing — a bare
collation swap fixes the NOCASE/RTRIM corner but not the `'1'` vs `1` corner.

## Design constraints

- **Thread enforcement metadata down from the planner, do NOT recompute schema lookups in the runtime
  hot path.** `buildUpsertClausePlans` in `insert.ts` (~:270) already holds `tableSchema` — resolve the
  per-target-column affinity + enforcement collation there, attach to `UpsertClausePlan`
  (`dml-executor-node.ts` ~:15) alongside `conflictTargetIndices`, and carry through
  `RuntimeUpsertClause` (`dml-executor.ts` ~:35). `matchUpsertClause` consumes precomputed
  collation-fn + affinity per target index — it must not reach back into schema.
- **Use the existing helpers, do NOT hand-roll collation or affinity.** Resolve collations via
  `uniqueEnforcementCollations` / `resolveUniqueEnforcementCollations`; compare via
  `compareSqlValuesFast`; apply affinity via the existing affinity-coercion util the vtab storage layer
  uses (locate it — do not write a new coercion path). Keep one source of truth.
- **Keep `conflictTargetIndices` ordering the single source for target columns** — the collation-fn /
  affinity arrays index-align with it; do not introduce a second parallel column list that can drift.
- Preserve `sqlValueIdentical`'s numeric-storage-class tolerance (bigint/number parity) — the new path
  must not regress the byte-identical / seed-idempotency case the NOTE guarantees (~:341: well-formed
  seeds re-present byte-identical literals, so seed idempotency stays unaffected).

## Edge cases & interactions

- **NOCASE case-variant** (`'abc'` proposal vs stored `'ABC'`) on a NOCASE-collated target → DO UPDATE
  runs. This is the corner the Lamina-side test pins (see Notes).
- **RTRIM trailing-space variant** on an RTRIM-collated target → matches.
- **Affinity coercion** (`'1'` proposal into INTEGER key holding `1`) → matches after affinity applied.
- **Byte-identical key** (existing passing case) → still matches; no regression.
- **Non-matching target** (conflict on a *different* unique constraint than the one named) → still
  leaves target columns unequal, still aborts with UNIQUE error. The fix must not widen matching to
  swallow genuinely-different-constraint conflicts.
- **Multi-column conflict target** → every target index compared under its own column's collation/affinity.
- **DO NOTHING arm** (`action: 'nothing'`, no assignments) routes through the same `matchUpsertClause`
  — verify it too skips (not aborts) on a collation-equal conflict.
- **Out of scope — multi-constraint coincidence** (NOTE ~:324): an insert violating the targeted
  constraint AND another unique constraint at once, where the vtab short-circuits on the first
  violation. Value comparison cannot disambiguate this; do NOT attempt it here.

## TODO

- Locate the affinity-coercion util the insert/storage path uses; confirm it is callable at
  clause-plan build time in `insert.ts`.
- In `buildUpsertClausePlans` (`insert.ts` ~:270): for each `conflictTargetIndices` entry, resolve the
  column's affinity + enforcement collation fn via `uniqueEnforcementCollations`; attach index-aligned
  arrays to `UpsertClausePlan`.
- Extend `UpsertClausePlan` (`dml-executor-node.ts` ~:15) and `RuntimeUpsertClause` (`dml-executor.ts`
  ~:35) to carry the per-target affinity + collation-fn arrays.
- Rewrite the comparison at `dml-executor.ts` ~:344: apply affinity to `proposedRow[idx]`, then
  `compareSqlValuesFast(existingRow[idx], coercedProposed, collationFn[idx]) === 0` in place of
  `sqlValueIdentical`.
- Update the NOTE at ~:322 to reflect that the representation-sensitive corner is now fixed (leave the
  multi-constraint-coincidence corner documented as still out of scope).
- Add engine-level tests covering the edge cases above (NOCASE, RTRIM, affinity, byte-identical
  regression, different-constraint-still-aborts, DO NOTHING arm).
- The Lamina-side assertion flip lives in a sibling repo and is tracked by the Lamina ticket
  `bug-upsert-conflict-target-collation-match`. Cross-repo `prereq:` cannot chain it; coordinate the
  flip when this lands (that test currently pins the abort with a `rejects` assertion that becomes a
  successful update).
