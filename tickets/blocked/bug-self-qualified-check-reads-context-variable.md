description: When a table has a column and a per-statement context value with the same name, a CHECK that names the column through its table, such as `t.who > 0`, actually tests the context value and leaves the column unchecked. The documentation does not say which should happen, so a maintainer needs to decide what this spelling means.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripColumnQualifier: folds <table>.<name> to the bare name
  - packages/quereus/src/planner/building/constraint-builder.ts  # registers context variables ahead of columns, then applies the strip
  - packages/quereus/src/planner/analysis/check-extraction.ts  # readsContextVariable: the optimizer screen, and a NOTE on the table named `new`
  - docs/sql-ddl.md  # §2.6.2, where the proposed text goes
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a column and a context variable with the same name, which is uncommon, and the optimizer no longer draws wrong facts from it, so what remains is a CHECK that does not check what its author wrote.
----

**Blocked: the specification is silent. Unblocked by accepting or editing the proposed text below.**

## What happens today

§2.6.2 of `docs/sql-ddl.md` says a bare name means the context variable when a table declares both, and that `new.<column>` and `old.<column>` always reach the column. It says nothing about `<table>.<column>`. The table of column spellings in the generated-column section does not settle it, because a generated column has no context variables to shadow its names.

Measured on the `dist` build, memory module:

```sql
create table t (a integer primary key, who integer null, check (t.who > 0)) with context (who integer);
insert into t with context who = 5 values (1, -1);   -- accepted: the column holds -1
insert into t with context who = -5 values (2, 5);   -- rejected: the column holds 5
```

`main.t.who` behaves the same. A `check on delete (t.who > 0)` also reads the variable.

The cause is `stripColumnQualifier`. It folds `t.who` to the bare `who`, and the variable then captures the bare name.

A second case has the same cause and does contradict the documentation. On a table literally named `new`, `check (new.who > 0)` also reads the variable, because the strip treats `new` as the table's own name. The optimizer still lifts a fact from that spelling, so `select * from "new" where who <= 0` misses a stored row with `who = -1`. This is the one wrong result left after `bug-check-facts-read-context-variable-as-column`, and a `NOTE:` marks it in `readsContextVariable`.

A column DEFAULT was not measured.

## Proposed text

Recommended for `docs/sql-ddl.md` §2.6.2, replacing the last sentence of the paragraph that starts "Because context variables shadow same-named columns":

> The `new.<column>`, `old.<column>` and `<table>.<column>` forms always reach the column. On a write that stores a row, `<table>.<column>` means `new.<column>`; on a DELETE it means `old.<column>`. `context.<name>` always reaches the variable.

Qualifying a name with its table is how an author says "the column". Today that request is silently ignored, and with a NULL variable the CHECK passes every row. Both tickets written in this area assumed this meaning before it was measured.

## Alternatives

- **Keep today's behaviour and document it:** "`<table>.<column>` means whatever the bare name means, because the qualifier is folded away first." This changes no code and matches how generated columns describe the fold, but it keeps a CHECK that does not constrain the column it names. The table named `new` would still need its own fix, since the documentation promises `new.<column>` reaches the column.
- **Reject the spelling when the name is also a variable.** This is the most explicit option, but it refuses a schema that has one clear reading.

## If we do nothing

The optimizer stays correct, except on a table literally named `new`. A self-qualified CHECK on a shadowed name keeps testing the variable. `bug-alter-check-validation-cannot-reference-mutation-context` is being asked to match today's write behaviour, so ALTER and writes will agree.

## How reversible this is

Choosing a meaning changes which writes a CHECK accepts, so rows stored under the old meaning can violate the new one, and nothing re-validates them. The optimizer screen can stay either way: it would only forgo a fact. Lifting facts from `<table>.<name>` again would need those stored rows accounted for.
