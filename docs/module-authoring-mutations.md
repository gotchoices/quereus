# Module Mutation Statements

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The `wantStatements` opt-in: the literal, fully resolved `mutationStatement` SQL the engine passes with each `update()` call, its format, its determinism guarantees, and replay at the module boundary. A satellite of [Virtual Table Module Authoring Guide](module-authoring.md).

## Mutation Statements

Virtual table modules can opt-in to receive deterministic mutation statements for each row-level operation. This enables replication, audit logging, and change data capture with guaranteed reproducibility.

### Overview

When a module sets `wantStatements: true`, Quereus provides a `mutationStatement` string with each `update()` call. This statement:

- Represents the **bottom-level mutation** at the VirtualTable.update() level (not the top-level DML statement)
- Contains all values as **literals** (no parameters; non-deterministic source expressions like `random()` or `datetime('now')` are already resolved to the concrete per-row values the engine evaluated)
- Includes **resolved mutation context** values as literals in the WITH CONTEXT clause
- Is the **audit / transport encoding** of the resolved per-row primitive that hit the module; replay is the act of applying that primitive at the same module boundary on another instance — not re-parsing the captured SQL through the full DML pipeline (re-execution would re-fire CHECKs, default evaluation, and generated-column computation, which is explicitly not the supported replay path)

### Module Opt-In

Modules enable mutation statements by setting a property:

```typescript
class MyReplicatedTable extends VirtualTable {
  // Opt-in to mutation statements
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // args.mutationStatement contains the deterministic SQL statement
    if (args.mutationStatement) {
      await this.replicationLog.append(args.mutationStatement);
    }

    // Perform the actual mutation
    return this.performUpdate(args);
  }
}
```

### Statement Format

Mutation statements use Quereus SQL syntax with all values as literals:

**INSERT Example:**
```sql
-- Original statement with parameters
insert into orders (id, amount) values (:id, :amount)

-- Logged mutation statement (per row)
insert into orders (id, amount) values (1, 100)
```

**INSERT with Mutation Context:**
```sql
-- Original statement
insert into orders (id, amount, created_at)
with context now = datetime('now')
values (1, 100, now)

-- Logged mutation statement (context resolved to literal)
insert into orders (id, amount, created_at) with context now = '2024-01-15T10:30:00Z' values (1, 100, '2024-01-15T10:30:00Z')
```

**UPDATE Example:**
```sql
-- Original statement
update users set name = :newName where id = :userId

-- Logged mutation statement (per row)
update users set name = 'Alice' where id = 1
```

**DELETE Example:**
```sql
-- Original statement
delete from sessions where user_id = :userId

-- Logged mutation statement (per row)
delete from sessions where user_id = 42 and session_id = 'abc123'
```

### Determinism Guarantees

The mutation statement system ensures determinism by:

1. **Resolving Execution Parameters**: All `:name` and `?` parameters are replaced with their literal values
2. **Resolving Mutation Context**: All context variables are evaluated once per statement and emitted as literals
3. **Resolving Defaults / Generated Columns**: DEFAULT and `GENERATED ALWAYS AS` expressions are evaluated per row and emitted as literal values — this is true even when the source expressions contain non-deterministic functions (allowed under `pragma nondeterministic_schema = true`; see [Determinism Validation](determinism.md))
4. **Preserving Order**: Mutations are logged in the order they're applied to the virtual table

Replay then means: take the captured primitive and re-apply it at the module boundary (e.g. feed `mutationStatement` rows back through `vtab.update()` on the replica), not re-execute the SQL through the full DML pipeline. The atomicity of the original commit — including deferred CHECKs that were evaluated once at commit time — is preserved by replaying the transaction's writes as a unit.

### Use Cases

**Replication:**
```typescript
class ReplicatedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Send mutation to replicas
    await this.replicator.broadcast(args.mutationStatement!);

    // Apply locally
    return this.storage.update(args);
  }
}
```

**Audit Logging:**
```typescript
class AuditedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Log mutation with timestamp and user
    await this.auditLog.record({
      timestamp: Date.now(),
      user: this.currentUser,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

**Change Data Capture:**
```typescript
class CDCTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Publish change event
    await this.eventBus.publish({
      table: this.tableName,
      operation: args.operation,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

The database-level event system a module feeds — `getEventEmitter()`, the auto-event path,
transaction batching, and the row-shape / table-name / row-key contract across mid-transaction
ALTER — is documented separately in [Database-Level Event System](module-events.md).

**A module that raises its own data-change events owes two more guarantees**, on top of the
as-of-delivery ones above. A module without an emitter owes nothing here: the engine's
auto-event path produces both for it.

- **`key` is the primary key projected out of the event's own row image** — out of `newRow` for
  an `insert` and an `update`, out of `oldRow` for a `delete`. Never the pre-image key of an
  update, and never a key your storage layer normalized away from the values the row holds.
- **An `update` event never moves a row.** If a write relocates a row — its key values differ
  under the primary key's own comparator, which is per-column collation- and type-aware, not
  byte identity — emit a `delete` at the old key followed by an `insert` at the new key, in
  that order, instead of one `update`. Test relocation with the same comparator (or the same
  encoded key) your storage uses to address rows, never raw value equality: under a `NOCASE`
  key, rewriting `'apple'` to `'APPLE'` moves nothing and stays a single `update`, keyed by
  the post-image. Consumers are promised the ordering but **not** adjacency, so you may
  interleave other events between the pair.

Both are what lets a listener retire a row's old identity without knowing which columns form
the key — see [Event System § Subscribing to Data Changes](usage-events.md#subscribing-to-data-changes).
