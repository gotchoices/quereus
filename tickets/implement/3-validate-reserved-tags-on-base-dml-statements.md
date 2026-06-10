----
description: Validate reserved `quereus.*` tags at the `dml-stmt` site for ALL DML statements (base table, view, MV, nested) at builder entry, instead of only on the view path.
files:
  - packages/quereus/src/planner/building/insert.ts        # buildInsertStmt entry (~line 449)
  - packages/quereus/src/planner/building/update.ts        # buildUpdateStmt entry (~line 44)
  - packages/quereus/src/planner/building/delete.ts        # buildDeleteStmt entry (~line 45)
  - packages/quereus/src/planner/building/tag-diagnostics.ts  # shared raiseStmtTagDiagnostics helper — reuse, no changes expected
  - packages/quereus/src/planner/mutation/mutation-tags.ts # remove the dml-stmt leg; keep view-ddl leg
  - packages/quereus/src/schema/reserved-tags.ts           # registry — read-only reference, no changes
  - packages/quereus/test/logic/53-reserved-tags.sqllogic  # new base-table dml-stmt tests
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic # existing view-path dml-stmt tests — must keep passing
  - docs/sql.md                                            # § 2.6.3 reserved-namespace paragraph (~line 1238)
----

# Validate reserved tags on base-table DML statements

`insert/update/delete … with tags (…)` parses onto `stmt.tags` for every DML
statement, but reserved-tag validation at the `'dml-stmt'` site today fires only
inside `validateMutationTags` (`planner/mutation/mutation-tags.ts`), which runs
exclusively on the view-/MV-mediated path (`buildViewMutation`). A base-table DML
carrying a reserved key — `insert into t with tags ("quereus.bogus" = 1) values (…)`
or the retired `"quereus.update.default_for.x"` — is silently accepted and inert,
while the identical statement through a view fails loudly. Fix the asymmetry so the
docs/sql.md "hard error on every authoring path" claim is literally true.

## Design (settled)

**Validation point: the top of each DML builder entry function, before the view
dispatch.** All DML routes funnel through `buildInsertStmt` / `buildUpdateStmt` /
`buildDeleteStmt` — top-level statements (`block.ts`), DML inside a CTE
(`with.ts`), DML as a FROM subquery (`select.ts`), DML in expression position
(`expression.ts`), compound legs (`select-compound.ts`), and the view-mutation
substrate's own re-planning of synthesized base ops. One line per builder, at
function entry (before the `isCommittedSchemaRef` check):

```ts
raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt);
```

reusing the shared helper from `./tag-diagnostics.js` (the same unification the
DDL surfaces use) and `validateReservedTags` from `../../schema/reserved-tags.js`.
`validateReservedTags(undefined, …)` is a no-op, so the common no-tags case costs
one call.

**Remove the `dml-stmt` leg from `validateMutationTags`.** With entry validation
running *before* the `getView` dispatch in each builder, the statement's tags are
already proven clean by the time `buildViewMutation` → `validateMutationTags`
runs. Delete the `stmtTags` validation leg (line 54 of mutation-tags.ts) so
`'dml-stmt'` has exactly one validation site; keep the `view-ddl` leg (view/MV
tags are still validated lazily at mutation time). Keep the function name
(`validateMutationTags` — it still validates tags at the view-mutation boundary)
but:
  - update the module and function doc comments to describe the narrowed role
    (view-ddl site only; dml-stmt validation moved to the builder entries),
  - the `stmt` parameter stays (its `loc` sites the view-ddl error); `TaggedStmt`
    can narrow to `Pick<AST.InsertStmt, 'loc'>`,
  - simplify the short-circuit and the `messagePrefix` conditional accordingly
    (only the view-ddl branch remains).

**Why no warning sink is needed at dml-stmt:** no registry spec lists the
`'dml-stmt'` site, so every `quereus.*` key there yields `unknown-reserved-tag`
or `tag-not-allowed-here` — both `severity:'error'`. The only warning-producing
schema (`required-nonempty-rationale`, `quereus.lens.ack.*`) is legal solely at
logical-table/logical-constraint sites, so `raiseStmtTagDiagnostics`'s no-op
warning sink is correct here, same as on the DDL surfaces.

**Docs:** extend the docs/sql.md § 2.6.3 reserved-namespace paragraph (~line
1238) authoring-path list to include statement-level DML `WITH TAGS`
(`INSERT`/`UPDATE`/`DELETE … WITH TAGS`), and note that currently **no** reserved
key is legal at the DML-statement site (the namespace there is purely a typo
guard since the `quereus.update.*` retirement). Free-form keys stay accepted.

## Edge cases & interactions

- **View/MV-mediated DML still errors exactly once.** Entry validation throws
  before `buildViewMutation` is reached; `validateMutationTags` no longer
  validates stmt tags. Existing 93.4-view-mutation.sqllogic dml-stmt tests
  (lines ~1139, ~1239–1254: `df_v`, `tg_jv` cases) must keep passing with the
  same `unknown reserved tag` error text — the message comes from the same
  registry constructor; only the raise site moves.
- **View-DDL tag validation must not regress.** The `view-ddl` leg stays in
  `validateMutationTags`; the 93.4 cases where a retired key sits on the view
  itself (`df5_v`, `bvu_v`, `sst_v`) keep failing at mutation time, sited, with
  the view-context message prefix.
- **Synthesized base-op re-entry.** The view substrate re-plans base statements
  through the builders; `scope-transform.ts` spreads `...stmt`, so a synthesized
  statement can carry the original tags. The outer entry already validated (and
  would have thrown on any reserved key), so re-entry validation is a no-op on
  the valid path — verify no double-raise and no behavior change on the
  single-source spine (93.x suites cover this).
- **Nested DML positions.** DML in a CTE (`with w as (insert … with tags(…) …
  returning *) select …`), DML as INSERT source (`insert.ts:613`), and DML in
  FROM position all re-enter the builders, so each nested statement's own tags
  validate at its own entry. Add at least the CTE case as a test.
- **Mis-sited known key vs unknown key.** `"quereus.id"` on a DML statement is a
  *valid spec at an illegal site* → `tag-not-allowed-here`; `"quereus.bogus"` →
  `unknown-reserved-tag`. Test both messages on the base path.
- **Free-form tags untouched.** A base DML with only non-`quereus.*` tags
  succeeds and writes; mixed free-form + reserved fails (atomic — nothing
  written).
- **Sited errors.** The raised error carries the statement's line/column via
  `raiseStmtTagDiagnostics` (loc threading already handled, including
  `loc === undefined` for synthesized statements).
- **ON CONFLICT / RETURNING / mutation-context variants** all flow through the
  same entries; placement at function entry covers every statement shape with no
  per-variant handling.

## Tests (add to 53-reserved-tags.sqllogic, new section)

- base `insert … with tags ("quereus.bogus" = 1)` → `error: unknown reserved tag`;
  follow-up select proves nothing was written.
- base `update … with tags ("quereus.update.default_for.x" = '0')` → unknown
  reserved tag; row unchanged.
- base `delete … with tags ("quereus.id" = 'x')` → `tag-not-allowed-here`-shaped
  error (`not allowed on a DML statement`); row still present.
- base `insert … with tags (note = 'free-form', audit = true)` → succeeds.
- DML-in-CTE with a reserved statement tag → error.
- (Existing 93.4 view-path cases serve as the no-double-raise / unchanged-message
  regression net — run the full logic suite.)

## TODO

- Add `raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt)`
  at the entry of `buildInsertStmt`, `buildUpdateStmt`, `buildDeleteStmt` (before
  the committed-schema check), with a brief comment mirroring the DDL surfaces'.
- Remove the `dml-stmt` leg from `validateMutationTags`; narrow `TaggedStmt`,
  simplify `raiseTagDiagnostics` (view-ddl only), update the module doc comment.
- Add the new test section to `test/logic/53-reserved-tags.sqllogic`.
- Update docs/sql.md § 2.6.3 authoring-path sentence (+ a line that no reserved
  key is currently legal at the DML-statement site).
- `yarn build` (or workspace tsc) + `yarn test`; lint `packages/quereus`.
