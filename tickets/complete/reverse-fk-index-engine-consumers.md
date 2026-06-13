description: Routed the runtime FK-action engine and the plan-time parent-side FK builder through SchemaManager.getReferencingForeignKeys (the catalog reverse-FK index) instead of an O(catalog) nested-loop walk. Four discovery loops converted; per-FK bodies preserved verbatim. Maintained-parent enforcement short-circuits in O(1) transitively. Reviewed: build + lint clean, full quereus suite green (6099 passing), one minor finding fixed inline (multi-child RESTRICT runtime order-determinism test added).
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts          # 3 sites converted (executeForeignKeyActions, assertNoRestrictedChildrenForParentMutation, assertTransitiveRestrictsForParentMutation step 2); lens walkers (528, 760) left on _getAllSchemas by design
  - packages/quereus/src/planner/building/foreign-key-builder.ts # buildParentSideFKChecks converted
  - packages/quereus/src/schema/manager.ts                       # prereq's getReferencingForeignKeys / buildReverseFkIndex (read for identity + order verification)
  - packages/quereus/test/runtime/fk-restrict-runtime.spec.ts    # + multi-child RESTRICT first-declared-child determinism test (review add)
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # + unreferenced throughput gate case & referenced pair
  - packages/quereus/test/plan/parent-fk-check-gate.spec.ts      # plan-time gate (0 / 1 / 2 parent-side checks)
  - packages/quereus/test/schema/reverse-fk-index.spec.ts        # prereq index unit tests (iteration order, identity)
  - docs/materialized-views.md                                   # § Parent-side referential enforcement — cost claim O(catalog) → index-gated
  - docs/schema.md                                               # § Reverse foreign-key index — over-report parenthetical corrected
  - tickets/fix/delete-range-predicate-under-deletes.md          # pre-existing memory-vtab DELETE range-predicate bug discovered during testing
  - tickets/backlog/reverse-fk-index-lens-coverage.md            # parked: logical-FK (lens) reverse gating
----

# Route the FK-action engine through the reverse-FK index — COMPLETE

## What landed

Four catalog-walking discovery loops collapsed to a single indexed lookup,
`db.schemaManager.getReferencingForeignKeys(parent.schemaName, parent.name)` (the
primitive shipped by `reverse-fk-index-catalog`). In every case the two discovery
filters (`fk.referencedTable` match, `referencedSchema ?? childTable.schemaName`
target match) are satisfied by the index key and were dropped; the rest of each
per-FK body is verbatim.

Converted sites:
1. `executeForeignKeyActions` — cascade / set-null / set-default executor.
2. `assertNoRestrictedChildrenForParentMutation` — runtime RESTRICT pre-check.
3. `assertTransitiveRestrictsForParentMutation` **step 2** — cascade-recursion discovery loop.
4. `buildParentSideFKChecks` — plan-time parent-side `NOT EXISTS` synthesis.

Untouched by design: the lens-slot walkers (`executeLensForeignKeyActions`,
`assertLensRestrictsForParentMutation`, both still on `_getAllSchemas` →
`getAllLensSlots()` — the physical reverse index does not cover lens slots), and
`MaterializedViewManager.enforceParentSideReferentialActions` (its win is transitive:
it just calls the two now-index-gated engine functions).

## Review findings

Adversarial pass over the implement diff (`ba3d0f2c`), read before the handoff summary.

### Checked — verified correct, no change
- **Mechanical transform fidelity (the implementer's highest-risk item).** Read all four
  rewritten bodies against the diff: each is a single loop at the correct depth, body one
  level shallower, braces balanced. The per-FK bodies (action gate, `suppressed.has(fk)`,
  arity guard, MATCH-SIMPLE NULL skip, UPDATE referenced-column short-circuit, SET DEFAULT
  recursion, transitive `visited`/`lensRouted` threading) are byte-for-byte preserved.
- **No orphaned locals.** The removed `parentSchemaLower` / `parentTableLower` declarations
  have zero remaining references (`find_references` clean).
- **Call-site correctness.** All four sites pass the correct parent `(schemaName, name)` —
  `parentTable.*` in the runtime sites, `tableSchema.*` in the plan builder.
- **Identity + order dependence.** `buildReverseFkIndex` pushes the same `fk` object held in
  `childTable.foreignKeys` (identity preserved, required by `suppressed.has(fk)` and the lens
  suppression set) and emits buckets in schema-insertion → table → FK-declaration order
  (matching the old nested-loop order, so first-surviving-child RESTRICT determinism holds).
  Confirmed in `manager.ts` and exercised by `reverse-fk-index.spec.ts` + `lens-enforcement.spec.ts`.
- **Out-of-scope walkers.** The two surviving `_getAllSchemas` calls in
  `foreign-key-actions.ts` (lines 528, 760) iterate `getAllLensSlots()`, not tables/FKs —
  correctly parked (`tickets/backlog/reverse-fk-index-lens-coverage.md`), not missed scans.
- **Docs.** No other `docs/` file still describes the FK discovery as an O(catalog) / nested
  walk; the two edited sections (`materialized-views.md` cost claim, `schema.md` over-report
  parenthetical) reflect the new index-gated reality.
- **Lint + full suite.** `yarn workspace @quereus/quereus run lint` → exit 0;
  `yarn workspace @quereus/quereus test` → **6099 passing, 9 pending, 0 failing**.

### Found + fixed inline (minor)
- **Multi-child RESTRICT runtime order-determinism was not pinned by a behavioral test**
  (flagged by the implementer as Gap 1). The plan-time gate test asserts the *count* and the
  index unit tests assert declaration order, but no test asserted that a runtime 2-child
  RESTRICT throw names the *first-declared* child. Added
  `names the first-declared referencing child on a multi-child RESTRICT throw` to
  `fk-restrict-runtime.spec.ts`: two children both RESTRICT-referencing the parent and both
  holding a referencing row; a direct `assertNoRestrictedChildrenForParentMutation` call must
  throw naming `c1` and must NOT name `c2`. Passing (suite 6098 → 6099). This pins the
  iteration-order contract — the whole reason order is preserved — at the message level.

### Found + dispositioned as separate ticket (major, pre-existing, NOT this diff)
- **`tickets/fix/delete-range-predicate-under-deletes.md`** — `delete from t where id > 100`
  (and other non-front-anchored range predicates) silently under-deletes on the memory vtab.
  Confirmed pre-existing by inspection: this diff touches only FK *discovery* (read-side) and
  the plan builder — never the memory-vtab scan-then-delete path — and the implementer's repro
  fires with `foreign_keys` OFF on a plain table. Correct disposition; the throughput test
  deliberately uses a front-anchored `id <= 100` to dodge it, with an inline caveat.

### Considered, no finding
- **Plan-time count proxy** (Gap 2): the plan-time test infers FK-check count from total DELETE
  constraint count, valid because the minimal fixtures carry no other DELETE-time constraint
  class. Fixture-scoped on purpose; acceptable.
- **Cross-schema keying** (Gap 4): the index key uses `fk.referencedSchema ?? childTable.schemaName`,
  identical to the old scans, so cross-schema resolution is unchanged. `41-fk-cross-schema`
  remains the authority and stayed green.
- **Over-report safety margin.** Dropping the per-consumer `referencedTable`/target re-check
  leans harder on the prereq's invalidation correctness (a stale index holding a since-dropped
  FK would now be enforced without a re-check). This is the deliberate design of the index
  primitive — the key enforces the match — and the prereq's `reverse-fk-index.spec.ts` covers
  the full DDL-lifecycle invalidation. Noted, not a finding for this ticket.

## Validation performed

- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus test` → 6099 passing, 9 pending, 0 failing.

## Out of scope (parked)

Logical-FK (lens) reverse gating — `tickets/backlog/reverse-fk-index-lens-coverage.md` (the
physical reverse index does not cover lens slots; those walkers are already O(slots) and
empty in almost all DBs).
