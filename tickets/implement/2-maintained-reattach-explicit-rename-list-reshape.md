description: Make a declarative rename-list change on an EXPLICIT maintained table apply via `apply schema`. The differ already emits a re-attach (the bodyHash drifts); the only gap is that the emitted `set maintained as` does not carry the new rename list. With the verb's `set maintained (cols) as` grammar in place (prereq), the differ now threads the declared `maintained.columns` into the re-attach so the backing column is renamed and the derivation re-recorded, instead of erroring at the strict attach shape check.
prereq: maintained-set-maintained-rename-list-verb
files:
  - packages/quereus/src/schema/schema-differ.ts                     # applyMaintainedTransition (~1990) — carry maintained.columns; TableAlterDiff.setMaintained (~168) +columns; generateMigrationDDL (~2506) — render columns
  - packages/quereus/test/declarative-equivalence.spec.ts            # rewrite the "known limitation" test (~1407) to assert it now applies
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts   # differ-level coverage of the carried columns
  - packages/quereus/test/logic/50-declarative-schema.sqllogic       # apply-schema convergence section
  - docs/materialized-views.md                                       # Declarative-schema integration — explicit rename-list re-attach now applies
difficulty: medium
----

# Differ carries the rename list through the re-attach

## What lands here

With the verb able to accept `set maintained (a, c) as <body>` (prereq
`maintained-set-maintained-rename-list-verb`), the differ change is small and
local: when it emits a re-attach for a maintained table whose DECLARED form is
explicit (`maintained.columns` defined), carry that column list on the
`setMaintained` op so `generateMigrationDDL` renders
`alter table mv set maintained (a, c) as select id, x from t`. The verb then
positionally renames the body to `(a, c)`, reshapes the backing
(`b → c`), and re-records `derivation.columns = (a, c)` — converging the
canonical `bodyHash`.

No catalog surfacing of `derivation.columns` is required (the scoping note's
prerequisite for the rejected approach 1): detection is already automatic — the
rename list is part of the canonical definition the `bodyHash` covers, so any
rename-list change ALREADY drifts the hash and `applyMaintainedTransition`
ALREADY emits a `setMaintained`. The differ does not compare or synthesize
column renames; it simply hands the verb the declared list, and the verb does
the reshape. This is the resolved design (approach 2): the differ stays thin and
the reshape lives in the verb, reusing the implicit-reshape sibling's machinery.

## Differ changes

- **`TableAlterDiff.setMaintained`** (schema-differ.ts ~168): add
  `columns?: ReadonlyArray<string>`.
- **`applyMaintainedTransition`** (~1990): on every branch that sets
  `diff.setMaintained` (fresh attach AND re-attach — lines ~2002 and ~2019),
  include `columns: declaredMaintained.columns`. `declaredMaintained.columns` is
  the authored rename list (`undefined` for an implicit/sugar-without-list MV →
  the verb stays implicit, unchanged). This covers BOTH the sugar early-branch
  caller (`computeTableAlterDiff` ~1718) and the declared-shape branch (~1916),
  since both route through `applyMaintainedTransition`.
- **`generateMigrationDDL`** (~2506): pass `columns: alter.setMaintained.columns`
  into the synthetic `setMaintained` action so `astToString` renders the
  `(cols)` form (relies on the prereq's stringify support).

That is the whole differ surface. The re-attach detach-leg machinery
(`dropMaintained` for a concurrent shape change) is untouched — an explicit
rename-list change is an in-place verb reshape now, not a detach→reattach.

## Acceptance

- A rename-list change on an explicit maintained table applies via `apply schema`
  and converges (re-diff yields no create/drop/alter):
  - sugar `materialized view mv (a, b) as select id, x from t` →
    `materialized view mv (a, c) as select id, x from t`,
  - table-form `create table mv maintained (a, b) as …` →
    `… maintained (a, c) as …`.
- The backing column is renamed (`b → c`) and `derivation.columns` updated to
  `(a, c)`; the table incarnation survives (NOT a drop+recreate) and unrelated
  rows survive the relabel.
- The `declarative-equivalence.spec.ts` limitation test (~1407, "a column-list
  (rename) change on a sugar MV emits a re-attach the verb cannot apply") is
  rewritten to assert the change now APPLIES (and converges), mirroring the
  implicit sibling test right below it (~1452).
- The arity contract holds: an explicit rename list whose ARITY changed (not just
  names) remains a sited error (or, where the body also widened, the existing
  drop+recreate / strict error path) — never a silent widen/narrow. The differ
  carries whatever the declaration says; the verb's strict count check and arity
  guard (prereq) enforce the boundary.

## Edge cases & interactions

- **Body-only change on an explicit MV** (rename list unchanged): the differ now
  carries `columns = (a, b)` on every explicit re-attach, so a body-only change
  also applies (it errored before this work). Add apply-schema coverage —
  `mv (a, b) as select id, x` → `… select id, x + 1`.
- **Explicit → implicit** (`mv (a, b) as …` → `mv as …`): declared
  `maintained.columns` is `undefined` → `setMaintained.columns` undefined → the
  verb's implicit reshape-to-body (prereq's gate relaxation) follows the body.
  Applies and converges to an implicit record. Cover it.
- **Implicit → explicit** (`mv as select id, x` → `mv (a, b) as select id, x`):
  declared explicit → `setMaintained.columns = (a, b)` → the verb renames the
  backing `(id, x) → (a, b)` and records `(a, b)`. Converges. Cover it.
- **Arity change** (sugar `(a, b)` → `(a, b, c)` with a widened body): stays a
  sited error / drop+recreate per the contract — assert it does NOT silently
  apply.
- **Re-diff idempotency**: after each apply, recompute the diff and assert no
  `setMaintained` / no drop for the table (converged). This is the regression
  guard against an aliasing/recording mismatch that would churn forever.
- **Concurrent tag change + rename-list change**: a maintained table with both a
  tag drift and a rename-list change — `setMaintained` carries `columns` AND the
  `maintainedTags`/`tableTagsChange` routing still applies (`markMaintainedTagRoute`).
  Confirm both land in one apply.
- **In-diff source rename + MV rename-list change**: a source column renamed in
  the same diff while the MV's authored output list also changed.
  `maintainedBodyMatches` reconciles the source rename before the hash compare;
  the carried `columns` is the DECLARED list (post-rename world). Confirm no
  spurious double-churn and that the apply converges.
- **`rename_policy = 'require-hint'`**: a rename-list change is a re-attach
  (alter), not a create+drop, so it does not trip the unhinted-rename guard.
  Note / lightly cover.

## TODO

- Add `columns?` to `TableAlterDiff.setMaintained`.
- `applyMaintainedTransition`: carry `declaredMaintained.columns` on the attach
  and re-attach `setMaintained` assignments.
- `generateMigrationDDL`: render the carried columns into the synthetic action.
- Rewrite the `declarative-equivalence.spec.ts` limitation test to assert the
  sugar rename-list change applies + converges + rows survive; add the
  table-form `maintained (a, b) → (a, c)` case.
- Add apply-schema coverage for body-only explicit change, explicit→implicit,
  implicit→explicit, the arity-change error, and re-diff idempotency
  (`50-declarative-schema.sqllogic` and/or `maintained-table-differ-coverage.spec.ts`).
- Update `docs/materialized-views.md` § Declarative-schema integration: an
  explicit rename-list re-attach now applies in place (remove the
  known-limitation note).
- `yarn build`, `yarn lint`, memory suite green (stream with `tee`). Defer
  `yarn test:store`; document any store-specific residual.

## End
