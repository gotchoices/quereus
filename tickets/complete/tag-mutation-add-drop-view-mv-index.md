description: ADD TAGS (merge) / DROP TAGS (delete) extension on ALTER VIEW / ALTER MATERIALIZED VIEW / ALTER INDEX — a pure-mechanical mirror of the shipped ALTER TABLE add/drop verbs. Catalog-only tag mutations, no new semantics. Build + lint + tests green; reviewed and accepted with minor inline fixes.
prereq:
files:
  - packages/quereus/src/parser/ast.ts                              # AlterObjectTagsAction → setTags(mode) | dropTags union
  - packages/quereus/src/parser/parser.ts                           # parseObjectTagsAction branches SET/ADD/DROP TAGS
  - packages/quereus/src/planner/nodes/set-object-tags-node.ts      # SetObjectTagsMutation; toString/getLogicalAttributes
  - packages/quereus/src/planner/building/set-object-tags.ts        # validate reserved on setTags only; thread mutation
  - packages/quereus/src/runtime/emit/set-object-tags.ts            # dispatch objectKind × op → set/merge/drop setter
  - packages/quereus/src/schema/manager.ts                          # update{View,MaterializedView,Index}Tags helpers + 6 merge*/drop* setters
  - packages/quereus/src/emit/ast-stringify.ts                      # objectTagsActionToString → set/add/drop forms
  - packages/quereus/test/logic/50-metadata-tags.sqllogic           # Phases 32–39
  - packages/quereus/test/schema-manager.spec.ts                    # unit tests for the 6 new setters
  - packages/quereus/test/parser.spec.ts                            # parse + 10-form round-trip
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts       # +3 ADD/DROP cache-invalidation tests (added in review)
  - docs/sql.md                                                     # §2.7 subsection + grammar block
  - docs/schema.md                                                  # differ + validation notes (corrected in review)
----

# Completed: ADD / DROP TAGS on views, materialized views, and indexes

Per-key `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete) are now accepted on
`ALTER VIEW`, `ALTER MATERIALIZED VIEW`, and `ALTER INDEX`, layered over the existing
whole-set `SET TAGS`. A verbatim mirror of the prereq `tag-mutation-add-drop-ergonomics`
(ALTER TABLE), reusing every shared primitive — no new semantics.

Semantics (identical to ALTER TABLE): `SET TAGS` = whole-set replace (empty `()` clears →
`tags IS NULL`); `ADD TAGS` = merge (empty `()` no-op, NOT a clear); `DROP TAGS` = atomic
per-key delete (every key must be present else `NOTFOUND` names the missing key(s) and
nothing drops; dropping the last key → `tags IS NULL`; empty `()` no-op). Keys matched
verbatim/case-sensitive. `SET`/`ADD` validate reserved `quereus.*` keys at the object's
site (view/MV → `view-ddl`, index → `physical-index`); `DROP` does no value validation. All
catalog-only — no module/data round-trip, no re-materialize.

## Review findings

Approach: read the implement diff (`ffd503aa`) cold, then traced every layer — AST union,
parser, plan node, builder, emitter dispatch, and the SchemaManager read-modify-write
refactor — against the established ALTER TABLE primitives (`mutateTagRecord`, `freezeTags`,
`TagCompute`). Verified all referenced APIs exist (`getView`/`getMaterializedView` are
case-insensitive), the differ is genuinely untouched (not in the commit), and the
hidden-vs-exposed implicit-index resolution. Ran lint + the full memory-backed suite.

**What was checked and the disposition by category:**

- **Correctness / SPP / DRY / modularity** — Clean. The `update{View,MaterializedView,Index}Tags`
  extraction is a faithful, DRY mirror of `updateTableTags`/`updateColumnTags`/`updateConstraintTags`;
  each preserves its prior event (`view_modified` / `materialized_view_modified` / `table_modified`)
  with the canonical stored `objectName`, and the `_modified` types stay distinct from the create
  events so MV maintenance does not re-register. Drop-of-absent NOTFOUND is computed before any swap
  on all three paths (atomic). Emitter dispatch tests `op === 'drop'` first for clean union narrowing.
  No findings.

- **Type safety / error handling / resource cleanup** — Clean. Discriminated unions on both
  `AlterObjectTagsAction` and `SetObjectTagsMutation`; no `any`; NOTFOUND surfaces from the setters
  for both missing-object and drop-of-absent-key. No new resources to release (pure in-memory catalog
  swap). No findings.

- **Test coverage** — Strong starting point (sqllogic Phases 32–39, schema-manager unit tests for all
  6 new setters, parser parse + 10-form round-trip). **One genuine gap, fixed inline (minor):** the
  implementer flagged that no test proved `ADD`/`DROP` of a `quereus.update.*` tag invalidates a
  *cached* write-through plan — the whole reason the `*_modified` events fire. Added three tests to
  `test/plan/view-tag-mutation-plan.spec.ts`: view `ADD TAGS` overwrite re-routes a cached insert,
  view `DROP TAGS` re-routes (to NULL), and an MV `ADD`-then-`DROP` re-routes (proving
  `materialized_view_modified` fires on both merge and drop). All pass. Suite now 5018 passing
  (was 5015), 9 pending.
  - *Aside surfaced while writing these:* a bare `integer` column is **NOT NULL** in Quereus, so the
    DROP-of-the-only-default tests use `created integer null` to make the post-drop omit yield a clean
    NULL rather than a constraint error. (Pre-existing engine behavior; not introduced here.)

- **Docs** — Read every touched + adjacent doc. `docs/sql.md` §2.7 was updated correctly by the
  implementer. **Two minor doc fixes applied inline in `docs/schema.md`:** (1) the imperative-validation
  note covered only `SET TAGS` for the sibling view/MV/index objects — extended to state `ADD TAGS`
  validates the same way and `DROP TAGS` does not; (2) corrected a **pre-existing inaccuracy** — the
  differ section claimed the view/MV setters fire "no event", but the code fires
  `view_modified`/`materialized_view_modified` (that is precisely what the new cache-invalidation tests
  exercise), and added the symmetric note that ADD/DROP are an imperative-only convenience the differ
  never emits.

- **Major findings → new tickets** — **None.** This change is additive and mechanically mirrors a
  shipped, reviewed pattern; no behavior outside the new verbs is affected.

**Verification (final):**
- `yarn workspace @quereus/quereus run lint` → EXIT 0
- `yarn workspace @quereus/quereus run test` → 5018 passing, 9 pending, 0 failing

**Documented deferrals (accepted, not findings):**
- `test:store` not run (out of ticket scope). View/MV/index tag ADD/DROP ride the same `*_modified`
  events `SET TAGS` uses; store persistence for index and view/MV tags is itself still pending under
  backlog tickets `store-secondary-index-persistence` / `store-view-mv-persistence` (per `docs/schema.md`),
  so this path is unchanged by ADD/DROP.
- `schema()` shows hidden implicit indexes (no `isHiddenImplicitIndex` exposure filter, unlike
  `catalog.ts`) — pre-existing behavior, not introduced here; Phase 38 sidesteps it by using a distinct
  index name. A separate concern if it is ever deemed a bug.
- MV tags are not introspectable from SQL (`schema()` does not enumerate MVs), so MV sqllogic phases
  assert data-unchanged; MV tag-value assertions live in `schema-manager.spec.ts` via `getMaterializedView`.
- The differ remains intentionally whole-set `SET TAGS` only; ADD/DROP are imperative-only.
