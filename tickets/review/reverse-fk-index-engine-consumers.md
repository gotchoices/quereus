description: Reviewed handoff — the runtime FK-action engine and the plan-time parent-side FK builder now resolve their referencing FKs through SchemaManager.getReferencingForeignKeys (the reverse-FK index) instead of an O(catalog) nested-loop walk. Four discovery loops converted; per-FK bodies preserved byte-for-byte. The maintained-parent enforcement hook short-circuits in O(1) for an unreferenced table transitively, with no edit to the maintenance path. Build + lint + full quereus suite (6098 passing) green.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts          # 3 sites converted (executeForeignKeyActions, assertNoRestrictedChildrenForParentMutation, assertTransitiveRestrictsForParentMutation step 2)
  - packages/quereus/src/planner/building/foreign-key-builder.ts # buildParentSideFKChecks converted
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # + unreferenced throughput gate case & referenced pair
  - packages/quereus/test/plan/parent-fk-check-gate.spec.ts      # NEW: plan-time gate (0 / 1 / 2 parent-side checks)
  - packages/quereus/test/runtime/fk-restrict-runtime.spec.ts    # existing engine regression (directly exercises 2 rewritten fns)
  - packages/quereus/test/schema/reverse-fk-index.spec.ts        # prereq's index unit tests (iteration order, identity)
  - docs/materialized-views.md                                   # § Parent-side referential enforcement — cost claim O(catalog) → index-gated
  - docs/schema.md                                               # § Reverse foreign-key index — over-report parenthetical corrected
  - tickets/fix/delete-range-predicate-under-deletes.md          # NEW: pre-existing memory-vtab DELETE bug discovered during testing
----

# Route the FK-action engine through the reverse-FK index — review

## What landed

Four catalog-walking discovery loops were collapsed to a single indexed lookup,
`db.schemaManager.getReferencingForeignKeys(parent.schemaName, parent.name)` (the
primitive shipped by `reverse-fk-index-catalog`). In every case the two discovery
filters (`fk.referencedTable` match, `referencedSchema ?? childTable.schemaName`
target match) are now satisfied by the index key and were dropped; **the rest of each
per-FK body is verbatim**.

Converted sites:
1. `executeForeignKeyActions` — cascade / set-null / set-default executor.
2. `assertNoRestrictedChildrenForParentMutation` — runtime RESTRICT pre-check.
3. `assertTransitiveRestrictsForParentMutation` **step 2** — the cascade-recursion
   discovery loop (steps 1 / 1b call helpers and were untouched).
4. `buildParentSideFKChecks` — plan-time parent-side `NOT EXISTS` synthesis.

Preserved per site (the reviewer should confirm each survived the rewrite):
- **Action gate** (`if (action === 'restrict') continue;` in the executor; `!== 'restrict'`
  in the RESTRICT pre-check / plan builder; the cascade/setNull/setDefault filter in step 2).
- **`suppressed` set + `suppressed.has(fk)`** — relies on the index preserving FK **object
  identity** (prereq guarantee). The `suppressed` set is still computed *before* the loop
  exactly as before.
- **Arity guard**, **MATCH-SIMPLE NULL skip**, **UPDATE referenced-column-change short-circuit**.
- **`visited` cycle detection** keying — unchanged (it is outside the discovery loop).
- **Iteration order** — `buildReverseFkIndex` emits buckets in schema-insertion → table →
  FK-declaration order, matching the old nested-loop order (so first-surviving-child
  RESTRICT message determinism holds).

Untouched, by design (physical reverse-index does not cover lens slots): the lens walkers
(`executeLensForeignKeyActions`, `assertLensRestrictsForParentMutation`),
`basisFksOverriddenByDivergentLensFk`, `findLogicalParentFkRefs`, and the maintenance hook
`MaterializedViewManager.enforceParentSideReferentialActions` (its win is **transitive** —
it just calls the two now-index-gated engine functions).

## How it was implemented (note for the reviewer)

Sites 2–4 were collapsed with a small PowerShell script (replace loop headers, dedent the
preserved body by 2 tabs, drop the 2 now-extra closing braces) rather than hand edits,
because the bodies are long and contain UTF-8 em-dashes. **Verify the dedent and brace
math by reading the bodies** — typecheck + the full suite passing is strong evidence, but
the mechanical transform is the highest-risk part of this change. The post-edit shapes were
re-read and confirmed (single loop at the correct depth, body one level deeper, correct
close).

## Validation performed (this is a floor, not a ceiling)

- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus run typecheck` (src `tsc --noEmit`) → clean.
- `yarn workspace @quereus/quereus test` → **6098 passing, 9 pending, 0 failing**.

Behavioral safety nets that exercise the rewritten code and stayed green:
- `fk-restrict-runtime.spec.ts` — directly calls `assertNoRestrictedChildrenForParentMutation`
  and `assertTransitiveRestrictsForParentMutation` (RESTRICT, transitive CASCADE→RESTRICT on
  both DELETE and UPDATE, lens pre-check, NO-action skip).
- `maintained-parent-fk.spec.ts` — full RESTRICT/CASCADE/SET NULL/SET DEFAULT matrix across
  bounded-delta, full-rebuild, residual-aggregate arms, MV-over-MV, feedback loop, cross-cases.
- sqllogic: `41-foreign-keys`, `41-fk-cascade-conflict-and-self-ref`, `41-fk-cross-schema`,
  `41-fk-extended-targets`, `41.1-fk-collation-conflict`.
- `lens-enforcement.spec.ts` — divergent-basis-FK suppression (identity-dependent) stayed green.

New tests added:
- **Plan-time gate** (`test/plan/parent-fk-check-gate.spec.ts`): asserts a `delete from
  <unreferenced>` emits **0** parent-side FK checks, a singly-referenced parent emits **1**,
  and a doubly-referenced parent emits **2** — read off the `CHECK <n> CONSTRAINTS ON DELETE`
  ConstraintCheck node detail via `query_plan()`. This directly pins site 4's gate.
- **Maintained-parent throughput** (`maintained-parent-fk.spec.ts`): an unreferenced
  maintained `M` driven through 200 inserts + 100 updates + 100 deletes maintains a result
  identical to the live source projection, with white-box `getReferencingForeignKeys('main',
  'm') === []` before and after; paired with a referenced `M` that still cascades across a
  bulk of deltas (non-empty bucket).

## Gaps / things to scrutinize (be adversarial)

1. **Error-message determinism for a *multi-child RESTRICT* runtime throw is NOT pinned by a
   new test.** The plan-time test asserts the *count* (2) for two referencing children, and
   the index unit tests assert declaration-order preservation, but no test asserts that a
   2-child RESTRICT *runtime* violation names the same (first-surviving) child as before. The
   ordering is preserved by construction (`buildReverseFkIndex` order); if you want belt-and-
   suspenders, add a 2-child RESTRICT runtime test asserting the named child.
2. **Plan-time count proxy.** The plan-time test infers "parent-side FK checks" from the total
   constraint count on a DELETE node, valid because these minimal tables carry no other
   DELETE-time constraint class. If you add CHECK constraints to those fixtures the proxy
   breaks — it is fixture-scoped on purpose.
3. **Discovered pre-existing bug — `tickets/fix/delete-range-predicate-under-deletes.md`.**
   While writing the throughput test I found that `delete from t where id > 100` (and other
   non-front-anchored range predicates like `id between …` / `id % 2 = 0`) **silently
   under-deletes** on the memory vtab — reproduces on a plain table with `foreign_keys` OFF,
   so it is independent of this diff. The throughput test deliberately uses a front-anchored
   `delete … where id <= 100` to dodge it, with an inline caveat pointing at the fix ticket.
   The reviewer should NOT treat that as a hole in this ticket; it is a separate, serious
   correctness bug now tracked.
4. **Cross-schema keying.** The index keys a declared FK under the *child's* schema
   (`fk.referencedSchema ?? childTable.schemaName`), identical to the old scans — so
   cross-schema FK resolution is whatever it was (the `41-fk-cross-schema` suite covers it).
   No behavior was intended to move here; confirm the suite is the authority.

## Out of scope (parked)

Logical-FK (lens) reverse gating — `tickets/backlog/reverse-fk-index-lens-coverage.md` (the
physical reverse index does not cover lens slots; those walkers are already O(slots) and
empty in almost all DBs).
