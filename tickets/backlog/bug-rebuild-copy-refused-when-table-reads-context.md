---
description: Changing the primary key of a table whose CHECK or DEFAULT uses a per-statement parameter fails with a confusing error when the storage module has to rebuild the table, because the internal row copy has no value to give that parameter.
architecture: docs/schema.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts (the `insert or abort into <shadow> … select …` copy, ~2245)
  - packages/quereus/src/planner/building/mutation-context.ts (`registerMutationContextSymbols`, which raises the error)
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: Only modules with no `alterTable` reach this rebuild (memory and the store both re-key in place), so no module in this repo hits it, and the statement is refused rather than corrupting anything.
---

# `ALTER PRIMARY KEY` rebuild refuses a table that reads a context variable

When a module has no `alterTable`, `ALTER TABLE … ALTER PRIMARY KEY` falls back to a rebuild: create a shadow table from the canonical `CREATE TABLE` text, copy the rows with `insert or abort into <shadow> (…) select … from <table>`, drop the original, rename the shadow.

The canonical text now carries `with context (…)`, so the shadow declares the same variables as the table. The copy supplies no `with context` values, because it has none: the variables hold per-statement values that were never stored.

## Observed

Run against `makeNoAlterModule({ withRenameTable: true })` from `packages/quereus/test/no-alter-module.ts`, with one row inserted first, then `alter table t alter primary key (code)`:

| Table | Result |
|---|---|
| `constraint c check (new.v <= cap)`, `with context (cap integer)` | fails: `table 'main.t__rekey_…' requires mutation context variable 'cap'; supply it with 'with context cap = …'` |
| `v integer not null default cap`, `with context (cap integer)` | fails with the same error, although the copy supplies `v` explicitly |
| `with context (cap integer)`, nothing reads it | succeeds |

The error names the internal shadow table and asks for a clause the user has no way to add to an `ALTER`.

Before the canonical text carried the clause these two shapes failed as well, for a different reason (read from the code and the emitted text, not re-run): the CHECK shape as `Column not found: cap`, and the DEFAULT shape because the shadow's text did not parse. So this is not a regression, but the failure is now the only thing left in the way.

Not checked separately: that this failure leaves the original table intact. The rebuild's failure cleanup is pinned for a key collision (`alter-table-conformance.spec.ts`, 'a row-set that collides under the new key…'), which fails at the same copy statement.

## Expected

A re-key changes no row, and each row already passed its CHECK when it was written. The in-place re-key paths in the memory and store modules succeed on these tables without any context value, so the rebuild path should as well.
