description: Native ALTER PRIMARY KEY in the store module via two-pass re-key + index rebuild.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/alter-table.spec.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/41.1-alter-pk.sqllogic
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic
----

## What was built

Replaces the `UNSUPPORTED` throw in `StoreModule.alterTable`'s `alterPrimaryKey` arm
with an in-place native re-key, eliminating the slow shadow-table fallback in
`runAlterPrimaryKey` for store-backed tables.

### Data re-key: `StoreTable.rekeyRows(newPkDef)`

Two-pass algorithm:

1. **Validate** — stream every row, compute the new PK bytes via `buildDataKey`,
   collect into `Map<hex(newKey), { newKey, oldKey, row }>`. On collision throw
   `StatusCode.CONSTRAINT` without mutating the store (all-or-nothing).
2. **Write** — single `store.batch()` that deletes the old key and puts the new
   `(key, serialized row)` pair for every row whose key changed. Uses byte-wise
   `bytesEqual` rather than double-hex comparison for the no-op skip check.

### Secondary index rebuild

Index keys embed the PK suffix, so every secondary index is cleared and rebuilt
against the now-rekeyed data store via the existing `buildIndexEntries` helper.
Full clear + rebuild — O(n) but trivially correct.

### Schema + catalog update

After data/index mutations succeed: `table.updateSchema`, `saveTableDDL`, emit
the `alter` schema-change event — identical pattern to the `addColumn`/`dropColumn`
arms.

## Semantics

- Column layout unchanged — only `primaryKeyDefinition` is replaced.
- Runtime layer (`runAlterPrimaryKey`) pre-validates NOT NULL, duplicate-column,
  and column-existence; the store trusts that shape.
- Uniqueness of the resulting keys is enforced in pass 1 (can fail even on a
  valid PK shape if existing rows collide under it).
- Row count preserved; `cachedStats` left alone.

## Transactional semantics

Matches `addColumn`/`dropColumn`: writes go through `store.batch()`, not
`TransactionCoordinator`. Validation-first structure means `CONSTRAINT` failures
leave the store pristine. A crash mid-batch leaves the store inconsistent —
same exposure as existing ALTER paths.

## Testing

### Unit (`packages/quereus-store/test/alter-table.spec.ts`)
- Empty-table re-key, then insert under new PK and point-lookup.
- Populated-table re-key: row count preserved, point-lookup under new PK.
- Duplicate-on-rekey: `CONSTRAINT` thrown, count + original PK lookup intact.
- Re-key with existing secondary index: post-alter query by indexed column.

### Logic
- `41.1-alter-pk.sqllogic` — empty/populated rekey, duplicate rejection,
  empty-PK, NOT NULL enforcement, DESC direction, composite PK, nonexistent
  column, duplicate column, nullable-column regression, parser round-trip.
  Removed from `MEMORY_ONLY_FILES`; passes under `QUEREUS_TEST_STORE=true`.
- `50.1-declare-schema-pk.sqllogic` — declarative `apply schema` covering
  pure rekey, rekey + drop old PK column, and pure PK reorder cases.

### Guard
- `yarn test` (memory): 2443 passing.
- `yarn workspace @quereus/store test`: 216 passing.
- `yarn test:store`: 566 passing; only pre-existing unrelated
  `50-declarative-schema.sqllogic` multi-candidate connection failure remains.

## Usage

```sql
alter table t alter primary key (col);
alter table t alter primary key (a, b desc);
alter table t alter primary key ();   -- drop PK
```

Also covers `apply schema` diffs that include `ALTER PRIMARY KEY`, including
the rekey-then-drop and pure-reorder variants.

## Review pass

- Tightened pass 2 of `rekeyRows` to use direct byte comparison (`bytesEqual`)
  instead of recomputing two hex strings per row, avoiding O(n·k) string work
  on the hot path.

## Follow-up (separately tracked, out of scope here)

`runAlterPrimaryKey` in `packages/quereus/src/runtime/emit/alter-table.ts:380-386`
catches `e instanceof QuereusError && e.code === StatusCode.UNSUPPORTED`. The
`instanceof` check can fail under the test harness when the engine runs through
ts-node while the store dist imports the compiled engine (two distinct
`QuereusError` classes). The native path makes this moot for ALTER PK, but
future module-level UNSUPPORTED for other `alterTable` variants would hit the
same invisible-fallback. Hardening to `e?.code === StatusCode.UNSUPPORTED` is
worth doing alongside the next module-level UNSUPPORTED change.
