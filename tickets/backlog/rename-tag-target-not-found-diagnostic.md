----
description: Rename the `tag-target-not-found` mutation-diagnostic reason — it is now raised only for `insert defaults (col = expr, …)` clause entries; no tag is involved.
prereq: view-insert-defaults-not-rewritten-on-source-rename
files:
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts
  - packages/quereus/src/planner/mutation/single-source.ts        # resolveDefaultForColumn raises it
  - docs/view-updateability.md                                    # diagnostic catalog lists the reason
----

# Rename the `tag-target-not-found` diagnostic reason

After `remove-view-default-for-tag`, the `tag-target-not-found`
`MutationDiagnosticReason` is raised in exactly one situation: an
`insert defaults (col = expr, …)` clause entry naming a column that is neither a
view-output nor a base column. The "tag" in the name is a fossil of the retired
`quereus.update.default_for.<col>` surface and now misleads users reading the
structured diagnostic (no tag appears anywhere in their statement).

Rename to something construct-accurate — `default-target-not-found` (or
`insert-default-target-not-found`) — across the reason union, the raise site,
the diagnostic catalog in docs/view-updateability.md, and every test asserting
the reason string. No behavior change; reason strings are part of the structured
`MutationDiagnostic` surface, and backwards compatibility is not yet a concern.

Deferred until `view-insert-defaults-not-rewritten-on-source-rename` lands —
that fix reproduces via this reason and renaming first would churn it.
