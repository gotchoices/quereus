description: In autocommit, the rows of an insert's `values` list are evaluated before the insert starts its implicit transaction, so a module function that answers from the open transaction (Optimystic's `StampId()`) sees none; a write statement should begin its transaction before any of its instructions run, or modules should be able to begin it themselves.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/core/database.ts (`Database._executeSingleStatement`, `Database._ensureTransaction`), packages/quereus/src/core/database-transaction.ts (`TransactionManager.ensureTransaction`), packages/quereus/src/runtime/emit/dml-executor.ts (`runInsert`, `runUpdate`, `runDelete` — each starts the implicit transaction), packages/quereus/src/core/database-internal.ts (`DatabaseInternal`)
repro: verified
----

# A write statement begins its transaction before evaluating it

Filed from Optimystic, where it blocks `stampid-answers-inside-an-autocommit-write` (Optimystic ticket `quereus-begins-a-write-statements-transaction-before-evaluating-it`, in that repo's `tickets/blocked/`).

## What happens today

Measured on Optimystic's linked build of this repo, tracing the scheduler, `_ensureTransaction` and the Optimystic connection's `begin`:

```
insert into t (id, body) values (StampId(), 'a')    -- autocommit, table t already connected
  StampId() evaluated  -> null        (stack: scalar-function run ← Scheduler.runSyncLoop ← _executeSingleStatement)
  _ensureTransaction                  (from runInsert)
  connection.begin                    (the module opens its transaction here)
  -> NOT NULL constraint failed: t.id
```

The rows of a `values` list are synchronous scheduler instructions feeding the insert instruction, so they run before `runInsert` reaches its lazy transaction start (`await ctx.db._ensureTransaction()`). An `insert … select` works, because its rows are pulled inside `runInsert`, after the transaction began.

| statement, autocommit | result |
|---|---|
| `insert into t (id, body) values (StampId(), 'a')` | NOT NULL refusal (`id` is NULL) |
| `insert into t (id, body) values (StampId(), 'm1'), ('fixed', 'm2')` | NOT NULL refusal |
| `insert into t (id, body) select StampId(), 'sel'` | stores the stamp |
| the first, inside `begin … commit` | stores the stamp |
| the first, into a nullable column | stores NULL silently |

Any module function that answers from the transaction the engine has open behaves this way; the order in which a statement's expressions and its transaction start run is not something a module author can see or rely on today.

## Proposed capability

**Recommended.** In autocommit mode, a statement that writes (its plan contains an insert, update or delete, or a `returning` form of one) begins its implicit transaction before any of its instructions run, so every expression it evaluates, `values` rows included, runs inside that transaction. The `_ensureTransaction()` calls in the DML emitters stay and become no-ops for such a statement. A read-only statement is unchanged. The implicit transaction still ends when the statement ends, committing or rolling back as today. Document the guarantee in docs/module-authoring-transactions.md.

**Alternative**, if the first is not wanted: `DatabaseInternal.ensureTransaction(): Promise<void>`, beside `registerConnection` and `getConnectionsForTable`. In autocommit it begins the implicit transaction that the current statement's end will finish; inside a transaction it does nothing. Valid only while a statement executes (`_isExecuting()`); an async scalar function may call it. `_ensureTransaction` does this today but is `@internal`, and the build's `stripInternal` removes it from the published types. A prototype in Optimystic calling it through a cast fixed every row of the table above, and a `select StampId()` in autocommit answered a fresh stamp per statement with `getAutocommit()` true again afterwards. Cost: every module with such a function has to call it, and each read-only statement that evaluates one opens and commits an empty transaction.

Rejected: leaving it to modules to document "use `insert … select` or an explicit transaction" — that is what happens if nothing is done, and it leaves a silent NULL for nullable columns.

Reversibility: neither option changes stored data. The first changes when `begin` reaches connections for write statements in autocommit (earlier, before row evaluation); a module that relies on `begin` arriving after its own `values` expressions were evaluated would notice — check the engine's own modules and the conformance harness for that.

## Test sketch

- A scalar function registered by a test module that records whether a transaction is open when it runs; `insert … values (fn(), …)` in autocommit sees one, with single and multi-row `values`, upsert, and `returning`.
- Same for `update … set c = fn()` and `delete … where c = fn()`.
- A read-only `select fn()` in autocommit still sees no transaction and leaves `getAutocommit()` true.
- A write statement that fails before its first row still rolls its implicit transaction back.
