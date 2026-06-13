description: Precompute a "tables referencing M" reverse-index so parent-side FK enforcement can skip the O(catalog) referencing-FK scan when nothing references M. ALREADY DELIVERED — archived from plan/ with no new implement work.
files:
  - packages/quereus/src/schema/manager.ts                      # reverseFkIndex, getReferencingForeignKeys, buildReverseFkIndex, invalidateReverseFkIndex
  - packages/quereus/src/runtime/foreign-key-actions.ts         # engine consumers (execute/assert* route through the index)
  - packages/quereus/src/planner/building/foreign-key-builder.ts# buildParentSideFKChecks consumer
  - packages/quereus/src/core/database-materialized-views.ts    # enforceParentSideReferentialActions (benefits transitively)
  - packages/quereus/test/schema/reverse-fk-index.spec.ts       # index unit tests
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts  # reverse-FK gate behavioral parity tests
  - packages/quereus/test/plan/parent-fk-check-gate.spec.ts     # plan-time gate tests
----

# Reverse-index for inbound FKs (parent-side enforcement fast-path) — already delivered

## Outcome

This plan ticket described a performance optimization (a precomputed reverse-FK index so
parent-side referential enforcement on a maintained table `M` short-circuits in O(1) when
nothing references `M`). **On investigation the entire feature was already implemented,
wired, and tested** — delivered under the engine-level work named
`reverse-fk-index-engine-consumers` (referenced by name in
`test/plan/parent-fk-check-gate.spec.ts`). No new implement ticket was warranted; emitting
one would have re-done shipped, green code. The ticket is archived to `complete/`.

## What exists in the tree (verified against each requirement)

- **The index** — `SchemaManager.reverseFkIndex: Map<string, ReferencingForeignKey[]> | null`
  (`manager.ts`), lazily (re)built by `buildReverseFkIndex()` and read via
  `getReferencingForeignKeys(parentSchema, parentTable)`. A miss returns the shared frozen
  `EMPTY_REFERENCING_FKS` array — the O(1) unreferenced-table gate, zero per-call allocation.
- **Engine-level scope (benefits ordinary DML too, not maintenance-only)** — every
  parent-side referential scan routes through the index:
  `executeForeignKeyActions`, `assertTransitiveRestrictsForParentMutation`,
  `assertNoRestrictedChildrenForParentMutation` (`foreign-key-actions.ts`), the plan-time
  `buildParentSideFKChecks` (`foreign-key-builder.ts`), and
  `SchemaManager.assertNoReferencingChildrenForDrop` (the DROP path).
- **Maintenance caller** — `enforceParentSideReferentialActions`
  (`database-materialized-views.ts`) calls the two now-indexed engine functions per
  delete/key-update backing change, so a maintained `M` with no inbound FK pays only the
  `foreign_keys`-pragma check plus one map lookup per change.
- **Cross-schema FKs** — keyed by qualified name: `${fk.referencedSchema ?? childTable.schemaName}.${fk.referencedTable}`,
  lowercased, in `buildReverseFkIndex`.
- **Lens / logical-FK path not regressed** — the index keys only physical
  `TableSchema.foreignKeys`. The logical-FK walkers (`executeLensForeignKeyActions`,
  `assertLensRestrictsForParentMutation`) remain separate calls gated on `lensRouted`, so
  the physical fast-path's empty bucket never gates off the logical step. Maintenance writes
  are `lensRouted = false`, so the maintenance caller is unaffected either way.
- **Invalidation** — a pure derived cache nulled by `invalidateReverseFkIndex()`:
  - a self-subscribed change listener resets on `table_added` / `table_modified` /
    `table_removed` (covers `create table … references`, `alter … add/drop constraint`, FK
    retargets from parent/column rename, `drop table`);
  - the event-less catalog paths reset directly — `addSchema`, `getOrCreateSchema`,
    `removeSchema` (ATTACH/DETACH fire no event), and `importTable` (silent rehydration).

## Tests already covering it

- `test/schema/reverse-fk-index.spec.ts` — index rebuild correctness across the DDL
  lifecycle, the shared-empty-array gate, and the in-file DROP consumer.
- `test/runtime/maintained-parent-fk.spec.ts` — "reverse-FK index gate" describe block:
  white-box assertion that an unreferenced maintained table resolves to `[]` while a sibling
  referenced table resolves to a non-empty bucket (proving the index is built, not unbuilt),
  plus behavioral parity across a bulk insert/update/delete delta lifecycle; and the paired
  referenced-table CASCADE case. Cross-schema (`s2.m`) coverage included.
- `test/plan/parent-fk-check-gate.spec.ts` — plan-time gate: a referenced parent's DELETE
  carries its parent-side FK checks; an unreferenced table's DELETE carries none.

## Review findings

- **No functional gap.** Every requirement in the original spec — precomputed index, O(1)
  unreferenced gate, engine-level scope, qualified cross-schema keys, lens non-regression,
  full invalidation coverage — is present and tested.
- **One doc-drift fix applied inline** (the only residual): the JSDoc on
  `enforceParentSideReferentialActions` (`database-materialized-views.ts`) still described
  the per-change cost as an `O(catalog)` referencing-FK scan ("parity, not a new tax"), which
  became inaccurate once the engine adopted the reverse index. Updated to state both calls
  route through `getReferencingForeignKeys` and short-circuit in O(1) for an unreferenced
  maintained table. Comment-only change; no behavior touched, existing tests remain
  authoritative.
