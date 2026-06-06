description: Two parked reserved-tag-validation gaps discovered while making the direct CREATE path validate — (1) inline *named* column-constraint `WITH TAGS` is validated by neither the declarative differ nor CREATE, and (2) view DDL reserved tags are only validated lazily at mutation, so a typo on a never-mutated view's tag never surfaces. Both are design questions, not active work.
files:
  - packages/quereus/src/schema/schema-differ.ts                # ~217-257 — only validates ColumnDef.tags + TableConstraint.tags, not ColumnConstraint.tags
  - packages/quereus/src/planner/building/ddl.ts                # CREATE TABLE/INDEX validation landed in create-reserved-tag-validation
  - packages/quereus/src/planner/building/create-view.ts        # buildCreateViewStmt — no eager view-ddl tag validation
  - packages/quereus/src/planner/building/materialized-view.ts  # buildCreateMaterializedViewStmt — same
  - packages/quereus/src/parser/ast.ts                          # ColumnConstraint.tags vs ColumnDef.tags vs TableConstraint.tags
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # ~1160-1192 codifies "view-tag error surfaces at mutation, not at create"
----

# Reserved-tag validation: inline named-constraint tags + eager view-tag timing

Two follow-on concerns surfaced while implementing
`create-reserved-tag-validation` (which made direct `CREATE TABLE` / `CREATE
INDEX` mirror the differ's three tag surfaces). Both were deliberately left out
of that ticket to keep CREATE and the differ symmetric and the change
single-run-sized. Neither is urgent; each carries a design question.

## Gap 1 — inline named column-constraint `WITH TAGS` is validated nowhere

A named constraint written **inline on a column** carries its `WITH TAGS` on the
`ColumnConstraint.tags` AST field (e.g. `qty integer constraint chk_qty check
(qty > 0) with tags ("quereus.bogus" = 1)` — extracted into
`checkConstraints[].tags`). Both the declarative differ and the new CREATE-path
validation iterate only `ColumnDef.tags` (physical-column) and table-level
`TableConstraint.tags` (physical-constraint); **neither** walks
`ColumnDef.constraints[].tags`. So a reserved-key typo on an inline named
constraint is silently stored on both paths.

Closing this should be done in **both** the differ and the CREATE path **in one
change**, so the two stay symmetric (fixing only one would re-introduce the very
asymmetry the CREATE ticket removed). Site is `physical-constraint`. Decide
whether unnamed inline constraints need any handling (their trailing `WITH TAGS`
is parser-deferred to the column, so they already validate at `physical-column`).

## Gap 2 — view DDL reserved tags are validated only lazily (at mutation)

`CREATE VIEW … WITH TAGS` and `CREATE MATERIALIZED VIEW … WITH TAGS` do not
validate reserved tags at create time; the view-mutation path validates them at
the `view-ddl` site only when the view is **mutated**.
`test/logic/93.4-view-mutation.sqllogic` (~1160-1192) deliberately codifies that
timing (a removed/typo'd key on a view DDL errors on the first `insert`, not at
`CREATE VIEW`). Consequence: a typo on a view tag that is *never* mutated never
surfaces.

The design question: should view DDL tags **also** be validated eagerly at
create (catching the typo immediately, at the cost of changing *when* the error
fires and updating the 93.4 tests), or is lazy-at-mutation the intended contract
(a view tag is only meaningful for mutation, so an unused typo is harmless)?
This needs a call from the view-mutation owner before any change — route through
plan/ or get human sign-off rather than implementing speculatively.

## Notes

- Gap 1 is a concrete correctness hole with a clear fix; Gap 2 is a genuine
  design/contract question. They are bundled here only because both were
  discovered in the same review and both concern reserved-tag validation timing
  /coverage — split into separate plan/implement tickets if pursued.
