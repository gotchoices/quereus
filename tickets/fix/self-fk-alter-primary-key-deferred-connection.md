description: A self-referential FK table that undergoes `ALTER PRIMARY KEY` during a schema apply trips deferred FK enforcement at the next commit — `QuereusError: Deferred constraint execution found multiple candidate connections for table <schema>.<table>`. Pre-existing engine bug surfaced (not caused) by the FK parent-referenced-column rename work.
files:
  - packages/quereus/src/runtime/deferred-constraint-queue.ts          # findConnection (~line 158), runDeferredRows (~line 65) — the throw site
  - packages/quereus/src/core/database-transaction.ts                  # runDeferredRowConstraints (~line 261), commitTransaction (~line 139)
  - packages/quereus/src/core/database.ts                              # runDeferredRowConstraints (~line 1021)
  - packages/quereus/src/schema/schema-differ.ts                       # emits primaryKeyChange / ALTER PRIMARY KEY (the apply-time trigger)
  - packages/quereus/test/declarative-equivalence.spec.ts             # self-FK churn test deliberately sidesteps this with a non-PK UNIQUE ref column
----

## Symptom

After a declarative `apply schema` that renames the **primary-key column** of a table
carrying a **self-referential foreign key** (which emits both `RENAME COLUMN` and
`ALTER PRIMARY KEY` on that table), the *next* `insert` into that table fails at
**commit** with:

```
QuereusError: Deferred constraint execution found multiple candidate connections for table main.node
    at DeferredConstraintQueue.findConnection (runtime/deferred-constraint-queue.ts:158)
    at DeferredConstraintQueue.runDeferredRows (runtime/deferred-constraint-queue.ts:65)
    at TransactionManager.runDeferredRowConstraints (core/database-transaction.ts:261)
    at TransactionManager.commitTransaction (core/database-transaction.ts:139)
```

## Minimal reproduction

```sql
pragma foreign_keys = true;
declare schema main {
  table node { code INTEGER PRIMARY KEY, parent_code INTEGER null,
               constraint fk foreign key (parent_code) references node(code) }
}
apply schema main;
insert into node values (1, null), (2, 1);

-- rename the PK column code → ucode (emits RENAME COLUMN + ALTER PRIMARY KEY)
declare schema main {
  table node { ucode INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'code'),
               parent_code INTEGER null,
               constraint fk foreign key (parent_code) references node(ucode) }
}
apply schema main;

insert into node values (3, 2);   -- <-- throws at commit
```

## Scope / what is known

Confirmed **pre-existing** during review of `fk-parent-referenced-column-rename-churn`:
the failure reproduces **identically with the pre-ticket `schema-differ.ts`** (reverting
the differ change and re-running the repro throws the same error), so it is NOT caused by
the FK referenced-parent-column rename reconciliation. The reconciliation only changes
whether the *child/self* FK is reconciled vs dropped+recreated; the `ALTER PRIMARY KEY` is
emitted regardless and is the actual trigger.

Isolation probes (from the review):
  - plain `create table` self-FK + insert → enforces fine;
  - declarative-apply self-FK, **no** rename → enforces fine;
  - imperative `alter table … rename column` of the self-FK referenced col (no PK change) → fine;
  - declarative apply that renames the self-FK's **PK** referenced column (⇒ `ALTER PRIMARY KEY`) → **breaks**.

So the trigger is **`ALTER PRIMARY KEY` on a self-referential-FK table**, after which the
deferred-constraint queue's `findConnection` sees more than one candidate connection
registered for that table and cannot disambiguate.

## Expected behavior

After any schema-mutating apply (including `ALTER PRIMARY KEY`) on a self-referential-FK
table, deferred FK enforcement at the next commit must resolve a single connection for the
table and enforce the FK normally (valid self-reference accepted, orphan rejected).

## Investigation hints

`findConnection` in `runtime/deferred-constraint-queue.ts` rejects when it finds multiple
candidate connections for a table. The likely cause is a stale/duplicate connection (or
vtab module instance) registration left behind by the `ALTER PRIMARY KEY` path — the old
and new table incarnations both registered against the same `schema.table` key. Confirm
whether `ALTER PRIMARY KEY` (or the table-rebuild it implies) leaves a dangling connection
that a non-PK-touching `ALTER` does not, and ensure the queue keys on / cleans up the right
incarnation. Worth checking whether `ALTER PRIMARY KEY` on a non-self-FK table also leaves
the duplicate (it is simply not exercised because no deferred self-FK fires there).
