description: DESIGN QUESTION — human sign-off needed. Should direct `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` validate reserved `quereus.*` tags eagerly at create (mirroring the differ + the new CREATE TABLE/INDEX path), or is lazy-at-mutation the intended contract? Changing it alters WHEN the error fires and rewrites a deliberately-codified test contract (93.4) owned by the view-mutation subsystem. Blocked on a call from the view-mutation owner.
files:
  - packages/quereus/src/planner/building/create-view.ts        # buildCreateViewStmt — stores stmt.tags, no reserved-tag validation
  - packages/quereus/src/planner/building/materialized-view.ts  # buildCreateMaterializedViewStmt — same
  - packages/quereus/src/planner/mutation/mutation-tags.ts       # collectMutationTags — validates view tags at 'view-ddl' ONLY when the view is mutated
  - packages/quereus/src/schema/schema-differ.ts                # ~238-245 — differ validates declared (M)V tags eagerly at 'view-ddl'
  - packages/quereus/src/planner/building/ddl.ts                # CREATE TABLE/INDEX eager-validation precedent (create-reserved-tag-validation)
  - packages/quereus/src/schema/reserved-tags.ts                # 'view-ddl' site; legal keys: quereus.id / previous_name (differ-only) + quereus.update.default_for.<column> (mutation-only)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # ~1160-1192 — deliberately codifies "view-tag error surfaces at mutation, not at create"
----

# View DDL reserved-tag validation: eager-at-create vs lazy-at-mutation

> **Disposition (2026-06-08) — Options A/B SUPERSEDED.** The human chose the de-tag
> reframe. Options A and B below (eager-at-create vs lazy-at-mutation) are kept as the
> historical framing only; both are moot once the sole behavior-bearing `view-ddl` tag is
> replaced by a first-class construct. See **`## De-tag reframe — first-class view
> insert-default construct (design, 2026-06-08)`** at the end of this file for the chosen
> direction and staging.

> **Update (2026-06-07) — reframe under consideration (human, pending).** A third path sits
> *above* Option A/B: stop carrying this *semantic* behavior as a tag at all. The only
> behavior-bearing tag at this site is `quereus.update.default_for.<column>` (an omitted-insert
> default on view write-through); if that moves to a **first-class view insert-default
> construct**, the eager-vs-lazy *validation-timing* question dissolves (no tag → no tag
> validation to time). Precedent: the view-mutation **routing** tags were already removed this
> way in favor of per-row presence/membership columns (`reserved-tags.ts:15-18`,
> `mutation-tags.ts:22-27`). The human is weighing this de-tagging direction against the A/B
> options below — decision deferred. A broader "which reserved tags are genuinely metadata vs.
> semantic behavior" audit is a *separate* concern (the `quereus.lens.decomp.*` mapping,
> `quereus.id` / `previous_name` rename hints, and lens governance tags likely **stay** tags).

## Why this is blocked (not an implement ticket)

This is a genuine contract question with two internally-consistent answers, and
the original reviewer (`create-reserved-tag-validation`) explicitly asked for the
**view-mutation owner's** call before any change, because the eager option
rewrites a test contract (`93.4-view-mutation.sqllogic` ~1160-1192) that
*deliberately* asserts the lazy timing. The plan stage could not obtain that
sign-off (the interactive question went unanswered in the autonomous runner), and
there is no clearly-dominant default — so it parks here rather than shipping a
speculative behavior change to another subsystem's documented contract.

**Unblock condition:** the view-mutation owner (or the human) picks Option A or
Option B below. Then move this file to `tickets/implement/` (Option A — the TODO
is already written) or `tickets/complete/` (Option B — no code change; record the
decision). No code lands until then.

## The situation

`CREATE VIEW … WITH TAGS` and `CREATE MATERIALIZED VIEW … WITH TAGS`
(`create-view.ts` / `materialized-view.ts`) **store** `stmt.tags` on the view
node but never validate reserved tags at create time. The only `view-ddl`
validation today is in `mutation-tags.ts` `collectMutationTags`, which runs at
the `view-ddl` site **only when the view is mutated**
(`93.4-view-mutation.sqllogic:1160-1164`, 1182-1192).

Crucially, on a **direct** create *no reserved view tag has any create-time
effect*: the only keys legal at `view-ddl`
(`reserved-tags.ts`) are

- `quereus.id` / `quereus.previous_name` — rename hints read **only by the
  declarative differ**; inert on a directly-created view, and
- `quereus.update.default_for.<column>` — a **mutation-only** insert-default
  override.

So a typo on a view tag that is **never mutated never surfaces** (the hole), but
equally: at create time the tag genuinely does nothing, so validating at the
point of *effect* (mutation) is internally consistent (the lazy defense).

Note the asymmetry this leaves: the declarative differ already validates declared
(materialized) view tags **eagerly** at the `view-ddl` site
(`schema-differ.ts:238-245`), and `create-reserved-tag-validation` made direct
`CREATE TABLE` / `CREATE INDEX` validate eagerly — so direct `CREATE VIEW` is the
*only* DDL authoring path that defers reserved-tag validation.

## The design question

Should direct `CREATE VIEW` / `CREATE MATERIALIZED VIEW` reserved tags ALSO be
validated **eagerly at create**, or is **lazy-at-mutation** the intended contract?

### Option A — eager at create (consistency / fail-fast)

Validate view & MV reserved tags at build time in `buildCreateViewStmt` /
`buildCreateMaterializedViewStmt`, mirroring the differ and the
`raiseStmtTagDiagnostics` helper in `ddl.ts`.

- **Pros:** one uniform "a typo can't be silently stored on any authoring path"
  posture across every DDL path (the stated thrust of the whole reserved-tags
  effort — `ddl.ts:13-14`, `reserved-tags.ts:155-156`); a never-mutated view's
  typo is caught at authoring time; removes the last DDL-path asymmetry.
- **Cons / cost:** changes **when** the error fires for view tags. Must rewrite
  `93.4-view-mutation.sqllogic` ~1160-1192 so the removed-routing-key / typo
  cases error at the `create view` line instead of at the first `insert`. The
  mutation-path validation (`collectMutationTags`) stays (a view can still be
  reached without re-validating, and statement-level `dml-stmt` tags are
  validated there regardless) — so this ADDS an eager gate, it does not move the
  lazy one.

### Option B — keep lazy-at-mutation (intended contract)

Treat lazy as the deliberate contract: a view's reserved tags are meaningful only
at mutation, so an unused typo is harmless and surfaces on first mutation.

- **Pros:** validates at the point of effect; no churn to the 93.4 contract; the
  create path stays minimal (DML statement tags are already validated lazily at
  `dml-stmt`, symmetric with view-level `view-ddl` tags).
- **Cons:** the never-mutated-view typo hole persists; direct `CREATE VIEW`
  remains the lone DDL path that defers reserved-tag validation.

## Edge cases & interactions (for whichever option lands)

- **Materialized views** must be decided **together with** plain views — same
  `view-ddl` site, same `stmt.tags` slot; do not split their behavior.
- **`default_for.<column>` is the only functional view tag.** Under Option A its
  *shape/site* is validated at create, but its *semantic* effect (omitted-insert
  default) still only fires at mutation — eager validation must not change the
  effect, only catch a malformed key earlier.
- **Differ unchanged.** The declarative-differ `view-ddl` validation already
  fires eagerly; neither option touches it — keep them consistent (Option A makes
  direct-create match the differ; Option B accepts the divergence by design).
- **Mutation path stays.** `collectMutationTags` must keep validating at mutation
  regardless (statement-level `dml-stmt` tags, and a view mutated after a tag was
  added by other means). Option A adds a gate; it does not remove this one.
- **`IF NOT EXISTS` / re-create:** under Option A a malformed tag should fail at
  plan-build even if the view already exists, matching the CREATE TABLE precedent
  (`50-metadata-tags.sqllogic:457-461`).
- **Sited diagnostics:** an eager view error should carry the statement's
  line/column (reuse the `ddl.ts` `raiseStmtTagDiagnostics` pattern), matching the
  mutation-path sited errors the 93.4 tests assert.

## TODO (Option A only — delete this section if Option B is chosen)

- [ ] Add eager reserved-tag validation to `buildCreateViewStmt`
      (`create-view.ts`) and `buildCreateMaterializedViewStmt`
      (`materialized-view.ts`): `validateReservedTags(stmt.tags, 'view-ddl')`
      raised via the shared `ddl.ts` `raiseStmtTagDiagnostics` pattern (factor it
      to a shared helper rather than copy-paste).
- [ ] Rewrite `test/logic/93.4-view-mutation.sqllogic` ~1160-1192 so the
      view-DDL typo / removed-routing-key cases assert the error at `create view`
      / `create materialized view`, not at the first `insert`. Keep the
      statement-level (`dml-stmt`) typo cases (~1156-1158) firing at mutation.
- [ ] Add eager-validation cases (valid `default_for`, typo'd key, mis-sited key)
      to the view test surface; mirror the CREATE TABLE block style in
      `50-metadata-tags.sqllogic`.
- [ ] `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`
      + lint; reconcile any other test that depended on lazy view-tag timing.
- [ ] Update `docs/view-updateability.md` (Tags section) to state the create-time
      validation timing.

----

## De-tag reframe — first-class view insert-default construct (design, 2026-06-08)

This supersedes Options A/B. Rather than decide *when* to validate the one
behavior-bearing `view-ddl` tag (`quereus.update.default_for.<column>`), we remove
that tag entirely and replace it with a first-class **view insert-default** language
construct. Once the tag is gone, no behavior-bearing reserved tag remains at the
`view-ddl` site (only the differ-only rename hints `quereus.id` / `quereus.previous_name`
stay — inert on a direct create), so the eager-vs-lazy validation-timing question
dissolves with nothing left to time.

Precedent: the view-mutation **routing** tags (`target` / `exclude` / `delete_via` /
`policy`) were removed this exact way in favor of per-row presence/membership columns
(`remove-update-routing-tag-surface`). `reserved-tags.ts:13-16` and the
`mutation-tags.ts` header doc record that removal; this work is the same move applied to
the last remaining `quereus.update.*` key.

### 1. Current mechanism, end-to-end

The `quereus.update.default_for.<column>` tag supplies an omitted-insert default during
write-through (insert through an updateable view / MV). Its full lifecycle:

**Authoring.** `create view v(...) as <body> with tags ("quereus.update.default_for.created" = '111')`.
`with tags` is parsed by `Parser.createViewStatement` / `createMaterializedViewStatement`
(`parser/parser.ts` ~2685-2693, ~2745+) via `parseTags()` into the AST's
`CreateViewStmt.tags` / `CreateMaterializedViewStmt.tags`
(`Record<string, SqlValue>`, `parser/ast.ts` ~332-355). The value is a TEXT **SQL
expression string** (`'111'`, `'epoch_ms(''now'')'`), not a literal.

**Storage.** `buildCreateViewStmt` (`planner/building/create-view.ts:73-82`) and
`buildCreateMaterializedViewStmt` (`planner/building/materialized-view.ts:55-65`) freeze
`stmt.tags` onto `CreateViewNode.tags` / `CreateMaterializedViewNode.tags` — **no
reserved-tag validation at build**. The emitter `emitCreateView`
(`runtime/emit/create-view.ts`) copies `plan.tags` into `ViewSchema.tags`; the MV emitter
does the same onto `MaterializedViewSchema.tags`. Both schema records carry
`tags?: Readonly<Record<string, SqlValue>>` (`schema/view.ts:28`, `:64`). The tag can also
be **mutated post-create** via `alter view … set/add/drop tags` (`AlterViewStmt`,
`AlterObjectTagsAction`, `parser/ast.ts:387-401`), which swaps the in-memory schema's
`tags` without rewriting the stored `sql`.

**Validation (the `view-ddl` site).** Shape/site validation lives in the typed registry
`schema/reserved-tags.ts`. The spec
(`{ template: 'quereus.update.default_for.<column>' }`, sites
`siteSet('view-ddl', 'projection', 'dml-stmt')`, `valueSchema: 'expression'`,
`reserved-tags.ts:178-190`) is matched by `validateReservedTags(tags, site)`. This runs at
`'view-ddl'` **only** in two places: the **differ** (`schema/schema-differ.ts:268-272`,
eagerly on a *declared* view/MV) and `collectMutationTags`
(`planner/mutation/mutation-tags.ts:62`, **lazily at first mutation** of a directly-created
view). A direct `create view` never validates — the hole Options A/B argued over.
Note: `'projection'` is a declared legal site but is **inert** — `ResultColumn`
(`parser/ast.ts:444-453`) carries no `tags` field and `columnList()`
(`parser/parser.ts:865-913`) parses none, so no per-result-column tag is ever produced or
validated. This is a useful fact for §2.

**Consumption (write-through).** At insert time, `view-mutation-builder.ts:48` calls
`collectMutationTags(view, req.stmt)`, which validates view-level (`view-ddl`) and
statement-level (`dml-stmt`) tags, then merges them (statement wins) into a
`ReservedTagMap` threaded onto `req.tags`. `readDefaultFor(tags)`
(`mutation-tags.ts:93-99`) enumerates the templated key family into a
`Map<lowercased-column, expression-text>`. The single-source spine consumes it in
`rewriteViewInsert` (`planner/mutation/single-source.ts:737-741`): for each
`(colName, exprText)`, `resolveDefaultForColumn` (`single-source.ts:664-678`) maps the name
to a writable base column (a base column the view projects away, or a `base`-lineage view
column; an unknown name is a hard `tag-target-not-found` diagnostic), and if that column is
not already supplied by the insert or a constant-FD pin, `parseExpressionString(exprText)`
is appended to the rewritten base INSERT's column/value lists. It sits at **step 5** of the
insert-defaulting precedence chain (`docs/view-updateability.md:93`): after the user's
value, constant-FD, FD reconstruction, and EC propagation, but **before** the base
column's declared `default`. A second consumer is read-only: `deriveViewInfo`
(`func/builtins/schema.ts:833-876`) folds `readDefaultFor(view.tags)` columns into the
`defaultable` set so `view_info.is_insertable_into` / `column_info` report a view whose
`not null` projected-away column the tag rescues (`06.3.4-view-info.sqllogic:184-216`).

**Round-trip.** `generateViewDDL` / `generateMaterializedViewDDL`
(`schema/ddl-generator.ts:157-190`) lift the stored `ViewSchema` back to a `CreateViewStmt`
carrying `tags` and render via `createViewToString`
(`emit/ast-stringify.ts`, `tagsClauseToString`), so the tag survives the persistence /
declarative-schema round-trip as part of the generic `with tags` clause.

### 2. Proposed first-class construct

The construct must (a) attach a default **expression** to a named view output column,
(b) survive the schema→AST→SQL round-trip, (c) be consumed by the same write-through step
the tag feeds today, and (d) be authored consistently with how base-table column defaults
already work.

**Base-table precedent.** A base column default is a `ColumnConstraint` of `type:'default'`
carrying `expr: Expression` (`parser/ast.ts:550-563`), stored as
`ColumnSchema.defaultValue: AST.Expression`, rendered by `formatColumnDef` as
`DEFAULT <expr>` (`ddl-generator.ts:406-408`). The view construct should mirror this: an
**`Expression` AST node**, not a re-parsed text string — eliminating the
`parseExpressionString(exprText)` lower-from-text the tag path needs, and giving the
default a proper `loc` for sited diagnostics.

**Option 1 (recommended) — inline `default (<expr>)` in the view's projected column
list.** Today a view column list is bare names: `create view v(a, b) as …`. Extend each
entry to optionally carry a default:

```sql
create view df2_v (id, created default (111)) as select id from df2;
create view dfi_v (id, name, created default (epoch_ms('now'))) as select id, name from dfi;
```

The default attaches to a *named view output column*, which is exactly the granularity
`default_for.<column>` addresses (it names a view-or-base column). It reads like a table
column default, so the construct is discoverable and consistent with `ColumnDef`.

- **AST.** Change `CreateViewStmt.columns` / `CreateMaterializedViewStmt.columns` from
  `string[]` to `ViewColumnDef[]` where
  `interface ViewColumnDef { name: string; insertDefault?: Expression; }`
  (a new type in `parser/ast.ts`, sited via `AstNode` if a `loc` is wanted on the default).
  Keep the bare-name form producing `{ name }` with no `insertDefault`. The `string[]`
  shape persists in two derived places that must move in lockstep: `ViewSchema.columns`
  and `MaterializedViewSchema.columns` (`schema/view.ts:26`, `:62`), and `CreateViewNode` /
  `CreateMaterializedViewNode` constructor params.
- **Parser.** In `createViewStatement` / `createMaterializedViewStatement` column-list
  loops (`parser.ts:2666-2676`, `2723-2733`) and the declarative `declareViewItem`
  (`parser.ts:3534-3540`), after `consumeIdentifier`, optionally consume
  `default ( <expression> )` (reuse the existing `default` keyword + `expression()` —
  parenthesize to keep the comma-separated list unambiguous, matching how `using mod(...)`
  args are parenthesized). No new keyword.
- **ViewSchema field.** The simplest carrier is to widen `columns` to
  `ReadonlyArray<ViewColumnSchema>` with
  `interface ViewColumnSchema { name: string; insertDefault?: AST.Expression }`. A
  *separate* parallel field (`insertDefaults?: ReadonlyMap<string, AST.Expression>`)
  is the lower-churn alternative — it leaves `columns?: ReadonlyArray<string>` untouched and
  every existing arity/name reader unaffected — but it allows a default on a column the
  view does not name in its list. Recommend the **widened `columns`** for the explicit-list
  case **plus** a fallback: a `default` on a name not in an explicit list (or no list at
  all) is the common `default_for.created`-on-a-projected-away-column case, which has no
  column-list slot. So the construct also needs a list-independent slot — see the note
  below.
- **Write-through consumption.** Replace `readDefaultFor(tags)` at
  `single-source.ts:737` with a reader over the new schema field
  (`view.insertDefaults` / the widened `columns`), yielding `Map<lowercased-name,
  AST.Expression>`. `resolveDefaultForColumn` is unchanged. The
  `parseExpressionString(exprText)` call disappears (the value is already an AST
  `Expression`); `appendExprs.push(cloneExpr(expr))` replaces it. `deriveViewInfo`
  (`schema.ts:833-876`) reads the same field instead of `readDefaultFor(view.tags)`.
- **Round-trip.** `createViewToString` (`ast-stringify.ts:1064-1082`) and the declarative
  `declaredViewToString` render each column-list entry as `name [default (<expr>)]` using
  the existing `expressionToString`. `generateViewDDL` (`ddl-generator.ts:157-167`) lifts
  the schema field back into the `ViewColumnDef[]`. This is the same schema→AST-lift the
  generator already uses for constraints, so the persistence and declarative paths share
  one renderer and cannot drift.

**The projected-away-column gap.** `default_for.created` commonly targets a base column the
view *projects away* (`06.3.4-view-info.sqllogic:184`), which has no slot in the view's
output column list. A pure inline-column-list construct cannot express it. Two resolutions:
(a) **widen the inline form to permit naming a non-projected column** — but a view column
list is, by SQL convention, a *rename* of the body's projection, so naming a column the
body does not output breaks arity validation (`create-view.ts:54-62`); or (b) add a
**dedicated trailing clause** keyed by name, which is Option 2.

**Option 2 — dedicated `insert defaults (<col> = <expr>, …)` clause.** A trailing clause
after the body (where `with tags` sits today):

```sql
create view dfi_v (id, name) as select id, name from dfi
  insert defaults (created = epoch_ms('now'));
```

- **AST.** `CreateViewStmt.insertDefaults?: ReadonlyArray<{ column: string; expr: Expression }>`
  — a flat list, name-keyed, decoupled from the projected column list, so it naturally
  expresses a projected-away column.
- **Parser.** A trailing optional clause parsed in the same spot as `with tags`
  (`parser.ts:2685`), `insert defaults ( ident = expression , … )`. `insert` and `defaults`
  are existing keywords; the pairing is unambiguous after a complete body.
- **Schema / consumption / round-trip.** As Option 1 but onto the flat
  `insertDefaults` field — `readDefaultFor` is replaced by a trivial map read over it, and
  `createViewToString` appends `insert defaults (…)` rendered with `expressionToString`.

**Recommendation: Option 2** (the dedicated clause), because:
1. The dominant real use is a default on a **projected-away** base column
   (`default_for.created`), which the inline-column-list form (Option 1) structurally cannot
   express without abusing the rename-only column list. Option 2 expresses it directly.
2. It is name-keyed exactly like the tag it replaces, so the consumer (`resolveDefaultForColumn`)
   and the `deriveViewInfo` reader need only swap their source map — minimal blast radius.
3. It leaves `CreateViewStmt.columns: string[]` untouched, so every arity/name reader, the
   MV backing-shape derivation, and the differ's column handling are unaffected.
4. It mirrors the table-default *spirit* (a name → `Expression` binding) while honoring that
   a view's output-column list is a rename surface, not a definition surface.

Either way the value is a first-class `Expression` (not text), removing the
`parseExpressionString` round-trip and giving sited diagnostics a real `loc`.

### 3. Migration / removal

- **Remove the spec.** Delete the `quereus.update.default_for.<column>` entry from
  `RESERVED_TAG_SPECS` (`reserved-tags.ts:178-190`). With it gone, the `'projection'`
  `TagSite` has **no** remaining spec and the `'dml-stmt'`/`'view-ddl'` sites lose their
  only `quereus.update.*` key. Decide `'projection'`'s fate: it is currently inert (no
  parser path), so it can be **dropped from the `TagSite` union** (`reserved-tags.ts:44-62`)
  together with its `siteLabel` arm (`:581`) — it exists solely for `default_for`.
- **Statement-level `default_for` also goes.** The tag's `'dml-stmt'` site backed the
  per-statement override `insert into v with tags ("quereus.update.default_for.created" = …)`
  (`docs/view-updateability.md:709-715`). The reframe removes this too unless a statement-level
  equivalent is wanted; recommend dropping it (the view-level construct is the documented
  primary use, and a per-statement default is expressible as an explicit insert value). If a
  per-statement override is later desired, it is a separate construct, not a tag.
- **Drop the readers.** Remove `readDefaultFor` + `DEFAULT_FOR_TEMPLATE`
  (`mutation-tags.ts:40-99`); `collectMutationTags` keeps validating remaining `dml-stmt`
  tags (currently none in the `quereus.update.*` family — it still guards against typo'd /
  mis-sited reserved keys, so the function stays). The `tag-default` provenance language in
  `schema.ts:833-845` becomes `view-insert-default`.
- **What stays at `view-ddl`.** Only `quereus.id` / `quereus.previous_name`
  (`reserved-tags.ts:149-160`), both differ-only rename hints, inert on a direct create.
- **Eager-vs-lazy fully dissolved.** With no behavior-bearing tag at `view-ddl`, there is
  nothing whose validation timing matters on a direct `create view` — the differ still
  validates the rename hints eagerly (unchanged), and `collectMutationTags` still validates
  any `dml-stmt` reserved tag at mutation. Options A and B are moot; the asymmetry the
  ticket worried about (direct `create view` as the lone deferred-validation DDL path)
  disappears because the only thing it deferred no longer exists as a tag.

### 4. Edge cases & interactions (the implement ticket's adversarial surface)

- **Materialized views.** Same construct, same code paths — MV write-through routes through
  the identical single-source spine (`single-source.ts` header: every MV is a single-source
  passthrough), and `MaterializedViewSchema` carries the same `columns` slot. The construct
  **must** be wired on both `CreateView` and `CreateMaterializedView` in lockstep (do not
  split). Open question for implement: does a default on an MV's projected-away source
  column interact with row-time backing maintenance? The default fires only on *write-through
  to the source*, and maintenance is a pure projection of the resulting source row, so it
  should be transparent — verify with an MV write-through test.
- **Lens / view-updateability layer.** The multi-source / decomposition spines also read
  `default_for` for outer-join null-extended creates (`docs/view-updateability.md:176`) and
  the join insert-default chain. The reader swap must cover **every** `readDefaultFor`
  call-site, not just single-source — grep confirms `single-source.ts` and `schema.ts` are
  the consumers today, but the decomposition/multi-source paths reference the same merged
  `tags` map via `req.tags`; trace `ReservedTagMap` threading in `multi-source.ts` /
  `decomposition.ts` during implement.
- **Declarative-schema round-trip.** The construct must survive generate→parse→import like
  any view DDL. `declareViewItem` (`parser.ts:3534`) and `declaredViewToString`
  (`ast-stringify.ts:1346-1359`) are the declarative-side parser/renderer and must learn the
  new syntax alongside `createViewStatement`/`createViewToString`. The differ
  (`schema-differ.ts`) compares declared-vs-actual view DDL via these renderers; the default
  expression becomes part of the view body's compared identity, so a changed default is a
  view-modified diff (acceptable — it changes write-through behavior).
- **Determinism.** The default expression is evaluated per omitted-insert row at
  write-through, exactly as a base-column `default` is. It inherits base-column-default
  determinism rules (a `default` may read `epoch_ms('now')`, sequences, etc. — they resolve
  through the mutation-context envelope, `docs/view-updateability.md:94`). No *new*
  determinism constraint is needed; the construct should accept any expression the base
  `DEFAULT` clause accepts. Reject column references the view's image does not expose (the
  encapsulation guard) — `resolveDefaultForColumn` already enforces target resolution; the
  default *expression's* references should resolve in the base/view scope the same way the
  tag's parsed expression does today.
- **Tests that assert the tag behavior (need rewriting).**
  - `test/logic/93.4-view-mutation.sqllogic` ~1143-1159 — the `df2_v` view-level default,
    the statement-over-view override (drops if statement-level form is removed), and the
    `default_for.nope` typo→error case. Rewrite to the new construct syntax.
  - `test/logic/06.3.4-view-info.sqllogic` ~184-216 — `dfi_v` insertability-rescue and the
    `dfi_v_typo` silently-skipped-unresolvable case. Rewrite to the new syntax; the
    silently-skipped semantics should carry over (a default naming an unresolvable column is
    a hard error at *write* via `resolveDefaultForColumn`, but `view_info` stays conservative).
  - `test/logic/50-metadata-tags.sqllogic` ~501-509, ~585-589 — the **mis-sited**
    `default_for` on a physical-constraint / ADD CONSTRAINT (`tag-not-allowed-here`). Once
    the spec is removed these become **`unknown-reserved-tag`** errors (still errors, but a
    different reason) — update the expectation or drop them.
  - `test/logic/53-reserved-tags.sqllogic` ~43-54 — the mis-sited `default_for` on a logical
    table via declarative apply: same `unknown-reserved-tag` flip.
  - The removed-routing-key cases (`93.4` ~1199-1209) are unaffected (those keys are already
    gone).

### 5. Disposition

This is no longer a blocked yes/no. It is a **design→implement** effort. Recommend:

- **Move this file to `tickets/implement/`** carrying the chosen Option-2 design (or whichever
  the implement owner confirms), or split into a short prereq chain if the surfaces warrant it:
  1. **`view-insert-default-construct`** (the core) — AST `ViewColumnDef`/`insertDefaults`
     field, parser (direct + declarative), `ViewSchema`/`MaterializedViewSchema` field,
     `CreateView*Node` plumbing, emitter, `createViewToString`/`declaredViewToString` +
     `generateViewDDL` round-trip, write-through consumer swap in `single-source.ts` +
     `deriveViewInfo`, and the four test rewrites.
  2. **`remove-view-default-for-tag`** (chained after 1) — delete the
     `quereus.update.default_for.<column>` spec, retire the inert `'projection'` `TagSite`,
     drop `readDefaultFor`/`DEFAULT_FOR_TEMPLATE`, update the `50-`/`53-` mis-site
     expectations, and update `docs/view-updateability.md` (§ Tags → § View insert defaults)
     and `docs/sql.md` §2.8/§2.9 to document the construct and note the tag's removal.

  The split keeps the behavior-preserving construct addition reviewable on its own, then the
  tag removal lands once the replacement is proven by the rewritten tests. If kept as one
  ticket, sequence the phases identically (add construct → migrate tests → remove tag → docs)
  so the test suite never goes red between the construct landing and the tag leaving.

- **Verify the broader audit stays separate.** The `quereus.lens.*` mapping, the rename
  hints, and lens governance tags remain genuine metadata tags and are out of scope here
  (the 2026-06-07 note's "separate concern").
