description: Relocate the ADD CONSTRAINT FK collation-conflict check ahead of module.alterTable in runAddConstraintViaModule, so a rejected ALTER … ADD CONSTRAINT FOREIGN KEY never reaches the store module's saveTableDDL/updateSchema and can no longer rehydrate a "rejected" FK on the next reopen.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts            # runAddConstraintViaModule: pre-validation BEFORE module.alterTable; post-call priorFks loop removed
  - packages/quereus/src/schema/constraint-builder.ts              # buildForeignKeyConstraintSchema + validateForeignKeyCollations (both exported; unchanged)
  - packages/quereus-store/src/common/store-module.ts:1180-1221    # addConstraint arm: updateSchema + saveTableDDL run inside alterTable (the persistence side effect the reorder front-runs)
  - packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts  # store-reopen regression spec (red pre-fix, green post-fix)
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic   # § 8 comment annotated; § 8.2/8.3/8.4 ADD CONSTRAINT cases ADDED in review
  - docs/schema.md:124-148                                         # FK collation validation: "before any persistence side effect" on all paths
----

## What shipped

The ADD CONSTRAINT FK collation-conflict check is now a **pre-validation**: in
`runAddConstraintViaModule` (`add-constraint.ts`) it runs **before**
`module.alterTable`, replacing the prior **post-call** `priorFks` loop that ran
after the module returned. The FK is pre-built from the AST constraint against the
**prior** `tableSchema.columnIndexMap` via the already-exported
`buildForeignKeyConstraintSchema`, then checked with `validateForeignKeyCollations`.
With pre-validation the conflict is rejected before the store module's
`updateSchema` + `saveTableDDL` (which run inside `alterTable`), so a rejected
ALTER leaves the persisted catalog untouched and nothing rehydrates on reopen.

This closes the major finding the prior review filed
(`fk-collation-conflict-create-time-validation` → "Store ADD CONSTRAINT persists
the rejected FK to disk before the engine validates"). The collation lattice and
the error message are unchanged — only the call site moved.

## Review findings

Adversarial pass over commit `6bb39d06`. Read the full diff first, then the
implementation, the three other `validateForeignKeyCollations` call sites, the
store/memory addConstraint arms, and the docs.

### Verified correct (no change needed)
- **Behavior-equivalence of the reorder (central claim).** Both the store
  (`store-module.ts:1196`) and memory (`manager.ts:2277`) addConstraint arms build
  the FK via the *same* `buildForeignKeyConstraintSchema(constraint, <prior>.columnIndexMap,
  name, schema)`. The pre-built FK's child indices are therefore identical to the
  FK the module would return. `validateForeignKeyCollations` reads only `fk.columns`
  (child indices) and resolves the parent via `fk.referencedTable`/`referencedSchema`
  against the live catalog (or `childSchema` itself for a self-ref); the FK `name`
  only feeds error text. Child columns pre-exist on the prior `tableSchema`, so
  resolution is well-defined. **Confirmed equivalent.**
- **Single authoritative rejection point.** All three `validateForeignKeyCollations`
  call sites are distinct operations with no overlap: CREATE (`manager.ts:2433`,
  before `addTable`), ADD COLUMN (`alter-table.ts:558`, inside the validate-before-swap
  revert region), ADD CONSTRAINT (`add-constraint.ts:114`, before `module.alterTable`).
  ALTER … ADD CONSTRAINT routes only through `AddConstraintNode → emitAddConstraint
  → runAddConstraintViaModule` — no duplicate path. The removed `priorFks`
  reference-Set is fully gone; nothing else depended on the post-call
  `updatedTableSchema`-based validation.
- **Secondary benefit, newly noted: a latent memory-side divergence is also closed.**
  Pre-fix, on an FK-OFF conflict the memory manager's `addConstraint` returned
  *successfully* (the existing-row validator early-returns, then it commits
  `this.tableSchema = newSchema`), so the post-call throw in the emit layer left the
  memory module's cached schema carrying the rejected FK while the engine catalog
  stayed clean — its catch/restore (`manager.ts:2188`) only fires on a throw *inside*
  `addConstraint`. Post-fix, pre-validation throws before `module.alterTable` is ever
  called, so neither backend's module ever sees the rejected constraint. The fix is
  thus strictly cleaner for memory too, not only a store-persistence fix.
- **Docs accuracy.** `docs/schema.md:130-141` now states the check runs "before any
  persistence side effect" on every path; cross-checked against all three call sites
  — accurate.

### Found and fixed in this pass (minor)
- **Three ADD CONSTRAINT-path coverage gaps the implementer honestly flagged are now
  pinned** in `41.1-fk-collation-conflict.sqllogic` (added § 8.2 / § 8.3 / § 8.4):
  - **§ 8.2 — FK-ON ADD CONSTRAINT conflict** asserts `conflicting collations`. This
    locks the message-consistency improvement the reorder introduced: with
    `foreign_keys = ON` the conflict is now caught by the declaration-time
    pre-validation (before the module's existing-row scan), so it surfaces as
    `conflicting collations` instead of the pre-fix enforcement-seam `ambiguous
    collation`. § 8 already pins the FK-OFF message; this was previously unpinned.
  - **§ 8.3 — self-referencing ADD CONSTRAINT FK conflict** (mirrors § 6 / CREATE).
  - **§ 8.4 — multi-column ADD CONSTRAINT FK conflict** (mirrors § 7 / CREATE).
  All three pass on **both** the memory backend and the real LevelDB store path
  (`QUEREUS_TEST_STORE=true`), which also covers the store-path 41.1 run the
  implement stage had deferred to CI.

### Accepted as-is (not blocking, documented)
- **Count-mismatch / column-not-found ADD CONSTRAINT errors now surface before
  `module.alterTable`** rather than from inside it. Same helper, same error text,
  strictly fewer side effects — a beneficial reorder of those error paths. No new
  test added: the message is byte-identical to the module's (both call the same
  `buildForeignKeyConstraintSchema`), so a test would pin nothing the existing
  builders don't already cover.
- **Forward-declared-parent residual is unchanged and intended:** an ADD CONSTRAINT
  FK to a not-yet-created parent skips the collation check (parent types unknown) and
  stays caught at first DML — same residual as CREATE (41.1 § 10). In practice ADD
  CONSTRAINT's parent already exists, so this rarely applies.

### Not found
- No correctness, type-safety, resource-cleanup, or error-handling defects in the
  diff. Transaction/rollback semantics are unchanged: the pre-validation throw, like
  the prior post-call throw, propagates to the caller for transaction handling; the
  only difference is that it now precedes — rather than follows — the module's
  persistence, which is the entire point of the fix.

## Validation performed (all green)
- `yarn workspace @quereus/quereus run build` — EXIT 0
- `yarn workspace @quereus/store run build` — EXIT 0
- `yarn workspace @quereus/quereus lint` — EXIT 0
- `yarn workspace @quereus/quereus test` (memory) — **5978 passing, 9 pending, 0 failing**
- `yarn workspace @quereus/store test` — **546 passing** (includes the reopen spec;
  console noise is expected negative-path rehydrate logging, not failures)
- `41.1-fk-collation-conflict.sqllogic` on memory — pass (incl. new § 8.2/8.3/8.4)
- `41.1-fk-collation-conflict.sqllogic` on **LevelDB store** (`QUEREUS_TEST_STORE=true`)
  — pass (closes the store-path 41.1 coverage the implement stage deferred)
