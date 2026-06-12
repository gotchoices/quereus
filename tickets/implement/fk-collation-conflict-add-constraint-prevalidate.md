description: Move the ADD CONSTRAINT FK collation-conflict check ahead of module.alterTable in runAddConstraintViaModule, so a rejected ALTER … ADD CONSTRAINT FOREIGN KEY never reaches the store module's saveTableDDL/updateSchema. Today the validator runs AFTER module.alterTable returns; on the store backend the conflicting FK is already persisted to disk by the time the throw fires, so the engine catalog stays clean but the persisted catalog rehydrates the rejected FK on the next reopen.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts            # runAddConstraintViaModule: relocate the validator to BEFORE module.alterTable
  - packages/quereus/src/schema/constraint-builder.ts              # buildForeignKeyConstraintSchema + validateForeignKeyCollations (both exported; no change needed)
  - packages/quereus-store/src/common/store-module.ts:1180-1221    # addConstraint arm: updateSchema + saveTableDDL run before alterTable returns (no change needed)
  - packages/quereus/src/vtab/memory/layer/manager.ts:2276         # memory addForeignKeyConstraint builds FK the same way (confirms equivalence)
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic  # § 8 / § 8.1 cover in-session ALTER; no store-reopen coverage
  - packages/quereus-store/test/column-coercion.spec.ts:141-175    # reopen-test pattern: db1/mod1 → db2/mod2 + rehydrateCatalog against shared provider
difficulty: medium
----

## Background

`runAddConstraintViaModule` (`packages/quereus/src/runtime/emit/add-constraint.ts:81`)
currently validates a newly-added FK's child/parent collation pairing **after**
`module.alterTable` returns:

```
const updatedTableSchema = await module.alterTable(...);   // store: already updateSchema'd + saveTableDDL'd
const priorFks = new Set(tableSchema.foreignKeys ?? []);
for (const fk of updatedTableSchema.foreignKeys ?? []) {
  if (priorFks.has(fk)) continue;
  validateForeignKeyCollations(rctx.db, updatedTableSchema, fk);   // throws here
}
schema.addTable(updatedTableSchema);                       // never reached on conflict
```

The throw precedes `schema.addTable`, so the **engine** SchemaManager never
receives the rejected FK — in-session the rejection is clean on both backends.
But the **store** module's `addConstraint` arm
(`packages/quereus-store/src/common/store-module.ts:1195-1211`) does
`table.updateSchema(updatedSchema)` + `await this.saveTableDDL(updatedSchema)`
*before* returning. So on the store backend the conflicting FK is already on disk
when the validator throws. The engine catalog is clean, but on the next store
reopen the persisted FK rehydrates (rehydrate intentionally does not re-validate —
the "reload must not reject" rule) and the conflict surfaces only at the first DML
against the child. A "rejected" ALTER thus half-succeeds on the persisted catalog.

This is ADD-CONSTRAINT-specific: CREATE TABLE validates before `addTable` with
nothing persisted yet, and ADD COLUMN validates inside its try/revert region.

## Fix

Pre-build the FK schema from the AST constraint against the **prior**
`tableSchema`'s `columnIndexMap` and validate **before** calling
`module.alterTable`. The FK's child columns already exist on the table at ADD
CONSTRAINT time, so resolution against the prior schema is well-defined.

This is exactly equivalent to today's post-call check, just relocated: both store
(`store-module.ts:1196`) and memory (`vtab/memory/layer/manager.ts:2277`) build
the FK via `buildForeignKeyConstraintSchema(constraint, oldSchema.columnIndexMap,
name, schemaName)` — the same helper, the same `columnIndexMap` (the prior
schema's), so the pre-built FK's column indices are identical to the
module-returned FK's. `validateForeignKeyCollations(db, childSchema, fk)` indexes
`childSchema.columns[fk.columns[i]]`, which is well-defined against `tableSchema`
(the prior schema) since the child columns pre-exist.

Sketch (replacing the post-call loop at `add-constraint.ts:102-113`):

```
import { buildForeignKeyConstraintSchema, validateForeignKeyCollations } from '../../schema/constraint-builder.js';

// Only FK ADD CONSTRAINT has a collation pairing; UNIQUE has none.
// Pre-validate so a conflict is rejected BEFORE any module persistence side effect
// (store: saveTableDDL/updateSchema run inside alterTable). The FK's child columns
// already exist on `tableSchema`, so resolution against the prior schema is defined.
if (constraint.type === 'foreignKey') {
  const fk = buildForeignKeyConstraintSchema(
    constraint,
    tableSchema.columnIndexMap,
    tableSchema.name,
    tableSchema.schemaName,
  );
  validateForeignKeyCollations(rctx.db, tableSchema, fk);
}

const updatedTableSchema = await module.alterTable(rctx.db, ...);
// (post-call validation loop removed — pre-validation is the single rejection point)
schema.addTable(updatedTableSchema);
```

Notes for the implementer:
- **Remove** the existing post-call `priorFks` loop (`add-constraint.ts:102-113`).
  Pre-validation is the single, authoritative rejection point; keeping both is
  redundant (DRY). The reference-based new-FK selection that the loop used (the
  `priorFks` Set) goes away with it.
- `AddConstraintNode['constraint']` is an `AST.TableConstraint`
  (`add-constraint-node.ts:17`); `buildForeignKeyConstraintSchema` guards
  `con.type !== 'foreignKey'` internally, but the `if (constraint.type ===
  'foreignKey')` gate above keeps UNIQUE ADD CONSTRAINT off this path entirely.
- This removes the dependency on `foreign_keys = OFF` to make the
  declaration-time check the rejecting mechanism: with pre-validation the conflict
  is caught before the module's existing-row scan (`validateForeignKeyOverExistingRows`)
  ever runs. The module-side existing-row validator stays exactly where it is — it
  needs a row scan; this is a pure schema check.
- Self-referencing FK at ADD CONSTRAINT: the table is already registered, so
  resolution works either way; `validateForeignKeyCollations` also handles the
  self-ref short-circuit. No special handling needed.

## Testing

Two layers:

1. **`packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic`** — § 8 (conflict
   rejected) and § 8.1 (matching collations not rejected) must keep passing on
   both backends. With pre-validation the § 8 rejection no longer *depends* on
   `pragma foreign_keys = false`; you may simplify/annotate the § 8 comment block
   (which currently explains the OFF requirement) but keep the assertions. Do not
   remove § 8.1 — it still guards that a matching-collation ADD CONSTRAINT is left
   alone and the FK stays live/enforced.

2. **New store-reopen spec** (the sqllogic harness has no reopen primitive). Add a
   case to a `packages/quereus-store/test/*.spec.ts` (a new
   `fk-collation-conflict-reopen.spec.ts`, or fold into an existing alter spec)
   using the established reopen pattern from `column-coercion.spec.ts:141-175`:
   - shared in-memory provider (`createInMemoryProvider()` → `InMemoryKVStore`),
   - db1 + `StoreModule(provider)`: create parent + child, attempt the conflicting
     `alter table … add constraint … foreign key …`, assert it throws,
   - db2 + a fresh `StoreModule(provider)`, `await mod2.rehydrateCatalog(db2)`,
   - assert the rehydrated child table has **no** conflicting FK — e.g. the table's
     `foreignKeys` is empty, and/or a DML INSERT against the child that the
     rejected FK would have blocked now succeeds (proving the FK is truly absent
     from the persisted catalog, not merely dormant).

   Confirm the failing-then-reopen assertion holds **before** the fix would be a
   red test (FK present on reopen) and **after** the fix is green (FK absent).

## Validation

- `yarn workspace @quereus/quereus run build` (or `yarn build`) — type-check the emit change.
- `yarn test` — memory-backed logic suite (covers 41.1 § 8 / § 8.1 on memory).
- `yarn workspace @quereus/quereus-store test` — runs the new store-reopen spec
  (and the store unit specs). Stream output: `… 2>&1 | tee /tmp/store-test.log; tail -n 80 /tmp/store-test.log`.
- `yarn test:store` re-runs the quereus logic suite against LevelDB (slower) — run
  if you want 41.1 § 8 / § 8.1 exercised on the real store path; otherwise the new
  spec + memory suite is sufficient for agent-time validation. Note its wall-clock;
  defer to CI if it approaches the idle limit.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).

## TODO

### Phase 1 — fix
- [ ] In `runAddConstraintViaModule` (`add-constraint.ts`), add the FK
      pre-validation block before `module.alterTable` (import
      `buildForeignKeyConstraintSchema`; `validateForeignKeyCollations` is already
      imported).
- [ ] Remove the post-call `priorFks` validation loop (`add-constraint.ts:102-113`).

### Phase 2 — tests
- [ ] Add the store-reopen spec under `packages/quereus-store/test/` per the
      pattern above; verify it is red without the fix and green with it.
- [ ] Re-run 41.1 § 8 / § 8.1 on both backends; annotate the § 8 comment to reflect
      that the OFF gate is no longer load-bearing for the rejection.

### Phase 3 — validate
- [ ] build + `yarn test` + `yarn workspace @quereus/quereus-store test` + lint, streaming output.
- [ ] Update `docs/schema.md` (or wherever the FK declaration-time validation is
      documented from the create-time-validation ticket) to note that ADD CONSTRAINT
      now rejects before any persistence side effect, matching CREATE/ADD COLUMN.

## Handoff notes for review

- The change is a relocation, not a new rule — the collation lattice and error
  message are unchanged. The review focus is: (a) the pre-built FK's column indices
  match the module-built FK's (they do, by shared helper + shared columnIndexMap),
  and (b) nothing else depended on the post-call loop's `updatedTableSchema`-based
  validation.
- One residual is unchanged and intended: a forward-declared (not-yet-created)
  parent can't be collation-checked at declare time and stays caught at first DML
  (41.1 § 10). ADD CONSTRAINT's parent must already exist, so this residual does
  not apply to this path in practice.
