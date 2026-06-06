description: Close the reserved-tag validation hole on inline *named* column constraints — `ColumnDef.constraints[].tags` (e.g. `qty integer constraint chk check (qty>0) with tags ("quereus.bogus"=1)`) is validated by neither the declarative differ nor the direct CREATE path. Fix BOTH in one change at the `physical-constraint` site so the two stay symmetric.
files:
  - packages/quereus/src/schema/schema-differ.ts                # ~218-257 — declaredTable case walks col.tags + table-level c.tags, NOT col.constraints[].tags
  - packages/quereus/src/planner/building/ddl.ts                # ~43-50 raiseCreateTableTagDiagnostics — three surfaces, excludes ColumnDef.constraints[].tags
  - packages/quereus/src/parser/parser.ts                       # ~4168-4179 — confirms only NAMED inline constraints carry their own tags; unnamed defer to the column
  - packages/quereus/src/schema/reserved-tags.ts                # validateReservedTags + 'physical-constraint' site (legal keys: quereus.id / previous_name / expose_implicit_index)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # ~424-501 — direct CREATE-path reserved-tag tests (add inline-named-constraint cases near line 438)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic # ~286-308 — differ "typo'd reserved tag → hard error at apply" (add an inline-named-constraint case)
----

# Inline named column-constraint reserved-tag validation

A named constraint written **inline on a column** carries its `WITH TAGS` on the
`ColumnConstraint.tags` AST field. The parser
(`parser.ts:4168-4179`) consumes a trailing `WITH TAGS` onto the constraint
**only** when the constraint is named (`constraint <name> …`); an *unnamed*
inline constraint's trailing tags are deliberately left for the surrounding
column parser and therefore land on `ColumnDef.tags` (validated at the
`physical-column` site). So `ColumnConstraint.tags` is populated **only** for
named inline constraints.

Both reserved-tag validators iterate only two of the three physical surfaces of
a CREATE TABLE:

- **Differ** (`schema-differ.ts`, `declaredTable` case ~223-236): walks
  `item.tableStmt.columns[].tags` (`physical-column`) and table-level
  `item.tableStmt.constraints[].tags` (`physical-constraint`). It does **not**
  walk `column.constraints[].tags`.
- **Direct CREATE** (`ddl.ts`, `raiseCreateTableTagDiagnostics` ~43-50): same
  three surfaces (`stmt.tags`, `columns[].tags`, table-level
  `constraints[].tags`), and a comment explicitly excludes
  `ColumnDef.constraints[].tags` "to stay symmetric with the differ."

Consequence: a reserved-key typo or mis-site on an inline named constraint —
`qty integer constraint chk_qty check (qty > 0) with tags ("quereus.bogus" = 1)`
— is **silently stored on both paths**. This is not only a typo hole: the
**functional** key `quereus.expose_implicit_index` (legal at `physical-constraint`,
read by `catalog.ts`) is also unvalidated on the inline-named-UNIQUE path, e.g.
`vin text constraint uq_vin unique with tags ("quereus.expose_implicit_index" = true)`.

## Design resolution

Validate **all** `ColumnDef.constraints[].tags` at the `physical-constraint`
site, in **both** the differ and the direct CREATE path, in this single change.

- **Why both, one change:** fixing only one re-introduces the very
  CREATE-vs-differ asymmetry the `create-reserved-tag-validation` ticket removed.
  The differ already raises every declared object's diagnostics into one
  accumulated `tagDiagnostics` list and raises once; the CREATE path accumulates
  table → columns → constraints and raises once. Slot the new surface into each
  existing accumulation — no new raise sites, no ordering change beyond appending
  the constraint diagnostics after the existing column/table-constraint ones.

- **Site is `physical-constraint`** — the same position table-level named
  constraints already validate at, shared with `ALTER … ALTER CONSTRAINT … SET
  TAGS` and the catalog's `expose_implicit_index` reader. No new {@link TagSite}.

- **Do NOT gate on `cc.name`.** Iterate every `col.constraints[]` and validate
  `cc.tags`. Unnamed inline constraints have `tags === undefined` (parser defers
  them to the column), and `validateReservedTags(undefined, …)` returns `[]` — so
  the iteration is a harmless no-op on them and needs no name guard. This mirrors
  the table-level loop's existing "validate every constraint's tags, named or
  not" posture (`schema-differ.ts:226-236`) and is robust if the parser's
  deferral ever changes.

- **All constraint *kinds*, not just CHECK/UNIQUE/FK.** The differ's
  *lifecycle* code lifts only check/unique/foreignKey named constraints
  (`columnConstraintToTableConstraint` returns undefined for NOT NULL / DEFAULT /
  COLLATE / GENERATED / PRIMARY KEY). Tag **validation** is independent of
  lifecycle: validate `cc.tags` regardless of `cc.type`. A named NOT NULL
  carrying a reserved tag is unusual but parser-legal; validating it is correct
  and costs nothing (its tags are still subject to the same registry).

This is a pure additive validation surface — no behavior change for well-formed
schemas, only a new hard error for a previously-silent typo/mis-site.

## Out of scope (do not expand)

- **Gap 2** (eager vs lazy view-DDL reserved-tag timing) is a separate contract
  question parked in `tickets/blocked/view-ddl-reserved-tag-eager-validation.md`
  pending human sign-off. This ticket touches only the column-constraint surface.
- **`ALTER TABLE … ADD CONSTRAINT … WITH TAGS`** is a *different* authoring path
  (not an inline column constraint). If it also skips reserved-tag validation,
  that is an adjacent gap — note it in the review handoff, do **not** fix it here.

## Edge cases & interactions

- **Valid functional tag must NOT error:** `constraint uq unique with tags
  ("quereus.expose_implicit_index" = true)` inline on a column → accepted on both
  CREATE and differ, and still round-trips / is read by `catalog.ts`.
- **Typo'd reserved key → hard error on BOTH paths:** inline
  `constraint c check (...) with tags ("quereus.bogus" = 1)` must fail at direct
  `CREATE TABLE` *and* at `apply schema`.
- **Mis-sited key → error:** an inline named constraint carrying a key legal only
  elsewhere (e.g. `quereus.update.default_for.x`, valid at view-ddl/projection/
  dml only) → `tag-not-allowed-here` at `physical-constraint`.
- **Unnamed inline constraint with trailing tags → unchanged:** tags land on the
  COLUMN (`physical-column`), validated as today. No double-validation, no new
  error, no regression (verify the same tag is not validated twice).
- **Free-form (non-`quereus.*`) tags on an inline constraint:** untouched
  (`validateReservedTags` skips non-reserved keys) — guard against over-rejection.
- **Multiple constraints per column / multiple columns:** every constraint on
  every column is walked; diagnostics accumulate deterministically (the existing
  raise-first-error policy means a table-level or column-level error still wins
  ordering if present — keep the constraint diagnostics appended last, matching
  the CREATE path's table → column → table-constraint order; decide and document
  where the new column-constraint diagnostics sit relative to table-level
  constraint diagnostics, and keep CREATE and differ identical).
- **CREATE vs differ symmetry:** the SAME inline-named-constraint tag must
  validate identically on both paths (same site, same accept/reject) — assert
  this with parallel test cases in the two test files.
- **Valid `quereus.id` on an inline named constraint:** accepted and round-trips
  (the differ uses it for constraint rename detection on named constraints; a
  direct CREATE simply stores it). Confirm it does not spuriously error.
- **IF NOT EXISTS:** a malformed inline-constraint tag still fails at plan-build
  even when the table already exists (matches the existing CREATE-path semantics
  at `50-metadata-tags.sqllogic:457-461`).

## TODO

- [ ] In `schema-differ.ts` `declaredTable` case (~223-236), after the existing
      `col.tags` loop, walk each column's `constraints[]` and push
      `validateReservedTags(cc.tags, 'physical-constraint')` into `tagDiagnostics`.
      Keep the single accumulated `raiseReservedTagDiagnostics` call unchanged.
- [ ] In `ddl.ts` `raiseCreateTableTagDiagnostics` (~43-50), append a fourth
      surface: `...stmt.columns.flatMap(c => (c.constraints ?? []).flatMap(cc =>
      validateReservedTags(cc.tags, 'physical-constraint')))`. Keep the single
      `raiseStmtTagDiagnostics` raise. Update the doc-comment that currently says
      inline named-constraint tags are "intentionally excluded."
- [ ] Add CREATE-path tests in `test/logic/50-metadata-tags.sqllogic` near the
      existing physical-constraint block (~432-438): an inline named constraint
      with (a) a typo'd reserved key → `error: reserved tag`, (b) a valid
      `quereus.expose_implicit_index` / `quereus.id` → accepted + round-trips,
      (c) a mis-sited key → `error: not allowed`, (d) an unnamed inline
      constraint with trailing tags → tags land on the column unchanged.
- [ ] Add a differ-path test in `test/logic/50.2-declare-schema-renames.sqllogic`
      mirroring section 9 (~286-308): a declared table whose inline named
      constraint carries a typo'd reserved tag → `error: unknown reserved tag` at
      `apply schema`.
- [ ] Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`
      and `yarn workspace @quereus/quereus run lint`. Fix any fallout.
- [ ] Review handoff: state whether `ALTER TABLE … ADD CONSTRAINT … WITH TAGS`
      was checked for the same gap (adjacent surface; out of scope here).
