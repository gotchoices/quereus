----
description: Re-home the view `insert defaults (…)` clause as a core-select `with defaults (…)` trailing clause — atomic source move + existing-test/doc migration (green build)
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/derivation.ts, packages/quereus/src/schema/rename-rewriter.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/create-view-node.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/runtime/emit/create-view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/func/builtins/schema.ts, docs/view-updateability.md, docs/sql.md, docs/materialized-views.md, docs/schema.md, docs/architecture.md, packages/quereus/test/logic/*.sqllogic (18 files), packages/quereus/test/*.spec.ts (declarative-equivalence, emit-roundtrip, emit-roundtrip-property, schema-differ, view-mv-ddl-persistence)
difficulty: hard
----

## Goal

Move the `insert defaults (col = expr, …)` clause off the DDL statements and onto the **core
select AST** as `with defaults (col = expr, …)`, a trailing clause of the query expression. The old
`insert defaults` spelling and `parseInsertDefaultsClause` are **removed outright** (no backward
compatibility — project rule). This is a *move*, not a behavior change: entry shape, target
resolution, position in the insert-defaulting chain, and MV maintenance transparency all carry over
verbatim.

This is an **expand-nothing, contract-everything move**: the producer (parser) and every consumer
(schema / planner / runtime / `view_info`) switch storage source in lockstep, so the change must
land atomically to keep `yarn build` + `yarn test` green. That is why this is one ticket.

See the source plan (`with-defaults-core-select-clause`, now consumed) for the full motivation. The
design below is **settled** — do not re-litigate spelling, placement, or validation timing.

## Settled design decisions (carried from plan; do not reopen)

- **Spelling:** `with defaults (col = expr, …)` — `insert` qualifier dropped. `DEFAULTS` stays a
  contextual keyword (no new reserved word).
- **Residence:** a new optional field on `SelectStmt`. **Recommended name: `SelectStmt.defaults:
  ReadonlyArray<ViewInsertDefault>`** (field name mirrors the `with inverse → ResultColumn.inverse`
  convention). Keep the existing `ViewInsertDefault` type (`{ column, expr }`) to limit churn —
  renaming it to `ViewDefault` is optional cosmetic polish, not required.
- **Binding:** trails the query expression after `limit`/`offset`, **before** the DDL-level `with
  tags`. Binds to the **whole compound** (like trailing `order by`), so it is parsed only in
  non-compound-leg position (`!isCompoundSubquery`) and never lands on a leg.
- **Parser commit pattern:** commit on `WITH` + contextual `DEFAULTS`, exactly mirroring
  `parseInverseClause` (parser.ts ~2802) — including the safe-rewind property (the rewound token is
  `WITH`, which never touches the parenStack). A stray `insert` after a body falls back to the
  pre-existing downstream syntax error.
- **Validation timing: WRITE-TIME resolution stays (unchanged from today).** Build-time parity with
  `with inverse` was investigated and rejected: `with inverse` resolves targets against the select's
  **FROM-source attributes** (available in the projection builder), but `with defaults` resolves
  targets against **write-direction base-column lineage** (`deriveViewColumns` /
  `resolveDefaultForColumn` over a resolved single base table) — a namespace only assembled when the
  view is an actual write target, NOT during the read-only `planViewBody` arity/DML gate. Adding
  build-time target resolution would mean assembling write lineage at create for every view (out of
  scope). So keep `resolveDefaultForColumn` at write time; the `default-target-not-found` /
  `conflicting-assignment` diagnostics fire exactly when they do today. Document this in
  `docs/sql.md` (it is already the documented behavior — keep it accurate).
- **Inert-vs-rejected posture:** the clause is **inert metadata wherever it is not consumed by a
  write path** — mirroring an unused `with inverse`. Specifically:
  - **VALUES body** (read-only view): parse + store, inert. The write path already rejects the
    VALUES view as non-updateable; the defaults are dead metadata. No body-type-aware parser logic.
  - **Bare top-level `select … with defaults (…)`**: parses, attaches `.defaults`, ignored at
    runtime (nothing consumes it). Consistent with a top-level `with inverse` on a non-write-target
    select.
  - **DML-position `QueryExpr`** (`insert … returning … with defaults (…)`): **not grammatically
    reachable** — `with defaults` is parsed only by the select trailing-clause spine
    (`parseTrailingOrderLimit` is select-only); a `with` after a DML `returning` column-list falls
    through to the pre-existing downstream syntax error. No special rejection code.
- **Catalog migration:** store catalogs that persisted canonical DDL with the old `insert defaults`
  spelling **will not re-parse** after this change. This is acceptable under the project's
  transient-schema / no-backward-compat posture. State it explicitly in `docs/schema.md` rather than
  leaving it implicit.

## Consolidation that falls out (do all of it)

- **Storage:** delete `TableDerivation.insertDefaults` (schema/derivation.ts ~35) and
  `ViewSchema.insertDefaults` (schema/view.ts ~32). Defaults now live inside the stored body AST
  (`selectAst` / `ViewSchema.selectAst`). Readers pull from `(<body select>).defaults`.
- **Canonical hash:** drop the `insertDefaults` parameter from `viewDefinitionToCanonicalString`
  (ast-stringify.ts ~1108) and delete `insertDefaultsClauseToString` (~1080) — `astToString(select)`
  now carries the clause via `selectToString`, so `bodyHash` covers it automatically. Verify the
  declarative differ still detects a defaults-only edit as a definition change (it will, because the
  body string now differs).
- **Stringify:** render `with defaults (…)` inside the `trailing` block of `selectToString`
  (ast-stringify.ts ~585–600), appended in BOTH the compound and non-compound cases (same as
  `order by`/`limit`). Add `defaults` to the `compoundLegToString` paren-wrap guard (~635) for
  symmetry/defense, though a leg should never carry it. Remove every `insertDefaultsClauseToString`
  call site in the DDL renderers (createView/createMaterializedView/setMaintained/declared-view/
  declared-mv/maintainedClause — ~1137, 1162, 1265, 1427, 1448, 1862).
- **Rename propagation:** fold `renameTableInInsertDefaults` / `renameColumnInInsertDefaults`
  (schema/rename-rewriter.ts ~1037, ~1069) into the body-rewrite walk. The defaults entries now ride
  inside `selectAst`, so the existing select/body rename walk must visit `select.defaults`: a table
  rename leaves the target (a base COLUMN name) untouched and rewrites only table refs inside the
  default expr; a column rename rewrites the target via the same scope-aware synthetic-probe path the
  `with inverse` target rewrite already uses (rename-rewriter.ts ~535–539). Delete the two standalone
  functions and their call sites once subsumed.
- **`set maintained as` / `maintained as`:** drop the explicit `insertDefaults` parameter from the
  `setMaintained` action AST (ast.ts ~726) and the `MaintainedClause` (ast.ts ~320) — the body
  `select` brings its own `defaults`. Update parser.ts ~2639 (maintained-as) and ~3174 (set
  maintained) to stop calling `parseInsertDefaultsClause`.
- **`view_info` / `column_info`:** `func/builtins/schema.ts` ~893 reads `view.insertDefaults`; change
  it to read `defaults` off the body select AST (guard for non-select bodies — a VALUES body has no
  `.defaults` field access issue but the cast must be safe). Preserve the never-throw skip posture
  for an entry naming a nonexistent column.

## Parser change (precise)

- Add a `parseDefaultsClause(): AST.ViewInsertDefault[] | undefined` modeled byte-for-byte on
  `parseInverseClause` (parser.ts ~2802): `check(WITH)` → `advance` → `peekKeyword('DEFAULTS')` →
  on miss `this.current--` and return undefined; on hit consume `(`, parse `col = expr` entries with
  duplicate-target rejection (`Duplicate column '…' in WITH DEFAULTS.`), consume `)`.
- Call it in `selectStatement` (parser.ts ~669, immediately after `parseTrailingOrderLimit`) and in
  `continueSelectAfterFrom` (~2451, after its `parseTrailingOrderLimit`), guarded by
  `!isCompoundSubquery`, assigning to `result.defaults` (omit the field when undefined to keep ASTs
  minimal / round-trip-stable).
- **Delete** `parseInsertDefaultsClause` (~2764) and remove its 5 call sites: createView (~2733),
  createMaterializedView (~2907), maintained-as in createTable (~2639), set-maintained (~3174),
  declared-view (~3709), declared-mv (~3773). After deletion the createView/createMaterializedView
  statements no longer carry `insertDefaults`; their AST nodes lose the field.

## Edge cases & interactions (write tests / assertions for each)

- **Compound body:** `... union ... with defaults (...)` binds to the whole compound. A `with
  defaults` attempted mid-compound (before `union`) must NOT bind to the left leg — verify it errors
  cleanly (the leg parses with `isCompoundSubquery`, suppressing the clause, so the stray `with`
  surfaces as a downstream error). Round-trip a compound-body view carrying the clause byte-stable.
- **Clause adjacency:** a single `create view` carrying a result-column `with inverse`, a body-level
  `with defaults`, and a DDL-level `with tags` — all three — must parse, and `parse(stringify(ast))
  ≡ ast` (add to the emit-roundtrip property suite). Confirm the two trailing `with` clauses
  disambiguate on the post-`WITH` keyword (`defaults` consumed by the select spine; `tags` rewound
  and consumed by the DDL parser).
- **MV surfaces:** a defaults-only edit must still flip `bodyHash` and schedule rebuild/re-attach in
  the declarative differ; `materialized_view_modified` must fire on a rename-driven clause rewrite;
  canonical-DDL fixed point (live-create → persist → reopen → re-persist) must be byte-identical
  with the new spelling.
- **`view_info` insert-coverage** now reads from the body AST — including the never-throw skip for an
  entry naming a nonexistent column (06.3.4-view-info.sqllogic).
- **Duplicate-target** rejection inside the clause (parse error), and interaction with an
  authored-inverse put targeting the same base column — preserve today's `conflicting-assignment` at
  the supplied/default seam (93.4 / 93.5 sqllogic).
- **VALUES body + `with defaults`**: parses, inert; the view is non-updateable, so the defaults never
  fire — assert no crash and no spurious write-through.
- **Bare top-level `select … with defaults (…)`**: parses, runs, ignores the clause (no error).

## TODO

### Phase 1 — AST + parser + stringify (grammar move)
- [ ] ast.ts: add `SelectStmt.defaults?`; remove `insertDefaults` from `CreateViewStmt`,
      `CreateMaterializedViewStmt`, `MaintainedClause`, and the `setMaintained` action. Keep
      `ViewInsertDefault`.
- [ ] parser.ts: add `parseDefaultsClause`; wire into `selectStatement` + `continueSelectAfterFrom`
      (non-leg only); delete `parseInsertDefaultsClause` + all 5 call sites; drop the now-dead
      `insertDefaults` fields from the returned DDL nodes.
- [ ] ast-stringify.ts: render `with defaults` in `selectToString` trailing block; add to
      `compoundLegToString` guard; delete `insertDefaultsClauseToString` + all DDL call sites; drop
      the `insertDefaults` param from `viewDefinitionToCanonicalString`.

### Phase 2 — schema / planner / runtime consumers (switch source in lockstep)
- [ ] schema/view.ts + derivation.ts: delete the `insertDefaults` slots; update
      `viewDefinitionToCanonicalString` callers and `maintainedTableViewLike`.
- [ ] single-source.ts: read defaults from the body `selectAst.defaults` (the `MutableViewLike`
      surface) instead of `view.insertDefaults`; keep `resolveDefaultForColumn` write-time.
- [ ] rename-rewriter.ts: fold the two `*InInsertDefaults` rewrites into the body walk; delete them.
- [ ] create-view / materialized-view / alter-table — building/, nodes/, runtime/emit/: remove the
      threaded `insertDefaults` parameter end-to-end (these are mostly pass-through deletions).
- [ ] schema-differ.ts, manager.ts, catalog.ts, ddl-generator.ts: drop separate defaults itemization;
      rely on the body string.
- [ ] func/builtins/schema.ts: `view_info`/`column_info` read defaults off the body AST (safe cast,
      never-throw posture preserved).

### Phase 3 — migrate existing tests + docs (required for green build)
- [ ] Migrate the 18 test files spelling `insert defaults` → `with defaults` (and any DDL clause-order
      lines): logic/06.3.4-view-info, 41.3-alter-rename-propagation, 50-declarative-schema,
      50-metadata-tags, 50.2-declare-schema-renames, 51.7-maintained-table-attach-detach,
      53-reserved-tags, 53.2-materialized-view-rename-propagation, 93.4-view-mutation,
      93.5-authored-inverse; spec: declarative-equivalence, emit-roundtrip, emit-roundtrip-property,
      schema-differ, view-mv-ddl-persistence, view-tag-mutation-plan, view-mutation-substrate,
      reserved-tags. (Grep the test tree for `insert defaults`/`INSERT DEFAULTS` to confirm none
      remain.)
- [ ] docs: view-updateability.md (rename the "View insert defaults" section to reflect `with
      defaults`; note expanded residence on core select), sql.md (§2.8/§2.9 + MV DDL grammar; keep
      the write-time-resolution note accurate), materialized-views.md (DDL sections incl. the
      clause-order line), schema.md (bodyHash no longer itemizes defaults separately; rename events;
      add the explicit "old persisted catalogs won't re-parse" note), architecture.md (~line 117).

### Phase 4 — validate
- [ ] `yarn build` (stream with `tee`).
- [ ] `yarn lint` in packages/quereus (single-quote globs on Windows).
- [ ] `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`. Fix any fallout. Any failure
      clearly outside this diff → `tickets/.pre-existing-error.md` and proceed.

## Handoff honesty (for the reviewer)
- The new-capability coverage (`with defaults` on a CTE / subquery-in-FROM write target) is
  intentionally split into the prereq-chained `with-defaults-cte-subquery-targets` ticket — this
  ticket only proves the *move* (existing DDL sites keep working under the new spelling). Do not
  treat the absence of CTE/subquery defaults tests here as a gap.
- If `yarn test` wall-clock or the edit volume threatens the idle timeout (BUDGET_WARNING), split
  Phase 3's test migration into a same-stage prereq ticket and hand off Phases 1–2 with a green
  build for the touched packages, documenting exactly which test files still spell the old form.
