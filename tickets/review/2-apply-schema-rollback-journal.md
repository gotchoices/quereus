description: When applying a declared schema fails partway, the database is now put back the way it was instead of being left half-migrated — so tightening a rule that the existing data violates no longer leaves the table with no rule at all.
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts      # runBatchedMigrationLoop → runStepsWithUndoJournal / executeMigrationStep / unwindJournal / describeIrreversible; emitApplySchema header, watermark, snapshot NOTE
  - packages/quereus/src/schema/catalog-rendering.ts             # renderCatalogForRestoreCheck (new) — the post-unwind verification rendering
  - packages/quereus/src/core/database-events.ts                 # discardSchemaEventsSince now compacts in place (its own NOTE said a whole failed migration would trip it)
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts         # doc comment: the carve-out is now the narrow, conditional one
  - packages/quereus/src/vtab/module.ts                          # endSchemaBatch contract: the unwind has already run inside the batch
  - packages/quereus/test/apply-schema-restore.spec.ts           # new — fingerprint, error shape, forced undo failure, residual, events, strict policy
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic  # new — CHECK / UNIQUE / FK tightening + multi-step + in-transaction, both backends
  - packages/quereus/test/ddl-schema-event-atomicity.spec.ts     # partial case rewritten to "announces nothing"; DROP TABLE companion added
  - packages/quereus/test/schema-batch-hook.spec.ts              # end receives the loop error after the unwind; destroy seen inside the batch
  - packages/quereus/test/declarative-equivalence.spec.ts        # the tightening case pinned the OLD behaviour and was rewritten (ticket said "unchanged" — it could not be)
  - packages/quereus/test/schema/differ-undo-plan.spec.ts        # local ddl-blanking fingerprint helper replaced by the shared rendering
  - docs/schema.md                                               # § Failure and restoration (new); applied-state snapshot bullet
  - docs/schema-undo-plan.md                                     # § Restoring a failed apply (new) — the executor detail
  - docs/sql-alter.md                                            # the "not atomic" DROP + ADD sentence corrected
  - docs/schema-rename-detection.md                              # "apply aborts + data survives, not old constraint restored" corrected
  - docs/module-events.md                                        # carve-out paragraph narrowed
  - docs/usage.md                                                # the two apply-schema event paragraphs narrowed
  - tickets/backlog/debt-ddl-event-scope-kept-by-convention.md   # carve-out section rewritten to the conditional form
difficulty: hard
----
# Restore the catalog when a migration fails partway — implemented

## What landed

`apply schema` now passes the pre-apply catalog to `generateMigrationPlan`, so every step carries its undo, and runs the plan under an undo journal. On a failing step the journal runs in reverse (still inside the module batch, before `endSchemaBatch(error)`), the catalog is re-collected and its rendering compared to the pre-apply one, and the step's own `Failed to execute DDL: …` error is rethrown unchanged. Schema events batched since the apply's own watermark are discarded on that verified restore, so a restored apply announces nothing at all.

The residual is as the ticket specified: a step the differ marked `irreversible` (`DROP TABLE`, `DROP COLUMN`, `SET DATA TYPE`) poisons the journal *before* it runs. A later failure — or that step's own failure — throws a wrapped `QuereusError`: the original message, then `The schema is partially migrated and could not be restored: the earlier step \`X\` cannot be undone (reason).` (or `The schema could not be restored: the failing step \`X\` cannot be undone (…), so any partial effect of it stands.`), with the original error as `cause`, and the events of the landed steps are kept. The same wrapped shape covers an undo statement that throws (`undo statement \`Y\` failed (…)` — the unwind stops there) and a post-unwind catalog mismatch.

## Two deviations from the ticket text, both deliberate

**The restore check compares a rendering without the table and view `ddl` text.** The ticket named the view-text instability (`ViewSchema.sql` rewritten to body-only by rename propagation) and offered "blank each view's `ddl`" as a local option. Implementing the tests found the same class on *tables*: `ADD CONSTRAINT` appends, so `DROP CONSTRAINT ck_a` + re-add on a table with `[ck_a, ck_b]` restores `[ck_b, ck_a]`, and `generateTableDDL` (embedded in the comparison rendering as `ddl`) lists constraints in storage order — the motivating constraint-tightening case itself would have reported "could not be restored" on any table with two or more constraints of one class. So the check uses a new `renderCatalogForRestoreCheck` (catalog-rendering.ts): the comparison rendering with a table's and a view's `ddl` blanked. Everything an undo can touch is in the structured fields (columns, PK, tags, named constraints — which the rendering sorts — maintained derivation, the object set); index and assertion `ddl` are canonical and stay in. The ticket's "root fix" alternative (regenerate the full statement in the rename propagation) was not taken: it would not have fixed the table-order case, and it changes what `column-rename-cascade.spec.ts` / `rename-cross-schema.spec.ts` read from `ViewSchema.sql`. The user-visible consequence — exported DDL may list a restored constraint last — is stated in docs/schema.md.

**`declarative-equivalence.spec.ts` was not unchanged.** Its case "a CHECK body change that TIGHTENS against a violating row is refused — and the drop has already happened" asserted the old non-atomic behaviour (`check_constraint_info('t')` empty after the failure). It now asserts the restored constraint is present, still rejects a violating insert, and that the re-diff wants the same DROP + ADD pair.

## Also done while here

`discardSchemaEventsSince` carried a `NOTE` saying its per-event splice would go quadratic if a scope ever spanned "a whole failed migration" — which is exactly what the apply's watermark now does. It compacts each store in place in one pass instead (the arrays are shared with the savepoint-layer bookkeeping, so identity is kept). The existing `database-events.spec.ts` scope tests cover the semantics.

`unwindJournal` also treats a throw from re-collecting the catalog as "not restored" rather than letting it escape past `endSchemaBatch` — that keeps `runStepsWithUndoJournal`'s "never throws" contract honest, so end-batch always sees the step's original error.

## Use cases for review

- **Constraint tightening against a violating row** (CHECK / UNIQUE / FK) — `50.4-declare-schema-apply-restore.sqllogic` §1–3 on both backends; `apply-schema-restore.spec.ts` § "constraint tightening" with a second constraint of the same class so the storage-order shift is exercised and pinned. Assertions are presence *and* enforcement (a violating insert is refused, a row legal under the old rule is accepted).
- **Multi-step migration** (create table, create index, then a failing ADD COLUMN) — strict `renderCatalogForComparison` equality, the added table absent, `diff schema` reproduces the original plan; the same inside `begin … commit` with the transaction still usable afterwards; a later apply of the same declaration still migrates.
- **First step fails** — the original error passes through with no "could not be restored" text.
- **Destructive residual** — a failure after `DROP TABLE` names the irreversible step and carries the original as `cause`; an irreversible step that itself fails (a `SET DATA TYPE` over `'not a number'`) is reported as unrestorable, not restored.
- **Forced undo failure** — a memory module whose `destroy` refuses `n1` makes the undo of `create table n1` fail; the wrapped error carries both, and `n1` is still there (the unwind stopped).
- **Schema events**, both producer paths (engine fallback and emitter-backed module), inside an explicit transaction with a committed sibling write: restored → `[]`; unrestorable → `['drop/table/old', 'create/table/n1']`; success unchanged.
- **Strict DDL policy** — `DROP VIEW v` lands, `CREATE TABLE n1` is refused under `strict` inside `begin`; the view is back and the transaction commits.
- **Batch hooks** — `endSchemaBatch` receives the loop error *after* the unwind; the undo's `destroy` is observed with the batch still active.

## Known gaps — treat as a floor

- **No test of a store-backed module with batch hooks under a restore.** The store module does not implement `beginSchemaBatch` / `endSchemaBatch` (only the isolation wrapper delegates them), so the "discarding module rewinds its substrate" path the module.ts contract text describes is exercised only by the recording memory module in `schema-batch-hook.spec.ts`. The store leg of the sqllogic file covers the non-batching path for real.
- **Not tested: an `auto-commit` tier module.** No built-in module declares that tier; the tier-independence claim in the docs rests on the undo being ordinary DDL, not on a test.
- **The strict-policy test covers one shape** (a non-module-dispatching step followed by a refused one). The argument that no *new* exposure exists — an undo dispatches to the same module as its forward step — is reasoning, not a matrix.
- **Not tested: a restored failure inside a released or rolled-back savepoint.** `discardSchemaEventsSince` walks every layer by stamp and `database-events.spec.ts` pins that at the emitter level, but no apply-level case does.
- **The `ViewSchema.sql` rewrite by rename propagation is still there.** The restore check no longer depends on it, but the catalog's view `ddl` remains the one catalog text not rendered canonically from structured state (tables, indexes and assertions all are). A reviewer may want that as a `debt-` ticket; it is out of this ticket's scope and not needed for the guarantee.
- **The applied-state snapshot claim** ("a snapshot recorded by an earlier apply stays valid across a restored failure") is argued in the NOTE and docs, not tested — the fast-path spec's plant-a-lying-snapshot technique would be the way to pin it.

## Validation

- `yarn workspace @quereus/quereus test`: 10,721 passing, 25 pending (was 10,701 before this ticket).
- `yarn test:store`: 10,713 passing, 33 pending (the `50.4` file included).
- `yarn workspace @quereus/quereus run lint` (eslint + test-file type check): clean.
- `node scripts/check-docs.mjs`: OK. `docs/schema.md` is now 11,780 words (220 from the cap) — the new subsection was kept short and the executor detail placed in `docs/schema-undo-plan.md` (1,510 words) for that reason.
- `npx tsc -b tsconfig.build.json` (library rebuild, so the sibling packages test against the new engine), then the three suites that use `apply schema` through the built engine: `quereus-isolation` 427 passing, `quereus-store` 1,958 passing, `quereus-sync` 755 passing. The other workspaces (CLI, web, plugins, sync client, coordinator) were not run; nothing in them touches the migration loop.
