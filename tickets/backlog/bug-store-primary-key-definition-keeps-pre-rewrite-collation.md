description: When the store module re-collates an undecorated text primary-key column to its table key collation (NOCASE by default), it updates the column but leaves the table's primary-key definition saying BINARY, so engine code that reads the key's collation from the definition compares keys under the wrong collation.
architecture: docs/schema.md
files: packages/quereus-store/src/common/store-module-schema-rewrite.ts (`reconcilePkCollations`), packages/quereus/src/vtab/index-descriptor.ts (`primaryKeyDescriptor`), packages/quereus/src/runtime/emit/dml-executor.ts (~line 470, `pkEventComparators`), packages/quereus-isolation/src/isolated-table.ts (`constraintComparator`, ~line 864)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The store itself keys from the column collation and every planner collation check now reads the column too, so the stale field only reaches consumers that read `primaryKeyDefinition[].collation`; changing what the store persists touches the DDL and materialized-view shape comparisons, which may not be worth it if those consumers are rerouted instead.
----
## What is wrong

`reconcilePkCollations` (store module, run at CREATE through `normalizeCreateSchema`) rewrites an undecorated text primary-key column's `collation` to the table key collation K (NOCASE by default). It returns `{ ...schema, columns, columnIndexMap }` and does not touch `primaryKeyDefinition`, whose members were built from the column's pre-rewrite collation (`findPKDefinition` copies `columns[i].collation || 'BINARY'`). After CREATE, for `create table t (k text primary key) using store`, the column says NOCASE and `primaryKeyDefinition[0].collation` says BINARY.

The store reads key collations from the columns (`resolvePkKeyCollations(pkDef, columns, …)`), so its own storage is consistent. The planner's collation checks in `rule-select-access-path.ts` (`resolveIndexKeyCollations`) read the column too, deliberately, for this reason. Two engine-side consumers read the definition:

- **Isolation overlay window filter.** `primaryKeyDescriptor` copies `primaryKeyDefinition[].collation` into the `_primary_` access path. `IsolatedTable.constraintComparator` prefers the descriptor's key collation, so a staged overlay row is matched against a primary-key seek window under BINARY while the underlying store matched committed rows under NOCASE. Expected effect: inside a transaction over an isolated store table, `insert into t values ('ALICE')` then `select * from t where k = 'alice'` (a NOCASE comparison, since the column is NOCASE; the planner adds no re-check for a MATCH) misses the staged row.
- **Data-change event relocation test.** `dml-executor.ts` builds `pkEventComparators` from `primaryKeyDefinition[].collation`, so `update t set k = 'APPLE' where k = 'apple'` on that table would be reported as delete-at-old-key plus insert-at-new-key, though the row never left its NOCASE slot (the comment there names exactly this case as the one to avoid).

## How to confirm

Neither arm has been run. An isolation-over-store test (beside `store-semantic-index-window-overlay` in the isolation layer's specs) with an undecorated text primary key, a staged row differing only in case, and an equality read inside the same transaction confirms the first arm; a data-change subscription on a store table receiving a case-only key update confirms the second. `schema/table.ts` documents `primaryKeyDefinition` as what `table_info`, key extraction and the DDL generator read, so check whether any of those report BINARY for such a key.

## Expected behaviour

After CREATE, a primary-key member's `collation` in `primaryKeyDefinition` equals its column's `collation`, on every backend. The likely single site is `reconcilePkCollations` rewriting both together (as `rekeySchemaPrimaryKey` in `schema/table.ts` already does for ALTER PRIMARY KEY); check that persisted-DDL round trips and the materialized-view backing-shape comparison still agree afterwards.
