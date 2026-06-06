description: Close the reserved-tag validation hole on inline *named* column constraints (`ColumnDef.constraints[].tags`) — validated by neither the declarative differ nor the direct CREATE path before this change. Fixed BOTH at the `physical-constraint` site so they stay symmetric. Ready for review.
files:
  - packages/quereus/src/schema/schema-differ.ts                      # declaredTable case: new loop over col.constraints[].tags @ physical-constraint (appended after table-constraint loop)
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics: added 4th surface (column-constraint tags) + updated doc-comment
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags + the 'physical-constraint' site (unchanged — reused as-is)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic             # CREATE-path inline-named-constraint cases (after RsvOkConTbl block ~line 484)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic  # differ-path § 10 (after § 9, ~line 308)
  - packages/quereus/test/schema-differ.spec.ts                       # fixed malformed fixture: column constraints {} → [] (line 208)
  - packages/quereus/src/planner/building/alter-table.ts              # ADJACENT GAP (out of scope) — addConstraint case does NOT validate constraint.tags
  - docs/schema.md                                                    # §Reserved-tag validation: differ + direct-CREATE surface lists updated (3→4 surfaces)
----

# Inline named column-constraint reserved-tag validation

## What changed

A named constraint written **inline on a column** carries its `WITH TAGS` on
`ColumnConstraint.tags`. The parser (`parser.ts:4168-4179`) lifts a trailing
`WITH TAGS` onto the constraint **only when it is named** (`constraint <name> …`);
an *unnamed* inline constraint's trailing tags are deliberately left for the
column parser and land on `ColumnDef.tags` (validated at `physical-column`). So
`ColumnConstraint.tags` is populated **only** for named inline constraints.

Before this change, both reserved-tag validators walked only three of the four
physical surfaces of a CREATE TABLE (table tags, column tags, table-level
constraint tags) and **skipped `ColumnDef.constraints[].tags`**. A reserved-key
typo or mis-site on an inline named constraint was silently stored on both paths
— including the functional key `quereus.expose_implicit_index` on the
inline-named-UNIQUE path.

The fix adds the fourth surface in **both** places, at the existing
`physical-constraint` site (no new `TagSite`, no new raise site):

- **Differ** (`schema-differ.ts`, `declaredTable` case): after the existing
  table-level constraint loop, a new loop walks every column's `constraints[]`
  and pushes `validateReservedTags(cc.tags, 'physical-constraint')` into the
  single accumulated `tagDiagnostics`. Appended **last** (after the table-level
  constraint loop) so the accumulated order matches the CREATE path exactly.
- **Direct CREATE** (`ddl.ts`, `raiseCreateTableTagDiagnostics`): a fourth
  `flatMap` over `stmt.columns[].constraints[].tags` at `physical-constraint`,
  appended after the existing three. Single raise unchanged. Doc-comment updated
  (it previously said inline named-constraint tags were "intentionally excluded").

Both iterate **every** constraint regardless of `cc.name` (unnamed → `cc.tags`
undefined → `validateReservedTags` returns `[]`, a harmless no-op) and regardless
of `cc.type` (validation is independent of the lifecycle lift that only handles
check/unique/fk). Pure additive validation — no behavior change for well-formed
schemas, only a new hard error for a previously-silent typo/mis-site.

**Accumulation order (CREATE and differ are now identical):**
table → columns → table-constraints → **column-constraints**. The raise-first-error
policy means a table-level or column-level error still wins ordering if one is
also present; the new column-constraint diagnostics sit last. This is documented
in both code comments.

## Use cases to validate (what the reviewer should exercise)

These are covered by the added tests, but list them as the verification surface:

- **Typo'd reserved key → hard error on BOTH paths.**
  `qty integer constraint chk check (qty>0) with tags ("quereus.bogus"=1)` →
  fails direct `CREATE TABLE` (`error: reserved tag`) AND `apply schema`
  (`error: unknown reserved tag`). (CREATE: `50-metadata-tags` RsvInlineBadCon;
  differ: `50.2` § 10.)
- **Mis-sited key → `tag-not-allowed-here`.** An inline named constraint carrying
  `quereus.update.default_for.<col>` (legal only at view-ddl/projection/dml) →
  `error: not allowed` at `physical-constraint`. (`50-metadata-tags`
  RsvInlineMissite.)
- **Valid functional tag must NOT error + round-trips.**
  `vin text constraint uq_vin unique with tags ("quereus.expose_implicit_index" = true)`
  → accepted; round-trips through `unique_constraint_info` (the same tag
  `catalog.ts` reads to surface the implicit covering structure). (`50-metadata-tags`
  RsvInlineUq.)
- **Valid `quereus.id` on an inline named constraint** → accepted + round-trips
  via `unique_constraint_info`. (`50-metadata-tags` RsvInlineId.)
- **Unnamed inline constraint with trailing tags → unchanged.** Tags land on the
  COLUMN (`physical-column`), validated/stored there, round-trip via `table_info`;
  NOT validated/stored at the constraint site — no double-validation, no
  regression. (`50-metadata-tags` RsvInlineUnnamed.)
- **CREATE vs differ symmetry** — the same inline-named-constraint tag validates
  identically (same site, same accept/reject) on both paths; asserted by the
  parallel cases in the two test files.

## Known gaps / honest notes for the reviewer

- **ADJACENT GAP — `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` is NOT validated
  (out of scope, confirmed present).** `buildAlterTableStmt` (`alter-table.ts`,
  `addConstraint` case) builds `AddConstraintNode` directly from
  `stmt.action.constraint` **without** calling `validateReservedTags` on
  `constraint.tags`. So
  `alter table t add constraint c check (...) with tags ("quereus.bogus"=1)`
  still silently stores a bad tag. This is a *different* authoring path (not an
  inline column constraint), explicitly parked out of scope by this ticket. The
  fix would mirror the CREATE arm: validate `constraint.tags` at
  `physical-constraint` in the `addConstraint` case. **Recommend filing a fix
  ticket** — the same class of hole this ticket closed, on the one remaining
  table-constraint authoring surface. (Note: `ALTER … ALTER CONSTRAINT … SET TAGS`
  *does* validate, via the `setTags` arm.)
- **`quereus.expose_implicit_index` round-trip assertion** uses
  `unique_constraint_info(...).tags` + `json_extract` returning a native boolean
  `true`. I verified `json_extract` returns the boolean verbatim
  (`json.ts` jsonExtractFunc) and the sqllogic harness renders it as `true`. I did
  **not** add a sqllogic assertion of the *catalog visibility effect* (the implicit
  index becoming visible) — that is already covered by
  `covering-structure.spec.ts:892`. If the reviewer wants belt-and-suspenders, an
  sqllogic check that the exposed implicit index appears in `schema()` would add
  coverage, but it would duplicate the existing unit test.
- **Store path (`test:store`) not run.** Validation lives in the module-agnostic
  planner/differ; the store module is unaffected by construction (same reasoning
  the predecessor `create-reserved-tag-validation` ticket used). Round-trips were
  exercised only against the memory module. Low risk; left to CI / out-of-band.
- **Test fixture fix is mine and intentional.**
  `schema-differ.spec.ts:208` previously used `constraints: {}` (an object) on a
  hand-built column — invalid AST shape; `ColumnDef.constraints` is
  `ColumnConstraint[]`. The old differ never iterated it, so the malformed fixture
  slid through; my new loop iterates it and threw `TypeError: object is not
  iterable` *before* the test's expected `defaultVtabArgs` JSON-parse error.
  Changed `{}` → `[]` (a valid empty array): the loop no-ops and the test reaches
  its intended JSON-parse assertion. This is a fixture correctness fix, not a
  weakening — confirmed the test still asserts the `Invalid JSON in schema default
  vtab args` error and passes.

## Validation run (all green)

- `yarn workspace @quereus/quereus typecheck` (== build tsconfig, `src` only) → clean (exit 0)
- `yarn workspace @quereus/quereus run lint` → clean (exit 0)
- `yarn workspace @quereus/quereus test` → **4900 passing, 0 failing, 9 pending**
- Focused: `50-metadata-tags.sqllogic` + `50.2-declare-schema-renames.sqllogic`
  pass; `schema-differ.spec.ts` 16/16 pass (incl. the fixed JSON-parse test).

## Reviewer checklist

- Confirm CREATE/differ accumulation order is genuinely identical (both append
  column-constraints last) — matters only for multi-error tables under
  raise-first-error.
- Confirm no `cc.name`/`cc.type` gate slipped in (validate every constraint).
- Decide whether to file the `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` fix ticket
  (recommended above).
- Confirm docs/schema.md surface lists (differ + direct CREATE) read correctly
  with the 4th surface.
