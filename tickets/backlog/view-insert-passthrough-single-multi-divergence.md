description: The single-source and multi-source INSERT paths appear to disagree on whether a `passthrough` view column (an identity-on-value transform of one base column — `b collate nocase as bc`, no-op `cast(b as <same-logical-type>) as bc`) is insertable. By code inspection multi-source INSERT admits it; single-source INSERT rejects it. Reproduce, then decide and align the two spines (and document the chosen insertability contract for passthrough).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, docs/view-updateability.md
----

## Background

Discovered while closing `single-source-passthrough-column-static-dynamic-divergence`
(which fixed the single-source **UPDATE** path for passthrough columns). That ticket
was deliberately scoped UPDATE-only; this captures the separable INSERT question.

A `passthrough` column is identity on the stored value, so — unlike an `inverse`
column — it has no transform to apply on write and could be stored verbatim on
INSERT just as it now is on UPDATE.

## Observed divergence (by code inspection)

- **Multi-source INSERT** (`multi-source.ts` `analyzeMultiSourceInsert`) admits
  passthrough: its implicit supplied set is `outColumns.filter(c => c.writable &&
  !c.inverse)` and its per-supplied gate is `!out.writable || out.inverse || …`. A
  passthrough column is `writable && inverse === undefined`, so it passes both
  (identity and passthrough are indistinguishable there — both have no `inverse`).
- **Single-source INSERT** (`single-source.ts` `rewriteViewInsert`) rejects it:
  base-column resolution goes through `requireBaseColumn(findViewColumn(...))` over
  the AST-only `deriveViewColumns` model, which classifies `collate` / `cast` as
  `computed` → `no-inverse`. An *implicit* insert (no column list) into a
  single-source view that merely *exposes* a passthrough column also fails, because
  the passthrough column is in the implicit non-generated target set.

So single-source INSERT (rejects) and multi-source INSERT (admits) disagree on the
identical `c.note collate nocase as note` projection, depending only on whether the
view body is single-table or a two-table join.

## To settle

- Reproduce both spines at runtime (the multi-source admit needs a join view that
  exposes the shared key + a passthrough column; the single-source reject reproduces
  with `create view v as select id, b collate nocase as bc from t; insert into v …`).
- Decide the contract: **passthrough is insertable** (store the value verbatim;
  align single-source INSERT *up* to multi-source — likely a `writableSites` consult
  with `inverse === undefined` in `rewriteViewInsert`, leaving `deriveViewColumns`
  parity untouched, exactly mirroring the UPDATE fix), **or passthrough is
  non-insertable** (align multi-source INSERT *down* — which requires distinguishing
  identity from passthrough on `OutColumn`, since identity must stay insertable).
  The identity-on-value semantics favour "insertable", but the decision and its
  effect on the parity-pinned readers needs confirmation.
- Whichever way it lands, make the two spines agree and document the passthrough
  insertability contract in `docs/view-updateability.md` § Scalar Invertibility
  (the paragraph already notes INSERT stays inverse-blind; extend it to state the
  passthrough INSERT contract explicitly).
