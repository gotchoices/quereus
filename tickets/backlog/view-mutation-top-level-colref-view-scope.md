description: Decide and enforce whether a top-level `returning` / `where` / `set` column reference in a single-source view-mediated mutation may name a base-table column the view projects away. Today it resolves against the base table (a view-encapsulation leak); decide whether to validate such references against the view's column set instead.

files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, docs/view-updateability.md

## Background

The single-source view-mutation rewrite (`single-source.ts`) substitutes view-column
references to their base-term lineage via `remapper` + `makeViewColumnDescend`. A
reference that is **not** a view column passes through unmapped, so it resolves
against the underlying base table. This means a column the view projects away is
still referenceable in a view-mediated `where`, `set`, and (since sequence 3.7)
`returning`.

Confirmed during the 3.7 review: for `create view sv as select id, shown from t3`
(base `t3` also has nullable `secret`), `insert into sv (id, shown) values (1,'x')
returning id, secret` succeeds and returns `secret = null` — the projected-away base
column leaks through RETURNING. This is **consistent** with the pre-existing WHERE/SET
behavior, but is arguably a view-encapsulation leak: a view consumer can read/filter
columns the view's column list does not expose.

## Decision needed

Either:
- **Accept** (document explicitly as intended — top-level clauses resolve against the
  base table for single-source views, by design), or
- **Enforce**: validate that top-level `returning` / `where` / `set` column references
  name a column of the *view* (not just the base table), raising a structured
  diagnostic otherwise. Note the multi-source re-query path already rejects unknown
  columns naturally (it queries the view).

## Use cases to pin down

- `returning <projected-away-base-col>` through a single-source view.
- `where <projected-away-base-col> = …` and `set <projected-away-base-col> = …`
  (the pre-existing surface — any enforcement must treat all three consistently).
- A computed/renamed view column whose base lineage differs from its view spelling
  (ensure enforcement keys off the view column set, not base names).

## Note

Lower priority — behavior is consistent and not incorrect, just an encapsulation
question. Touches the long-standing WHERE/SET surface, so any change should be applied
uniformly across all three clauses, not RETURNING alone.
