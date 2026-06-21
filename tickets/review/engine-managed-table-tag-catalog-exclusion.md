description: Add a reserved tag that lets the engine mark a table as engine-owned so the "apply schema" / "diff schema" comparison ignores it instead of trying to drop it.
files:
  - packages/quereus/src/schema/reserved-tags.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/schema/reserved-tags.spec.ts
  - packages/quereus/test/schema/catalog.spec.ts
----

## Implementation summary

The full change is committed (as part of `e1b06c30`). All five files were modified; no other files were touched.

### What was added

**`reserved-tags.ts`**
- `ENGINE_MANAGED_TABLE_TAG = 'quereus.engine_managed'` exported with a full doc comment
- A `ReservedTagSpec` entry: `sites: ['physical-table']`, `valueSchema: 'boolean'`
- `quereus.engine_managed` included in the `unknownReservedTag` suggestion string
- `RESERVED_TAGS` length is now 20

**`catalog.ts`**
- `isEngineManagedTable(tableSchema)` helper → `tableSchema.tags?.[ENGINE_MANAGED_TABLE_TAG] === true`
- `collectSchemaCatalog`'s table loop `continue`s when `isEngineManagedTable` — placed before the maintained/isView branches so it is unconditionally excluded

**`index.ts`**
- `ENGINE_MANAGED_TABLE_TAG` re-exported alongside `SYNC_REPLICATE_TAG` etc.

### Tests (both new, passing)

**`reserved-tags.spec.ts`** — `quereus.engine_managed (boolean, table-only)`:
- Accepts boolean at `physical-table`; rejects non-boolean; rejects non-table sites; flags typo as `unknown-reserved-tag`
- Updated RESERVED_TAGS length assertion from 19 → 20; added `quereus.engine_managed` to the key-list check

**`catalog.spec.ts`** — engine-managed exclusion:
- `engine_managed = true` table excluded from `collectSchemaCatalog` but still resolvable via `getTable`
- `engine_managed = false` table stays included

### Validation

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/schema/reserved-tags.spec.ts" \
  "packages/quereus/test/schema/catalog.spec.ts" \
  "packages/quereus/test/schema-differ.spec.ts" \
  "packages/quereus/test/exports.spec.ts" \
  "packages/quereus/test/declarative-equivalence.spec.ts"
→ 299 passing
```

## Known gaps / reviewer focus

- The exclusion is at `collectSchemaCatalog` time (before the differ). This is intentional and mirrors how `expose_implicit_index` works in the differ's `actualIndexes` filter — but at a different layer. The reviewer should verify this is the right cut point (i.e. that no other `collectSchemaCatalog` consumer should see engine-managed tables).
- `getTable` / `getAllTables` still return engine-managed tables — confirmed intentional (the lens compiler needs to resolve them). The reviewer should confirm no other catalog consumer would benefit from exclusion.
- No `export_schema` test. The ticket description says engine-managed tables are omitted from `export_schema`; the implementation achieves this via `collectSchemaCatalog` exclusion, but there is no dedicated `export_schema` test. The reviewer may want to add one.
- Cross-repo consumer (lamina `quereus-lens-member-relations-basis-catalog`) stamps `ENGINE_MANAGED_TABLE_TAG` on basis member relations and has an e2e `lens-basis-inplace-reapply-keeps-members-e2e.test.ts`. That test lives in the lamina repo and is not covered here.
