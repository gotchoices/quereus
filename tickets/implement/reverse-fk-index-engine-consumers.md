description: Route the runtime FK-action engine and the plan-time parent-side FK builder through SchemaManager's reverse-FK index, replacing their O(catalog) referencing-FK walks with an O(referencing-FKs) lookup. The maintained-table parent-side enforcement hook then short-circuits in O(1) for an unreferenced maintained table — transitively, with no edit to the maintenance path (the triage steer: improve the general architecture, not a special case).
prereq: reverse-fk-index-catalog
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts          # executeForeignKeyActions, assertNoRestrictedChildrenForParentMutation, assertTransitiveRestrictsForParentMutation step 2
  - packages/quereus/src/planner/building/foreign-key-builder.ts # buildParentSideFKChecks (plan-time NOT EXISTS synthesis)
  - packages/quereus/src/core/database-materialized-views.ts     # enforceParentSideReferentialActions — UNCHANGED; win is transitive (add regression test only)
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # existing matrix — add the unreferenced-maintained-table throughput case
  - packages/quereus/test/runtime/fk-actions.spec.ts (or nearest) # behavioral regression for the rewritten engine sites
----

# Route the FK-action engine through the reverse-FK index

## Why

`reverse-fk-index-catalog` landed `SchemaManager.getReferencingForeignKeys(parentSchema,
parentTable)`: a derived, event-invalidated map from a referenced `schema.table` to its
referencing FKs, returning `[]` (the O(1) gate) when nothing references the table. This ticket
makes the engine consume it everywhere it currently re-walks the whole catalog to find
referencing FKs.

Because the maintained-parent enforcement hook
(`MaterializedViewManager.enforceParentSideReferentialActions`) calls
`assertTransitiveRestrictsForParentMutation` + `executeForeignKeyActionsAndLens`, converting
*those* functions makes the maintenance path's per-backing-delta cost drop to O(1) for an
unreferenced maintained table **with no change to `database-materialized-views.ts`**. Ordinary
`delete from P` / `update P` benefit identically. That is the "general architecture, not a
special case" outcome the prereq's review steered toward.

## Design

Each site shares one rewrite. Replace the nested discovery walk:

```ts
for (const schema of db.schemaManager._getAllSchemas()) {
  for (const childTable of schema.getAllTables()) {
    if (!childTable.foreignKeys) continue;
    for (const fk of childTable.foreignKeys) {
      if (fk.referencedTable.toLowerCase() !== parentTableLower) continue;
      const targetSchema = fk.referencedSchema ?? childTable.schemaName;
      if (targetSchema.toLowerCase() !== parentSchemaLower) continue;
      // ── per-FK body (KEEP verbatim) ──
    }
  }
}
```

with the indexed lookup (the two discovery filters are now satisfied by the index key and
drop out; everything else stays byte-for-byte):

```ts
for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(parentTable.schemaName, parentTable.name)) {
  // ── per-FK body (UNCHANGED): action gate, suppressed.has(fk), resolveReferencedColumns
  //    arity guard, MATCH-SIMPLE NULL skip, UPDATE column-change short-circuit, the
  //    cascade / RESTRICT / recursion work ──
}
```

Critically preserved per site:
- The **action gate** (`if (action === 'restrict') continue;` in the cascade functions;
  `if (action !== 'restrict') continue;` in the RESTRICT pre-check; the
  cascade/setNull/setDefault filter in the transitive walk).
- The **`suppressed` set** computed before the loop (`basisFksOverriddenByDivergentLensFk`
  when `lensRouted`) and the `suppressed.has(fk)` check — the index preserves FK object
  identity (prereq guarantee), so this keeps working.
- The **arity guard**, **MATCH-SIMPLE NULL skip**, and **UPDATE referenced-column-change
  short-circuit**, all of which depend on the parent row passed in, not on discovery.
- The **`visited` cycle-detection** keying in `executeForeignKeyActions` /
  `assertTransitiveRestrictsForParentMutation`.

### Sites to convert

1. `executeForeignKeyActions` (foreign-key-actions.ts) — the cascade executor.
2. `assertNoRestrictedChildrenForParentMutation` — the runtime RESTRICT pre-check.
3. `assertTransitiveRestrictsForParentMutation` **step 2** (the cascade-recursion discovery
   loop). Step 1 / step 1b call helpers; only step 2's own `for (schema)…` walk converts.
4. `buildParentSideFKChecks` (foreign-key-builder.ts) — the plan-time `NOT EXISTS` synthesis
   walk. Uses `ctx.schemaManager`, so it calls `getReferencingForeignKeys` the same way.

### Explicitly NOT in scope (lens / logical FKs)

The lens walkers (`executeLensForeignKeyActions`, `assertLensRestrictsForParentMutation`),
`basisFksOverriddenByDivergentLensFk`, and `findLogicalParentFkRefs` scan **lens slots**
(`getAllLensSlots`), not `TableSchema.foreignKeys`, so the physical reverse-FK index does not
cover them and they stay **unchanged**. They are already cheap (O(slots), and slots are empty
in the overwhelming majority of databases). For the maintenance hook `lensRouted = false`, so
no lens path runs at all; the suppression set is the empty set without calling
`basisFksOverriddenByDivergentLensFk`. A logical-FK reverse gate is parked in
`tickets/backlog/reverse-fk-index-lens-coverage.md`.

`enforceParentSideReferentialActions` itself is **not edited** — its `foreign_keys` pragma
early-return stays, and the per-change cost reduction is entirely transitive through the two
engine functions it calls.

## Edge cases & interactions

- **Behavioral parity is the bar.** Every existing FK test (cascade delete/update, set-null,
  set-default, RESTRICT block, transitive multi-level cascade, cross-schema FK, self-FK,
  composite FK, cascade-cycle detection) must pass unchanged. The rewrite is discovery-only;
  no semantics move.
- **Error-message determinism.** A multi-child RESTRICT violation names the *first* surviving
  child. The prereq index preserves the original iteration order, so the named child is
  identical — but confirm with a 2-child RESTRICT test if one exists.
- **`lensRouted = true` divergent suppression** still elides the right basis FKs: identity
  preserved ⇒ `suppressed.has(fk)` unchanged. Pin with an existing lens divergent-action test
  (lens-overrides / lens FK suite) staying green.
- **Maintenance fan-out gate.** A maintained table `M` that nothing references: a maintenance
  delete/key-update of `M` now pays one map lookup (empty bucket) per backing delta instead of
  a full catalog walk — assert via the new throughput case (below). A maintained table that
  *is* referenced still enforces correctly (RESTRICT/CASCADE/SET NULL all fire) — the existing
  `maintained-parent-fk.spec.ts` matrix already covers this and must stay green.
- **Index freshly invalidated mid-statement.** A statement that does DDL then DML (rare) hits a
  rebuild on first lookup — correct, just uncached for that one access.

## Key tests

- **Engine regression** (foreign-key-actions): re-run / confirm the full FK-action suite green
  — cascade, set-null, set-default, RESTRICT, transitive, cross-schema, self-FK, composite,
  cycle. No new behavior; this is the safety net for the discovery rewrite.
- **Plan-time regression** (foreign-key-builder / golden plans): the synthesized parent-side
  `NOT EXISTS` checks are identical for a referenced parent and **absent** for an unreferenced
  one (the gate also trims plan-time work) — verify a `delete from <unreferenced>` plan emits
  no parent-side FK check, and a referenced parent's plan is unchanged.
- **Maintained-parent throughput** (add to maintained-parent-fk.spec.ts): a maintained table
  `M` that **nothing** references, driven through many backing deltas (bulk source write), must
  produce identical results to today and must not consult the catalog per delta. Assert
  behavior identical; optionally white-box that `getReferencingForeignKeys('main','m')` returns
  `[]` so the hook's two engine calls early-return. Pair with a **referenced** maintained table
  to confirm enforcement still fires after the gate change.

## TODO

- Convert the discovery loop in `executeForeignKeyActions`, `assertNoRestrictedChildrenForParentMutation`,
  and `assertTransitiveRestrictsForParentMutation` step 2 to `getReferencingForeignKeys`,
  keeping every per-FK body line (action gate, suppression, arity, NULL skip, UPDATE
  short-circuit, recursion, visited) intact.
- Convert `buildParentSideFKChecks` (foreign-key-builder.ts) likewise.
- Leave the lens functions and `enforceParentSideReferentialActions` untouched.
- Add the unreferenced-maintained-table throughput case (+ referenced counterpart) to
  `test/runtime/maintained-parent-fk.spec.ts`.
- Add / confirm engine + plan-time regression coverage for the rewritten sites.
- `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test` green.
- Update `docs/materialized-views.md` § Parent-side referential enforcement and/or
  `docs/schema.md` to note the scan is now index-gated (parity cost claim → O(1)-gated).
