description: A single-source view column that is a non-identity **passthrough** of one base column — `b collate nocase as bc`, or a no-op `cast(b as <same-logical-type>) as bc` — is reported `is_updatable = 'YES'` / `base_column = b` by the static `column_info`/`view_info` surfaces (`baseSiteOf` returns a writable `base` site for any `kind:'base'` UpdateSite, inverse-or-not), but the single-source dynamic UPDATE path rejects `update v set bc = …` with `no-inverse` ("computed (non-invertible) expression and is read-only"). This is the *same* static↔dynamic divergence class that `single-source-inverse-column-static-dynamic-divergence` closed for the `inverse` (arithmetic `b ± k`) profile, left open for the `passthrough` profile. The multi-source join path already routes these columns writable (it routes any `writable && !inverse` base site), so single-source vs multi-source also disagree.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Problem

The invertibility registry (`scalar-invertibility.ts`) recognises three profiles on
the update path:

- `passthrough` — a non-data-altering transform: bare column / rename, `collate(x, _)`,
  a no-op `cast` (target logical type === operand's). Traces to a `base` `UpdateSite`
  with **`inverse === undefined`** (it is identity on the stored value).
- `inverse` — `x ± k` / `k ± x`. Traces to a `base` site **with an `inverse`** closure.
- `opaque` — no inverse; the column is `computed` (read-only).

The static surfaces (`func/builtins/schema.ts` `baseSiteOf`) report a column writable
whenever its UpdateSite is `kind: 'base'`, regardless of the `inverse` field — so **both**
`inverse` and `passthrough` non-identity columns get `is_updatable = 'YES'`,
`base_column = <base>`.

The single-source dynamic write path classifies the SET target two ways:

- `analysis.inverseSites` (added by `single-source-inverse-column-static-dynamic-divergence`)
  routes a target whose plan-lineage site has a **truthy `inverse`** — this covers the
  `inverse` profile but **not** `passthrough` (whose `inverse` is `undefined`).
- otherwise `requireBaseColumn(findViewColumn(...))`, which reads the **AST-only**
  `deriveViewColumns` model (`classifyProjectionExpr`, bare-column-only). A `collate` /
  `cast` expression is not `type === 'column'`, so it is classified `computed` and
  rejected `no-inverse`.

A non-bare-column passthrough therefore falls between the two readers and is rejected,
while the static surface (and the multi-source spine) treat it as writable.

### Confirmed repro (observed during review of the inverse ticket)

```sql
create table t (id integer primary key, b text null);
insert into t values (1, 'hi');
create view v as select id, b collate nocase as bc from t;
-- static: bc -> is_updatable='YES', base_column='b'
select column_name, is_updatable, base_column from column_info('v');
update v set bc = 'yo' where id = 1;   -- REJECTED: no-inverse ("computed … read-only")
```

```sql
create table t2 (id integer primary key, b integer null);
insert into t2 values (1, 5);
create view v2 as select id, cast(b as integer) as bc from t2;   -- no-op cast (same logical type)
select column_name, is_updatable, base_column from column_info('v2');  -- bc -> 'YES', b
update v2 set bc = 99 where id = 1;    -- REJECTED: no-inverse
```

Multi-source (the join path) routes the same `writable && !inverse` base site as a plain
base-column write, so a `collate`/no-op-`cast` column on a *join* view is writable —
single-source and multi-source disagree on the identical projection.

## Expected behavior

A passthrough (identity-on-stored-value) projection of a single base column should be
writable on the single-source UPDATE path, storing the assigned value directly into the
base column (no inverse to apply — `passthrough` is identity on the value). I.e. the
single-source spine should consume the plan-lineage `base` site for **`writable && !nullExtended`
identity-base targets whose AST `deriveViewColumns` says `computed`**, not only those
carrying an `inverse`. After the fix, static `is_updatable`, the single-source dynamic
write, and the multi-source write all agree for `passthrough` columns, exactly as the
inverse ticket aligned them for `inverse` columns.

DELETE / RETURNING / read context are already correct (a passthrough column resolves
via `columnMap` to its forward base term). INSERT remains inverse/passthrough-blind on
both spines (the `viewColumns` model keeps it `computed`); confirm whether a passthrough
column *should* be insertable (it arguably can be — it is identity on the value) or stays
non-insertable for parity — a small spec decision to settle in this ticket.

## Scope / suggested approach

- The cleanest unification is to widen the single-source SET-target routing to consult
  `resolveBaseSite` for **every** target (the multi-source spine already does this), with
  `inverse` applied only when present — collapsing `inverseSites` into a single
  `writableSites` map (`baseColumn` + optional `inverse`). Keep the identity-only
  `deriveViewColumns` / `classifyProjectionExpr` / `viewColumnsFromUpdateLineage` readers
  unchanged — their parity is pinned by `property.spec.ts`; only the dynamic write path
  reads the richer lineage.
- Add coverage: a `06.3.5` static↔dynamic-agreement block and a `93.4` write-through
  section for both `collate` and no-op-`cast` columns; a `property.spec.ts` PutGet for a
  passthrough column (mirroring the inverse B1 test); and a multi-source/single-source
  parity assertion that a `collate` column is writable on both.
- Update `docs/view-updateability.md` § Scalar Invertibility ("Where inverse profiles are
  consumed") to state that the single-source spine consumes the full writable-base set
  (passthrough + inverse), not just inverse.

## Severity / disposition

Pre-existing relative to the inverse work (the single-source path classified all
non-bare-column projections `computed` before), but it is the **same divergence the
parent ticket set out to close**, just for a different profile — so the parent's
"static↔dynamic divergence closed" reads as more complete than it is. Real correctness/
consistency bug: the static catalog advertises a write the engine then refuses, and the
two mutation spines disagree.
