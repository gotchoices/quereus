description: When one open connection changes a shared table's definition, other connections on the same table currently have to be re-opened to see the change. Let them pick up the new definition automatically instead, the way SQLite re-prepares a statement after a schema change.
prereq: bug-schema-change-not-propagated-to-other-connections-catalog
architecture: docs/schema.md
files:
  - packages/quereus/src/schema/manager.ts        # per-Database catalog; SchemaChangeNotifier is per-Database only
  - packages/quereus/src/schema/change-events.ts  # SchemaChangeNotifier
  - packages/quereus-isolation/src/isolation-module.ts
tradeoffs: Two Database objects sharing one in-process module is mostly a test and embedding shape, and once the prerequisite guard lands the failure is loud rather than silent, so re-opening the connection may be an acceptable permanent answer.
---

# Context

Each `Database` keeps its own catalog. Two `Database` objects that register the same module instance share one physical table, but a DDL statement on one updates only its own catalog. The prerequisite ticket makes the other connection fail with `StatusCode.SCHEMA` when its catalog no longer matches the module's live row layout. This ticket is about making it *recover* instead of fail.

# Wanted behaviour

- A connection whose catalog entry is stale replaces it with the module's live definition and re-plans the statement, without the caller re-opening anything — at least for a statement that has not yet produced rows.
- Dependents in that connection's catalog that reference the table (views, materialized views, foreign keys, assertions, lens mappings) are revalidated the same way they would be after a local ALTER, and its cached prepared statements are invalidated.
- Drift the prerequisite guard does not detect is covered too. That guard (`packages/quereus/src/runtime/stale-catalog-guard.ts`) compares only column count, column names in order, generated-ness and the primary key, so all of the following go unnoticed today: a CHECK / FOREIGN KEY / UNIQUE or column NOT NULL another connection added or dropped (this connection's writes keep the old enforcement), a column type or collation change (this connection coerces and compares under the old one), and a changed DEFAULT (this connection writes the old default). Type and collation were left out because one `Database` briefly lets its own catalog lead the module on them (a materialized-view reshape registers a preview of the new types/collations while it validates), so a connect-time comparison cannot tell that window from a stale catalog; a broadcast trigger, or the engine marking that window, would let them be compared.
- A connection mid-transaction keeps today's isolation-layer answer when its staged rows cannot be carried forward (overlay poison → it must roll back). Open question: a connection whose staged rows migrate cleanly — should it adopt the new definition mid-transaction, or fail and require a rollback?

# Open questions

- Is the trigger a broadcast (module or a shared registry notifies every `Database` that registered it) or lazy (detected at connect, as the guard does today)? Lazy needs no new cross-`Database` channel; broadcast catches constraint-only changes the layout guard ignores.
- Which real deployments are exposed? Separate processes over one persistent store re-read the catalog from the store on open, but neither the catalog nor the module instance in a long-lived second process learns of the change — that case needs a store-level schema version, not an in-process notifier.
