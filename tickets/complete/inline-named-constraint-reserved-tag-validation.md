description: Close the reserved-tag validation hole on inline *named* column constraints (`ColumnDef.constraints[].tags`) — previously validated by neither the declarative differ nor the direct CREATE path. Fixed symmetrically at the existing `physical-constraint` site on BOTH paths. Reviewed; lint/typecheck/full-suite green; one major adjacent-gap finding spun out as a fix ticket.
files:
  - packages/quereus/src/schema/schema-differ.ts                      # declaredTable case: loop over col.constraints[].tags @ physical-constraint, appended LAST (after table-constraint loop) for order symmetry
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics: 4th flatMap (column-constraint tags) + updated doc-comment
  - packages/quereus/src/parser/parser.ts                            # columnConstraint (~4168): trailing WITH TAGS lifted onto cc.tags ONLY when named — the load-bearing invariant (unchanged; verified)
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags (no-op on undefined) + 'physical-constraint' site (unchanged — reused)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic             # CREATE-path inline-named-constraint cases (after RsvOkConTbl block)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic  # differ-path § 10
  - packages/quereus/test/schema-differ.spec.ts                       # fixed malformed fixture: column constraints {} → [] (line 208)
  - docs/schema.md                                                    # §Reserved-tag validation: differ + direct-CREATE surface lists updated (3→4 surfaces)
----

# Inline named column-constraint reserved-tag validation

## What shipped

A named constraint written inline on a column (`qty integer constraint chk
check (qty>0) with tags (...)`) carries its `WITH TAGS` on
`ColumnConstraint.tags`. The parser lifts a trailing `WITH TAGS` onto the
constraint **only when it is named** (`parser.ts:4173`, `name !== undefined`
gate); an unnamed inline constraint's trailing tags defer to the column parser
and land on `ColumnDef.tags` (validated at `physical-column`). So
`ColumnConstraint.tags` is populated **only** for named inline constraints.

Before this change, both reserved-tag validators walked only three of the four
physical CREATE-TABLE surfaces (table tags, column tags, table-level constraint
tags) and **skipped `ColumnDef.constraints[].tags`** — a reserved-key typo or
mis-site on an inline named constraint (including the functional key
`quereus.expose_implicit_index` on the inline-named-UNIQUE path) was silently
stored on both paths.

The fix adds the fourth surface in both places at the existing
`physical-constraint` site — no new `TagSite`, no new raise site:

- **Differ** (`schema-differ.ts:249-253`): after the table-level constraint loop, a
  new nested loop walks every column's `constraints[]` and pushes
  `validateReservedTags(cc.tags, 'physical-constraint')` into the accumulated
  `tagDiagnostics`. Appended last so accumulation order matches CREATE exactly.
- **Direct CREATE** (`ddl.ts:52`): a fourth `flatMap` over
  `stmt.columns[].constraints[].tags` at `physical-constraint`, appended after the
  existing three.

Both iterate every constraint regardless of `cc.name` (unnamed → `cc.tags`
undefined → `validateReservedTags` returns `[]`, a no-op) and regardless of
`cc.type`. Accumulation order on both paths is identical:
table → columns → table-constraints → **column-constraints**. Pure additive
validation — no behavior change for well-formed schemas, only a new hard error for
a previously-silent typo/mis-site.

## Review findings

**Diff reviewed:** `48b8ee53` (implement) — read in full, fresh eyes, before the
handoff summary. Source: `ddl.ts` (+13/-6), `schema-differ.ts` (+17),
`schema-differ.spec.ts` (±1). Tests: `50-metadata-tags.sqllogic` (+58),
`50.2-declare-schema-renames.sqllogic` (+25). Docs: `docs/schema.md` (±2).

**Correctness / load-bearing invariant — verified.** The whole change rests on
"the parser populates `ColumnConstraint.tags` only for *named* inline
constraints." Confirmed at `parser.ts:4173` — the trailing-`WITH TAGS` consume is
gated on `name !== undefined && this.matchKeyword('WITH')`. Confirmed
`validateReservedTags` is a genuine no-op on `undefined` (`reserved-tags.ts:305`,
`if (!tags) return []`), so the absent `cc.name` guard is safe — an unnamed inline
constraint has `cc.tags === undefined` and contributes nothing. Confirmed
`ColumnConstraint.tags` is `Record<string, SqlValue> | undefined` and
`ColumnDef.constraints` is `ColumnConstraint[]` (`ast.ts:520/563`).

**CREATE / differ symmetry — verified.** Both append the column-constraint
diagnostics LAST. The differ deliberately keeps two separate loops over
`item.tableStmt.columns` (one for `col.tags`, one for `col.constraints[].tags`)
rather than merging them — merging would interleave column tags with
column-constraint tags and break the documented order parity with the CREATE
`flatMap` chain. The separation is intentional and correct, not a DRY miss; the
raise-first-error policy makes the order observable only for multi-error tables.

**Site choice — verified.** `physical-constraint` is the correct `TagSite` for an
inline column constraint (the site denotes the schema-object kind, not the syntax
position); identical to the table-level constraint and the `ALTER … SET TAGS`
constraint arm.

**Round-trip / functional surface — verified.** The `RsvInlineUq` /
`RsvInlineId` tests prove the schema-build path genuinely stores
`ColumnConstraint.tags` for a named inline constraint and surfaces them via
`unique_constraint_info` — i.e. this was a real functional surface that was being
stored-but-not-validated, not a dead path. `RsvInlineUnnamed` confirms the unnamed
case round-trips on the COLUMN via `table_info` with no double-validation.

**Test fixture fix — verified legitimate, not a weakening.** `schema-differ.spec.ts:208`
`constraints: {}` (an object — invalid AST shape; the old differ never iterated it)
would make the new `for…of` throw `TypeError` before the test's intended
`Invalid JSON in schema default vtab args` assertion. Changed `{}` → `[]`; read the
full test (line 195-224) and confirmed it still asserts that JSON error and the
fixture has no tags, so the new loop no-ops and the JSON parse is still reached.

**Validation re-run (all green, independently):**
- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus typecheck` → exit 0
- `yarn workspace @quereus/quereus test` → **4900 passing, 0 failing, 9 pending**

**MAJOR finding → spun out as a fix ticket (`alter-table-add-tag-validation`).**
The implementer disclosed `ALTER TABLE … ADD CONSTRAINT … WITH TAGS`
(`alter-table.ts:27`, `addConstraint`) as an out-of-scope adjacent gap that
silently stores bad constraint tags. Confirmed present. Additionally found —
**not previously disclosed** — that `ALTER TABLE … ADD COLUMN … WITH TAGS`
(`alter-table.ts:56`, `addColumn`) has the **same** hole: it validates the
column's DEFAULT but neither `column.tags` nor `column.constraints[].tags`. Same
class of hole this ticket closed, on the two remaining imperative ADD authoring
surfaces (the `setTags` arm at `alter-table.ts:122` *does* validate). Both folded
into the one fix ticket, which mirrors `raiseCreateTableTagDiagnostics`.

**Minor findings — none fixed inline (none warranted a change):**
- *Differ-path acceptance coverage.* `50.2` § 10 tests only the typo→error case on
  the differ path; the accept + round-trip cases live on the CREATE path
  (`50-metadata-tags`). The validation call is byte-identical across paths
  (`validateReservedTags(cc.tags, 'physical-constraint')`) and table-constraint
  differ acceptance is already covered by § 9, so a differ-path acceptance test
  would be near-zero marginal value. Left as-is.
- *Multi-error ordering not asserted.* No test exercises a table with both a
  table-level and a column-constraint reserved-tag error to assert the documented
  first-error ordering parity between CREATE and differ. Low value (single
  documented policy, shared code), left as-is.

**Docs — verified.** `docs/schema.md` reserved-tag section updated on both surface
lists (differ: "physical-constraint (… and every inline column constraint's
tags …)"; direct CREATE: "four physical surfaces … column-constraints") and the
accumulation-order line. Reads correctly against the shipped code. The stale
doc-comment in `ddl.ts` that previously said inline named-constraint tags were
"intentionally excluded" was corrected.

**Out-of-scope / deferred (honest notes, accepted as-is):**
- Store path (`test:store`) not run — validation lives in the module-agnostic
  planner/differ; store module unaffected by construction. Left to CI / out-of-band,
  per the predecessor `create-reserved-tag-validation` precedent.
- The `quereus.expose_implicit_index` *catalog visibility effect* (implicit index
  becoming visible) is covered by `covering-structure.spec.ts:892`; the sqllogic
  round-trip here asserts only the tag value, avoiding duplication.
