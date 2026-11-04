description: When one statement finishes while another statement's automatic commit is still in progress, the same transaction gets committed a second time. Storage backends with a slow commit can then fail or roll back work; a downstream project sees this in about half its runs.
files:
  - packages/quereus/src/core/database.ts # _finalizeImplicitTransaction: commits whatever implicit transaction is active, with no record of who owns it or whether a commit is already running
  - packages/quereus/src/core/statement.ts # finalizes through wrapAsyncIterator, after the execution mutex has been released
repro: verified
----

Reported in GitHub issue #38. Reproduced on the current build with the issue's script, using a memory table and one registered connection whose `commit()` takes 50 ms:

```
sequential  fulfilled,fulfilled begin 1 commit 1 alone
overlapping fulfilled,fulfilled begin 1 commit 2 alone,overlapping
```

An autocommit `insert` finishes and starts committing, after releasing the execution mutex. A `select` started 10 ms later takes the mutex, runs, and reaches `_finalizeImplicitTransaction`. The transaction manager still reports the insert's transaction as implicit, so the `select` commits it too. One `begin()` is followed by two `commit()` calls, the second while the first is still awaiting.

The reporter's module shares one transaction across connections, so the second commit throws "already sealed" and its failure handling rolls the shared state back. Their workaround is an application-side queue per database.

Expected: every `begin()` gets exactly one `commit()` or `rollback()`, whichever statements overlap. The issue offers two approaches: finalize inside the mutex, or let only the statement that opened the implicit transaction commit it. Choose by what else has to hold:

- The `select` must not read through a transaction that is partway through committing, and must not start a new transaction that the first commit then closes.
- A commit that fails must reach the statement that owned the commit, and must not be reported to the bystander.
- The other finalize callers need the same rule: the `eval`, `iterateRows` and `all` paths in `statement.ts`, the paths in `database.ts`, and the OR ROLLBACK branch at the top of `_finalizeImplicitTransaction`, which rolls back any active transaction.
- Holding the mutex across a commit must not deadlock with a module whose `commit()` runs statements on the same database, such as sync or a commit hook.

The issue's script is the reproduction to keep as a test, at the lowest layer that shows the double call.
