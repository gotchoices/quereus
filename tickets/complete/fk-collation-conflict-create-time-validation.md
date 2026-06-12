description: Declaration-time FOREIGN KEY collation-conflict validator. A FK whose child column and parent key column declare same-rank conflicting collations is rejected at CREATE TABLE / ALTER ADD CONSTRAINT / ALTER ADD COLUMN / declarative apply through the same comparison-collation lattice FK enforcement uses, instead of only at the first DML against the child.
files:
  - packages/quereus/src/schema/constraint-builder.ts          # validateForeignKeyCollations (sibling of validateForeignKeyOverExistingRows)
  - packages/quereus/src/schema/manager.ts                     # createTable validates each completeTableSchema.foreignKeys before addTable
  - packages/quereus/src/runtime/emit/add-constraint.ts        # runAddConstraintViaModule validates newly-added FK(s) before schema.addTable
  - packages/quereus/src/runtime/emit/alter-table.ts           # runAddColumn validates resolvedForeignKeys first, inside the try/revert region
  - packages/quereus/src/index.ts                              # barrel export of validateForeignKeyCollations
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic
  - packages/quereus/test/logic/50-declarative-schema.sqllogic
  - docs/types.md
  - docs/schema.md
----

## What shipped

A pure-schema validator `validateForeignKeyCollations(db, childSchema, fk)` in
`schema/constraint-builder.ts`. It maps the child FK column and the resolved
parent key column to `ScalarType`s via `columnSchemaToScalarType`
(`collationExplicit` → provenance `'declared'`, else `'default'`) and runs the
pair through `resolveComparisonCollation` — the SAME lattice helper the
synthesized `parent.k = NEW.fk` enforcement comparison resolves through. On a
`kind === 'conflict'` result it throws `QuereusError(StatusCode.ERROR)` naming the
FK, both qualified columns, and both collations. Lockstep with enforcement is
structural (verified: enforcement builds `parent.ref = NEW.fk` where both operands
carry `columnSchemaToScalarType`, and the lattice is symmetric, so operand order
is irrelevant).

Wired at three engine-universal call sites (covers memory + store with no
per-module edits) plus declarative apply transitively:
- **CREATE TABLE** — `manager.createTable`, post-reconcile, before `schema.addTable`
  (self-ref resolves against the not-yet-registered schema).
- **ALTER ADD CONSTRAINT** — `runAddConstraintViaModule`, validates FK(s) not
  present by reference in the prior schema, before `schema.addTable`.
- **ALTER ADD COLUMN** — `runAddColumn`, validates each `resolvedForeignKeys` entry
  first inside the existing try/revert region (a conflict drops the just-
  materialized column and restores the engine catalog).

The check is **unconditional** (not gated on `pragma foreign_keys`): a
conflicting-collation declaration is malformed, same class as a child/parent
column-count mismatch.

## Review findings

Reviewed the full implement diff (0f5f122a) with fresh eyes, then the handoff.
Scrutinized lockstep fidelity, all four call sites, schema resolution, error
paths, test coverage, and docs.

### Checked and CONFIRMED correct
- **Lockstep with enforcement.** Read `foreign-key-builder.ts`,
  `comparison-collation.ts`, and `columnSchemaToScalarType`. The validator uses
  the identical type-mapping and the identical (symmetric) lattice the DML-time
  parent-existence comparison uses. It fires on exactly the conflicts the first
  DML would, never a re-derived name/textuality rule. No drift possible by
  construction.
- **Store reconcile edge (the subtle one).** An implicit-default text PK that the
  store reconciles to NOCASE keeps `collationExplicit` unset → rank 1 → no
  contribution → no false conflict. Verified against `columnSchemaToScalarType`'s
  provenance mapping and covered by 41.1 § 4/§ 5 (green in store mode).
- **Self-referencing FK at CREATE** resolves the parent against `childSchema`
  directly (table not yet registered) — correct; covered by § 6.
- **Build, lint, tests.** `build` clean (EXIT 0); `lint` clean (EXIT 0); full
  memory suite **5978 passing, 9 pending, 0 failing**; the three changed logic
  files + 41.1 pass under **store mode** too.

### Found and FIXED inline (minor)
- **Duplicate "Step 34" in `50-declarative-schema.sqllogic`.** The new FK-rejection
  step collided with the pre-existing "Step 34: Test view removal". Renumbered the
  new step to **33.1** (no churn to later steps). Cosmetic only.
- **Missing positive ALTER coverage (false-rejection regression guard).** The
  implementer's 41.1 § 8/§ 9 asserted only the *conflict* (rejection) path for
  ALTER ADD CONSTRAINT and ADD COLUMN; a regression that falsely rejected a
  *valid* text FK via ALTER would have gone uncaught (the pre-existing 41.4/41.8
  ALTER FK tests use integer columns, where collation never contributes). Added:
  - § 8.1 — ADD CONSTRAINT with matching NOCASE/NOCASE succeeds AND the FK is
    enforced (case-variant accepted, non-matching rejected).
  - § 9.1 — ADD COLUMN with matching NOCASE column succeeds AND the column is
    actually added (validate-before-swap only reverts on conflict).
  Both pass under memory and store. (Note: ADD COLUMN without `null`/`default`
  defaults to NOT NULL in this engine — the § 9.1 column is declared `null` to
  allow the presence assertion, matching the 41.4 convention.)

### Found and FILED as a new ticket (major)
- **Store ADD CONSTRAINT persists the rejected FK to disk before the engine
  validates** → `tickets/fix/fk-collation-conflict-add-constraint-persists-before-validation.md`.
  `runAddConstraintViaModule` validates *after* `module.alterTable` returns, but
  the store module already `saveTableDDL`'d. On a conflict the engine catalog
  stays clean (throw precedes `schema.addTable`) yet the store has persisted the
  FK, which rehydrates unvalidated on reopen and surfaces at DML — a "rejected"
  ALTER half-succeeds on disk. The implementer flagged this as a reviewer
  judgment call (gap #1). Not fixed inline: the clean fix (pre-build the FK from
  the AST via the already-exported `buildForeignKeyConstraintSchema` and validate
  before `module.alterTable`) is a behavioral reorder with store-persistence
  implications that needs a store-reopen test — out of scope for an inline review
  fix. The ticket documents the repro, the suggested approach, and the test gap.

### Checked, ACCEPTED as-is (no action)
- **ADD CONSTRAINT overlaps the existing-row validator when `foreign_keys` is ON**
  (gap #2). Both reject; the test deliberately uses pragma-off to exercise this
  validator as the sole rejecting mechanism. Documented in 41.1 § 8. Resolved as
  a side effect of the filed fix ticket's pre-validation reorder if taken.
- **`priorFks.has(fk)` is reference-based** (gap #3). Both built-in modules append
  (`[...existing, fk]`), preserving identity, so only the new FK is validated. The
  new § 8.1 positive test guards the matching-FK path. Acceptable for current
  modules; flagged for the record.
- **Schema-resolution nuance.** The validator resolves the parent via
  `findTable(referencedTable, fk.referencedSchema ?? childSchema.schemaName)`;
  enforcement passes `fk.referencedSchema` (undefined → default main→temp search).
  Diverges only in a contrived temp/main same-name edge; the validator's choice
  (default to the child's own schema) is arguably the more correct FK semantics.
  No action.
- **CHECK constraints are NOT validated at CREATE time** (gap #4). Out of scope
  (FK-only); a conflicted CHECK still surfaces at first write. Pre-existing
  limitation, documented in `06.4.4` § 5. Not introduced by this change; no new
  ticket filed (the comment already records it as unimplemented).
- **Full `yarn test:store` not run** (gap #5). Not agent-runnable per ticket
  guidance; the changed logic files were run under store mode (green). A full
  store pass is deferred to CI.

### Docs
Read both touched doc sections (`docs/types.md` § Comparison collation resolution,
`docs/schema.md` § createTable) and the surrounding context. Both accurately
describe the new declaration-time behavior, the unconditional nature, and the two
intended residuals (forward-declared parent; reload non-revalidation). No staleness
found.

## Residuals (intended, documented)
- **Forward-declared parent**: child declared before parent exists → CREATE
  succeeds (parent types unknown); conflict still caught at first DML with
  `ambiguous collation`. Covered by 41.1 § 10.
- **Reload / `importTable` does not re-validate**: a legacy persisted conflicting
  FK reloads without error and surfaces at DML (consistent with "reload must not
  reject").

## Validation performed (review pass)
- `yarn workspace @quereus/quereus build` — EXIT 0.
- `yarn workspace @quereus/quereus lint` — EXIT 0.
- `yarn workspace @quereus/quereus test` (memory) — 5978 passing, 9 pending, 0 failing.
- `41.1` + `06.4.4` + `50-declarative-schema` under **store mode** — passing.
- `41.1` + `50-declarative-schema` under memory mode after the added/renumbered
  cases — passing.
