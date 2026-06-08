description: ALTER TABLE ADD COLUMN with NOT NULL and no literal DEFAULT now fails fast on non-empty tables in both the MemoryTable and StoreModule paths. The error names the column and the qualified `schema.table` instead of surfacing later as a constraint violation against an internal `__rekey_*` temp name.
prereq: StoreModule.alterTable, StoreTable.hasAnyRows, MemoryTable addColumn guard
files:
  - packages/quereus-store/src/common/store-module.ts (addColumn guard ~L402-L412)
  - packages/quereus-store/src/common/store-table.ts (`hasAnyRows()` helper ~L142-L149)
  - packages/quereus/src/vtab/memory/layer/manager.ts (addColumn guard ~L911-L920)
  - packages/quereus/test/logic/41-alter-table.sqllogic (section 5: qualified-name + empty-table + NULL + literal-DEFAULT cases)
  - packages/quereus-store/test/alter-table.spec.ts (smoke tests: empty OK, non-empty refused, literal DEFAULT OK)

----

## What shipped

Both ALTER TABLE ADD COLUMN paths refuse a NOT NULL column without a literal DEFAULT when the underlying table already has rows. The refusal happens before any row migration, so no NULL ever reaches storage.

Error message (both paths):

```
Cannot add NOT NULL column '<col>' to non-empty table '<schema>.<table>' without a DEFAULT value
```

Thrown as `QuereusError` with `StatusCode.CONSTRAINT`.

### Key pieces

- `StoreTable.hasAnyRows()` — short-circuits on the first entry from a full-scan iterator; cheaper than `approximateCount` and avoids deserialization.
- `StoreModule.alterTable → addColumn` — after extracting any literal DEFAULT and before `migrateRows`, the guard fires when `newColSchema.notNull && defaultValue === null && await table.hasAnyRows()`. Non-literal DEFAULTs leave `defaultValue === null`, so they are also refused on non-empty tables (intentional strictness; call out in `plan/declarative-schema-enhancements.md` if we want to soften).
- MemoryTable manager — error format aligned to the StoreModule path (includes `'<col>'` and `'<schema>.<table>'`).

## Testing

- `yarn build`: clean across the monorepo.
- `packages/quereus` tests: 2443 passing, 2 pending.
- `packages/quereus-store` tests: 170 passing, including:
  - empty-table ADD COLUMN NOT NULL allowed
  - non-empty ADD COLUMN NOT NULL refused; error mentions `'rank'` and `main.items`, never `__rekey_`
  - non-empty ADD COLUMN NOT NULL DEFAULT &lt;literal&gt; allowed
- `packages/quereus/test/logic/41-alter-table.sqllogic` section 5 additionally asserts:
  - error message contains `'rank'`
  - error message contains `main.t_notnull`
  - NULL column without DEFAULT on non-empty table allowed
  - NOT NULL without DEFAULT on empty table allowed

## Usage notes

- To add a NOT NULL column to a non-empty table, supply a literal DEFAULT (e.g., `ALTER TABLE t ADD COLUMN score INTEGER NOT NULL DEFAULT 0`) or drop the NOT NULL constraint.
- Non-literal DEFAULTs (e.g., `DEFAULT (random())`) are refused on non-empty tables by both backends. If a later ticket wants to allow this with per-row evaluation, the guards in `store-module.ts` and `manager.ts` are the hook points.
