description: A storage module may say that some of its stored rows hold null in a column declared not null (left over from a schema change). The engine now believes it: for such a module, every not-null column is reported as possibly null and the optimizer no longer draws conclusions from the declaration.
architecture: docs/module-capabilities.md#surface-inventory
files:
  - packages/quereus/src/vtab/capabilities.ts                            # columnNeverNullOnRead (the helper) + both flags' doc comments
  - packages/quereus/src/planner/type-utils.ts                           # tableColumnReadType; relationTypeFromTableSchema (column types + UNIQUE→key promotion)
  - packages/quereus/src/planner/nodes/reference.ts                      # tableSchemaAttributes; TableReferenceNode passes its own module
  - packages/quereus/src/planner/util/ind-utils.ts                       # fkChildNullable (now takes childModule)
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts   # three reads
  - packages/quereus/src/planner/analysis/coverage-prover.ts
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # holdsForEveryRow
  - packages/quereus/src/vtab/best-access-plan.ts                        # nullSafeOrderingPrefixLength
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # NOTE text updated to name the helper
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts # two count/retraction reads (not in the plan's list)
  - packages/quereus/src/schema/lens-prover.ts                           # proveForwardInjective basis gate (not in the plan's list)
  - packages/quereus/src/planner/building/delete.ts                      # OLD image (not in the plan's list)
  - packages/quereus/src/planner/building/update.ts                      # OLD image (not in the plan's list)
  - packages/quereus/src/planner/building/insert.ts                      # upsert OLD + existing-row images (not in the plan's list)
  - packages/quereus/src/planner/building/alter-table.ts                 # ADD COLUMN backfill / CHECK row images (not in the plan's list)
  - packages/quereus/test/alter-add-column-delegate.spec.ts
  - packages/quereus/test/lens-row-local-null-write.spec.ts
  - docs/module-capabilities.md
  - docs/lens-prover.md
  - docs/optimizer-rule-families.md
  - docs/sql-alter.md
  - docs/sql-ddl.md
----

# NOT NULL columns of a grandfathering module are read as nullable — review handoff

## What changed

`permitsGrandfatheredNotNullViolators` (a module capability flag) now has a second consumer besides the lens prover: the planner. One helper decides whether a table column can ever read NULL:

```ts
// vtab/capabilities.ts
columnNeverNullOnRead(table, columnIndex, module = table.vtabModule): boolean
  // = column.notNull && module does not declare permitsGrandfatheredNotNullViolators
```

`planner/type-utils.ts` adds `tableColumnReadType(table, i, module?)` = `columnSchemaToScalarType(col, { nullable: !columnNeverNullOnRead(...) })`. Every read-side use of `column.notNull` goes through one of the two. `columnSchemaToScalarType` itself is unchanged; write-side row images (NEW, constraint/FK checks, write coercion, `planner/mutation/*`, `mutation-context`, `insert-node`, `write-site-analysis`) still read the declaration.

The ticket's decision is implemented as written: only `permitsGrandfatheredNotNullViolators` widens reads; `delegatesNotNullBackfill` does not. The `TotalMemoryModule` fixture declares both flags, and the `delegatesNotNullBackfill` doc comment, its `module-capabilities.md` row, `sql-alter.md` and `sql-ddl.md` now say that a module leaving rows NULL must also declare the second flag.

## Deviations from the plan — please check these

- **Where the helper lives.** The plan put it in `type-utils.ts`. It is in `vtab/capabilities.ts` instead, because `vtab/best-access-plan.ts` needs it and `vtab/` only imports types from `planner/`, never values. `type-utils.ts` holds the type-building wrapper (`tableColumnReadType`).
- **Module threading.** `relationTypeFromTableSchema`, `tableSchemaAttributes` and `fkChildNullable` take an optional module argument (default: the schema's `vtabModule`). `TableReferenceNode` passes the module it was built with, the same way it already does for `getTrustedCheckExtraction`. `best-access-plan.ts` uses the schema's module. For a registered table both are the same object; the NOTE in `rule-minmax-index-boundary.ts` now says so.
- **Read sites the plan did not list, classified as read-side and routed:**
  - stored-row images built during writes: `OLD` in DELETE and UPDATE, upsert `OLD` and the upsert "existing" (conflict) row, and the existing-row images that ALTER ADD COLUMN uses for a per-row backfill expression and for a new column's CHECK. Each of these holds a row that is already stored, so it can be a grandfathered NULL. Example: `delete from t returning required` would otherwise promise non-null and return NULL. NEW images keep the declared type, because NEW has passed NOT NULL enforcement before anyone sees it.
  - `core/database-materialized-views-plan-builders.ts`: two places assume a NOT NULL argument column makes `count(x)` equal to `count(*)` and makes retraction safe. Both read stored source rows.
  - `schema/lens-prover.ts` `proveForwardInjective`: a NOT NULL basis column is used to argue that the CHECK enumeration covers every stored value. A grandfathered NULL is a stored value outside that enumeration.
- **Not routed (judged write-side or not about stored rows):** `lens-compiler.ts requiredBasisColumnsOf` (skeleton inserts must supply the column), `func/builtins/schema.ts` (`table_info` output; view insertability), `computeNullGuardColumns` in the MV builders (the MV's own declared columns), lens-prover reads of *logical* columns (logical tables have no module), `vtab/memory/*` (a native module, which never declares the flag).

## Lens prover consequences (measured — reviewer should weigh)

As the plan predicted, over a declaring module a basis column declared NOT NULL now reads nullable. So the prover reports `lens.nullability-mismatch` for every `not null` logical column that such a basis supplies, **including the primary key**. I measured this with a throwaway spec (deleted afterwards): basis `a(id pk, av integer not null)` on a declaring module joined with `b(id pk, bv integer not null)`, and a logical `m(id pk, av not null, bv not null)`:

- **mixed body** (`b` on plain `memory`): the deploy is **blocked** with two errors, `m.id` and `m.av`. Before this change it deployed with no diagnostics.
- **all-declaring body** (`b` also declaring): deploys, with three advisories (`id`, `av`, `bv`). Before this change it had none.

This matches `docs/lens-prover.md` ("mixed-module bodies stay strict"), and the docs now say it in so many words. But the demotion is all-or-nothing per lens body, and that now matters in practice: in a mixed body, every NOT NULL column from the declaring module becomes a deploy-blocking error. Before this change that only happened to columns the basis declared nullable. Two open questions for the reviewer, neither filed:

- Should primary-key columns be exempt from `columnNeverNullOnRead`? The capability's wording does not exempt them, and a nullable PK column followed by `set not null` could in principle grandfather a NULL key. So I left them in.
- Should the prover's demotion apply per column (based on the module the column's value comes from) rather than per body? That would be a lens-prover design change.

No shipped module declares the flag, so only third-party modules are affected today.

## Tests

- `test/alter-add-column-delegate.spec.ts` ("delegating module: engine skips the check…"): one added assertion. After the delegated ADD COLUMN, `getColumnDefs()` for `select required from t` reports `nullable: true`. This pins the capability branch of the helper. Once `announced-nullability-egress-check` (in implement/, which lists this ticket as a prereq) installs its strict egress check, the existing NULL-reading cases in this spec become the end-to-end regression.
- `test/lens-row-local-null-write.spec.ts`: the test "a non-nullable derived column classifies `proved`: no advisory…" asserted the over-claim this ticket removes, because its basis was on a declaring module. It is rewritten as "a basis column declared `not null` still reads nullable on the grandfathering module: advisory, and the NULL write still rejects". It asserts that the advisory appears for `tag` and that the NULL insert is still rejected.
- No optimizer test, as the plan said. The key-promotion, foreign-key, partial-UNIQUE, coverage, query-rewrite, IS NOT NULL shortcut, ordering, materialized-view and OLD-image paths were checked by reading the code only. Nothing runs them with a declaring module. Plan tests pass unchanged, which confirms the native modules' plans did not move.

## Validation

- `yarn workspace @quereus/quereus test`: 11189 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` (eslint plus a type-check of the test files): clean.
- `yarn test:store` was not run. The store module never declares the flag, so its behavior is unchanged by construction.

## Things a reviewer could probe

- The isolation layer passes the underlying module's capabilities through and was not exercised directly. With isolation over a declaring module, `tableSchema.vtabModule` is the isolation module, and its `getCapabilities()` should report the flag.
- `getCapabilities()` is now called once per column for each table type build, attribute build, and some analysis passes. Types are cached per node. The plan judged this acceptable, and I did not measure it.
