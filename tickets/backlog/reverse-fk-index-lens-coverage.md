description: Extend the reverse-FK gate to logical (lens) FKs so the lens cascade walker, lens RESTRICT pre-check, and divergent-basis suppression can also short-circuit in O(1) when no lens slot / logical FK references a basis table.
files:
  - packages/quereus/src/schema/lens-fk-discovery.ts            # findLogicalParentFkRefs, basisFksOverriddenByDivergentLensFk
  - packages/quereus/src/runtime/foreign-key-actions.ts         # executeLensForeignKeyActions, assertLensRestrictsForParentMutation
  - packages/quereus/src/schema/manager.ts                      # candidate home for a lens-backed reverse gate
prereq: reverse-fk-index-catalog
----

# Reverse gate for logical (lens) FKs

## Context

`reverse-fk-index-catalog` + `reverse-fk-index-engine-consumers` build and consume a
catalog-level reverse index over **physical** FKs (`TableSchema.foreignKeys`). That index does
**not** cover *logical* FKs, which live only on a lens slot's `enforced-fk` obligation (on no
basis table) and are discovered by walking `getAllLensSlots()` rather than table FKs.

Today the lens paths — `executeLensForeignKeyActions`, `assertLensRestrictsForParentMutation`,
`basisFksOverriddenByDivergentLensFk`, and the underlying `findLogicalParentFkRefs` — each scan
every schema's lens slots, resolve each slot's single basis spine
(`resolveSlotBasisSource`), and match it against the basis parent table. This is already cheap
in practice: the slot set is empty in the overwhelming majority of databases, and the
maintenance hook never enters these paths (`lensRouted = false`). So the value here is real but
secondary to the physical index.

## Idea

Maintain a reverse gate analogous to the physical index, keyed by the **basis** `schema.table`:
"does any lens slot resolve its basis spine to this table, and does any logical FK reference a
slot so backed?" When the answer is no, the four lens functions early-return in O(1) instead of
walking the slot set. As with the physical index, build it as a pure derived cache rebuilt from
the catalog on lens-slot / obligation lifecycle events; conservatively fall through to the full
slot scan on any uncertainty (a stale gate must never under-report, or it would drop logical
enforcement).

## Caveats

- Lens slots and their `enforced-fk` obligations have their own lifecycle (`declare lens`,
  `apply schema`, lens redeploy, basis retarget). The gate must invalidate on all of them —
  identify the slot-mutation events the way the physical index keys off `table_*`.
- The single-basis-spine resolution (`resolveSlotBasisSource`) is the matching boundary; a
  multi-source / decomposition parent resolves to no single spine and is already a no-op, so
  the gate need only index slots with a resolvable single spine.
- Keep the divergent-action complement invariant intact: the gate only decides *whether to
  scan*, never *which* basis FKs are suppressed.

Promote when lens-routed write throughput over basis tables that back no logical-FK parent
slot becomes a measured concern, or alongside other lens-path performance work.
