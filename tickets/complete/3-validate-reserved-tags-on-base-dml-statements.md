----
description: Complete — reserved `quereus.*` tag validation fires at the `dml-stmt` site for ALL DML statements (base table, view/MV, nested) at builder entry; redundant dml-stmt leg removed from validateMutationTags. Reviewed; minor doc + test gaps fixed inline.
files:
  - packages/quereus/src/planner/building/insert.ts        # validation + rationale comment at buildInsertStmt entry
  - packages/quereus/src/planner/building/update.ts        # validation at buildUpdateStmt entry
  - packages/quereus/src/planner/building/delete.ts        # validation at buildDeleteStmt entry
  - packages/quereus/src/planner/mutation/mutation-tags.ts # narrowed to view-ddl site only
  - packages/quereus/src/planner/building/view-mutation-builder.ts # call-site comment (view-level only)
  - packages/quereus/src/planner/building/tag-diagnostics.ts # doc comment lists DML entries among shared surfaces
  - packages/quereus/test/logic/53-reserved-tags.sqllogic  # section 7: base-table + nested + DML-source + view-write tests
  - docs/sql.md                                            # § 2.6.3 authoring-path list; grammar appendix tags_clause on DML
----

# Complete: validate reserved tags on base-table DML statements

Statement-level `WITH TAGS` on `INSERT`/`UPDATE`/`DELETE` now validates reserved
`quereus.*` keys at the `'dml-stmt'` site as the first statement of
`buildInsertStmt`/`buildUpdateStmt`/`buildDeleteStmt` — so base-table writes,
view/MV-mediated writes, and nested DML (CTE, FROM, expression position,
compound legs, DML-as-INSERT-source) all reject a typo'd or mis-sited reserved
key with a sited hard error before any plan is built. Previously only the
view-mediated path validated statement tags; base-table reserved tags were
silently accepted. `validateMutationTags` was narrowed to the `'view-ddl'` site
only (the lazy guard for stray reserved keys declared on the mutated view/MV
itself), eliminating the redundant dml-stmt leg. Free-form (non-`quereus.*`)
statement tags remain untouched on every path.

## Review findings

**Process:** read the implement diff fresh (`343d73cf`), then verified every
claim against the codebase before consulting the handoff's self-assessment.

**Correctness / coverage — verified, no issues:**
- Exhaustively enumerated all `buildInsertStmt`/`buildUpdateStmt`/`buildDeleteStmt`
  call sites: `block.ts` (top-level), `expression.ts` (expression position),
  `insert.ts:622-632` (DML as INSERT source), `select-compound.ts` (compound
  legs), `select.ts:556` (FROM subquery), `with.ts` (CTE), and
  `view-mutation-builder.ts:552/808/1135` (synthesized re-entries). Every DML
  route funnels through a validated entry — the "all paths" claim holds.
- No-double-raise confirmed by construction: the single-source spine clone
  (`scope-transform.ts` `...stmt` spread) carries tags into re-entry, but an
  invalid tag raises at the *outer* entry before any clone exists; on the valid
  path re-validation is a pure no-op. The synthesized side/member inserts
  (`view-mutation-builder.ts:538/786`) are built fresh without tags. Added a
  test (see below) proving a free-form-tagged write through a view lands.
- `validateReservedTags(undefined, …)` returns `[]` — the no-tags common case
  costs one call, as claimed. `validateMutationTags` has exactly one caller
  (`view-mutation-builder.ts:50`); `'dml-stmt'` has exactly one raise site.
- Warning-severity diagnostics (empty lens-ack rationale) cannot occur at
  `dml-stmt` (lens keys are not legal there → error first), so the no-op
  warning sink in `raiseStmtTagDiagnostics` is safe.
- Plan-cache interaction sound: statement tags are part of the SQL text (cache
  key), so build-time validation is consistent; the view-ddl leg's cache
  invalidation via the recorded `view` schema dependency is unchanged.
- Error shapes verified against the registry: unknown key → `unknown reserved
  tag`; known-but-mis-sited (e.g. `quereus.id`) → `not allowed on a DML
  statement` (siteLabel `'a DML statement'`).

**Minor findings — fixed in this pass:**
- *Test gap (flagged honestly by the handoff):* DML-as-INSERT-source and the
  view re-entry success path had no dedicated tests. Added to
  `53-reserved-tags.sqllogic` § 7: an inner tagged insert used as INSERT source
  errors at the inner entry with neither table written; a free-form-tagged
  insert through a single-source view succeeds and writes exactly one row
  (exercises the `...stmt` clone re-entry).
- *Doc gap:* the sql.md grammar appendix omitted the tags clause from all three
  DML productions even though the parser accepts it (and § 2.6.3 now documents
  the site). Fixed: `insert_stmt`/`update_stmt`/`delete_stmt` now carry
  `{ context_clause | tags_clause }`, matching the prose "WITH TAGS can appear
  alongside WITH CONTEXT in any order".

**Major findings:** none — no new tickets filed.

**Explicitly checked, nothing found:** type safety (no `any`, `TaggedStmt`
narrowed correctly, unused `TagSite` import dropped); DRY (one raise helper, one
registry, one site each); resource/perf (validation is O(tags) at plan build,
zero runtime cost); error-path ordering (tag validation before the
committed-schema check in all three builders — consistent); docs accuracy
(§ 2.6.3 "hard error on every authoring path" is now literally true; the
"no reserved key legal at dml-stmt" note matches the registry).

## Validation

- `yarn build` (quereus) — clean. `yarn lint` (quereus) — clean.
- Targeted suites: `53-reserved-tags` (incl. new cases) and `93.4-view-mutation`
  — pass.
- Full root `yarn test` (all 12 workspaces) — green: 5663 passing / 9 pending in
  quereus; zero failures anywhere.
- `yarn test:store` not run — validation is pure plan-build; nothing touches the
  store path (per AGENTS.md, store runs are for store-specific diagnosis).
