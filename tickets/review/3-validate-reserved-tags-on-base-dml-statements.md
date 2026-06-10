----
description: Review — reserved `quereus.*` tag validation now fires at the `dml-stmt` site for ALL DML statements (base table, view/MV, nested) at builder entry; the redundant dml-stmt leg was removed from validateMutationTags.
files:
  - packages/quereus/src/planner/building/insert.ts        # validation + full rationale comment at buildInsertStmt entry
  - packages/quereus/src/planner/building/update.ts        # validation at buildUpdateStmt entry (short comment, refs insert)
  - packages/quereus/src/planner/building/delete.ts        # validation at buildDeleteStmt entry (short comment, refs insert)
  - packages/quereus/src/planner/mutation/mutation-tags.ts # narrowed to view-ddl site only; TaggedStmt = Pick<InsertStmt,'loc'>
  - packages/quereus/src/planner/building/view-mutation-builder.ts # call-site comment updated (view-level only)
  - packages/quereus/src/planner/building/tag-diagnostics.ts # doc comment now lists the DML entries among the shared surfaces
  - packages/quereus/test/logic/53-reserved-tags.sqllogic  # new section 7: base-table + nested dml-stmt tests
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic # unchanged; regression net for the view path (passes)
  - docs/sql.md                                            # § 2.6.3 authoring-path list + "no reserved key legal at dml-stmt" note
----

# Review: validate reserved tags on base-table DML statements

## What was done

Implemented exactly per the settled design in the implement ticket:

- **Builder-entry validation.** `raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt)`
  is the first statement of `buildInsertStmt`, `buildUpdateStmt`, and
  `buildDeleteStmt` — before the committed-schema check and the view dispatch.
  All DML routes (top-level, CTE, FROM-subquery, expression position, compound
  legs, the view substrate's synthesized base-op re-entry) funnel through these
  three entries, so every statement's own tags validate at its own entry.
  `validateReservedTags(undefined, …)` is a no-op, so the common no-tags case
  costs one call. Insert carries the full rationale comment; update/delete carry
  a one-liner referencing it.
- **`validateMutationTags` narrowed to the `view-ddl` site.** The `dml-stmt` leg
  is gone; `TaggedStmt` narrowed to `Pick<AST.InsertStmt, 'loc'>` (the loc still
  sites the view-ddl error); the short-circuit checks only view tags; the
  `messagePrefix` conditional collapsed to the unconditional view-context prefix;
  module + function doc comments rewritten for the narrowed role. The unused
  `TagSite` import was dropped. `'dml-stmt'` now has exactly one validation site.
- **Docs.** sql.md § 2.6.3: authoring-path list now includes statement-level DML
  `WITH TAGS`, plus a sentence that **no** reserved key is currently legal at the
  DML-statement site (pure typo guard since the `quereus.update.*` retirement) —
  the "hard error on every authoring path" claim is now literally true.

## Validation performed

- `yarn build` (quereus tsc) — clean.
- Root `yarn test` (all workspaces) — green: 5663 passing / 9 pending in quereus
  plus all other packages; exit 0, zero failures.
- Targeted mocha runs of `53-reserved-tags.sqllogic` and
  `93.4-view-mutation.sqllogic` — both pass. The 93.4 dml-stmt cases (`df_v`,
  `tg_jv` ~lines 1139/1239–1254) pass with the **unchanged** `unknown reserved
  tag` message text (same registry constructor; only the raise site moved to the
  builder entry, which uses the same empty message prefix the old dml-stmt leg
  used). The view-DDL-tag cases (`df5_v`, `bvu_v`, `sst_v`) still fail at
  mutation time with the view-context prefix.
- `yarn lint` (quereus) — clean.

New tests (53-reserved-tags.sqllogic § 7) cover the ticket's required cases:
- base INSERT with `"quereus.bogus"` → `unknown reserved tag`; follow-up select
  proves nothing written.
- base UPDATE with retired `"quereus.update.default_for.note"` → unknown; row
  unchanged.
- base DELETE with mis-sited known key `"quereus.id"` → `not allowed on a DML
  statement` (tag-not-allowed-here shape, distinct from unknown); row survives.
- base INSERT with only free-form tags → succeeds and writes.
- mixed free-form + reserved → fails atomically, nothing written.
- DML-in-CTE (`with w as (insert … with tags ("quereus.bogus" = 1) … returning *)
  select …`) → error at the nested statement's own entry.

These tests fail without the source change (base-table reserved tags were
silently accepted before), so they exercise the new code, not vacuously pass.

## Review focus / known gaps (honest)

- **No-double-raise on synthesized re-entry is verified only indirectly.** The
  view substrate re-plans synthesized base statements through the same builders
  (`scope-transform.ts` spreads `...stmt`, so tags can ride along). On the valid
  path re-entry validation is a no-op by construction (the outer entry already
  proved the tags clean), and the full 93.x suites pass with unchanged messages —
  but there is no dedicated test asserting "raised exactly once". If the reviewer
  wants one, a free-form-tagged write through a multi-source view would be the
  shape to assert succeeds.
- **Nested positions tested only via CTE.** DML as INSERT source
  (`insert.ts:~620`) and DML in FROM position route through the same entries but
  have no dedicated reserved-tag test. Low risk (identical code path), flagged
  for completeness.
- **`yarn test:store` not run** (per AGENTS.md it's for store-specific diagnosis;
  nothing here touches the store path — validation is pure plan-build).
- The DML syntax sections of sql.md don't enumerate `WITH TAGS` per statement;
  the ticket scoped the docs change to § 2.6.3 only. Fine as-is, noting it.

## Use cases (for review exercise)

```sql
-- now errors (used to be silently inert):
insert into t with tags ("quereus.bogus" = 1) values (1);
update t with tags ("quereus.update.default_for.x" = '0') set x = 1;
delete from t with tags ("quereus.id" = 'x');          -- not-allowed-here shape
-- still fine:
insert into t with tags (audit = true) values (1);     -- free-form untouched
-- unchanged behavior (regression net):
insert into v with tags ("quereus.bogus" = 1) ...;     -- same error, now raised at entry
insert into v_with_bad_ddl_tag ...;                    -- view-ddl leg, prefixed + sited
```
