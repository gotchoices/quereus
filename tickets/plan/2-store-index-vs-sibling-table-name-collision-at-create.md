description: The flat store-naming scheme `{schema}.{table}_idx_{index}` can collide at CREATE time — if table `t` has a real index named `archive` AND a sibling table is named exactly `t_idx_archive`, both map to the same physical store `main.t_idx_archive`. The sibling-prefix-scan fix does NOT resolve this; it needs CREATE-time collision detection or an unambiguous naming/encoding scheme.
files:
  - packages/quereus-store/src/common/key-builder.ts     # buildIndexStoreName / buildDataStoreName / STORE_SUFFIX
  - packages/quereus-store/src/common/store-module.ts     # createTable / createIndex — where a collision check would live
  - packages/quereus-plugin-leveldb/src/provider.ts       # on-disk dir naming mirrors the same scheme
  - packages/quereus-plugin-indexeddb/src/provider.ts
----

# Physical store-name collision between a real index and a same-named sibling table

## The structural ambiguity

Store names are built by string concatenation with a `_idx_` delimiter that is itself a
legal substring of any identifier:

- data store:  `buildDataStoreName(schema, table)`  → `{schema}.{table}`
- index store: `buildIndexStoreName(schema, table, index)` → `{schema}.{table}_idx_{index}`

So these two distinct logical objects produce the **same** physical store name:

| logical object                               | physical store name      |
|----------------------------------------------|--------------------------|
| index `archive` on table `t`                 | `main.t_idx_archive`     |
| data store of table named `t_idx_archive`    | `main.t_idx_archive`     |

The `store-name-prefix-collision-sibling-tables` fix closed the *prefix-scan* hole (a
sibling being wrongly swept when `t` is renamed/dropped) by passing an authoritative
index-name list to the providers. It does **not** close this CREATE-time collision: if
both objects are created, they share one physical store and silently corrupt each other.

## Why the prior fix doesn't cover it

The authoritative-index-list approach makes rename/drop touch *exactly* the named index
stores — but when the index name and the sibling table name resolve to the same physical
name, "exactly the named store" still hits the sibling's storage. The ambiguity is in the
naming scheme, not in the discovery logic.

## Possible directions (decide during plan)

- **CREATE-time collision detection** — when creating an index, reject if its computed
  store name equals an existing table's data store name (and vice-versa when creating a
  table). Cheapest; user-visible error instead of corruption.
- **Unambiguous encoding** — escape/separate the table and index components so no
  table name can collide with a `{table}_idx_{index}` form (e.g. length-prefixing,
  reserved delimiter that is escaped in identifiers, or separate namespaces/sub-dirs for
  data vs index stores). More invasive; also resolves the `invalidateCache` prefix issue.

## Acceptance

- Creating index `archive` on `t` while a table named `t_idx_archive` exists (or the
  reverse order) does not let the two share physical storage — either rejected with a
  clear error or stored under non-colliding names.
- Regression test for both creation orders across at least the in-memory and one
  persistent provider.
