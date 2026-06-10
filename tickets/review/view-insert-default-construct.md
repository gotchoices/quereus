----
description: Review — first-class view insert-default construct: `create [materialized] view v [(cols)] as <body> insert defaults (col = expr, …)` parsed at all three DDL sites, carried as AST `Expression` values on ViewSchema/MaterializedViewSchema, consumed by the insert write-through rewrite and `view_info` with documented three-tier precedence over the deprecated `quereus.update.default_for.<column>` tag (tag removal is the chained `remove-view-default-for-tag`).
files:
  - packages/quereus/src/parser/ast.ts                          # ViewInsertDefault; insertDefaults on CreateViewStmt + CreateMaterializedViewStmt
  - packages/quereus/src/parser/parser.ts                       # parseInsertDefaultsClause (~2710) + 3 call sites: createView, createMaterializedView, declareViewItem
  - packages/quereus/src/schema/view.ts                         # insertDefaults on ViewSchema + MaterializedViewSchema
  - packages/quereus/src/planner/building/create-view.ts        # thread onto CreateViewNode
  - packages/quereus/src/planner/building/materialized-view.ts  # thread onto CreateMaterializedViewNode
  - packages/quereus/src/runtime/emit/create-view.ts            # copy onto ViewSchema
  - packages/quereus/src/runtime/emit/materialized-view.ts      # copy onto MaterializeViewDefinition
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # materializeView threads onto MaterializedViewSchema
  - packages/quereus/src/schema/manager.ts                      # importCatalog view (~2462) + MV (~2521) rehydration paths
  - packages/quereus/src/planner/mutation/single-source.ts      # rewriteViewInsert 3-pass precedence (~733); resolveDefaultForColumn gains `spelling` param
  - packages/quereus/src/func/builtins/schema.ts                # deriveViewInfo: clause ∪ tag column-name union (~865)
  - packages/quereus/src/emit/ast-stringify.ts                  # insertDefaultsClauseToString + 4 renderers (view/MV × direct/declared)
  - packages/quereus/src/schema/ddl-generator.ts                # generateViewDDL / generateMaterializedViewDDL lift the field
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # clause cases ~1146-1206 (precedence, shadow, MV, error)
  - packages/quereus/test/logic/06.3.4-view-info.sqllogic       # insertability rescue ~184-222
  - packages/quereus/test/logic/50-declarative-schema.sqllogic  # declare/diff/apply round-trip ~1051-1093
  - packages/quereus/test/declarative-equivalence.spec.ts       # direct vs declarative write-through equivalence
  - packages/quereus/test/emit-roundtrip-property.spec.ts       # insertDefaultsArb on createViewArb + declaredViewItemArb
  - packages/quereus/test/emit-roundtrip-comparator.ts          # isPositionalKey: string-valued `column` survives compare (shared infra change)
  - docs/view-updateability.md                                  # § View insert defaults (new); step-5 chain reworded
  - docs/sql.md                                                 # §2.8/§2.9 syntax + EBNF insert_defaults_clause
----

# First-class view insert-default construct — implemented

**Where the diff lives:** the implementation was swept into commit `0af303bd`
("ticket(review): store-rename-produces-colliding-index-store-name") by the runner after
this ticket's first agent run was interrupted post-validation — the two change sets share
the commit but touch disjoint files (this ticket: `packages/quereus/src` + tests + docs;
store-rename: `packages/quereus-store` + leveldb plugin + `docs/store.md`). Review against
that commit's `packages/quereus` hunks, not this run's commit (which only moves ticket files).

## What was built

Trailing clause after the view body, before `with tags`, on both plain and materialized
views and on declarative `view` items:

```sql
create view dfi_v (id, name) as select id, name from dfi
  insert defaults (created = epoch_ms('now'));
```

- **AST**: `ViewInsertDefault { column: string; expr: Expression }`;
  `insertDefaults?: ReadonlyArray<ViewInsertDefault>` on `CreateViewStmt` and
  `CreateMaterializedViewStmt`. Values are first-class expressions with real `loc` — the
  tag's `parseExpressionString(exprText)` lowering is gone for the clause path.
- **Parser**: `parseInsertDefaultsClause` commits only once `DEFAULTS` follows `INSERT`
  (single-token backtrack via `this.current--` otherwise, preserving prior syntax errors
  for a stray trailing `insert`); rejects duplicate column names. Wired at
  `createViewStatement`, `createMaterializedViewStatement`, and `declareViewItem`.
- **Schema threading**: field on `ViewSchema`/`MaterializedViewSchema`; through
  `CreateViewNode`/`CreateMaterializedViewNode`, both emitters, `materializeView`, and both
  `importCatalog` rehydration paths (manager.ts) — so store-backed persistence round-trips
  via `generateViewDDL`/`generateMaterializedViewDDL` → catalog DDL text → re-parse.
- **Consumers**: `rewriteViewInsert` (single-source spine, which is also MV write-through)
  applies omitted-insert defaults in three ordered passes per resolved base column:
  statement-level `default_for` tag → the clause → the deprecated view-level tag (shadowed
  by the clause; alive until `remove-view-default-for-tag`). `deriveViewInfo` unions clause
  and tag column names for the `defaultable` set (names only; precedence is the rewrite's
  concern). `multi-source.ts`/`decomposition.ts` were traced: no `readDefaultFor` consumers
  exist there — the union above covers every call site.
- **Round-trip**: `insertDefaultsClauseToString` rendered by all four renderers
  (`createViewToString`, `createMaterializedViewToString`, `declaredViewToString`,
  `declaredMaterializedViewToString`); DDL generator lifts the schema field back to AST.
- **Docs**: `docs/view-updateability.md` gains § View insert defaults (construct primary,
  tag deprecated-pending-removal; step 5 of the defaulting chain reworded);
  `docs/sql.md` §2.8/§2.9 prose + examples + EBNF.

## Semantics (unchanged from the tag)

Evaluated per omitted-insert row at write-through, step 5 of the insert-defaulting chain
(after user value / constant-FD / FD reconstruction / EC propagation, before the base
column's declared `default`). Target is a base column the view projects away (dominant
case) or a `base`-lineage view column, resolved by the existing
`resolveDefaultForColumn`; an unknown name is a hard sited diagnostic at write time but is
silently skipped by `view_info` (never-throw introspection posture → conservative
`is_insertable_into`).

## Use cases to validate (all covered by tests)

- **Write-through default** — `93.4-view-mutation.sqllogic` ~1146: clause supplies a
  projected-away column; non-literal expr (`100 + 11`) alongside a renamed column list.
- **Precedence** — same file: statement-level `default_for` tag overrides the clause for
  one statement; clause shadows a same-column view-level tag (df4: clause 333 beats tag
  444); view-level tag alone still works (df5 — overlap-window case the removal ticket
  flips).
- **Unknown column** — hard error at insert (df6); silently skipped in
  `view_info` with `is_insertable_into = NO` (`06.3.4` dfi_v_typo).
- **Insertability rescue** — `06.3.4`: clause recovers a not-null no-default
  projected-away column → `YES`, cross-checked by a real insert; negative control without
  the clause → `NO`; tag-form rescue still works.
- **MV write-through** — `93.4` mvd_v: default lands on the source row; backing
  maintenance is transparent (reads-own-writes shows the projected row).
- **Declarative round-trip** — `50-declarative-schema.sqllogic`: diff renders the clause,
  apply re-parses it, write-through works on the applied view, identical re-declare diffs
  empty. `declarative-equivalence.spec.ts`: direct and declarative paths agree.
- **AST round-trip property** — `emit-roundtrip-property.spec.ts`: `insertDefaultsArb` on
  both the direct CREATE VIEW arbitrary and the declared-view arbitrary.

## Validation performed

`yarn build` (exit 0), `yarn lint` in packages/quereus (exit 0), `yarn test` full
workspace run (exit 0; 5551 passing in quereus, 0 failing anywhere — the
`failingKv.iterate` stack line in sync output is a deliberately-failing mock inside a
passing test).

## Known gaps / reviewer attention

- **Un-cloned schema AST in the rewrite**: pass 2 pushes the schema-held `d.expr` node
  into `appendExprs` without cloning at that point, relying on the single consumption
  point cloning per row (`appendExprs.map(cloneExpr)` in the VALUES rewrite) and on
  non-VALUES sources being rejected before that. Verify no other path consumes
  `appendExprs` un-cloned — a later transform mutating the schema's AST would be a
  cross-statement corruption bug.
- **Shared comparator change**: `emit-roundtrip-comparator.ts` now treats `column` as
  positional only when numeric and added it to `CASE_INSENSITIVE_STRING_KEYS`. This is
  shared round-trip-comparison infrastructure — it also affects how UPDATE SET
  assignments' `column` fields compare (now case-insensitively). Tests are green; confirm
  the relaxation is sound.
- **`yarn test:store` not run** (per AGENTS.md it's reserved for store-specific diagnosis/
  release). Store persistence of the clause rides the `generateViewDDL` parse→generate
  fixed point (engine-tested by the round-trip property suite and
  `view-mv-ddl-persistence.spec.ts`'s pinned facts), but no store-mode rerun was executed.
- **Parser backtrack**: the `this.current--` rewind after consuming `INSERT` assumes
  `advance()` has no side effects beyond the cursor in this parser — true today; flag if
  the parser ever grows token-stream state.
- **Statement-level tag retained by design**: the per-statement
  `insert into v with tags ("quereus.update.default_for.x" = …)` override is untouched
  here; the whole tag (statement site included) dies in `remove-view-default-for-tag`,
  which already carries `prereq: view-insert-default-construct`.
