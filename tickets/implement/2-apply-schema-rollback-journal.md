description: When applying a declared schema fails partway, put the database back the way it was instead of leaving it half-migrated — so tightening a rule that the existing data violates no longer leaves the table with no rule at all.
prereq: apply-schema-undo-plan
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts      # emitApplySchema, runBatchedMigrationLoop, beginSchemaBatchAll/endSchemaBatchAll
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts         # withStatementScopedSchemaEvents + the apply carve-out this ticket narrows
  - packages/quereus/src/core/database-events.ts                 # beginSchemaEventScope / discardSchemaEventsSince
  - packages/quereus/src/schema/catalog.ts                       # collectSchemaCatalog
  - packages/quereus/src/schema/catalog-rendering.ts             # renderCatalogForComparison — the restore verification
  - packages/quereus/src/vtab/module.ts                          # beginSchemaBatch / endSchemaBatch contract text
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts     # the partially-applied case changes meaning
  - packages/quereus/test/schema-batch-hook.spec.ts              # batch hooks must still see the loop error, now after the unwind
  - packages/quereus/test/declarative-equivalence.spec.ts        # convergence tests must still pass
  - docs/schema.md                                               # § Declarative Schema — needs a "Failure and restoration" subsection
  - docs/sql-alter.md                                            # § after line 142 — the "not atomic" DROP + ADD paragraph
  - docs/schema-rename-detection.md                              # § Constraint body-change detection — "apply aborts + data survives, not old constraint restored"
difficulty: hard
----
# Restore the catalog when a migration fails partway

## What changes

`apply schema` executes its migration plan under an undo journal. Each step that succeeds pushes its undo DDL (from `MigrationStep.undo`, which ticket `apply-schema-undo-plan` produces). If a step fails, the executor runs the journal in reverse, checks that the catalog really is back where it started, and rethrows the original error. From the caller's point of view the apply either happened or it did not.

The guarantee has one stated residual, and it falls out of physics rather than design: a step that destroyed data (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... SET DATA TYPE`) cannot be taken back, so once one of those has run the apply is no longer restorable. The executor knows this before it runs such a step and says so plainly if a later step then fails. Every other migration — including every case the motivating complaint is about — is all-or-nothing.

## Mechanism

`emitApplySchema` already collects `actualCatalog` before doing anything. Pass it to `generateMigrationPlan` so the plan carries undo, and keep a `renderCatalogForComparison(actualCatalog)` string as the pre-apply fingerprint.

`runBatchedMigrationLoop` becomes:

- **Before executing a step marked `irreversible`, poison the journal.** Poison first, not after: the step may apply partially before it throws, so its own failure must not be treated as restorable either. Once poisoned, stop journaling.
- **After a step succeeds, push its `undo` onto the journal** (nothing to push when `undo` is the empty array).
- **On a step failure with an unpoisoned journal**, run the journal in reverse through `db._execWithinTransaction`, still inside the module batch. Then re-collect the catalog and compare its rendering to the pre-apply fingerprint.
- **Then `endSchemaBatchAll(started, db, schemaName, loopError)` as today**, with the original loop error. A module that discards its batch on error and a module that has no batch hooks both end up at the same place: the discarding module rewinds its substrate to the pre-apply state (the undo DDL it also received is discarded with everything else), the non-batching module has had both the forward and the undo DDL applied for real. Either way the substrate matches the restored catalog.
- **Rethrow.** On a verified restore, rethrow the original error object unchanged. Otherwise throw a `QuereusError` whose message leads with the original message and then states that the schema could not be restored and is partially migrated — naming the last irreversible step that ran, or the undo statement that failed, or the fact that the post-unwind catalog did not match — with the original error as `cause`.

Why an undo journal rather than transactional DDL: the undo statements are ordinary DDL, so this works identically on every module tier (`transactional`, `non-transactional`, `auto-commit`) and needs nothing new from module authors. Raising the built-in backends to the transactional tier is the separate, much larger backlog ticket `feat-transactional-ddl-native-backends`; this ticket deliberately does not depend on it.

## The three questions the plan stage was asked to settle

**Whole-apply rollback, or reorder so failures come first.** Whole-apply rollback, by undo journal. Reordering was rejected because the ticket requires `diff schema` output to stay identical, and the plan's ordering is load-bearing (drops free names for same-name creates; assertion creates must run last). The residual class is named above: the three data-destroying steps, and only those.

**Modules whose DDL is not transactional.** No tier-specific behaviour and no refusal. Undo is issued as DDL, which every tier executes. On an `auto-commit` module the forward DDL may have force-committed the surrounding transaction; the undo DDL commits the same way, so the end state is still the pre-apply catalog. Document the tier-independence rather than adding a gate.

**Explicit transactions.** A failed apply inside `begin ... commit` restores to the pre-apply point and leaves the outer transaction open — savepoint-like behaviour, obtained for free because the undo runs as statements inside that same transaction. Row data written earlier in the transaction is untouched. If the user then commits, the committed schema is the pre-apply schema.

## Schema events

Today `apply schema` is deliberately exempt from `withStatementScopedSchemaEvents` because a partial apply is real and its landed statements must stay announced. That reason now holds only for the unrestorable case, so the carve-out narrows rather than disappears:

- Take the watermark with `emitter.beginSchemaEventScope()` at the top of the apply's `run()`.
- Discard back to it **only when the apply failed and the restore was verified complete** — nothing happened, so nothing is announced.
- On success, or on an unrestorable failure, keep the events. A partially-migrated schema must stay announced exactly as it does today, or a replicating peer diverges from the device it happened on.

Because of that conditional, apply still cannot use the plain `withStatementScopedSchemaEvents` helper. Update the helper's doc comment (`ddl-event-scope.ts`) so the carve-out it describes is the narrow one, and update the "carve-out any solution must keep" section of `tickets/backlog/debt-ddl-event-scope-kept-by-convention.md` to match — that ticket's whole premise cites the old, wider carve-out.

## Edge cases & interactions

- **An undo statement itself throws.** Worst case: the unwind stops mid-way and the schema is in a state neither the user nor the plan ever asked for. Do not swallow it. Stop unwinding, report it inside the wrapped error alongside the original failure, and keep the schema events. Pin it with a test that forces an undo step to fail.
- **The post-unwind catalog does not match the fingerprint.** Treated exactly like an undo failure. This is the cheap self-check that catches a wrong or missing undo arm, including a failing step that left residue of its own (each DDL statement is responsible for its own atomicity; this check is what notices when one is not). It costs one catalog render on the failure path only.
- **The failing step is the first step.** The journal is empty; restore trivially succeeds; the original error passes through untouched.
- **`beginSchemaBatch` itself throws.** Unchanged path — no step ran, nothing to unwind.
- **`endSchemaBatch` throws after a successful unwind.** The existing rule stands: with a loop error in flight the end-batch error is logged and swallowed so the original cause survives.
- **A seed failure (`apply schema ... with seed`).** Seeding runs after the migration loop and is **outside** the guarantee: a seed row that violates a constraint aborts the apply with the migration already applied. Say so in `docs/schema.md`; do not silently imply the whole statement is atomic.
- **The applied-state fast path.** A restored failure records no snapshot (the apply throws first), and a snapshot recorded by an *earlier* apply stays valid precisely because the restore returns the catalog to the state that snapshot describes. The NOTE in `emitApplySchema` that says catalog DDL is not rollback-able and so the snapshot cannot go stale needs rewriting to say this instead.
- **Logical schemas.** The lens deployment path returns long before the migration loop and is already atomic; it gains nothing here and must not regress.
- **`pragma ddl_transaction_policy = 'strict'`.** Undo statements are module-dispatching DDL inside a transaction, like the forward statements. Under strict the forward step would have been refused first, so there is no new exposure — check it, and say so in the docs.
- **Nested event scopes.** Each generated sub-statement opens its own scope inside the apply's. The existing note in `ddl-event-scope.ts` already says the outer failure retracting the inner statement's events is the wanted reading; confirm that still holds with the conditional discard.
- **`feat-apply-schema-persisted-catalog-fingerprint`** (backlog) wants a durable record written atomically with the apply. An apply that either lands or restores is the ground that ticket needs; no change required here beyond not making it harder.
- **`feat-apply-schema-destructive-acknowledgement`** (backlog) would close the residual by refusing an unacknowledged data-destroying plan up front. Deliberately not in scope here — this ticket must not change whether a destructive apply is *allowed*, only what happens when one fails.

## Tests the result must pass

- **Constraint tightening against a violating row**, for each of CHECK, UNIQUE and FOREIGN KEY, on the memory backend and the store backend (`yarn test:store`): the apply fails with the constraint error, the old constraint is still present in the catalog, and it is still *enforced* (a write that violates the old rule is still rejected — presence in the catalog alone is not the assertion).
- **A multi-step migration** — add a table, add a column, then a failing step: after the failure, `renderCatalogForComparison(collectSchemaCatalog(db, 'main'))` equals the pre-apply rendering, the added table does not exist, and re-running `diff schema` produces the original plan.
- **The same cases inside `begin ... commit`**: the restore happens, the transaction is still usable afterwards, and committing leaves the pre-apply schema.
- **The destructive residual**: a plan whose failing step comes after a `DROP TABLE` leaves the schema partially migrated, the error says so and names the irreversible step, and the events for the steps that landed are still delivered.
- **A forced undo-statement failure**: the wrapped error carries both the original cause and the unwind failure.
- **Schema events**: a restored failure announces nothing at all; a successful apply announces what it always did.
- `ddl-schema-event-atomicity.spec.ts` — its partially-applied case (`create table n1` then a failing `ADD COLUMN w NOT NULL`) is now fully reversible, so it must be rewritten to assert the new behaviour: no events, and `n1` absent. Add a companion case containing a `DROP TABLE` that still partially applies, so the residual stays pinned.
- `schema-batch-hook.spec.ts` — `endSchemaBatch` still receives the loop error, now after the unwind has run.
- `declarative-equivalence.spec.ts` — unchanged and still passing.

## TODO

- Thread `actualCatalog` into `generateMigrationPlan` and keep its rendering as the pre-apply fingerprint.
- Add the journal, the poison rule, the reverse unwind and the post-unwind verification to `runBatchedMigrationLoop`.
- Add the wrapped "could not be restored" error, naming which of the three reasons applied.
- Replace the unconditional event exemption with the conditional discard; update `ddl-event-scope.ts`'s doc comment and `tickets/backlog/debt-ddl-event-scope-kept-by-convention.md`'s carve-out section.
- Rewrite the `emitApplySchema` header comment and the applied-state snapshot NOTE, both of which currently assert that there is no catalog rollback.
- Docs: a "Failure and restoration" subsection in `docs/schema.md` § Declarative Schema stating the guarantee, the three irreversible steps, the seed residual and the tier-independence; correct the "not atomic" paragraph in `docs/sql-alter.md`; correct "apply aborts + data survives, not old constraint restored" in `docs/schema-rename-detection.md`.
- Add the tests above; run `yarn test`, `yarn test:store` and `yarn lint`.
