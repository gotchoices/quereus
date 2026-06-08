description: Migrated in-scope ad-hoc `attrs.findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex().get(id) ?? -1` surface. No-behavior-change DRY refactor. Reviewed and accepted.
files: packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/src/planner/util/key-utils.ts
----

## What shipped

Migrated the remaining in-scope hand-rolled `findIndex(a => a.id === id)` attribute-index scans to `RelationalPlanNode.getAttributeIndex().get(id) ?? -1` (`reference.ts` uses bare `.get(id)` to preserve its `undefined`-on-miss contract). Pure consistency/DRY cleanup — no behavior change. `getAttributeIndex()` is the cached `attrId → columnIndex` map on `PlanNode` (rebuilds per immutable instance), already adopted by `join-node.ts` and the access rules; this aligns the rest of the in-scope sites with that idiom.

- **Group A — node-in-hand swaps**: `sort.ts`, `window-node.ts` (leading-key index lookup; `sourceAttributes` local kept for `.length`/`extractOrderingFromSortKeys`); `reference.ts` `getColumnIndexForAttribute` collapsed to `return this.getAttributeIndex().get(attributeId);`.
- **Group B — runtime emitters**: `bloom-join.ts`, `merge-join.ts`, `asof-scan.ts` capture `left/right` index maps once before the loop; attribute arrays retained where still needed (row descriptors, collation, col counts); `=== -1` throw-on-unresolved guards preserved verbatim.
- **Group C — `propagateAggregateFds` signature**: parameter `sourceAttrs: readonly Attribute[]` → `sourceAttrIndex: ReadonlyMap<number, number>`; all three callers (`AggregateNode`, `HashAggregateNode`, `StreamAggregateNode`) pass `this.source.getAttributeIndex()`. The function used `sourceAttrs` only for the migrated lookup (`outputColumnCount` is passed separately), so the swap is total.
- **Group D — deliberately not migrated**: `key-utils.ts` `deriveProjectionColumnMap` (pure helper, no owning node, called by unit tests with hand-built `Attribute[]`; documented with a one-line comment); `createTableInfoFromNode` (builds its index map in a single pass — no scan to eliminate).

## Review findings

**Diff reviewed**: implement commit `151d1b56`, read before the handoff summary.

### Correctness / semantics — checked, no issues
- **`?? -1` miss semantics**: historical `findIndex` returns `-1` on miss; `getAttributeIndex().get(id)` returns `undefined` → `?? -1` reproduces it exactly. Real attrs map to real (`>= 0`) indices, so "id present, maps to index 0" is a genuine hit, never confused with a miss. `reference.ts` correctly keeps `undefined`-on-miss via bare `.get()`.
- **Duplicate-id edge**: `findIndex` returns the *first* match; `Map.set(id, i)` keeps the *last*. This diverges only if a single node's `getAttributes()` contains duplicate ids — which is an invariant violation independently guarded by `computeAttributeProvenance` ("Duplicate attribute ID"). Join emitters index `left`/`right` separately, matching the pre-migration `leftAttributes`/`rightAttributes` split. Safe.
- **`propagateAggregateFds`**: verified the parameter was used *only* for the migrated `findIndex`; the `if (srcIdx >= 0 && !map.has(srcIdx))` guard is preserved. All three `computePhysical` callers updated; reference search confirms no others.
- **Throw guards**: the `=== -1 → throw "could not resolve …"` paths in all three emitters preserved verbatim.

### Tests — adequate as-is, none added
No new behavior to cover. `getAttributeIndex()` itself is unit-tested (`test/planner/attribute-provenance.spec.ts`: correct positions, cache identity, rebuild-after-`withChildren`). The migrated emitters (bloom/merge/asof) are exercised by the `.sqllogic` suite; `propagateAggregateFds` by `test/optimizer/keys-propagation.spec.ts`. Full suite green confirms no regression.

### Scope finding — documented, not actioned (minor, not revertible)
The implement commit `151d1b56` bundled **unrelated doc edits** not named in the ticket: `docs/incremental-maintenance.md`, `docs/optimizer.md`, `tickets/backlog/known/updatable-views.md` — all concerning the lens / keyed-derived-relations layer, not attribute indexing. I verified their cross-references resolve (`docs/lens.md` and `tickets/backlog/known/updatable-views.md` exist; the old `tickets/backlog/updatable-views.md` path is gone). They are coherent and harmless. Reverting good docs out of a landed commit would be wrong, so flagged here only — future implement runs should avoid committing unrelated working-tree changes under a ticket commit.

### Follow-up filed (major → backlog)
Many out-of-scope `findIndex(a => a.id === …)` sites remain across `rules/**`, `constraint-extractor.ts`, `physical-utils.ts`, `equi-pair-extractor.ts`. The ticket deferred these; filed `backlog/migrate-remaining-attribute-index-consumers.md` to finish the migration, with the site list and the "don't build a throwaway map for node-less helpers" guidance carried forward.

### Docs
Reviewed every touched source file; no doc updates were *required* for the attribute-index migration (it changes no public/SQL behavior). The bundled lens-layer doc edits are accurate against the current tree (links resolve) but belong to a different effort.

## Verification performed (review pass)
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — 3591 passing / 9 pending (exit 0).
- Build was verified clean during implement; the only compilation-fragile change (the `propagateAggregateFds` signature) is exercised by the passing test run.
