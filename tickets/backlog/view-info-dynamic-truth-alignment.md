description: Align `view_info()` updateability columns with dynamic-mutation truth for two known static-surface divergences — `quereus.update.default_for` tag-defaults (currently under-reports `is_insertable_into`) and outer-join `null-extended` columns (currently over-reports `is_updatable` / `effective_targets`).
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, docs/view-updateability.md
----

# view_info() ↔ dynamic-mutation truth alignment

The `view_info()` TVF (landed by `view-information-schema-surface`) is a **static**
projection over the planned body's `updateLineage` / `attributeDefaults`. It is
deliberately conservative, but the review pass identified two places where the
static reading diverges from what the dynamic `propagate()` substrate actually
does. Neither blocks the landed surface — they are tracked here to be resolved as
the lineage surface matures (especially when outer-join view mutation lands).

## Divergence 1 — `default_for` tag-defaults under-report `is_insertable_into` (conservative; NO-when-YES)

`AttributeDefault` declares three kinds — `constant-fd`, `base-default`,
`tag-default` — but only the first two are ever emitted onto `PhysicalProperties`
(`constant-fd` at `FilterNode`, `base-default` at `TableReferenceNode`).
`quereus.update.default_for.<column>` is consumed only in the rewrite
(`planner/mutation/single-source.ts` `rewriteViewInsert`), never threaded onto the
physical surface. Consequently a view whose insertability depends on a
`default_for` tag covering a **not-null, projected-away** base column reports
`is_insertable_into = 'NO'` even though a dynamic insert through the view
*succeeds* (the tag supplies the omitted value).

This is the **safe** direction (reports NO when truth is YES), so it is not
urgent. Resolution options:

- **(b, preferred)** Thread `tag-default` onto `attributeDefaults` so both this
  view-level surface and the parked per-column surface
  (`view-column-updateability-surface`) become accurate with no per-consumer
  special-casing. Note the body is planned standalone (`_buildPlan([view.selectAst])`)
  **without** the view's tags, so the threading must inject the view's
  `default_for` tags at plan time (or `deriveViewInfo` must read `view.tags` via
  `readDefaultFor` and fold the resolved base columns into its `defaultable` map).
- **(c, minimal)** Special-case view-level `default_for` directly in
  `deriveViewInfo`: `readDefaultFor(view.tags)`, resolve each column to its base
  (mirroring `single-source.ts` `resolveDefaultForColumn`), and add it to the
  per-table `defaultable` set. Cheaper but leaves the per-column surface and any
  statement-level `default_for` untouched.

Add a sqllogic case: a `not null`, no-declared-default base column, projected away,
recovered by a `create view … with ("quereus.update.default_for.<col>" = …)` tag
⇒ `is_insertable_into = 'YES'`, cross-checked against a real insert through the view.

## Divergence 2 — outer-join `null-extended` columns over-report (potential false positive; YES-when-NO)

`baseSiteOf` in `schema.ts` unwraps any number of `null-extended` wrappers to the
inner `base` site. This matches the ticket's effective-targets rule ("null-extended
unwrapped") and is harmless for the in-scope plain-view / inner-join shapes (which
never produce `null-extended` sites). **But** for an *outer-join* view body the
`JoinNode` backward method wraps the non-preserved side `null-extended`, and write
materialization of that side is an unimplemented later phase. So an outer-join view
would currently report `is_updatable = 'YES'` and list the null-extended base in
`effective_targets`, while a dynamic `update`/`insert` touching that side is **not
yet supported** — a false positive (the dangerous direction).

This is presently unreachable by any test because outer-join views are out of the
landed scope. When outer-join view mutation lands (or sooner, defensively), decide:

- Keep `effective_targets` unwrapped (the ticket's stated rule) **but** gate
  `is_updatable` / `is_insertable_into` / `is_deletable` contributions on whether
  the producing site is a *writable* base (strict `kind === 'base'`, or a
  `null-extended` site only once its materialization path exists), so the surface
  never advertises a capability the substrate will reject; **or**
- Treat `null-extended` as non-writable uniformly until materialization lands.

Add outer-join view coverage (LEFT/RIGHT/FULL) asserting the surface agrees with
what `propagate()` actually accepts, and update `docs/view-updateability.md`
§ Information Schema Surface to state the outer-join contract explicitly (it
currently only enumerates the wholly-unthreaded read-only shapes).
