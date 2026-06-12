description: Relocate the ADD CONSTRAINT FK collation-conflict check ahead of module.alterTable in runAddConstraintViaModule, so a rejected ALTER … ADD CONSTRAINT FOREIGN KEY never reaches the store module's saveTableDDL/updateSchema. Previously the validator ran AFTER module.alterTable returned; on the store backend the conflicting FK was already persisted to disk by the time the throw fired, so a "rejected" ALTER half-succeeded on the persisted catalog and rehydrated the conflicting FK on the next reopen.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts            # runAddConstraintViaModule: pre-validation moved BEFORE module.alterTable; post-call priorFks loop removed
  - packages/quereus/src/schema/constraint-builder.ts              # buildForeignKeyConstraintSchema + validateForeignKeyCollations (both exported; unchanged)
  - packages/quereus-store/src/common/store-module.ts:1180-1221    # addConstraint arm: updateSchema + saveTableDDL run inside alterTable (unchanged — this is the persistence side effect the reorder front-runs)
  - packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts  # NEW store-reopen regression spec (red pre-fix, green post-fix)
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic   # § 8 comment annotated (OFF gate no longer load-bearing); § 8 / § 8.1 assertions unchanged
  - docs/schema.md:124-148                                         # FK collation validation paragraph: "before any persistence side effect" on all paths
----

## What shipped

The ADD CONSTRAINT FK collation-conflict check is now a **pre-validation**: in
`runAddConstraintViaModule` (`add-constraint.ts`) it runs **before**
`module.alterTable`, replacing the prior **post-call** `priorFks` loop that ran
after the module returned. The FK is pre-built from the AST constraint against the
**prior** `tableSchema.columnIndexMap` via the already-exported
`buildForeignKeyConstraintSchema`, then checked with `validateForeignKeyCollations`:

```ts
if (constraint.type === 'foreignKey') {
  const fk = buildForeignKeyConstraintSchema(
    constraint, tableSchema.columnIndexMap, tableSchema.name, tableSchema.schemaName,
  );
  validateForeignKeyCollations(rctx.db, tableSchema, fk);
}
const updatedTableSchema = await module.alterTable(rctx.db, …, { type: 'addConstraint', constraint });
schema.addTable(updatedTableSchema);
```

This closes the major finding the prior review filed
(`fk-collation-conflict-create-time-validation` → "Store ADD CONSTRAINT persists
the rejected FK to disk before the engine validates"). The collation lattice and
the error message are unchanged — only the call site moved. With pre-validation
the conflict is rejected before the store module's
`updateSchema` + `saveTableDDL` (which run inside `alterTable`), so a rejected
ALTER leaves the persisted catalog untouched.

### Why the relocation is behavior-equivalent (the central review claim)
Both the store (`store-module.ts:1196`) and memory
(`vtab/memory/layer/manager.ts:2277`) addConstraint arms build the FK via the
**same** `buildForeignKeyConstraintSchema(constraint, <prior>.columnIndexMap, name,
schema)` — the same helper, the same prior-schema `columnIndexMap`. So the
pre-built FK's child column indices are identical to the FK the module would have
returned. `validateForeignKeyCollations` only reads `fk.columns` (child indices)
and resolves the parent via `fk.referencedSchema` (= the `schemaName` arg, matching
the modules' `oldSchema.schemaName`); the FK `name` only feeds error text. The
child columns pre-exist on `tableSchema` at ADD CONSTRAINT time, so resolution
against the prior schema is well-defined.

### Side effects of the reorder (intended, worth the reviewer's eye)
- The post-call `priorFks` reference-Set selection is **gone** entirely. The prior
  review accepted that Set as "acceptable for current modules" (gap #3); it is now
  moot — pre-validation is the single, authoritative rejection point.
- With `foreign_keys = ON`, the conflict is now caught by the **declaration-time**
  pre-validation (`conflicting collations`) **before** the module's existing-row
  scan runs. Pre-fix, an FK-ON ADD CONSTRAINT conflict would instead surface as the
  enforcement-seam `ambiguous collation` error from the existing-row query plan.
  The rejection is unchanged; the **error message is now consistent** across
  pragma states. No sqllogic case asserts the FK-ON ADD CONSTRAINT *conflict* path
  message (§ 8 is FK-OFF; § 8.1 is FK-ON but matching/no-conflict), so this is a
  message change no test pins — flagged below as a coverage note.

## Use cases for testing / validation

### Primary regression: store reopen (NEW spec)
`packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts` — the sqllogic
harness has no reopen primitive, so this exercises the persist → reopen round-trip
directly (pattern from `column-coercion.spec.ts:141-175`):
1. db1 + `StoreModule(provider)`, **`pragma foreign_keys = false`** (the exact
   pre-fix bug path: enforcement off → module's existing-row validator
   early-returns → pre-fix, the post-call collation check was the only rejecting
   mechanism, firing *after* `saveTableDDL`). Create `acp (k text collate rtrim
   primary key)` + `acc (id integer primary key, ref text collate nocase)`, touch
   both to persist DDL, then attempt the conflicting
   `alter table acc add constraint fk_acc foreign key (ref) references acp(k)` —
   assert it throws `/conflicting collations/i`. `await mod1.whenCatalogPersisted()`.
2. db2 + fresh `StoreModule(provider)`, `await mod2.rehydrateCatalog(db2)`.
3. Assert the rehydrated `acc` has **no** FK (`foreignKeys` length 0) — the primary
   authoritative assert — **and** a DML `insert into acc` succeeds (FK truly absent,
   not dormant; pre-fix with the FK present + enforcement on, the insert would throw
   the ambiguous-collation error at plan time).

**Red/green confirmed (not just reasoned):** I temporarily restored the pre-fix
post-call loop, rebuilt, and ran the spec → **RED** (`foreignKeys` length `1`,
expected `0` — the rejected `fk_acc` survived on disk). Restored the fix → **GREEN**.
Build EXIT 0 both times.

### Memory / cross-backend: 41.1 § 8 / § 8.1
Both still pass on memory. § 8 (conflict rejected, FK OFF) and § 8.1 (matching
NOCASE/NOCASE not rejected and the FK stays live/enforced) are unchanged in
assertions; only § 8's comment was updated to record that the OFF gate is no longer
load-bearing for the rejection (pre-validation fires regardless of pragma — OFF is
now kept only to isolate the pure declaration-time check from the enforcement scan).

## Validation performed
- `yarn workspace @quereus/quereus run build` — EXIT 0 (type-checks the emit change).
- `yarn workspace @quereus/quereus test` (memory) — **5978 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/store test` — **546 passing** (includes the new reopen
  spec; the console noise is expected negative-path logging from corrupt-DDL /
  non-deterministic-MV rehydrate tests, not failures).
- `yarn workspace @quereus/quereus lint` — EXIT 0.
- **Not run:** `yarn test:store` (41.1 § 8 / § 8.1 against the real LevelDB store
  path). The new in-memory-provider reopen spec already exercises the store
  addConstraint + rehydrate code path, and the changed sqllogic is comment-only, so
  this was deferred to CI per ticket guidance. A reviewer wanting belt-and-suspenders
  store-path coverage of 41.1 can run it out-of-band.

## Known gaps / suggested review focus (honest floor, not a finish line)
- **No ADD CONSTRAINT conflict test with `foreign_keys = ON`.** The error-message
  consistency improvement (now `conflicting collations` instead of the
  enforcement-seam `ambiguous collation`) is unpinned. A one-line 41.1 addition
  (FK-ON ADD CONSTRAINT conflict asserting `conflicting collations`) would lock it.
  Low risk — the pre-validation is unconditional and already covered FK-OFF.
- **Self-referencing and multi-column ADD CONSTRAINT FK conflicts are not
  exercised on the ADD CONSTRAINT path.** § 6 (self-ref) and § 7 (multi-col) cover
  only CREATE. At ADD CONSTRAINT time the table is already registered, so
  `validateForeignKeyCollations`'s self-ref short-circuit and per-pair loop apply
  unchanged — but neither is directly tested for ADD CONSTRAINT. Equivalence to the
  CREATE path is structural (same helper, same lattice), so I judged additional
  cases optional, not blocking; a reviewer may disagree and want them.
- **`buildForeignKeyConstraintSchema` now runs before `alterTable`**, so its own
  errors (child column not found, child/parent column-count mismatch) now surface
  *before* any module side effect rather than from inside the module. Same error
  text (same helper), strictly fewer side effects — but it is a (beneficial)
  reorder of *those* error paths too, not only the collation one. No test asserts a
  count-mismatch ADD CONSTRAINT, so this reorder is unpinned.
- **Forward-declared parent residual is unchanged and intended:** an ADD CONSTRAINT
  FK to a not-yet-created parent skips the collation check (parent types unknown)
  and stays caught at first DML — same residual as CREATE (41.1 § 10). In practice
  ADD CONSTRAINT's parent usually exists, so this rarely applies here.

## Review focus checklist
- (a) Pre-built FK column indices match the module-built FK's — confirm via the
  shared `buildForeignKeyConstraintSchema` + shared prior-schema `columnIndexMap`
  (store-module.ts:1196 / manager.ts:2277).
- (b) Nothing else depended on the removed post-call loop's
  `updatedTableSchema`-based validation (the `priorFks` Set is fully gone).
- (c) The reopen spec's `foreign_keys = false` choice is load-bearing for the
  *pre-fix* repro (it isolates the persistence bug from the enforcement-seam
  rejection) — confirm it still meaningfully red-tests the persistence path.
