description: autoIncrement is unconditionally true for all INTEGER PKs regardless of AUTOINCREMENT keyword
prereq: none
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
----

## Resolution

The original bug reported that `autoIncrement` was unconditionally `true` for all INTEGER primary keys,
regardless of whether the `AUTOINCREMENT` keyword was present.

An implementation (commit `ad4e8ca`) added `autoIncrement` to `ColumnSchema` and `PrimaryKeyColumnDefinition`,
propagated it from the AST, and included 5 tests.

However, the project owner then removed AUTOINCREMENT support entirely (commit `e4e5963`), making it a
parser error:

```
AUTOINCREMENT is not supported. Quereus uses key-based addressing without implicit side-effects.
```

This is the correct resolution for Quereus's architecture: key-based addressing has no rowids, so
AUTOINCREMENT is not a meaningful concept. The parser now rejects the keyword with a clear error message
(`parser.ts:3237-3238`).

The original bug no longer applies since:
- There is no `autoIncrement` field on any schema type
- The `AUTOINCREMENT` keyword is a parse error
- `PrimaryKeyColumnDefinition` has no auto-increment behavior

## Testing

No dedicated tests needed -- the parser error path is covered by the parser's constraint parsing logic.
The `AUTOINCREMENT` keyword is checked and rejected immediately after parsing `PRIMARY KEY`.
