description: On a table with per-statement context values, a column default that names a sibling through its table, such as `default (t.b)`, is accepted when the table is created and then makes every insert that uses the default fail. The same default is refused immediately on a table without context values, so the mistake should be reported when the table is declared.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/manager.ts  # validateOneDefault: rejectColumns is switched off when the table declares mutation context
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The failure is a clear error at the first write and never a wrong value, and the message names the bad reference, so a maintainer might leave it.
----

`validateOneDefault` rejects column references in a DEFAULT at declaration time, unless the table declares mutation context, because a bare name there may be a variable. That exemption also lets through a table-qualified name, which is never a variable and which a DEFAULT's scope cannot resolve.

Measured on the `dist` build, memory module:

| DEFAULT | Table | Result |
|---|---|---|
| `default (d.b)` | no context | refused at CREATE: `may not reference a bare column; use 'new.<column>'` |
| `default (d.b)` | has context | accepted at CREATE; insert fails with `d.b isn't a column` |
| `default (d.who)`, column and variable both `who` | has context | same |
| `default (main.d.who)` | has context | same |
| `c integer not null default (d.who)` with `insert or replace` supplying NULL | has context | same |
| `default ((select max(k) from u where k = t.who))` | has context | same |

## Expected behavior

A DEFAULT naming its own table's column through the table is refused at declaration time whether or not the table declares context, with the existing message that points at `new.<column>`. That includes `ALTER COLUMN … SET DEFAULT`, which shares `validateOneDefault`. A qualifier that a FROM inside the DEFAULT binds stays legal.

`docs/sql-ddl.md` §2.6.2 says a DEFAULT does not accept this spelling, and needs no change.
