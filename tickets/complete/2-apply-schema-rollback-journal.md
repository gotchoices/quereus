description: When applying a declared schema fails partway, the database is now put back the way it was instead of being left half-migrated — so tightening a rule that the existing data violates no longer leaves the table with no rule at all.
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts      # runBatchedMigrationLoop → runStepsWithUndoJournal / executeMigrationStep / unwindJournal / describeIrreversible
  - packages/quereus/src/schema/catalog-rendering.ts             # renderCatalogForRestoreCheck
  - packages/quereus/src/core/database-events.ts                 # discardSchemaEventsSince compacts in place
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts         # doc comment on the conditional carve-out
  - packages/quereus/src/vtab/module.ts                          # endSchemaBatch contract (+ review NOTE on the unrestorable case)
  - packages/quereus/test/apply-schema-restore.spec.ts           # + savepoint-release case, + snapshot-survives case (review)
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts
  - packages/quereus/test/schema-batch-hook.spec.ts
  - packages/quereus/test/declarative-equivalence.spec.ts
  - packages/quereus/test/schema/differ-undo-plan.spec.ts
  - docs/schema.md, docs/schema-undo-plan.md, docs/sql-alter.md, docs/schema-rename-detection.md, docs/module-events.md, docs/usage.md
difficulty: hard
----
# Restore the catalog when a migration fails partway — complete

## What landed (implement stage)

`apply schema` passes the pre-apply catalog to `generateMigrationPlan`, so every step carries its undo, and runs the plan under an undo journal inside the module batch. On a failing step the journal runs in reverse, the catalog is re-collected and its `renderCatalogForRestoreCheck` rendering compared to the pre-apply one, `endSchemaBatch(error)` fires, and the step's own `Failed to execute DDL: …` error is rethrown unchanged with every schema event since the apply's watermark retracted. The residual: a step the differ marked `irreversible` (`DROP TABLE`, `DROP COLUMN`, `SET DATA TYPE`) poisons the journal before it runs; a failure at or after it throws a wrapped error naming the step, with the original as `cause`, and the landed steps' events are kept. The same wrapped shape covers an undo statement that throws and a post-unwind fingerprint mismatch.

Two deliberate deviations from the ticket text, both accepted in review: the restore check blanks a table's and a view's `ddl` text (constraint storage order moves on re-add; view text is rewritten by rename propagation — the structured fields carry everything an undo can touch), and the `declarative-equivalence.spec.ts` tightening case had pinned the old non-atomic behaviour and was rewritten.

## Review findings

**Read first:** the implement-stage diff (`ff90a50ba`) in full, then every source file and doc it touched, then the differ's undo arms (`UndoRenderer`, every `statements.push` site in `generateMigrationPlan`), the event emitter's batching lifecycle (`startBatch` at transaction begin, savepoint layers, `discardSchemaEventsSince`), and the strict DDL policy gate.

**Checked and confirmed correct (no change needed):**
- Every push site in `generateMigrationPlan` attaches an undo when a catalog is passed, so `describeIrreversible`'s `no undo was recorded for it` fallback is unreachable by construction — kept as a defensive default, not a bug.
- The event watermark is a lifetime-monotonic stamp taken before any step can batch; batching is on for both explicit and implicit (autocommit) transactions, and the discard walks every savepoint layer by stamp. A restored apply inside a released savepoint is now pinned (added test, both producer paths).
- In-place compaction in `discardSchemaEventsSince` writes only to indices at or below the read cursor, so it is safe over the shared arrays and keeps their identity.
- Under `ddl_transaction_policy = strict` an undo is the same class of DDL as its forward step (module-dispatching ↔ module-dispatching; `SET TAGS` is exempt on both sides), so the "no new exposure" claim holds by construction. One shape is tested; that is adequate.
- The applied-state snapshot claim is now tested (added: a snapshot recorded before a restored failure is unchanged afterwards, still describes the live catalog, and the original declaration re-applies as a no-op).
- `renderCatalogForRestoreCheck` is rendered once per migrating apply (before the loop, not only on failure); one extra rendering against a migration is negligible.
- `unwindJournal` treating a catalog re-collect throw as "not restored" keeps the loop's never-throws contract honest.

**Minor, fixed inline:**
- `runBatchedMigrationLoop` had dropped the previous catch-all: an unanticipated throw out of `runStepsWithUndoJournal` would have reached `endSchemaBatch` with `error` undefined, so a batching module would have committed its overlay while the apply propagated as failed. Restored a `catch` that records the thrown value as the loop error before rethrowing.
- The `endSchemaBatch` contract in `module.ts` and step 3 of docs/schema-undo-plan.md said "either way the substrate agrees with the catalog" without carving out the unrestorable verdict, where no unwind ran and a discarding module would rewind a substrate the catalog still describes as migrated. Reworded, and parked the concern as a `NOTE:` tripwire on the contract (no built-in module discards; the store module has no batch hooks). This disagreement predates the ticket — before it, every failure had that shape.
- docs/schema-undo-plan.md step 4 said an unrestorable failure's events "are kept" without saying that in autocommit the failed statement's implicit rollback drops them, as it does for any failed DDL whose catalog change escaped. Added the clause with a link to usage.md, which states the general rule.

**Major:** none. The undo-journal design retires the class ("a failed apply leaves 1..N-1 applied") rather than patching an instance, and the residual is bounded to the three data-destroying steps by the differ's own marking.

**Tripwires recorded:**
- `packages/quereus/src/vtab/module.ts` (`endSchemaBatch` doc): a discarding module under an unrestorable failure rewinds a substrate the catalog keeps as migrated; revisit if a module ever implements batch hooks that discard.

**Considered and declined (not filed):**
- The store module lacks batch hooks, so the "discarding module rewinds its substrate" path is exercised only by the recording memory module. Filing bar not met: no module discards today, and the tripwire above marks the site.
- No `auto-commit` tier module exists to test; the tier-independence claim rests on the undo being ordinary DDL. Not filed for the same reason.
- `ViewSchema.sql` is still rewritten body-only by rename propagation and is the one catalog text not rendered canonically from structured state. The restore check no longer depends on it and existing specs read it as-is; a `debt-` ticket would need a consumer that is actually wrong, and none was found.
- The post-unwind mismatch and re-collect-throw branches of `unwindJournal` are not forced by a test; both are three-line branches that only produce the wrapped error, and forcing them needs a module that lies to the catalog. Left uncovered deliberately.

**Validation (review pass):**
- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus test`: 10,724 passing, 25 pending (was 10,721; the three added tests).
- Store leg of the new sqllogic file (`QUEREUS_TEST_STORE=true`, `--grep 50.4`): passing. The full store suite was not re-run; the review changes are a catch-all on an unexercised path, doc text, and two tests.
- `node scripts/check-docs.mjs`: OK (docs/schema.md at 11,780 words, 220 from the cap — the next addition there must split the file).
