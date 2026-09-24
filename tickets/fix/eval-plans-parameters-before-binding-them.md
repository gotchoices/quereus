description: A query run through `Database.eval(sql, params)` is planned before its parameter values are looked at, so the planner does not know their types and a storage module that needs trusted types will not use an index. Reads that should touch a few rows scan the whole table.
files:
  - packages/quereus/src/core/database.ts (`Database._evalGenerator` — calls `this.prepare(sql)` without the parameters, then `stmt.getColumnNames()`)
  - packages/quereus/src/core/statement.ts (`Statement.compile()` — freezes each parameter's type from the arguments bound so far; its `NOTE:` says the freeze only affects "pre-bind introspection")
repro: verified
----
# `Database.eval` plans a parameterised query before binding its parameters

Filed from SiteCAD, a consumer, on 2026-09-17. SiteCAD is changing its own two store helpers to prepare with parameters, so it no longer waits on this; the defect stays for every other caller of `eval`.

## What happens

`Database.eval(sql, params)` runs `_evalGenerator`, which calls `this.prepare(sql)` with no parameters and then `stmt.getColumnNames()`. Reading the column names compiles the plan, and `Statement.compile()` freezes each parameter's type from the arguments bound so far, which is none. Only then does `_iterateRowsRawInternal(params)` bind the values. A virtual-table module that refuses to seek on a bound whose plan-time type it cannot trust (lamina's `isPushdownSafeBoundType`) therefore runs `hour_start >= ?` as a filter over a full scan.

`Database.get` passes the parameters to `prepare` and plans correctly. The `NOTE:` in `Statement.compile()` says the freeze only affects pre-bind introspection; `eval` is such a caller on every execution.

## Measured in the consumer (2026-09-14)

A lamina-backed table of 1,200 rows, a range read returning 30, three runs each:

| query | time |
| --- | --- |
| `db.eval` with `hour_start >= ? and hour_start < ?` | 250–400 ms |
| the same, bounds bound as `BigInt` | 250–265 ms (the type is frozen before binding, so the value's type never matters) |
| `db.prepare(sql, params).iterateRows()` | 10–58 ms |
| `db.eval` with `cast(? as integer)` on each bound | 12–14 ms |
| literal bounds | 11–27 ms |

`query_plan` shows an index range for the literal and cast forms and a sequential scan for bare `?`. Equality on a single non-key-prefix column behaves the same way; equality on a whole multi-column primary key seeks.

## Fix, either form

Have `_evalGenerator` pass `params` to `prepare` for a single-statement batch, or bind before reading column names.

## The reproduction this ticket owes

A memory-table or test-module case asserting that the plan for `eval(sql, params)` sees the same parameter types as `prepare(sql, params)`.
