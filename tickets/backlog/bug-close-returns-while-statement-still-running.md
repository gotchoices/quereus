description: Closing a database does not wait for work already running on it, so a statement can keep running against a database the caller believes is shut, which matters most when the caller then closes the storage underneath it.
files:
  - packages/quereus/src/core/database.ts # close(): takes no mutex and awaits only committed reads
  - packages/quereus/src/core/statement.ts # _iterateRowsGenerator holds the mutex for a whole iteration, which is why waiting on the mutex is not a safe fix
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The likely trigger is shutting down during other work, the closed-database check coming with bug-apply-schema-starves-event-loop already stops later statements, and a real fix has to tell a running statement from an abandoned iterator, which is more machinery than the remaining window may justify.
----

`Database.close()` sets `isOpen = false`, waits only for committed reads, then tears down shared state. It takes no execution mutex and does not wait for a statement that holds it.

**Observed on the 4.25.0 build:** with a `select` iterator open, `close()` returned and the next `it.next()` still produced a row. With a migrating `apply schema` in flight, `close()` returned in 0.3 ms and the apply carried on, re-creating 27 tables on the closed database and resolving as success. That run used a build patched to yield between steps; without a yield, a module that really waits in its hooks should behave the same (inferred from the code, not run).

`bug-apply-schema-starves-event-loop` adds a closed-database check at the top of `_executeSingleStatement`, which refuses every later statement. What remains after it lands:

- A statement already inside a module hook finishes after `close()` has returned. If the caller then closes the underlying store, that hook is writing to a closed store, and the module can add a catalog entry after the catalog was cleared.
- An open row iterator keeps producing rows after close.
- An `apply schema` with no statement left to refuse still finishes normally. If `close()` lands on the yield after the plan's last step and there is no seeding, the apply resolves as success on the closed database, and each module's `endSchemaBatch` runs with no error after `close()` has returned (observed by running it). If seed rows remain, it rejects with `Cannot apply seed data: table … not found after migration`, which does not mention the close (also observed).

**Expected:** when `close()` resolves, nothing is still running against the database, and an open iterator reports that the database closed.

**Why this is not simply "take the mutex in close":** an unconsumed `eval` iterator holds the mutex for as long as it stays open, so a caller that abandoned one would hang `close()` forever, where today it returns. Committed reads accept that delay, as the comment in `close()` says, but they can be aborted and serialized iterators currently have no such signal. A fix has to abort or otherwise release those iterators, and must not deadlock when `close()` is called from inside a statement, such as from a module hook.
