description: Extend per-key `ADD TAGS` / `DROP TAGS` ergonomics to ALTER VIEW / ALTER MATERIALIZED VIEW / ALTER INDEX (symmetry with the ALTER TABLE add/drop verbs), so view / MV / index tags can also be touched per-key instead of whole-set `SET TAGS` only.
files:
  - packages/quereus/src/parser/parser.ts            # parseSetObjectTagsAction / alterView|MaterializedView|Index statements
  - packages/quereus/src/parser/ast.ts               # AlterObjectTagsAction — add merge/drop variants
  - packages/quereus/src/schema/manager.ts           # mergeViewTags/dropViewTags + MV + index variants
  - packages/quereus/src/runtime/emit/...            # ALTER VIEW/MV/INDEX SET TAGS emit path (wherever the object-tag action is emitted)
  - docs/sql.md                                      # §2.7 "SET TAGS on views, materialized views, and indexes" subsection
prereq: tag-mutation-add-drop-ergonomics
----

# ADD TAGS / DROP TAGS on views, materialized views, and indexes

## Why

`tag-mutation-add-drop-ergonomics` adds per-key `ADD TAGS (k = v)` (merge) and
`DROP TAGS (k)` (delete keys) to **ALTER TABLE** at the table / column / named-constraint
sites. The other tagged catalog objects — plain views, materialized views, and indexes —
still only support **whole-set** `SET TAGS` (shipped by the original tag-mutation work):

```sql
alter view v             set tags (…);   -- whole-set replace only
alter materialized view m set tags (…);  -- whole-set replace only
alter index ix           set tags (…);   -- whole-set replace only
```

For symmetry and the same "touch one key" ergonomics, these should also accept:

```sql
alter view v             add tags (cacheable = true);
alter view v             drop tags (purpose);
alter materialized view m add tags (owner = 'team-b');
alter materialized view m drop tags (legacy);
alter index ix           add tags (purpose = 'search');
alter index ix           drop tags (purpose);
```

## Scope / expectations

- Mirror the ALTER TABLE resolution exactly (set in the prereq ticket):
  - `ADD TAGS` = merge (set/overwrite listed keys, keep the rest); `DROP TAGS` = delete the
    listed keys; `DROP` of an absent key raises `NOTFOUND` atomically (drops nothing);
    dropping the last key(s) yields `tags IS NULL`; key matching is case-sensitive/verbatim.
  - `ADD TAGS` validates reserved `quereus.*` keys at the object's site (`view-ddl` for
    view/MV, `physical-index` for index) exactly as `SET TAGS` does; `DROP TAGS` does no value
    validation.
- AST: extend `AlterObjectTagsAction` (currently `{ type:'setTags'; tags }`) to a discriminated
  form carrying merge vs replace and a drop variant with `keys: string[]`, mirroring the
  ALTER TABLE shape from the prereq.
- Parser: `parseSetObjectTagsAction` (parser.ts ~2872) currently hard-codes `SET TAGS`; branch
  it on `SET` / `ADD` / `DROP` + `TAGS`, reusing the `parseTags` / `parseTagKeys` helpers.
- SchemaManager: add `mergeViewTags`/`dropViewTags`, `mergeMaterializedViewTags`/
  `dropMaterializedViewTags`, `mergeIndexTags`/`dropIndexTags`, reusing the `mutateTagRecord`
  core introduced in the prereq. Preserve the existing event semantics: view → `view_modified`,
  MV → `materialized_view_modified` (never re-materializes), index → `table_modified` on the
  owning table; hidden implicit covering structures stay NOTFOUND.
- Differ unchanged (stays on whole-set `SET TAGS`).
- Docs: extend the "SET TAGS on views, materialized views, and indexes" subsection of
  `docs/sql.md` §2.7 with the ADD/DROP forms.

## Edge cases & interactions (for the eventual implement ticket)

- DROP absent key on view/MV/index → NOTFOUND, atomic.
- ADD/DROP on an MV is a pure metadata write — must **not** re-materialize or touch the
  backing table (assert via row-count / no-rebuild, as the SET TAGS MV tests do).
- View/MV behavioral tag changes (`quereus.update.*`) via ADD/DROP must invalidate cached
  write-through plans (fire the right `*_modified` event), same as SET TAGS.
- `ALTER INDEX … ADD/DROP TAGS` on the auto-built covering structure of a UNIQUE constraint
  raises NOTFOUND (its tags live on the constraint).

This is a future-symmetry concern, not required by the original add/drop desired surface —
promote to `plan/` (or straight to `implement/`, since the design is fully determined by the
prereq) when prioritized.
