---
description: After `CREATE INDEX` (incl. `CREATE UNIQUE INDEX`) on a `USING store` table, the connected `StoreTable`'s cached `tableSchema` is now refreshed — both `indexes` and (for UNIQUE) `uniqueConstraints` — so subsequent INSERT/UPDATE/DELETE correctly maintain the new index entries via `updateSecondaryIndexes` and enforce uniqueness via `checkUniqueConstraints`.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## What changed

### Fix (`packages/quereus-store/src/common/store-module.ts:308-362`)

`StoreModule.createIndex` now refreshes the connected `StoreTable`'s cached
schema after `buildIndexEntries` and before emitting the schema-change event.
The refresh mirrors `SchemaManager.addIndexToTableSchema`
(`packages/quereus/src/schema/manager.ts:1250-1265`):

```ts
const updatedIndexes = Object.freeze([...(tableSchema.indexes ?? []), indexSchema]);
const updatedSchema: TableSchema = { ...tableSchema, indexes: updatedIndexes };
if (indexSchema.unique) {
    updatedSchema.uniqueConstraints = Object.freeze([
        ...(tableSchema.uniqueConstraints ?? []),
        {
            name: indexSchema.name,
            columns: Object.freeze(indexSchema.columns.map(c => c.index)),
            predicate: indexSchema.predicate,
        },
    ]);
}
table.updateSchema(updatedSchema);
```

The engine-side `SchemaManager.createIndex` (in `packages/quereus`) was already
calling `schema.addTable(updatedTableSchema)` to update the engine's registry —
the only missing piece was that the `StoreTable` instance held its own
`tableSchema` reference (captured at construction in `store-table.ts:153`) and
its DML helpers (`updateSecondaryIndexes`, `checkUniqueConstraints`,
`uniqueColumnsChanged`) read off `this.tableSchema`. Without this fix the
cached reference stayed stale for the lifetime of the connected table.

### Regression tests (`packages/quereus-store/test/column-default-conflict.spec.ts:175-232`)

Two cases under `describe('CREATE INDEX refreshes cached tableSchema')`:

1. `maintains the new index on inserts and updates issued after CREATE INDEX`
   — covers the secondary-index maintenance path. Inserts one row, creates a
   non-unique index, then asserts the index store grows / shrinks correctly
   across post-CREATE-INDEX INSERT, UPDATE-of-indexed-column, and DELETE.
2. `enforces uniqueness for a UNIQUE index created after CREATE TABLE` — added
   in this review pass after discovering the uniqueConstraints gap. Creates a
   UNIQUE index after one row exists, then asserts a duplicate insert is
   rejected with a UNIQUE constraint error and a non-conflicting insert
   succeeds.

The non-unique test's lifecycle assertions (1 → 3 → 3 → 2) — rather than a
single count-at-end — are intentional: a single end-state count happens to
match (`1`) both with and without the fix because the original pre-CREATE
INDEX row's entry survives. Splitting across the lifecycle exposes the bug.

## Validation done

- `yarn workspace @quereus/store test`: **261 passing** (was 260; one new test
  added in this review pass), 0 failing.
- Verified the new UNIQUE-index test **fails on the otherwise-fixed code**
  before the uniqueConstraints addition (insert of duplicate `b=100` succeeds
  silently); passes after.
- `yarn test` (root): all packages pass except the same 2 pre-existing
  failures in `@quereus/sample-plugins` (`key_value_store virtual table >
  supports delete` and `... supports update`) — unrelated to `StoreModule`.
- `yarn workspace @quereus/quereus run lint`: clean (exit 0).
- `yarn workspace @quereus/store run typecheck`: clean (exit 0).
- **Not run:** `yarn test:store` (LevelDB-backed logic tests). The fix is
  in-memory state on the `StoreTable` instance; the regression tests directly
  inspect the index store and the engine's UNIQUE enforcement path via the
  in-memory provider, which is sufficient.

## Review findings

Categories below are SPP/DRY/modular/scalable/maintainable/performant,
resource cleanup, error handling, type safety, plus the documentation,
test-coverage, and adjacent-bug audits the review stage requires.

### Major: UNIQUE indexes lost their uniqueConstraint entry — **fixed inline**

The implement-stage fix only updated `tableSchema.indexes`. But
`SchemaManager.addIndexToTableSchema`
(`packages/quereus/src/schema/manager.ts:1250-1265`) does two things when an
index is `unique: true`:

1. Append to `indexes`.
2. Append a derived `UniqueConstraintSchema` to `uniqueConstraints`.

`StoreTable.checkUniqueConstraints`
(`packages/quereus-store/src/common/store-table.ts:929-967`) iterates
`tableSchema.uniqueConstraints` — **not** `tableSchema.indexes` — to enforce
uniqueness. So before this fix:

- `CREATE UNIQUE INDEX u_b ON u (b)` followed by a duplicate `INSERT INTO u
  VALUES (..., 100), (..., 100)` would silently accept both rows.

I confirmed the gap by writing the test first (it failed on the partial fix
with `expected UNIQUE constraint violation`), then mirrored
`addIndexToTableSchema`'s UNIQUE branch and re-ran (passes). Disposition:
**minor follow-on to the same root cause; fixed inline**.

The same constraint object also carries `predicate` (for partial indexes) so
`checkSingleUniqueConstraint`-style consumers that respect partial scope still
work consistently. `defaultConflict` is intentionally omitted — `CREATE INDEX`
has no per-constraint `ON CONFLICT` clause, matching SchemaManager's behavior.

### Major: PK-change UPDATE leaks moved-row index entry — **already filed,
unchanged**

Per the discovering ticket
(`store-table-pk-change-update-leaks-moved-row-index`), the PK-change UPDATE
path mis-constructs the old-key for `updateSecondaryIndexes` (uses `newPk`
for both old and new). With this fix landed, that bug becomes observable at
the index-store level (it was previously masked because no inserts after
CREATE INDEX touched the index). The added regression tests do not UPDATE the
PK so they do not trip the leak. **Not addressed here** — separate ticket
already exists.

### Minor: DROP INDEX symmetry — **N/A, not implemented**

`StoreModule` does not implement `dropIndex` (verified via search of the
package). `SchemaManager.dropIndex`
(`packages/quereus/src/schema/manager.ts:1276-1342`) calls
`module.dropIndex` only when the module exposes one, and itself only updates
`indexes` (not `uniqueConstraints`) — that is a separate engine-side gap that
becomes relevant whenever any module *does* implement `dropIndex`. Filed as
follow-up below.

### Minor: SchemaManager.dropIndex doesn't refresh uniqueConstraints — **filed
follow-up**

Symmetric to the bug fixed here on the create side: when an engine-side
`schema.addTable(updatedTableSchema)` follows `dropIndex`, the new table
schema only filters `indexes`, leaving any UNIQUE-derived
`uniqueConstraints` entry behind (manager.ts:1316-1323). Today this is
unreachable for `USING store` (no `dropIndex` implementation) but is a
latent bug for any module that adds one. Filed as a backlog ticket:
`schema-manager-drop-index-stale-unique-constraint`.

### Code quality — clean

- The `Object.freeze` + spread pattern matches `alterTable`'s existing branches
  (e.g. `dropColumn` at `store-module.ts:484-499`). DRY: I considered extracting
  a `withAddedIndex(tableSchema, indexSchema)` helper that both
  `SchemaManager.addIndexToTableSchema` and `StoreModule.createIndex` could
  call, but that would require exporting `UniqueConstraintSchema` from
  `@quereus/quereus`'s public surface and adds cross-package coupling for a
  ~10-line block. Left inline; the SchemaManager comment now references the
  mirror, so a future change in either spot is discoverable.
- Type safety: no `any`, no casts. `indexSchema.predicate` is `Expression |
  undefined`; `UniqueConstraintSchema.predicate` is `Expression | undefined`
  — direct assignment is type-safe.
- Resource cleanup, error handling: no new resources or fallible paths
  introduced.
- Performance: O(existing-index-count) shallow copy at CREATE INDEX time,
  i.e. once per DDL statement. Negligible.
- Cross-platform: pure in-memory state mutation; no platform-specific code.

### Documentation — checked, no updates needed

- `docs/architecture.md` and `docs/schema.md` describe the engine-side schema
  lifecycle (planner / SchemaManager registry); they do **not** describe the
  `StoreTable` instance's cached schema (an implementation detail of
  `quereus-store`). No doc updates required.
- `packages/quereus-store/README.md` and `packages/quereus/README.md` were
  spot-checked for any reference to CREATE INDEX behavior on USING store
  tables; none found.
- Comment in the fix references the SchemaManager mirror by name, which is the
  right level of in-code documentation for future maintainers.

### Test coverage — adequate

Categories assessed:

- **Happy path**: covered by the non-unique INSERT/UPDATE/DELETE lifecycle
  test and the UNIQUE accept-non-conflicting branch.
- **Edge cases**: the lifecycle test exercises pre-existing-row backfill, new
  row insert, indexed-column UPDATE (delete-old + put-new), DELETE.
- **Error path**: the UNIQUE test exercises `checkUniqueConstraints` returning
  a constraint error.
- **Regression / interaction**: both tests cover the *cached schema reference*
  surface; both fail on the unmodified code.
- **Not added** (deemed out of scope):
  - CREATE INDEX on a non-empty table where the indexed column has NULL
    values (covered by the `buildIndexEntries` path, which is unchanged).
  - Composite-key DESC ordering (orthogonal to the cache-invalidation bug).
  - `INSERT ... ON CONFLICT REPLACE` through a newly-created UNIQUE index
    (would exercise the same `checkUniqueConstraints` path now wired through;
    the existing `UNIQUE ON CONFLICT REPLACE` test covers the resolution
    branch via a CREATE-TABLE-time UNIQUE).

### Pre-existing failures — confirmed unrelated

The 2 `@quereus/sample-plugins` failures (`key_value_store virtual table >
supports delete` and `... > supports update`) are pre-existing on `main` and
target a different VTab module (not `StoreModule`-based). Out of scope.

## Follow-up tickets to file

- `schema-manager-drop-index-stale-unique-constraint` — backlog. When
  `SchemaManager.dropIndex` removes a UNIQUE-backed index, the derived
  `uniqueConstraints` entry is left behind in the table schema. Latent until a
  vtab module implements `dropIndex`.
