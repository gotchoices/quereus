description: Detect a foreign key whose child column and parent key column declare conflicting explicit/declared collations at CREATE TABLE / ALTER (ADD CONSTRAINT, ADD COLUMN, declarative apply) time, instead of only at the first DML against the child. Reuse the comparison-collation lattice so the check stays in lockstep with what FK enforcement actually plans.
difficulty: medium
files:
  - packages/quereus/src/schema/constraint-builder.ts          # new validateForeignKeyCollations (FK-validation home; sibling of validateForeignKeyOverExistingRows)
  - packages/quereus/src/schema/manager.ts                     # createTable: validate after finalizeCreatedTableSchema (post-reconcile), NOT importTable (reload-safe)
  - packages/quereus/src/runtime/emit/add-constraint.ts        # runAddConstraintViaModule: validate the newly added FK (universal across memory + store)
  - packages/quereus/src/runtime/emit/alter-table.ts           # runAddColumn: validate each resolvedForeignKeys entry (universal across memory + store)
  - packages/quereus/src/planner/type-utils.ts                 # columnSchemaToScalarType — column → ScalarType (collationExplicit → 'declared', else 'default')
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # resolveComparisonCollation — THE lattice helper to call
  - packages/quereus/src/schema/table.ts                       # resolveReferencedColumns
  - docs/types.md                                              # § Comparison collation resolution — note the FK declaration-time check
  - docs/schema.md                                             # FK section — declaration-time collation validation
  - packages/quereus/test/logic/41-foreign-keys.sqllogic       # existing FK logic tests (reference for new test file)
----

## Problem

With the comparison-collation lattice landed (ticket
`comparison-collation-provenance-and-precedence`), the synthesized FK
enforcement comparison `parent.k = NEW.ref` is a plan-time ambiguous-collation
error when both columns carry *different* explicitly-declared collations
(`collationExplicit` → `collationSource: 'declared'`, rank 2; a COLLATE
wrapper would be rank 3 'explicit'). That error is correct but **late**: it
surfaces only when the EXISTS check is first planned (first INSERT/UPDATE on
the child). The contradiction is fully visible in the schema the moment the
REFERENCES clause is declared, so we reject it there.

## Design

### The check is the lattice, applied to the two column types

FK enforcement compares `parent.refCol = child.fkCol`. The collation that
comparison resolves under (and whether it conflicts) is exactly
`resolveComparisonCollation(childType, parentType)` where each `*Type` is the
column's `ScalarType`. `columnSchemaToScalarType(col)`
(`planner/type-utils.ts`) is the canonical `ColumnSchema → ScalarType` map —
it sets `collationName: col.collation` and `collationSource:
col.collationExplicit ? 'declared' : 'default'`. Using **that** map + the
**same** `resolveComparisonCollation` guarantees the create-time check fires on
exactly the conflicts enforcement would (the ticket's lockstep requirement —
do NOT re-derive a textuality- or name-based rule).

Consequences of staying in lockstep (intended, not bugs):
- Matching declared collations (nocase/nocase) → resolved, no conflict.
- One-sided declaration (child declared nocase vs parent defaulted BINARY) →
  the defaulted side contributes nothing (rank-1 BINARY is the engine floor) →
  resolves to NOCASE, no conflict.
- A *declared* `COLLATE BINARY` (rank 2) vs a declared NOCASE → conflict
  (declared BINARY is a real preference, per the lattice).
- Non-text columns carrying a divergent **explicit** COLLATE still conflict —
  because enforcement's `BinaryOpNode.generateType` would also throw for them.
  We mirror enforcement exactly rather than gating on textuality.

### New shared validator

Add to `constraint-builder.ts` (sibling of `validateForeignKeyOverExistingRows`,
the existing FK-validation home — keeps all FK declaration validation in one
file):

```ts
/**
 * Rejects a FOREIGN KEY whose child column and parent key column declare
 * conflicting explicit/declared collations — the same conflict the synthesized
 * `parent.ref = child.fk` enforcement comparison raises at plan time, surfaced
 * here at declaration time. Pure schema check (no row scan). Resolves the parent
 * against the live catalog; a not-yet-created (forward-declared) parent is
 * skipped — its absence means the parent column types are unknown, so the
 * conflict cannot be seen yet and remains caught at first DML (unchanged). A
 * self-referencing FK resolves against `childSchema` directly so it validates
 * before the table is registered.
 */
export function validateForeignKeyCollations(
  db: Database,
  childSchema: TableSchema,
  fk: ForeignKeyConstraintSchema,
): void
```

Behavior:
- Resolve parent: if `fk.referencedTable`/`fk.referencedSchema` names
  `childSchema` itself (case-insensitive, default schema = child schema), use
  `childSchema` as parent (self-ref, works pre-registration); else
  `db.schemaManager.findTable(fk.referencedTable, fk.referencedSchema ?? childSchema.schemaName)`.
- Parent absent → `return` (forward ref; documented residual).
- `parentColIndices = resolveReferencedColumns(fk, parent)`; if
  `parentColIndices.length !== fk.columns.length` → `return` (the count-mismatch
  error is already raised by the builders; don't double-report).
- For each pair `i`: `childCol = childSchema.columns[fk.columns[i]]`,
  `parentCol = parent.columns[parentColIndices[i]]`;
  `res = resolveComparisonCollation(columnSchemaToScalarType(childCol), columnSchemaToScalarType(parentCol))`.
  On `res.kind === 'conflict'` throw a `QuereusError(StatusCode.ERROR)` naming
  the FK, both qualified columns, and both collations, e.g.:
  `FOREIGN KEY '<fk.name>' on '<child>': child column '<child>.<childCol>' (collation <c>) and parent column '<parent>.<parentCol>' (collation <p>) declare conflicting collations; declare a matching COLLATE on both sides.`

Imports needed in `constraint-builder.ts`: `columnSchemaToScalarType` from
`../planner/type-utils.js`, `resolveComparisonCollation` from
`../planner/analysis/comparison-collation.js`. (`manager.ts` already imports
from `../planner/...`, so the schema→planner direction is established; no
layering concern within the package.)

### Three universal call sites (no per-module edits)

The memory and store modules both route their ADD CONSTRAINT and ADD COLUMN
through the engine emit layer, and CREATE TABLE through `manager.createTable`.
Hooking at those three engine points covers every FK-declaration entry — store
and memory alike — with one validator and no duplication:

1. **CREATE TABLE** — `manager.ts` `createTable`, immediately after
   `finalizeCreatedTableSchema` yields `completeTableSchema` and BEFORE/around
   `schema.addTable`. Iterate `completeTableSchema.foreignKeys ?? []` and call
   the validator for each. `completeTableSchema` is **post-reconcile** (the
   store's `reconcilePkCollations` runs inside `module.create`), so an
   implicit-default text PK reconciled to the store's NOCASE keeps
   `collationExplicit` unset → contributes rank 1 → never falsely conflicts.
   Place this in `createTable` ONLY, never in `buildTableSchemaFromAST` or the
   `importTable`/rehydrate path — reload must not reject an already-persisted
   schema (a legacy conflicting FK reloads fine and still surfaces at DML).

2. **ADD CONSTRAINT** — `runtime/emit/add-constraint.ts`
   `runAddConstraintViaModule`, after `module.alterTable` returns
   `updatedTableSchema` and before `schema.addTable`. Identify the newly added
   FK(s) — the entries in `updatedTableSchema.foreignKeys` not present by
   reference in `tableSchema.foreignKeys` — and validate each. (Both modules'
   `addConstraint` flow through here; the module-side
   `validateForeignKeyOverExistingRows` stays where it is — it needs a row
   scan, this doesn't.)

3. **ADD COLUMN** — `runtime/emit/alter-table.ts` `runAddColumn`, after
   `resolvedForeignKeys` is computed (child index resolved into the live
   schema, ~line 477) — validate each entry alongside the existing
   `validateForeignKeyOverExistingRows` loop (~line 555), using
   `enhancedTableSchema` (the schema that carries the new column) as
   `childSchema`. Validate-before-swap, matching the existing ordering.

4. **Declarative apply** — the schema-differ emits CREATE TABLE / ALTER … ADD
   COLUMN / ALTER … ADD CONSTRAINT statements that re-execute through the three
   paths above, so it is covered transitively. Add a declarative test, but no
   new call site.

### Not gated on `foreign_keys` pragma

`validateForeignKeyOverExistingRows` early-returns when `foreign_keys` is off,
because it's an enforcement concern. A conflicting-collation declaration is a
**malformed declaration** — same class as the child/parent column-count
mismatch, which the builders reject unconditionally. So this check is
unconditional too (a contradictory schema is rejected whether or not
enforcement is currently enabled). Document this in the ticket comment.

## Edge cases & interactions

- **Forward-declared parent (parent created after child).** Parent unresolvable
  at child-declare time → validator skips → child creates. The conflict still
  surfaces at first DML against the child (unchanged enforcement path). This is
  the one unavoidable residual: the parent column types aren't knowable yet.
  We do NOT add parent-create-side re-validation (out of scope; child-side-only
  mirrors how `validateForeignKeyOverExistingRows` already works). Cover with a
  test that asserts forward-ref CREATE succeeds and the first INSERT errors.
- **Self-referencing FK.** Child column references a PK column on the same
  table with a divergent declared collation. Validator must resolve parent =
  `childSchema` (the table isn't in the catalog yet at CREATE), so it fires at
  CREATE, not DML.
- **Multi-column FK.** Validate each `(childCol, parentCol)` pair independently;
  a conflict on any one pair rejects.
- **Reconciled implicit PK (store).** `create table p (k text primary key)
  using store` reconciles `k` to NOCASE without `collationExplicit` → rank 1.
  A child `c text references p(k)` (defaulted BINARY) must NOT conflict. Pin in
  the store conformance/test:store path.
- **Declared `COLLATE BINARY` is a real preference.** Child `c text collate
  binary references p(k)` where `p.k` is `collate nocase` → conflict (rank-2
  BINARY vs rank-2 NOCASE).
- **Matching collations / one-sided declaration → no conflict.** nocase/nocase
  resolves; nocase/defaulted resolves to nocase. Both must succeed.
- **Reload / `importTable` must not validate.** A database persisted before
  this change that holds a conflicting FK must reload without error (the call
  lives in `createTable`, not the shared builder or import path). Add a
  rehydrate test if practical, or at minimum keep the call out of the import
  path by construction.
- **`foreign_keys = off`.** CREATE with a conflicting FK still rejects
  (declaration error, unconditional). Test both pragma states.
- **Lockstep with enforcement.** A divergent explicit COLLATE on non-text
  columns is flagged here because enforcement would also throw. Don't add
  textuality gating that would let the create-time check and DML-time check
  disagree.
- **Partial-failure ordering.** At ADD COLUMN / ADD CONSTRAINT, the validator
  throws BEFORE the live schema is swapped (validate-before-mutate), so a
  rejected ALTER leaves the table untouched. At CREATE, throwing before
  `addTable` (self-ref uses `childSchema` directly) leaves the catalog clean;
  if you instead validate after `addTable`, you MUST `removeTable` on conflict —
  prefer before-addTable.

## TODO

### Phase 1 — validator + wiring
- Add `validateForeignKeyCollations(db, childSchema, fk)` to
  `constraint-builder.ts` per the design (self-ref parent resolution,
  forward-ref skip, count-mismatch skip, per-pair lattice check, named error).
- Import `columnSchemaToScalarType` and `resolveComparisonCollation` into
  `constraint-builder.ts`.
- Wire CREATE TABLE: `manager.ts` `createTable`, loop
  `completeTableSchema.foreignKeys` before `addTable`.
- Wire ADD CONSTRAINT: `add-constraint.ts` `runAddConstraintViaModule`, validate
  the newly added FK(s) before `schema.addTable`.
- Wire ADD COLUMN: `alter-table.ts` `runAddColumn`, validate each
  `resolvedForeignKeys` entry (childSchema = `enhancedTableSchema`) before the
  schema swap.
- Optionally export `validateForeignKeyCollations` from `index.ts` for symmetry
  with `validateForeignKeyOverExistingRows` (not required by current call sites,
  which are all in engine `src/`).

### Phase 2 — tests
- New logic file `packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic`
  (memory module) covering: CREATE-time conflict (declared nocase child vs
  declared rtrim parent PK) errors; matching collations OK; one-sided
  declaration OK; declared-BINARY-vs-declared-NOCASE conflict; ADD CONSTRAINT
  conflict errors; ADD COLUMN conflict errors; self-referencing FK conflict
  errors at CREATE; forward-ref CREATE succeeds + first INSERT errors;
  multi-column FK conflict on one pair.
- A declarative-schema test (apply a schema diff that introduces a conflicting
  FK rejects) — extend `test/logic/50*.sqllogic` or `declarative-equivalence`.
- Store-path coverage (`yarn test:store`, or the store conformance specs):
  reconciled implicit-default PK does NOT falsely conflict with a defaulted
  child column; an explicit divergent collation DOES conflict. Reuse the
  existing store create/alter conformance harness if it fits.
- (Optional) a focused unit test constructing two `TableSchema`s and asserting
  `validateForeignKeyCollations` throws/passes, if a lightweight db/schemaManager
  stub is available; otherwise rely on sqllogic.

### Phase 3 — docs
- `docs/types.md` § Comparison collation resolution: note that an FK's
  child/parent column collations are validated through the same lattice at
  declaration time (CREATE / ALTER), with the forward-ref residual called out.
- `docs/schema.md` FK section: document the declaration-time collation check and
  its unconditional (pragma-independent) nature.

### Validation
- `yarn build` then `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/q.log; tail -n 80 /tmp/q.log`.
- Lint the touched package (single-quote globs on Windows).
- `yarn test:store` for the store-reconcile edge cases (stream output; if it
  routinely exceeds ~10 min, run only the relevant conformance spec).
