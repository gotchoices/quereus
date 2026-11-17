description: A storage module may declare that some of its existing rows hold null in a column declared not null (left over from a schema change). The engine still tells callers — and its own optimizer — that such a column can never be null. When reading from such a module, treat its not-null columns as possibly null.
architecture: docs/module-capabilities.md#surface-inventory
files:
  - packages/quereus/src/planner/type-utils.ts                          # relationTypeFromTableSchema (column types + UNIQUE→key promotion); home of the new helper
  - packages/quereus/src/planner/nodes/reference.ts                     # tableSchemaAttributes — attribute types of a table scan
  - packages/quereus/src/planner/building/table.ts                      # TableLiteralNode built from a table schema
  - packages/quereus/src/planner/util/ind-utils.ts                      # fkChildNullable
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts  # three notNull reads
  - packages/quereus/src/planner/analysis/coverage-prover.ts            # nullable UNIQUE columns
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts      # partial-arg NOT NULL check
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # IS NOT NULL on a NOT NULL column
  - packages/quereus/src/vtab/best-access-plan.ts                       # notNull read the min/max rule mirrors
  - packages/quereus/src/vtab/capabilities.ts                           # delegatesNotNullBackfill / permitsGrandfatheredNotNullViolators doc comments
  - packages/quereus/test/alter-add-column-delegate.spec.ts             # TotalMemoryModule fixture
  - docs/module-capabilities.md                                         # surface inventory rows for both flags
----

# NOT NULL columns of a grandfathering module are read as nullable

## Background

`permitsGrandfatheredNotNullViolators` (`vtab/capabilities.ts`) declares that a module "may hold rows lacking a value for a declared NOT NULL column" — typically after `alter table … add column … not null` succeeded against existing rows with NOT NULL enforced only on forward writes. Today the flag is read in one place: the lens prover demotes `lens.nullability-mismatch` to a warning (`schema/lens-prover.ts` `basisPermitsGrandfatheredNotNull`). Everything else in the planner still treats the declared NOT NULL as a fact about every stored row:

- the scanned column's announced type is `nullable: false` (`columnSchemaToScalarType` via `relationTypeFromTableSchema` and `tableSchemaAttributes`), so `getColumnDefs()` promises embedders no NULL and every expression built on the column inherits the promise;
- a NOT NULL UNIQUE column is promoted to a relation key (`relationTypeFromTableSchema`), which licenses DISTINCT elimination and join reasoning — unsound when two grandfathered rows both hold NULL;
- FK child nullability, partial-UNIQUE extraction, the coverage prover, the MV query-rewrite matcher, and the `IS NOT NULL` access-path shortcut read `column.notNull` directly.

The sibling flag `permitsGrandfatheredCheckViolators` already does the equivalent for CHECK constraints: when set, the planner stops lifting declared CHECKs into optimizer facts. This ticket gives NOT NULL the same treatment.

The 2026-11-16 measurement (temporary "announced non-nullable ⇒ no null cell" check at statement egress) found this class only in `test/alter-add-column-delegate.spec.ts` — columns `required`, `tier`, `extra` — whose `TotalMemoryModule` fixture advertises `delegatesNotNullBackfill`, carries existing rows forward with NULL in the new NOT NULL column, and does **not** declare `permitsGrandfatheredNotNullViolators`. No shipped module declares either flag, so the optimizer arms below are static (read from code, not reproduced).

## Decision: which flag means "reads may see NULL"

`permitsGrandfatheredNotNullViolators` alone. `delegatesNotNullBackfill` only hands the ADD COLUMN decision to the module; a delegating module may still reject the add or backfill a value, in which case no NULL exists. A module that does carry NULLs forward is exactly what `permitsGrandfatheredNotNullViolators` describes, so it must declare that flag too. Alternative rejected: treating `delegatesNotNullBackfill` as implying it — that would discard NOT NULL facts for modules that never actually grandfather anything.

So: the `TotalMemoryModule` fixture declares `permitsGrandfatheredNotNullViolators: true` as well, and the `delegatesNotNullBackfill` doc comment (capabilities.ts) and its row in `docs/module-capabilities.md` say: a module that leaves pre-existing rows NULL in the new column must also declare `permitsGrandfatheredNotNullViolators`.

## Design

One helper in `planner/type-utils.ts`, e.g. `columnNeverNullOnRead(table: TableSchema, columnIndex: number): boolean` = `column.notNull && table.vtabModule?.getCapabilities?.().permitsGrandfatheredNotNullViolators !== true`. Route every **read-side** planner use of `column.notNull` through it:

- `relationTypeFromTableSchema`: each column's `nullable`, and the `allNotNull` test for promoting a UNIQUE constraint to a key;
- `tableSchemaAttributes` (`nodes/reference.ts`): attribute types;
- `fkChildNullable` (`util/ind-utils.ts`);
- `partial-unique-extraction.ts` (three reads), `coverage-prover.ts`, `query-rewrite-matcher.ts`, `rule-select-access-path.ts` (`IS NOT NULL` on a NOT NULL column), and `vtab/best-access-plan.ts` (the read the min/max boundary rule mirrors — keep the two in agreement, as the comment in `rule-minmax-index-boundary.ts` says).

Leave **write-side** reads alone — `constraint-builder.ts`, `mutation-context.ts`, `insert-node.ts`, `write-site-analysis.ts`, `planner/mutation/*`: forward writes still enforce the declared NOT NULL (the capability doc says the flag "changes NOTHING about writes"). `columnSchemaToScalarType` itself stays as it is, because it also builds NEW/OLD row images for writes; the widening happens at the table-read call sites. If you find a read-side `notNull` use not listed here (e.g. in `schema/` or `vtab/`), classify it the same way.

Native modules (memory, store) never declare the flag, so their plans are unchanged — confirm with the plan tests (`test/plan/`) staying green.

## Edge cases & interactions

- **Lens prover.** A NOT NULL logical column over a NOT NULL basis column of a declaring module now sees a nullable basis expression, so the prover emits the (already demoted, warning-severity) `lens.nullability-mismatch` advisory where it emitted nothing before. That is truthful — reads there may yield NULL — and is the advisory's documented purpose. `lens-ack.spec.ts`, `lens-row-local-null-write.spec.ts` and `lens-rowlocal-grouped-probe.spec.ts` declare the flag; update any assertion that counted advisories, and check that a mixed-module body (one declaring, one not) still behaves as `docs/lens-prover.md` describes.
- **Isolation layer** "inherits underlying" capabilities (`docs/module-capabilities.md`), so a wrapped declaring module is covered through `getCapabilities()` — no special case.
- **A table with no `vtabModule`** (logical tables, table literals) — helper falls back to `column.notNull`.
- **Capability read cost.** `getCapabilities()` is called per column per type derivation; types are cached per node (`TableReferenceNode.typeCache`). Fine as is.
- **Key promotion loss** means DISTINCT/GROUP BY over a declaring module's NOT NULL UNIQUE column is no longer eliminated — the intended cost.

## Test

No new optimizer test. The `alter-add-column-delegate.spec.ts` cases become the regression once `announced-nullability-egress-check` installs the strict egress check (they read NULL from a column the fixture now declares as grandfathering). Add one assertion in that spec: after the fixture's ADD COLUMN, `getColumnDefs()` for `select required from t` reports `nullable: true` — this pins the capability branch in the helper.

## TODO

- Add the helper to `type-utils.ts`.
- Route the read-side sites listed above through it.
- Declare `permitsGrandfatheredNotNullViolators` on `TotalMemoryModule`; add the one assertion.
- Update the `delegatesNotNullBackfill` and `permitsGrandfatheredNotNullViolators` doc comments in `vtab/capabilities.ts` and their rows in `docs/module-capabilities.md` (the latter now also gates the planner's NOT NULL trust, alongside the lens-prover demotion).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
