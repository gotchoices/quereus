description: Per-key metadata-tag ergonomics — `ALTER … ADD TAGS (k = v)` and `ALTER … DROP TAGS (k)` so a single tag can be added/changed/removed without restating the whole set (the v1 `SET TAGS` is whole-set-replace only).
files:
  - packages/quereus/src/parser/parser.ts            # alterTableStatement / alterColumnAction
  - packages/quereus/src/parser/ast.ts               # AlterTableAction (extend setTags or add addTags/dropTags)
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/planner/nodes/alter-table-node.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/schema/manager.ts           # merge/delete-key variants of the tag setters
  - docs/sql.md                                       # §2.7 SET TAGS subsection
----

# ALTER TABLE … ADD TAGS / DROP TAGS — per-key tag ergonomics

## Why

`10-alter-table-tag-mutation` shipped `ALTER TABLE … SET TAGS (…)` as the single
tag primitive: **whole-set replacement** at the table / column / named-constraint
sites (an empty list clears). That is the right minimal v1 and maps 1:1 onto the
declarative differ's "emit the full desired set" target, but it is ergonomically
awkward for the common interactive case of *touch one key*: you must restate
every existing tag to add or change one, and there is no way to drop a single key
at all (since `null` is a legal stored tag value, `set k = null` cannot mean
"remove `k`").

## Desired surface

```sql
alter table t add tags (audit = true);                         -- merge: set/overwrite `audit`, keep the rest
alter table t alter column c add tags (searchable = true);     -- merge on a column
alter table t alter constraint uq add tags (msg = 'dup');      -- merge on a named constraint
alter table t drop tags (audit, legacy);                       -- delete listed keys (no-op if absent? or error?)
```

Open design questions to resolve during planning:

- **DROP of an absent key** — silent no-op vs `NOTFOUND`. (Whole-set `SET TAGS`
  has no analogue; pick a rule and document it.)
- **AST shape** — extend the existing `setTags` action with a `mode:
  'replace' | 'merge' | 'drop'`, or add sibling `addTags` / `dropTags` variants.
  Merge/drop both need a SchemaManager helper that reads-modifies-writes the
  current frozen tag record (the v1 setters take the full record).
- **Reserved-tag validation** — `ADD TAGS` validates the added keys at the
  matching site exactly as `SET TAGS` does; `DROP TAGS` removes by key and needs
  no value validation.
- **Declarative differ** — stays on whole-set `SET TAGS` (it already computes the
  full desired set); ADD/DROP are an imperative-only convenience and need not be
  emitted by `generateMigrationDDL`.

## Non-goals

No change to the whole-set `SET TAGS` semantics or to the differ's drift
detection — this is purely additive sugar over the existing catalog-only swap.
