description: Review the `view_info()` TVF — the per-view updateability introspection surface (`is_insertable_into` / `is_updatable` / `is_deletable` / `effective_targets`) realizing `docs/view-updateability.md` § Information Schema Surface as a read-only static projection over the planned view body's `updateLineage` / `attributeDefaults` + base-column flags.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/quereus/view-info.spec.ts, docs/view-updateability.md
----

# Review: view_info() — view updateability introspection surface

Implements the deferred introspection surface from `view-updateability-phase-1`.
This is a **read-only projection** — it touches no propagation/execution path.

## What landed

- **`viewInfoFunc`** (`func/builtins/schema.ts`): a `createIntegratedTableValuedFunction`
  named `view_info`, `numArgs: -1` (0-arg lists every plain view across all schemas;
  optional 1-arg name filter, mirroring `function_info`), `deterministic: false`,
  `relationalAdvertisement` keyed on `(schema, name)` (`[[{index:0},{index:1}]]`).
  Columns: `schema`, `name`, `is_insertable_into`, `is_updatable`, `is_deletable`
  (all `'YES'`/`'NO'` TEXT), `effective_targets` (JSON-array TEXT, `'[]'` when none).
- **Registration** in `func/builtins/index.ts` `BUILTIN_FUNCTIONS` + import, next to the
  other `*_info` funcs.
- **Doc reconciliation** (`docs/view-updateability.md` § Information Schema Surface):
  `information_schema.views` → `view_info()` TVF, SQL-standard column meanings kept;
  the per-column `is_updatable` paragraph is now a forward note pointing at
  `tickets/backlog/view-column-updateability-surface.md`. Added an Implementation-Surface
  bullet for the func.

### Derivation (all static — no dry-run mutation)

Per view, lazily per call (re-plan-on-read; same posture as `deriveBackingShape`):

1. Plan the body **logically** and read the root's backward `updateLineage`
   (keyed by output `Attribute.id`), plus a whole-spine walk of `attributeDefaults`.
2. `effective_targets` = distinct base tables reached by `kind:'base'` output sites
   (null-extended unwrapped), resolved via a `tableId → TableReferenceNode` map, sorted.
3. `is_updatable` = ≥1 output column has base lineage.
4. `is_deletable` = every reachable base's **PK columns are all exposed** through base
   lineage.
5. `is_insertable_into` = every not-null-without-declared-default, non-generated base
   column of every reachable base is **projected or defaultable**.
6. Per-view `try/catch` → conservative all-`NO`/`'[]'` row (logged); never throws the TVF.

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @quereus/quereus typecheck` ✓, `lint` ✓, `test` ✓
  (4149 passing / 9 pending / 0 failing).
- **`test/logic/06.3.4-view-info.sqllogic`** — column-value cases: identity, rename,
  projected-away PK, projected-away constant-FD default (the crux), `select *` + predicate,
  declared-default-survives-projection, not-null-not-projected, computed-only, VALUES,
  aggregate, recursive-CTE, multi-source inner join, name filter + 0-arg enumeration.
- **`test/quereus/view-info.spec.ts`** — cross-checks (assert agreement, don't duplicate):
  `effective_targets` == the distinct base set `propagate()` reaches (single-source +
  multi-source join); `keysOf(root)` non-empty ⇒ `is_deletable='YES'` and the forward key
  projects onto the base PK.

## Reviewer focus — known gaps & deliberate calls (please probe)

1. **Deviation from the ticket's `db.getPlan` idiom → uses `db._buildPlan` (logical).**
   The optimizer degrades a join's top-node `updateLineage` to `computed`
   (doc § surface authority), which would make the *required* multi-source test report
   `effective_targets='[]'` / `is_updatable='NO'`. The logical tree preserves the
   Project/Join/TableReference structure that threads lineage — exactly what the
   view-mutation substrate (`planner/mutation/*`) plans for the same reason, which is also
   why `effective_targets` agrees with `propagate()`. Side benefit: `_buildPlan` skips the
   optimizer, so it is cheaper than `getPlan`. **Verify** this is the right call and that
   logical-tree FDs/keys are sufficient for `keysOf` here.

2. **`tag-default` is NOT threaded onto `PhysicalProperties` (honest divergence).**
   Only `constant-fd` (Filter) and `base-default` (TableReference) are emitted into
   `attributeDefaults`; `quereus.update.default_for` is consumed in the rewrite
   (`single-source.ts`), not in `computePhysical`. So a view whose insertability depends on
   a `default_for` tag covering a not-null projected-away column is reported
   `is_insertable_into='NO'` even though the dynamic insert path *succeeds*. This is the
   **conservative** direction (reports NO when actually YES), but it is a real surface ≠
   dynamic-truth divergence. Decide whether to (a) accept as conservative, (b) thread
   `tag-default` onto the physical surface in a follow-up, or (c) special-case view-level
   `default_for` here. Not currently covered by any test.

3. **Multi-source `is_deletable` conservatism.** `ms_jv` (FK join, parent PK hidden by the
   projection) reports `is_deletable='NO'`, yet a `delete from ms_jv` *works* dynamically
   (routes to the FK-child by default). This is faithful to the ticket's per-base rule
   ("PK constructible at *every* reachable base"), but it under-reports deletability for the
   common FK-child-default case. Confirm the per-base reading is the intended contract.

4. **Whole-spine `attributeDefaults` walk** (recovers projected-away constant-FD columns,
   e.g. `AdultsBare`). Each node's defaults are resolved through *that node's own*
   `updateLineage`. Argued safe against false positives because `defaultable` is only
   consulted for tables already in `effective_targets` (root output lineage), so a deep
   correlated-subquery base table cannot leak in. **Please sanity-check** that reasoning,
   especially for a view body with a scalar subquery whose inner table shares no columns
   with the outer.

5. **Outer-join / `null-extended` lineage is unexercised.** `baseSiteOf` unwraps
   `null-extended` to its inner base (forward-compatible, matches the ticket's
   effective-targets rule), but no test drives an outer-join view (out of the plain-view /
   inner-join scope). `is_updatable` uses the unwrapped form, so it counts a null-extended
   column as updatable — only differs from strict `kind==='base'` for outer joins.

6. **No caching** — re-plans every body on every `view_info()` call. Fine for small catalogs;
   a large catalog pays N re-plans per call. Caching was explicitly deferred by the ticket.

7. **`effective_targets` table names are unqualified** (`tableSchema.name`, case-preserved).
   Single-schema today; multi-schema same-named base tables across schemas would be
   ambiguous in the array (the row key is `(schema, name)`, but the array entries are bare).

## Out of scope (parked, do not expand here)

- Per-column `information_schema.columns.is_updatable` →
  `tickets/backlog/view-column-updateability-surface.md`.
- Materialized views: read-only at the write boundary; `view_info()` enumerates
  `getAllViews()` only (an MV would trivially be all-`NO`/`'[]'`).
