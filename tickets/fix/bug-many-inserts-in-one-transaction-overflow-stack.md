---
description: Inserting many rows one statement at a time inside a single transaction fails partway through with a stack overflow on an in-memory table, so a routine bulk load can abort.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/layer/interface.ts
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: A multi-row insert or an insert-select avoids it, and committing in batches probably does too (not tested), so a maintainer may defer this until a real workload reports it; the fix may also belong in the inheritree dependency rather than in this repository.
----

# Many single-row inserts in one transaction overflow the stack

## What happens

On a memory-backed table, this fails at row 15,576 with `QuereusError: Execution error: Maximum call stack size exceeded`:

```js
const db = new Database();
await db.exec('create table big (id integer primary key, v text null)');
const stmt = db.prepare('insert into big values (?, ?)');
await db.exec('begin');
for (let i = 0; i < 50000; i++) await stmt.run([i, 'x']);
```

That row number came from one run under node v24.2.0 with its default stack size, so expect it to vary with the stack limit.

An earlier run of the same pattern on a table with two text columns showed the stack as repeated frames of `BTree.chainVersion` in `node_modules/inheritree/dist/b-tree.js`, line 1130.

Loading the same volume with multi-row `insert` statements outside an explicit transaction did not fail.

## Expected

A transaction's statement count should not be limited by the JavaScript call stack. The load should complete, or fail with a clear limit error.

## What is not known

- **Root cause.** The frames suggest the chain of tree versions grows with each statement in the transaction, and `chainVersion` recurses once per link. That is inferred from the stack, not confirmed. `vtab/memory/layer/manager.ts` around line 886 and `vtab/memory/layer/interface.ts` around lines 80-96 discuss how layers contribute to `chainVersion()`, and are the place to start.
- **Whether it predates the build it was seen on.** It was hit on a working tree carrying an unrelated DATETIME comparison change. The failing statements contain no comparison and no DATETIME column, so that change is unlikely to be involved, but the previous commit was not run.
- **Store-backed tables** were not tried.
