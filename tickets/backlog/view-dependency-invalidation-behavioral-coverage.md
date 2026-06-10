----
description: The `view` plan-dependency invalidation of cached write-through plans (view_modified / materialized_view_modified) is no longer behaviorally observable or tested — restore coverage.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # recordDependency funnel (structural comment only)
  - packages/quereus/src/schema/manager.ts                          # view_modified / materialized_view_modified emitters
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts       # the spec that used to pin this behaviorally
----

# Restore behavioral coverage of view-dependency plan invalidation

Every view-/MV-mediated write records a `view` schema dependency in
`buildViewMutation`, and `ALTER VIEW/MATERIALIZED VIEW … {SET|ADD|DROP} TAGS`
fires `view_modified` / `materialized_view_modified` so a cached prepared
write-through statement re-plans. Until `remove-view-default-for-tag`, the
behavioral `default_for` tag made this observable end-to-end (the cached plan
re-routed to a new default after ALTER), and
`test/plan/view-tag-mutation-plan.spec.ts` pinned it.

With no behavioral reserved tag left, a stale plan and a fresh plan behave
identically under any *legal* tag change, so the invalidation path is now pinned
only structurally (a comment) — if `recordDependency` or the event wiring were
deleted, no test would fail. (The rewritten spec's DROP-TAGS recovery cases do
not exercise it: a failed compile is never cached, so the retry re-plans with or
without invalidation.)

## Expected coverage

Either of:

- **Behavioral**, once any future first-class view construct is mutable via
  `ALTER VIEW` (e.g. an `alter view … set insert defaults`): re-pin that a cached
  prepared write-through statement picks up the change without re-preparing —
  the original spec shape.
- **Unit-level**, available now: assert directly that (a) planning a
  view-/MV-mediated write records a `view` dependency for the target
  (single-source, and at least one of multi-source / decomposition / set-op /
  lens to prove the funnel covers all paths), and (b) a `view_modified` /
  `materialized_view_modified` event for that name invalidates the cached
  statement (observable via the statement/plan-cache API or an internal
  recompile counter), including the case-insensitive canonical-name match.

The read-side negative (a `select … from v` plan records no view dependency and
survives a tag change uninvalidated) is part of the contract and worth a case.
