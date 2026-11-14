description: A column declared with a registered custom numeric type, such as a length, keeps that type when it is selected directly, but adding, scaling or summing it returns a built-in type, and in some cases reports whole numbers for a column that stores fractions. A host cannot use a custom type to say what a computed number measures.
architecture: docs/types.md
files:
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode type inference, about lines 244-271: promotion is decided by comparing type names with 'REAL' and 'NUMERIC', and anything else falls to INTEGER
  - packages/quereus/src/func/builtins/aggregate.ts  # sum (NUMERIC_RETURN), avg (REAL_RETURN), total (REAL_RETURN_NOT_NULL) declare fixed return types; min and max infer from their argument
  - packages/quereus/src/types/logical-type.ts  # LogicalType: isNumeric is the only thing a custom type can say about arithmetic
  - docs/types.md  # § Logical Types, § Numeric Types
repro: verified
----

# Arithmetic and sums drop a custom numeric type

## What happens

Measured on 2026-11-13 against the published `@quereus/quereus` 5.4.0 from the SiteCAD tree (not re-run against this checkout's HEAD; the code at the sites above reads the same). Register `LENGTH` (and `AREA`) with `db.registerType` as types whose physical type is REAL. The measurement's scripts were throwaway and are not kept, so the exact definition object is not recorded; reproduce with `isNumeric` both set and unset and say which the table below is. Then `create table T (id integer primary key, len length, plain real) using memory`, prepare each select and read `Statement.getColumnType`:

| Keeps `LENGTH` | Becomes something else |
|---|---|
| `len`, `-len`, `abs(len)`, `round(len, 1)` | `len * 2` → `INTEGER`; `len * 2.0` → `INTEGER` |
| `min(len)`, `max(len)` | `len / 2` → `NUMERIC` |
| `coalesce(len, len)`, `case … then len else len end` | `len + len` → `INTEGER`; `len + plain` → `NUMERIC` |
| a scalar subquery, a common table expression, `union all` of two `len` columns | `len * len` → `INTEGER` |
| `cast(plain as length)` | `sum(len)` → `NUMERIC`; `avg(len)` → `REAL`; `total(len)` → `REAL` |

Two separate things are wrong here.

**A wrong answer today.** `len + len`, `len * 2` and `len * 2.0` report `INTEGER` for values that are fractions. The likely site, from reading it and not from stepping through: `BinaryOpNode` decides promotion by name. A NUMERIC operand gives NUMERIC, a REAL operand gives REAL or NUMERIC, and otherwise "both are INTEGER". A custom numeric type is neither name, so two of them land in the INTEGER branch whatever their physical type. That reading does not by itself explain `len * 2.0`; confirm the path when reproducing. Anything that trusts the reported type (a consumer formatting the column, a representation check) is told a REAL-valued result is an integer. This holds for any custom numeric type, with or without the request below.

**The type is not carried.** No arithmetic result and no `sum`, `avg` or `total` is the custom type, so a host that declares a column as a length gets an untyped number from the first total or difference it computes, which is most of what a report does.

## Who asked

SiteCAD (Nate, 2026-11-13) wants a column to say what its numbers measure (length, area, volume) so every surface shows it in the reader's units. A custom type per measure was the first idea. SiteCAD's investigation found the behaviour above and recommended a different carrier for stored tables for that reason; whether the type route becomes usable depends on this ticket. The SiteCAD ticket is `tickets/blocked/decide-how-a-stored-table-column-declares-its-measure.md` in that repository.

## Expected behaviour

Fix the wrong answer first: arithmetic over a custom numeric type must promote by the type's physical type, not fall to INTEGER. A custom REAL-physical type behaves as REAL does in the promotion rules, a custom INTEGER-physical type as INTEGER.

Then decide and state in `docs/types.md` whether a custom numeric type is preserved through arithmetic and aggregates, and how a type says so. A proposal to start from:

- `a + b` and `a - b` of the same custom type return that type.
- `a * n` and `a / n`, where `n` is a built-in numeric type, return the custom type.
- `a * b` and `a / b` of two custom types return the built-in type their physical types promote to (a length times a length is not a length).
- `sum`, `avg` and `total` of a custom type return that type; `min` and `max` already do.
- Mixed custom and built-in operands in `+` and `-` return the built-in promotion (the measured `len + plain` → `NUMERIC` is defensible and can stay).

Whether this is the default for every custom numeric type or something a type opts into (a field beside `isNumeric` on `LogicalType`) is the design question; a type such as a currency amount wants the same rules, an identifier-like numeric type does not.

## Notes for whoever fixes it

- `total(len)` returning REAL is by its definition (always a float); say in the doc whether it carries the custom type.
- The planner comments at the promotion site explain why a mixed INTEGER/REAL pair announces NUMERIC (a bigint operand can survive); a custom INTEGER-physical type meets the same case.
- Add the cases to the sqllogic suite as type assertions on prepared statements, since the row values do not show the reported type.
