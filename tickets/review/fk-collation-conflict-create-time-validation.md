description: Review the declaration-time FOREIGN KEY collation-conflict validator. A FK whose child column and parent key column declare same-rank conflicting collations is now rejected at CREATE TABLE / ALTER ADD CONSTRAINT / ALTER ADD COLUMN / declarative apply through the SAME comparison-collation lattice FK enforcement uses, instead of only at the first DML against the child.
difficulty: medium
files:
  - packages/quereus/src/schema/constraint-builder.ts          # NEW validateForeignKeyCollations (sibling of validateForeignKeyOverExistingRows)
  - packages/quereus/src/schema/manager.ts                     # createTable: validates each completeTableSchema.foreignKeys before addTable
  - packages/quereus/src/runtime/emit/add-constraint.ts        # runAddConstraintViaModule: validates newly-added FK(s) before schema.addTable
  - packages/quereus/src/runtime/emit/alter-table.ts           # runAddColumn: validates resolvedForeignKeys first, inside the try/revert region
  - packages/quereus/src/index.ts                              # barrel export of validateForeignKeyCollations (symmetry)
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic     # NEW dedicated coverage (memory + store)
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic  # § 10 + § 5 parenthetical updated for new CREATE-time behavior
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # NEW Step 34: declarative apply rejects a conflicting FK
  - docs/types.md                                              # § Comparison collation resolution — FK declaration-time note
  - docs/schema.md                                             # createTable — FK declaration-time collation validation
----

## What landed

A new pure-schema validator `validateForeignKeyCollations(db, childSchema, fk)`
in `schema/constraint-builder.ts` (alongside `validateForeignKeyOverExistingRows`).
It maps the child FK column and the resolved parent key column to `ScalarType`s
via `columnSchemaToScalarType` (the same map the FK builder's `parent.k = child.fk`
comparison uses — `collationExplicit` → provenance `'declared'`, else `'default'`)
and runs the pair through `resolveComparisonCollation` (the one lattice helper).
On `res.kind === 'conflict'` it throws `QuereusError(StatusCode.ERROR)` naming the
FK, both qualified columns, and both collations, ending `… declare conflicting
collations; declare a matching COLLATE on both sides.`

Wired at three engine-universal call sites (covers memory + store, no per-module
edits) plus declarative apply transitively:
- **CREATE TABLE** — `manager.createTable`, loops `completeTableSchema.foreignKeys`
  *after* `finalizeCreatedTableSchema` (post-reconcile) and *before* `schema.addTable`
  (self-ref resolves against the not-yet-registered schema; never in
  `buildTableSchemaFromAST`/import, so reload is unaffected).
- **ALTER ADD CONSTRAINT** — `runAddConstraintViaModule`, validates the FK(s) in the
  returned schema not present *by reference* in the prior schema (both built-in
  modules append, preserving existing FK object identity), before `schema.addTable`.
- **ALTER ADD COLUMN** — `runAddColumn`, validates each `resolvedForeignKeys` entry
  *first* inside the existing try/revert region, so a conflict drops the just-
  materialized column and restores the original catalog (table untouched).

The check is **unconditional** (NOT gated on `pragma foreign_keys`) — a
conflicting-collation declaration is malformed, same class as the child/parent
column-count mismatch the builders already reject unconditionally.

## Behavior to verify (use cases)

All covered in `test/logic/41.1-fk-collation-conflict.sqllogic` unless noted.
The file runs under **both** memory and store; store-mode was run for the three
changed logic files (all green).

Conflicts (reject at declaration):
- CREATE: declared NOCASE child vs declared RTRIM parent PK → reject, with
  `foreign_keys = off` (proves unconditional). [§1]
- CREATE: declared BINARY (rank 2) vs declared NOCASE — a declared `collate
  binary` is a real preference → reject. [§2]
- CREATE self-referencing FK (text PK one collation, FK column another) → reject
  *at CREATE*, before the table is registered (validator resolves parent =
  childSchema). [§6]
- CREATE multi-column FK conflicting on exactly one pair → reject. [§7]
- ALTER ADD CONSTRAINT conflicting FK → reject (run with `foreign_keys = off` so
  THIS validator is the rejecting mechanism — see gap #2). [§8]
- ALTER ADD COLUMN conflicting column-level FK → reject AND the column is reverted
  (asserted: post-failure `select *` shows only the original column). [§9]
- Declarative `apply schema` with a conflicting FK (parent+child) → reject;
  isolated in schema `Test3`. (`50-declarative-schema.sqllogic` Step 34.)

No-conflict (must still succeed — lockstep with enforcement):
- Matching declared collations (nocase/nocase) → create + enforce. [§3]
- One-sided declaration (declared NOCASE child vs implicit-default parent PK) →
  resolves NOCASE, creates. [§4] (also `06.4.3-write-path-collation.sqllogic` §5,
  pre-existing, unaffected)
- **Store reconcile edge**: implicit-default text PK reconciled to NOCASE (rank 1,
  not explicit) vs a *defaulted* child column → must NOT falsely conflict. [§5]

Residual (forward-declared parent): child declared before parent exists → CREATE
succeeds (parent types unknown), conflict still caught at first DML with
`ambiguous collation`. [§10]

Also updated `06.4.4-comparison-collation-precedence.sqllogic` § 10 (the old test
that asserted the conflict surfaced only at INSERT — it now asserts the CREATE is
rejected) and the § 5 parenthetical (CHECK create-time detection is still
unimplemented; the FK variant now validates at CREATE/ALTER).

## Honest gaps / things to scrutinize

1. **Store ADD CONSTRAINT persists before the engine validates (in-memory + on-disk
   divergence).** For ADD CONSTRAINT, the validator runs in the engine emit layer
   *after* `module.alterTable` returns — but the store module's `alterTable` already
   called `saveTableDDL` (and `table.updateSchema`), and the memory module already
   swapped its cached `tableSchema`, before returning. So on a conflict the module
   half has the FK while the engine SchemaManager (authoritative for planning) does
   NOT (my throw precedes `schema.addTable`). In-session this is benign (the rejected
   FK is never used; a subsequent DROP cleans the store entry). On a store *reopen*
   the persisted conflicting FK rehydrates without error (rehydrate intentionally
   does not re-validate) and surfaces at DML — consistent with the documented
   "reload must not reject" rule, but it does mean the ticket's "leaves the table
   untouched" guarantee holds for the *engine catalog* only, not the store's
   persisted catalog. This follows the ticket's explicit "validate after
   module.alterTable returns" design. **Reviewer judgment call:** is the persisted-
   then-rejected store entry acceptable, or should ADD CONSTRAINT pre-build the FK
   from the AST (`buildForeignKeyConstraintSchema`) and validate *before*
   `module.alterTable`? No automated test exercises the store reopen of a rejected
   ADD CONSTRAINT.

2. **ADD CONSTRAINT mechanism overlaps the existing-row validator when
   `foreign_keys` is ON.** With the pragma on, the module's
   `validateForeignKeyOverExistingRows` *prepares* the `parent.k = child.fk`
   existence query, whose plan-time comparison raises the equivalent `ambiguous
   collation` error *before* my validator runs. So my ADD CONSTRAINT validator is
   the sole rejecting mechanism only when `foreign_keys` is OFF. Both reject at ALTER
   time; the test deliberately uses pragma-off to exercise my path. (CREATE TABLE and
   ADD COLUMN have no such overlap — CREATE runs no existence query, and ADD COLUMN
   runs my validator first.)

3. **`priorFks.has(fk)` (ADD CONSTRAINT) is reference-based.** Both built-in modules
   append (`[...existing, fk]`), preserving existing FK object identity, so only the
   new FK is validated. A hypothetical module that rebuilds the whole `foreignKeys`
   array with fresh objects would cause every FK to be re-validated — harmless for
   valid FKs, but it could re-reject a *legacy* (reload-tolerated) conflicting FK on
   an unrelated ADD CONSTRAINT. Acceptable given current modules; flagged for the
   record.

4. **CHECK constraints are NOT validated at CREATE time** — out of scope (FK-only).
   A conflicted CHECK still surfaces at the first write; `06.4.4` § 5 documents this.

5. **Full `yarn test:store` not run** (slow / not agent-runnable per ticket guidance).
   Only the three changed logic files were run under store mode (green). A full store
   pass is deferred to CI.

## Validation performed

- `yarn workspace @quereus/quereus build` — clean (EXIT 0).
- `yarn workspace @quereus/quereus test` (memory) — **5978 passing, 9 pending, 0
  failing**.
- Store mode for the three changed logic files (`test-runner.mjs --store --grep …`)
  — 3 passing.
- `yarn workspace @quereus/quereus lint` — clean.
- `documentation.spec.ts` — 6 passing (after the doc edits).
