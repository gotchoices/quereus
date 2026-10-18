description: An index declared on a materialized view (a "maintained" table) inside `declare schema` gets created on the first apply, but the schema comparison never sees it, so every later diff asks to create it again and a second apply fails with "index already exists".
architecture: docs/schema.md
files: packages/quereus/src/schema/catalog.ts (`collectSchemaCatalog`, maintained-table branch ~283), packages/quereus/src/schema/schema-differ.ts (index loop in `computeSchemaDiff`)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Maintained tables' internal covering indexes must stay hidden from the differ, so the fix has to tell user-declared indexes apart from engine-built ones on those tables; a maintainer may prefer to reject user indexes on maintained tables at declare time instead.
----
# Declared index on a maintained table never converges

## Observed

```sql
declare schema main {
	table src { id integer primary key, v integer }
	table m { id integer primary key, v integer } maintained as select id, v from src
	index m_v on m (v)
}
apply schema main   -- ok; m_v exists on the live table
diff schema main    -- still: create index m_v on m (v)
apply schema main   -- fails: Failed to execute DDL: create index m_v on m (v)
```

Also: a plain `create index m_v2 on m (v)` on a maintained table is invisible to `diff schema`, so a declaration that omits it never proposes a drop.

## Cause

`collectSchemaCatalog` (`packages/quereus/src/schema/catalog.ts`) pushes a maintained table and `continue`s before the per-table index loop, so none of its indexes reach `catalog.indexes`. The comment there says this hides the *internal covering* indexes, but it hides user-created ones too.

## Expected

A user-declared index on a maintained table behaves like one on a plain table: it appears in the catalog, re-diff is empty after apply, and an index dropped from the declaration produces `DROP INDEX`. The engine-built covering structures stay out of the catalog (they're filtered the same way implicit unique-constraint indexes are today via `displayIndexesForTable`). The alternative is to reject `index … on <maintained table>` in `declare schema` with a clear error.

Found during review of apply-schema-creates-indexes-before-added-columns; `test/apply-schema-index-order.spec.ts` ("indexes a column added to a maintained table…") reads the live table's indexes instead of the catalog because of this bug.
