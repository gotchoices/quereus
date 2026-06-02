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

## Decision (settled): widen the dynamic single-source path

The two surfaces must agree, and the resolution is **direction (1) — widen the
dynamic single-source path to consume the threaded `inverse`**, mirroring what the
multi-source join path now does (`view-mutation-multisource-threaded-updatesite`).
`update v set bp = 9` must store `t.b = 8`; the static `is_updatable = 'YES'` becomes
honest. This is the deliberate continuation of the inverse-writability trajectory —
the single-source spine should not lag the multi-source one. (Direction (2), narrowing
the static surface to report `NO`, is explicitly *rejected*: it would under-report a
column we are choosing to make writable.)

### Design task (plan)

The single-source spine must stop relying on the identity-only AST classifier
(`classifyProjectionExpr`) and instead read the plan-node `UpdateSite`'s full lineage
(the `base`+`inverse` chain). Note the existing `identityBaseColumn` /
`viewColumnsFromUpdateLineage` reader is **deliberately identity-only** for
`deriveViewColumns` parity, so this needs a *separate* full-lineage reader on the
dynamic path (do not widen the identity-only reader in place — that would perturb the
view-column derivation). On an `update set <invcol> = expr`, compose the inverse to
produce the base setter (`t.b = bp - 1`), reusing `scalar-invertibility.ts`'s
`traceInvertibleColumn` / inverse-chain machinery (the same surface multi-source
consumes). A genuinely non-invertible (`opaque`) projection stays `no-inverse`.

### Acceptance

- `update v set bp = 9 where id = 1` stores `t.b = 8` (reproduction above now succeeds).
- A still-`opaque` computed column stays read-only (`no-inverse`) — the widening is
  inverse-gated, not a blanket allow.
- Static `column_info` / `view_info` `YES` now matches dynamic behavior.
- Golden coverage (`06.3.5-column-info` / `06.3.4-view-info`) + a single-source PutGet
  law pin the static↔dynamic agreement.
- Update `docs/view-updateability.md` § Scalar Invertibility to drop the "single-source
  spine does not yet consume inverses" caveat, and the `identityBaseColumn`
  doc-comment in `analysis/update-lineage.ts`.

## Notes

- Pre-existing: `func/builtins/schema.ts` `baseSiteOf` already resolved inverse
  sites before the multi-source ticket; that ticket did not touch the static
  surfaces or the single-source spine.
- Documented (not fixed) in `docs/view-updateability.md` § Scalar Invertibility
  ("The single-source spine does not yet consume inverses…") and in the
  `identityBaseColumn` doc-comment in `analysis/update-lineage.ts`.
