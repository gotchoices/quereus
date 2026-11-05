description: Adding a column with a computed default and a CHECK fails for some CHECK spellings that the same statement accepts when the default is a plain literal. The spellings are `old.<column>` in part of the CHECK, and a column named through its table, such as `t.a`.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnChecks compiles the CHECK as written
  - packages/quereus/src/schema/constraint-builder.ts  # storedRowPredicate: the conjunct screen and own-row reading the literal path gets
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripSelfQualifierInSchemaExpression: the fold the write path applies
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The failure is a clear refusal rather than a wrong result, and adding the column first and the constraint second avoids it, so a maintainer might leave it.
----

`ALTER TABLE … ADD COLUMN` validates an inline CHECK against existing rows by one of two routes. A literal DEFAULT goes through the shared existing-row scan, and a computed DEFAULT or generated column compiles the CHECK and evaluates it per row. Only the scan applies the rules for which spellings mean what.

Measured on the memory module, with `create table t (a integer primary key, b integer null)` holding one row:

| CHECK on the new column `c` | `default 1` | `default (new.b)` |
|---|---|---|
| `check (old.a is null or c > 0)` | accepted | `old.a isn't a column` |
| `check (t.c > 0)` | accepted | `t.c isn't a column` |

## Expected behavior

Both routes accept the same CHECKs. A conjunct containing `old.<column>` owes stored rows nothing and is skipped, while its other conjuncts are still judged. A self-qualified name means what it means on a write. On a table that declares mutation context, `<table>.<column>` reaches the column even when a variable shares the name, as decided in `bug-self-qualified-check-reads-context-variable`, which also updates `docs/sql-alter.md` under *Existing-row validation of a CHECK*.

The partial operation mask, the third difference between these routes, is already fixed in `buildAddColumnChecks`.
