description: ADD COLUMN registered a new column-level FK into the live schema BEFORE validating existing rows, so the FK-IND optimizer folded the validator's own NOT EXISTS anti-join to EmptyRelation and admitted an orphan. Fixed by validating against an intermediate schema that omits the new constraint, committing the full schema only after validation passes. Review extended the fix to the identical CHECK fold and filed a store-persistence follow-up.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts, packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, packages/quereus/test/logic/41.8-alter-add-constraint-unique-fk.sqllogic, docs/runtime.md
----

## Summary (implemented + reviewed)

**Root cause** (FK): `ALTER TABLE … ADD COLUMN … REFERENCES p(pid)` registered the
enhanced schema **including the new column-level FK** into the live `SchemaManager`
*before* running existing-row FK validation. The validator's `NOT EXISTS` anti-join then
matched `ruleAntiJoinFkEmpty` and folded to `EmptyRelationNode` under the inclusion
dependency `child.fk ⊆ parent.pk` — the very invariant being checked — so the orphan was
never found and a violating row was admitted.

**Fix** (implement): build an intermediate `validationSchema` carrying the new **column**
but not the new **FK**; register it before validation; commit the full
`enhancedTableSchema` (with FK) only after validation passes. Reverted the validator SQL
from the LEFT-anti-join workaround back to the `NOT EXISTS` correlated subquery. Docs +
tests updated (41.4 §2m engine-bug guard, 41.8 §10 comment).

## Review findings

**Process**: read the implement diff (`7014b333`) with fresh eyes first, traced the
FK-IND fold path, the ADD CONSTRAINT path it claims to mirror, and both core modules'
addColumn, then probed the flagged coverage gaps adversarially. Lint + typecheck + full
memory suite (4853 passing) + full store suite (4848 passing) all green, before and after
the review edits.

### MAJOR — found and FIXED inline: identical CHECK-fold bug (same statement, same function)

The implementer's handoff claimed the CHECK+FK-on-one-ADD-COLUMN combination was "sound"
with only a "minor coverage gap." It was **not sound** — the literal-default CHECK
backfill scan had the *exact same* fold bug the ticket fixed for FK, just via a different
rule:

- `validateBackfillAgainstChecks` issues `select 1 from <t> where not (<check>)`.
- The fix left the new CHECK in `validationSchema` (`mergedChecks`). A declared CHECK `p`
  seeds a **domain constraint** on the scan, so `ruleFilterContradiction` proves
  `p ∧ ¬p` unsatisfiable and folds the scan to `EmptyRelationNode` — the scan trusts the
  invariant it is checking and reports no violation.

Confirmed minimal repro (pre-review): `add column v integer default 0 check (v > 0)` over
a populated table **silently admitted `v = 0`** (and a standalone `select 1 from c where
not (v > 0)` returned `[]` while `select not (v > 0)` returned `true` for the same row).

Disposition — fixed inline because it is the same data-integrity bug class, in the exact
function and `validationSchema` abstraction this ticket introduced, and a small low-risk
change: `validationSchema` now strips **both** the new FK(s) and the new CHECK(s)
(`checkConstraints: updatedTableSchema.checkConstraints`), keeping only pre-existing
(already-proven) constraints. The post-validation commit gate widened from
`hasNewForeignKeys` to `usesIntermediateSchema = hasNewForeignKeys || hasNewChecks`.
Verified: all five literal-default cases (check-only ±, check+fk ×3) now behave correctly.
Was technically pre-existing (CHECK-only path was unchanged by the implement commit) but
sat squarely inside the reviewed change.

### MAJOR — found and FILED (`tickets/fix/alter-add-column-constraint-store-ddl-persistence`)

Confirmed via a temporary `rehydrate-catalog.spec.ts` probe: `ALTER TABLE ADD COLUMN …
REFERENCES`/`CHECK` **loses the constraint on store reload**. The store module's addColumn
persists DDL from a schema that omits the engine-merged column-level constraints, so after
`rehydrateCatalog` an orphan insert is accepted. Pre-existing (from
`alter-add-column-backfill-fk-enforcement`) and orthogonal to the fold bug (this fix only
reorders in-memory `SchemaManager` registration; it does not touch store persistence), so
filed as a separate fix ticket rather than fixed here. Probe reverted.

### Tests added (this pass)

- `41.4 §1b` — CHECK-only literal-default violation guard (the minimal CHECK-fold repro):
  `default 0 check (v > 0)` over a populated row must abort; revert restores the table; a
  satisfying default succeeds and backfills.
- `41.4 §2n` — CHECK + FK on one ADD COLUMN: CHECK arm aborts (default 0), FK arm aborts
  (default 99 passes CHECK but is an orphan), doubly-valid (default 1) succeeds, and both
  constraints enforce forward. This is the combination the implementer left untested; it
  now also guards the CHECK-fold fix. Passes in memory **and** store mode.

### Checked and clean (no action)

- **Load-bearing invariant** (module returns `foreignKeys`/`checkConstraints` WITHOUT the
  new column-level constraint): verified for **both** core modules — memory
  (`layer/manager.ts addColumn` spreads `...this.tableSchema`) and store
  (`store-module.ts addColumn` spreads `...oldSchema`) preserve the original constraint
  sets and never derive the new FK/CHECK. So `updatedTableSchema.{foreignKeys,
  checkConstraints}` are genuinely the pre-existing sets, and stripping to them is correct.
- **Mirrors ADD CONSTRAINT** claim: accurate. The memory manager's
  `addForeignKeyConstraint` validates against `newSchema` *before* `updateSchema`/the
  engine's `schema.addTable`, so the live SchemaManager has no new FK during validation —
  the same validate-before-register ordering this fix adopts.
- **`childSchema` arg to the FK validator**: only supplies table/column *names*; the
  planner resolves the child table from the live SchemaManager (= `validationSchema`). The
  indirection holds.
- **Evaluator-default (per-row) + CHECK path**: `runCheckScan` is false (checks enforced
  inline during backfill via compiled callbacks, independent of `validationSchema`); the
  widened commit gate still commits the full schema. Covered by the green property/logic
  suites.
- **Composite FK** (41.8 §10) and **self-referential FK** (41.4 §2f/2g): the reverted
  `NOT EXISTS` multi-column match chain + `_c`/`_p` aliases keep correlation unambiguous.
- **Revert path**: unchanged (drop column + `schema.addTable(tableSchema)`); pre-existing
  no-notifyChange-on-revert behaviour is not a regression.
- **Lint / typecheck / tests**: lint 0, typecheck 0, memory 4853 passing / 9 pending,
  store 4848 passing / 14 pending.

### Out of scope (acknowledged, not filed)

`pragma foreign_keys = off` "garbage-in": with enforcement off, inserting orphans under a
declared FK then querying still folds `NOT EXISTS` to empty. This is garbage-in under the
stated soundness model (declared FKs are hard inclusion dependencies). Not filed — correct
per the implementer's reasoning. The same caveat now applies to declared CHECKs under the
domain-constraint fold; both share the model.

### Known noise (pre-existing, not actionable)

IDE-only TS diagnostic: unused `schema` parameter in `rebuildViaShadowTable`
(`alter-table.ts`). Untouched by this work; `tsc --noEmit` and `eslint` both exit 0.
