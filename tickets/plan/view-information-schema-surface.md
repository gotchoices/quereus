description: Expose view updateability metadata through `information_schema.views` — the `is_insertable_into`, `is_updatable`, `is_deletable`, and `effective_targets` columns per the `docs/view-updateability.md` § "information_schema surface" section. Reads off the `updateLineage` / `attributeDefaults` surfaces produced by `view-updateability-phase-1`; independently reviewable once that lands.
prereq: view-updateability-phase-1, view-mutation-plan-node-substrate
files: docs/view-updateability.md
----

Deferred out of `view-updateability-phase-1` (the implementation ticket) so the
core write-through machinery reviews independently of the introspection surface.

## Background

`docs/view-updateability.md` specifies an `information_schema.views` surface with:

- `is_insertable_into` — whether an insert can propagate to the underlying bases.
- `is_updatable` — whether an update can propagate.
- `is_deletable` — whether a delete can propagate.
- `effective_targets` — the set of base tables a mutation against the view reaches.

These are computable from the per-attribute `updateLineage`
(`base` / `computed` / `null-extended`) and `attributeDefaults` surfaces, plus the
propagation pass's per-base operation list (the same source `ChangeScope`
consumes for `effective_targets`).

> **Surface dependency.** The *plan-node-threaded* `updateLineage` / `AttributeDefault`
> on `PhysicalProperties` is delivered by `view-mutation-plan-node-substrate`, **not**
> `view-updateability-phase-1` — Phase 1 shipped only the single-source AST-rewrite
> lineage in `planner/analysis/update-lineage.ts`. Hence the added
> `view-mutation-plan-node-substrate` prereq. A v1 of this surface could report from the
> Phase-1 single-source lineage for the common case; general per-column accuracy needs
> the substrate.

## Why backlog, not plan

This is a thin read-only projection over already-built analysis surfaces. It has
no design questions left once Phase 1 lands — promote it to `plan/` (or straight
to `implement/` if the surface is obvious at that point) after the Phase 1
implement ticket reviews clean. Until then there is nothing to build against.

## Out of scope

- The write-through machinery itself (that's `view-updateability-phase-1`).
- Phases 2–7 lineage shapes — `is_*` columns should reflect *current shipped*
  propagatability, so this surface gains accuracy as later phases land rather
  than needing rework.
