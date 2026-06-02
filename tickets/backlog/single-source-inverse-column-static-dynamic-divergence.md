description: A SINGLE-source view exposing an inverse-profile column (e.g. `create view v as select b + 1 as bp from t`) reports `is_updatable = 'YES'` through the static `view_info` / `column_info` surfaces, but a real `update v set bp = ...` is REJECTED (`no-inverse`) by the single-source mutation spine. The static surface (`baseSiteOf`) resolves any `base` site including one carrying an `inverse`; the dynamic single-source path still classifies projections at the AST level with the identity-only `classifyProjectionExpr`. The two disagree. (Pre-existing — not introduced by `view-mutation-multisource-threaded-updatesite`; surfaced during its review.)
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/single-source.ts, docs/view-updateability.md

## Problem

The static updateability surfaces and the dynamic single-source write path disagree
about whether a single-source **inverse-profile** column is writable:

- **Static (`func/builtins/schema.ts`):** `deriveColumnInfo` / `deriveViewInfo` read
  the plan-node `updateLineage` through `baseSiteOf`, which resolves *any* `base`
  site — including one carrying an `inverse` (e.g. `b + 1` traces to `base` `t.b`
  with inverse `w ↦ w - 1`). So `column_info('v')` reports column `bp` as
  `is_updatable = 'YES'`, `base_table = 't'`, `base_column = 'b'`.

- **Dynamic (single-source spine):** the single-source view-mutation path classifies
  projections at the AST level via the identity-only `classifyProjectionExpr`
  (`scalar-invertibility.ts`), so `bp` is `computed` (read-only). A real
  `update v set bp = 9` is rejected with a `no-inverse` diagnostic.

The **multi-source** (two-table inner-join) path was just taught to consume the
threaded `inverse` (ticket `view-mutation-multisource-threaded-updatesite`), so a
join view's inverse column is now writable both statically and dynamically. The
single-source path was intentionally left out of that ticket's scope, which is why
the divergence is single-source-only.

### Reproduction

```sql
create table t (id integer primary key, b integer);
create view v as select id, b + 1 as bp from t;
select column_name, is_updatable, base_column from column_info('v');
--  bp -> is_updatable = 'YES', base_column = 'b'   (static says writable)
update v set bp = 9 where id = 1;
--  rejected: no-inverse  (dynamic says read-only)
```

## Expected behavior / decision needed

The two surfaces must agree. There are two directions; this is a **design question**
for the human:

1. **Widen the dynamic single-source path** to consume the threaded `inverse`
   (mirroring what multi-source now does) — `update v set bp = 9` would store
   `t.b = 8`. This is the natural continuation of the inverse-writability work and
   makes the static `YES` honest. It requires the single-source spine to stop
   relying on the identity-only AST classifier and instead read the plan-node
   `UpdateSite` (the `identityBaseColumn` / `viewColumnsFromUpdateLineage`
   reader is deliberately identity-only for `deriveViewColumns` parity, so this
   would need a separate full-lineage reader on the dynamic path).

2. **Narrow the static surface** so a single-source `base`-with-`inverse` column
   reports `is_updatable = 'NO'` until the dynamic path supports it — i.e. make
   `baseSiteOf` (or its single-source callers) inverse-aware. This keeps the static
   report conservative and truthful to today's dynamic behavior, at the cost of
   under-reporting a column that *will* become writable.

Direction (1) is the likely long-term intent (it matches the multi-source
trajectory), but it is a feature, not a bug-fix, so it is parked here rather than
in `fix/`. Whichever is chosen, add golden coverage (`06.3.5-column-info` /
`06.3.4-view-info`) and a single-source PutGet law so the agreement is pinned.

## Notes

- Pre-existing: `func/builtins/schema.ts` `baseSiteOf` already resolved inverse
  sites before the multi-source ticket; that ticket did not touch the static
  surfaces or the single-source spine.
- Documented (not fixed) in `docs/view-updateability.md` § Scalar Invertibility
  ("The single-source spine does not yet consume inverses…") and in the
  `identityBaseColumn` doc-comment in `analysis/update-lineage.ts`.
