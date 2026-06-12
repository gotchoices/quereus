----
description: Remaining builtin aggregate return-type fidelity — json_group_array/json_group_object → JSON nullable, string_concat → TEXT nullable (currently fall through the implicit REAL-nullable default)
files:
  - packages/quereus/src/func/builtins/json.ts          # jsonGroupArrayFunc / jsonGroupObjectFunc
  - packages/quereus/src/func/builtins/string.ts         # stringConcatFunc
  - packages/quereus/src/types/json-type.ts              # JSON_TYPE
  - packages/quereus/src/types/builtin-types.ts          # TEXT_TYPE
difficulty: easy
----

# Remaining builtin aggregate return-type fidelity (json/string)

Follow-on to `aggregate-return-type-fidelity`, which fixed `count`, `total`,
`group_concat`, and the stat aggregates but explicitly left three builtin
aggregates on the `createAggregateFunction` implicit default
(`REAL nullable`):

| Function | Body returns | Declared today | Should be |
|---|---|---|---|
| `json_group_array(value)` | native JS array (or NULL for empty group) | REAL nullable (default) | JSON nullable |
| `json_group_object(name, value)` | native JS object (or NULL for empty group) | REAL nullable (default) | JSON nullable |
| `string_concat(value)` | joined TEXT string (or NULL for empty group) | REAL nullable (default) | TEXT nullable |

`JSON_TYPE` already exists (`src/types/json-type.ts`, exported from
`src/types/index.ts`) and `TEXT_TYPE` from `builtin-types.ts`. The fix mirrors
exactly what was done for `group_concat` in the parent ticket: add an explicit
`returnType: { typeClass: 'scalar', logicalType: <TYPE>, nullable: true, isReadOnly: true }`.

## Why this is its own ticket (not a one-liner)

`json_group_array`/`json_group_object` finalize to native objects/arrays.
Declaring them `JSON_TYPE` activates the type's `serialize`/`deserialize` hooks
and `validate` (which accepts objects). With the current REAL declaration the
native-object output technically violates `REAL_TYPE.validate` (`typeof v ===
'number'`), so today it only works because output validation is not enforced on
the projection path. Switching to JSON is the *correct* type but must be
verified end-to-end: projection, storage round-trip into a maintained/created
table, comparison, and the existing `json_group_*` logic tests
(`test/logic/` — search `json_group`). Confirm no value-level regression and
that a maintained table can declare a `json` column fed by `json_group_array`.

`string_concat → TEXT` is mechanically trivial and low-risk (identical shape to
`group_concat`), but is grouped here since it shares the same theme and test
sweep.

## Acceptance

- Explicit `returnType` on all three functions.
- A logic test (or extension of an existing `json_group` / `string_concat`
  test) that pins the declared type — e.g. via a maintained/`create table as`
  column type, the way `51.7` pins `count(*) as n integer not null`.
- `yarn workspace @quereus/quereus run lint` and `... run test` green.
