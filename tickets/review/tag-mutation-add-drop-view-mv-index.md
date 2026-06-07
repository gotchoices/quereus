description: Review the ADD TAGS (merge) / DROP TAGS (delete) extension on ALTER VIEW / ALTER MATERIALIZED VIEW / ALTER INDEX. Implemented as a pure-mechanical mirror of the shipped ALTER TABLE add/drop verbs — catalog-only tag mutations, no new semantics. Build + lint + tests green.
prereq:
files:
  - packages/quereus/src/parser/ast.ts                              # AlterObjectTagsAction → setTags(mode) | dropTags union
  - packages/quereus/src/parser/parser.ts                           # parseObjectTagsAction (renamed) branches SET/ADD/DROP TAGS
  - packages/quereus/src/planner/nodes/set-object-tags-node.ts      # SetObjectTagsMutation; toString/getLogicalAttributes
  - packages/quereus/src/planner/building/set-object-tags.ts        # validate reserved on setTags only; thread mutation
  - packages/quereus/src/runtime/emit/set-object-tags.ts            # dispatch objectKind × op → set/merge/drop setter
  - packages/quereus/src/schema/manager.ts                          # update{View,MaterializedView,Index}Tags helpers + 6 merge*/drop* setters
  - packages/quereus/src/emit/ast-stringify.ts                      # objectTagsActionToString → set/add/drop forms
  - packages/quereus/test/logic/50-metadata-tags.sqllogic           # Phases 32–39
  - packages/quereus/test/schema-manager.spec.ts                    # unit tests for the 6 new setters
  - packages/quereus/test/parser.spec.ts                            # parse + 10-form round-trip
  - docs/sql.md                                                     # §2.7 subsection + grammar block
----

# Review: ADD / DROP TAGS on views, materialized views, and indexes

## What landed

Per-key `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete) are now accepted on
`ALTER VIEW`, `ALTER MATERIALIZED VIEW`, and `ALTER INDEX`, layered over the existing
whole-set `SET TAGS`. This is a verbatim mirror of the prereq `tag-mutation-add-drop-ergonomics`
(ALTER TABLE), reusing every shared primitive — no new semantics were invented.

Semantics (identical to ALTER TABLE):
- `SET TAGS` = whole-set replace; empty list `()` clears (`tags IS NULL`).
- `ADD TAGS` = merge: set/overwrite listed keys, keep the rest; empty `()` is a **no-op**
  (distinct from `SET TAGS ()`).
- `DROP TAGS` = delete listed keys, **atomic**: every key must currently be present else a
  `NOTFOUND` names the missing key(s) and nothing is dropped; dropping the last key → `tags IS NULL`;
  empty `()` is a no-op.
- Keys matched **verbatim / case-sensitive**.
- `SET`/`ADD` validate reserved `quereus.*` keys at the object's site (view/MV → `view-ddl`,
  index → `physical-index`); `DROP` does **no** value validation (dropping a reserved key is legit).
- All catalog-only — no module/data round-trip, no re-materialize. MV ADD/DROP never touches
  the backing table.

## How it's wired (layer by layer)

- **AST**: `AlterObjectTagsAction` became `{type:'setTags'; mode:'replace'|'merge'; tags} | {type:'dropTags'; keys}`
  (no `target` field — the object is the statement's own `name`).
- **Parser**: `parseSetObjectTagsAction` → `parseObjectTagsAction`, branching the leading keyword.
  No `(` look-ahead guard needed (after `ALTER VIEW <name>` only a tag op is legal).
- **Plan node**: carries `SetObjectTagsMutation` (`{op:'replace'|'merge'; tags} | {op:'drop'; keys}`);
  `toString()` renders SET/ADD/DROP TAGS; `getLogicalAttributes()` surfaces `op` + `tags`/`keys`.
- **Builder**: `setTags` (replace+merge) → reserved-tag validation then `{op:mode, tags}`;
  `dropTags` → no validation, `{op:'drop', keys}`.
- **SchemaManager**: extracted `updateViewTags` / `updateMaterializedViewTags` / `updateIndexTags`
  read-modify-write helpers (each preserving its prior event + guards) from the old inline
  `set*Tags`, then expressed `set*`/`merge*`/`drop*` (9 public setters) over them + the existing
  `mutateTagRecord` / `freezeTags`. The 6 new setters are `mergeViewTags`/`dropViewTags`,
  `merge/dropMaterializedViewTags`, `merge/dropIndexTags`.
- **Emit**: dispatches `objectKind × op` to the matching setter (drop-op tested first for clean
  TS narrowing of the union); `note` includes the op.
- **ast-stringify**: shared `objectTagsActionToString` → `set tags` / `add tags` / `drop tags`.

## Verification performed (the floor, not the ceiling)

- `yarn workspace @quereus/quereus run build` → EXIT 0
- `yarn workspace @quereus/quereus run lint` → EXIT 0
- `yarn workspace @quereus/quereus run test` → 0 failing (5015 passing, 9 pending)

Test coverage added:
- **sqllogic Phases 32–39** (`50-metadata-tags.sqllogic`): ADD/DROP merge+delete on view (32),
  index (33), MV no-rebuild (34); empty-list ADD/SET/DROP distinction on the view kind (35);
  ADD validates reserved + DROP allows dropping a reserved key, view + index (36); hidden
  implicit covering index NOTFOUND for ADD/DROP (37); exposed implicit index addressable (38);
  NOTFOUND object for all three kinds × ADD/DROP (39).
- **schema-manager.spec.ts**: merge/drop unit tests for all three kinds — overwrite-keeps-rest,
  empty no-op, drop-keeps-rest, drop-last→undefined, drop-absent→atomic NOTFOUND, NOTFOUND
  object, MV bodyHash-unchanged, hidden vs exposed implicit index.
- **parser.spec.ts**: parse for all SET/ADD/DROP × view/MV/index (incl. empty-list shapes),
  a non-SET/ADD/DROP verb rejection, and a 10-form round-trip through `astToString` (incl. a
  quoted `"quereus.id"` key to confirm key quoting).

## Things for the reviewer to probe (known gaps / non-obvious points)

- **No dedicated behavioral-invalidation test for ADD/DROP.** The ticket said a behavioral test
  beyond the existing SET-TAGS coverage was "not required, but note it." I did **not** add a test
  proving that an `ADD`/`DROP` of a `quereus.update.*` tag invalidates a cached write-through plan.
  This rides entirely on the extracted `update*Tags` helpers firing the same `view_modified` /
  `materialized_view_modified` / `table_modified` events that `set*Tags` fired before — structurally
  guaranteed by construction, but unproven by a new test. Worth a skeptical look at the three
  helpers to confirm each preserves its event (canonical stored-name `objectName`, distinct
  `_modified` type so MV maintenance does NOT re-register).
- **`schema()` shows hidden implicit indexes.** The `schema()` TVF iterates `tableSchema.indexes`
  **without** the `isHiddenImplicitIndex` exposure filter (unlike `catalog.ts`). This is
  pre-existing behavior, not introduced here, but it bit the first draft of Phase 38: a UNIQUE
  constraint named `uq_vin` already exists (Phase 23 `RsvInlineUq`), so `schema() WHERE name='uq_vin'`
  returned 2 rows. Phase 38 now uses `uq_expo_vin` to avoid the collision. If a reviewer thinks
  `schema()` *should* hide unexposed implicit indexes, that's a separate concern outside this ticket.
- **test:store NOT run** (per ticket scope). View/MV/index tag ADD/DROP ride the same
  `*_modified` events SET TAGS uses, which the generic store already subscribes to for recovery,
  so the store path is believed covered — but this was not exercised. A store-specific run
  (`yarn test:store`) would confirm tag ADD/DROP survive reconnect for store-backed schemas.
- **The differ is intentionally unchanged.** `schema-differ.ts` still emits whole-set `SET TAGS`
  only (it computes the full desired set); ADD/DROP are imperative-only. Confirm no reviewer
  expectation that the differ learn merge/drop.
- **MV tags are not introspectable from SQL.** `schema()` does not enumerate materialized views
  (only their backing tables, which are filtered out of the user catalog), so the MV sqllogic
  phases assert *data unchanged* (no rebuild) rather than tag values; the tag-value assertions for
  MV live in `schema-manager.spec.ts` via the `getMaterializedView` API + `bodyHash`.
- **EXPLAIN attribute shape** (`getLogicalAttributes` now emits `op` + `tags`/`keys`) is not
  directly asserted by any test — low risk, but unverified.
