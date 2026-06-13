description: A rename-list change on an EXPLICIT maintained table (`mv (a, b)` → `mv (a, c)`, sugar or table-form) drifts the body hash and the differ emits a re-attach, but `alter table … set maintained as` has no rename-list syntax so the emitted body cannot carry the new names → it errors at the strict shape check. Make this declarative reshape work (detach → column rename → re-attach, or differ-carried rename list).
files:
  - packages/quereus/src/schema/schema-differ.ts                     # applyMaintainedTransition — currently compares only bodyHash; cannot see a rename-list drift
  - packages/quereus/src/schema/catalog.ts                           # CatalogTable.maintained does NOT carry derivation.columns today — needs surfacing for the differ to compare
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation / describeAttachShapeMismatch
  - packages/quereus/test/declarative-equivalence.spec.ts            # "a column-list (rename) change on a sugar MV emits a re-attach the verb cannot apply (known limitation)" pins this gap
----

# Re-attach reshape for an explicit rename-list change

## The limitation

The explicit rename list is part of the canonical definition the body hash
covers, so changing it drifts the hash and the plan-free differ correctly emits a
re-attach:

```
create materialized view mv (a, b) as select id, x from t;   -- explicit rename list
-- declared changes to:  materialized view mv (a, c) as select id, x from t
-- differ emits:  alter table mv set maintained as <body>
--   → errors: the re-attach body's natural names (id, x) ≠ the declared (a, c),
--     and the verb has no rename-list syntax to carry the new names.
```

This is the EXPLICIT counterpart of the implicit output-column rename handled by
`maintained-reattach-implicit-reshape`. For the implicit (sugar, no rename list)
form the verb can reshape to follow the body's natural names. For the EXPLICIT
form the body's natural names are deliberately NOT the column names — the
authored rename list is — so "follow the body" is wrong; the reshape target is
the new DECLARED rename list (`a, c`), which the differ-emitted `set maintained
as` does not carry today.

The current behavior is pinned as a known limitation in
`declarative-equivalence.spec.ts` ("a column-list (rename) change on a sugar MV
emits a re-attach the verb cannot apply"). The documented workaround is the
table form with declared columns, or a manual drop+recreate.

## Why it is non-trivial (scoping notes)

- `CatalogTable.maintained` carries only `{ bodyHash, backingModuleName,
  backingModuleArgs }` — it does **not** surface `derivation.columns`. The differ
  therefore cannot currently *detect* a pure rename-list drift (it only sees the
  hash changed). Surfacing `derivation.columns` on the catalog is a prerequisite
  for the differ-side detection.
- The differ's existing "detach → column ops → re-attach when the declared shape
  ALSO drifted" path keys off the declared TABLE-FORM columns; a sugar
  declaration normalizes with `columns: []`, so that path never fires for the
  rename-list-only case.

## Two candidate approaches (resolve in the plan stage)

1. **Differ detects + emits column-rename ops (recommended).** Surface
   `derivation.columns` on `CatalogTable.maintained`; in
   `applyMaintainedTransition`, when both sides are maintained and the declared
   `maintained.columns` differs from the live recorded columns (reconciling
   in-diff renames), emit ordinary `RENAME COLUMN` ops (old recorded name → new
   declared name) followed by the re-attach — reusing the existing table-form
   "re-attach with column drift" machinery. The backing columns are renamed by
   the column ops; the subsequent `set maintained as` then matches. Keeps the
   verb dumb.

2. **Differ carries the rename list through the `setMaintained` op + verb
   reshape.** Add `columns?` to the `setMaintained` diff op / AST action (manual
   SQL leaves it undefined → implicit; the differ sets the declared
   `maintained.columns`). The verb positionally renames the body to the declared
   columns AND reshapes the backing (a `rename` op) to the new names. Reuses the
   implicit-reshape ticket's machinery but adds an explicit-target path. Heavier
   on the verb surface.

## Acceptance (target behavior)

- A rename-list change on an explicit maintained table (sugar `mv (a,b)` →
  `mv (a,c)`, and the table-form `maintained (a,b)` → `maintained (a,c)`) applies
  via `apply schema` — the backing column is renamed and the derivation's
  recorded columns updated — instead of erroring at the strict shape check.
- The `declarative-equivalence.spec.ts` limitation test is rewritten to assert
  the change now applies (and the table incarnation / unrelated rows survive).
- The arity contract is preserved: an explicit rename list whose ARITY changed
  (not just names) remains a sited error / drop+recreate, not a silent
  widen/narrow.
