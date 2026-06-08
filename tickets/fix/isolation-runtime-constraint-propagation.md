description: The `@quereus/isolation` layer builds its UNIQUE merged-view enforcement structures from the table schema at connect time and does not refresh them after an `alterTable` that changes UNIQUE constraints or a UNIQUE column's collation. Surfaced by the ALTER-conformance matrix: a runtime UNIQUE add enforces with `INTERNAL` (not `CONSTRAINT`), a UNIQUE drop keeps enforcing, and a UNIQUE-column collation change is missed by the pre-check. Discovered while landing `module-alter-conformance-harness`; the three cells are parked as skipped `it`s referencing this slug.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts
----

## Symptom

`@quereus/isolation` wrapping a memory module honors the column-shape and
nullability/type ALTER arms correctly (the conformance matrix passes for ADD/DROP/
RENAME COLUMN, ALTER COLUMN SET/DROP NOT NULL, SET DATA TYPE, SET DEFAULT, and
engine-side ADD CHECK). It diverges on **runtime changes to UNIQUE constraints and
to a UNIQUE column's collation** — the isolated table's merged-view conflict check
is not rebuilt after `alterTable`, so the overlay's pre-commit UNIQUE check uses a
stale constraint set.

Three concrete divergences (all reproduce with `IsolationModule({ underlying: new
MemoryTableModule() })` in autocommit; the baseline — the same UNIQUE declared at
`CREATE TABLE` — behaves correctly with a clean `CONSTRAINT`):

| Arm | Expected | Actual |
| --- | --- | --- |
| `ALTER TABLE … ADD CONSTRAINT … UNIQUE` then insert a duplicate | clean `CONSTRAINT` (code 19) | `INTERNAL` (code 2): *"Isolation flush insert … hit a unique constraint … The overlay merged-view pre-checks should have resolved this before commit; this indicates an isolation-layer invariant violation."* The new constraint is missed by the merged-view pre-check; the duplicate slips to the commit flush, where the underlying catches it and the layer raises INTERNAL. |
| `ALTER TABLE … DROP CONSTRAINT <unique>` then insert a (now-legal) duplicate | duplicate accepted | still rejected with `CONSTRAINT` even though `unique_constraint_info('t')` shows the constraint gone. Enforcement persists past the drop (silent divergence: the DDL reports success and the catalog reflects it, but the mandate is not honored). |
| `ALTER TABLE … ALTER COLUMN <c> SET COLLATE NOCASE` on a non-PK UNIQUE column, then insert a row that collides only under NOCASE | clean `CONSTRAINT` | same INTERNAL path as the ADD case — the re-collated conflict is missed by the pre-check and surfaces at flush. |

## Why it matters

The ADD/COLLATE cases enforce the constraint *eventually* (at the commit flush) but
via the wrong status code (`INTERNAL` instead of `CONSTRAINT`), so callers cannot
distinguish a user constraint violation from an internal bug, and the failure mode
is reported as an invariant violation. The DROP case is the more serious one: it is
a **silent divergence** — the constraint appears dropped (catalog + introspection
agree) yet remains enforced, exactly the class of bug the conformance harness exists
to catch.

## Likely root

`IsolatedTable` derives its UNIQUE-enforcement structures (the merged-view conflict
check / covering predicates — see `findMergedUniqueConflict` and the predicate cache
in `isolated-table.ts`) from `tableSchema` when the table connects, and caches them.
`IsolationModule.alterTable` migrates overlay *rows* forward and forwards the schema
change to the underlying, but the per-connection `IsolatedTable`'s cached
constraint/predicate structures (and possibly the cached underlying-table handle for
the DROP case) are not invalidated/rebuilt against the post-alter schema. The fix is
to refresh those structures when the table schema rotates (on `alterTable` / the
`table_modified` notification), so the overlay pre-check sees the current UNIQUE set
and collation.

## Acceptance

- Un-skip the three `ISOLATION_GAP_ARMS` cells in
  `packages/quereus-isolation/test/alter-table-conformance.spec.ts` (remove the
  `it.skip` loop's `.skip`) and have them pass:
  - runtime ADD UNIQUE → duplicate rejected with `StatusCode.CONSTRAINT`,
  - DROP UNIQUE → duplicate accepted (enforcement actually stops),
  - SET COLLATE on a UNIQUE column → NOCASE-collision rejected with `CONSTRAINT`.
- No `INTERNAL` "isolation-layer invariant violation" for a genuine user duplicate.
- The existing `cross-layer UNIQUE / PK conflict detection` suite in `@quereus/store`
  (CREATE-declared UNIQUE baseline) continues to pass.
