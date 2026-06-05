description: Direct `CREATE TABLE … WITH TAGS` (and column / named-constraint `WITH TAGS`) does not route its `quereus.*` tags through the reserved-tag registry, so a misspelled or mis-sited reserved key is silently stored at create time — whereas the declarative differ and `ALTER TABLE … SET TAGS` both reject it. Make the direct-CREATE path consistent.
files:
  - packages/quereus/src/schema/manager.ts            # buildTableSchemaFromAST / buildColumnSchemas / extractCheckConstraints / extractUniqueConstraints / extractForeignKeys — where create-time tags are frozen
  - packages/quereus/src/schema/reserved-tags.ts      # validateReservedTags + TagSite
  - packages/quereus/src/schema/reserved-tags-policy.ts # raiseReservedTagDiagnostics
  - packages/quereus/src/planner/building/create-table.ts  # likely plan-build validation site (mirror alter-table.ts setTags arm)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic   # add CREATE-time reserved-tag rejection cases
----

# Validate reserved `quereus.*` tags on the direct CREATE TABLE path

## Why

`10-alter-table-tag-mutation` routed `ALTER TABLE … SET TAGS` through
`validateReservedTags(tags, site)` at plan-build, matching the declarative differ
(`computeSchemaDiff`), the lens-compile path, and the view-mutation path — a
misspelled or mis-sited reserved key (e.g. `"quereus.update.taget"`,
`"quereus.bogus"`) now fails loudly.

The **direct** `CREATE TABLE … WITH TAGS` path was deliberately left out of that
ticket's scope and still does **not** validate. Confirmed at review time:

```sql
create table t (id integer primary key) with tags ("quereus.bogus" = 1);          -- ACCEPTED (should reject)
create table t2 (id integer primary key, x integer with tags ("quereus.bogus" = 1)); -- ACCEPTED (should reject)
```

So the same key is rejected by `SET TAGS` / `apply schema` but silently stored by
`CREATE TABLE`. This asymmetry means a typo'd reserved key can enter the catalog
through the most common authoring path and never surface until (if ever) a
consumer looks for the correctly-spelled key.

## Desired behavior

Route every `quereus.*` tag declared at `CREATE TABLE` time through
`validateReservedTags` at the matching site — `physical-table` (table-level
`WITH TAGS`), `physical-column` (column `WITH TAGS`), `physical-constraint`
(named table-level constraint `WITH TAGS`) — and raise via the shared
`raiseReservedTagDiagnostics` policy helper, exactly as the ALTER and declarative
paths do. Free-form (non-`quereus.*`) tags are unaffected.

## Notes / open questions

- **Where to validate** — plan-build (mirror `planner/building/alter-table.ts`'s
  `setTags` arm and `building/create-table.ts`) is the natural site so the error
  carries source location; `SchemaManager.buildTableSchemaFromAST` is the
  catch-all but runs without AST location context. Prefer the planner site.
- **Index / view CREATE** — `WITH TAGS` on `CREATE INDEX` / `CREATE VIEW` shares
  the same gap; decide whether to fix all physical-DDL CREATE sites in one pass
  (`physical-index`, `view-ddl`) for full parity with the differ.
- **Regression risk** — this *starts rejecting* schemas that previously parsed.
  That is the intended correctness fix (a stored typo is a latent bug), but call
  it out: any test fixture or sample carrying a bogus `quereus.*` create-time tag
  will now fail and must be corrected.
