description: When every step of `apply schema` succeeds but a module refuses the closing `endSchemaBatch`, nothing is undone, so the engine's catalog runs the new schema while the module's store holds the old one, and a retry finds no difference and reports success with nothing written.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/vtab/module.ts, packages/quereus/test/schema-batch-hook.spec.ts, docs/schema-undo-plan.md, docs/schema.md
repro: verified
----

# A refused `endSchemaBatch` leaves the apply in place

## What happens

`runBatchedMigrationLoop` unwinds the undo journal only when a step fails. `endSchemaBatchAll` runs in the `finally` after a clean loop, and its throw leaves the function with the journal unused. From there:

- The engine's catalog holds the new schema, and the module's store holds the old one.
- The next `apply schema` diffs against the engine's catalog, finds nothing to do, skips the batch hooks and succeeds.
- The applied-state fast path can then record that result.

This breaks the guarantee in `docs/schema-undo-plan.md` that a failed apply restores the pre-apply catalog or reports that it could not.

## Evidence

Measured by Sereus on `@quereus/quereus` 4.24.0 and `@optimystic/*` 1.24.0. Optimystic coalesces an apply's catalog writes and commits them in `endSchemaBatch`, so a cluster that cannot reach its members refuses there, after every step has succeeded.

| The apply changes | Engine after the refusal | Store writes during the retry | Retry result |
| --- | --- | --- | --- |
| a column tag | new tag | 0 | success |
| a nullable column | new column | 0 | success |
| a new table | new table | 0 | success |
| a new index | new index | 0 | success |
| a dropped column | column gone | 0 | success |

A query routed through the new index then throws `Table 'Note' does not maintain index 'NoteByBody'` until a fresh `Database` is opened.

There is no engine-level reproduction yet. The first test below is that reproduction: a module in `schema-batch-hook.spec.ts` that records DDL and throws from `endSchemaBatch`.

## Proposed change

Treat a throw from `endSchemaBatch` after a clean loop as a failed apply, using the existing "unwind, verify, report" steps. `runStepsWithUndoJournal` has to hand its journal, and the poisoning step if any, back to the caller on a clean run.

1. **Journal poisoned by an irreversible step:** do not unwind. Throw the wrapped "partially migrated" error with the end error as `cause`, and keep the schema events, as a failed step does now.
2. **Journal usable:** call `beginSchemaBatch` on every module again, run `unwindJournal`, then call `endSchemaBatch` with no error.
3. **Verified restore:** discard the schema events since the watermark and rethrow the original end error unchanged. Callers classify that error, so it must keep its identity.
4. **Anything else:** throw the wrapped error with the reason and the end error as `cause`. That covers an undo statement that throws, a fingerprint mismatch, and a `beginSchemaBatch` that throws during the unwind.

**Why the unwind batch ends with no error.** A module whose first commit landed has to commit the undo, and an error would tell a discarding module to throw it away.

**Which refusals of the unwind batch's commit count.** This needs per-module results from `endSchemaBatchAll`:

- **A module whose first `endSchemaBatch` threw:** log the refusal and tolerate it, because that module's store still holds the pre-apply state.
- **A module whose first `endSchemaBatch` succeeded:** report not restored, because its store holds the forward change while the catalog is restored. The fingerprint check cannot see this.

The original end error is always the one reported. If several modules refuse, the first stays the primary error, as it does today.

## Edge cases & interactions

| Case | Expected | Verified by |
| --- | --- | --- |
| Single module refuses, journal usable, and keeps refusing during the unwind | catalog equals the pre-apply fingerprint, the retry re-plans and re-sends the DDL, original error identity kept, no schema events | test |
| Irreversible step earlier in the apply, then a refusal | wrapped error with `cause`, nothing unwound, events kept | test |
| Two modules, one commits and one refuses; the unwind commit is refused by the one that committed | wrapped not-restored error | test |
| Undo statement throws | wrapped not-restored error; the unwind stops where it is | inspection (shares `unwindJournal`) |
| Inside an explicit transaction | restores and leaves the transaction open, as for a failed step | inspection, or a test if the path differs |
| `with seed` | seeds do not run, because the throw comes first | inspection |
| The applied-state snapshot | nothing recorded for the failed apply | test, as part of the retry assertion |
| A step failure followed by an end refusal | unchanged: the step's error wins, and the end error is logged | existing behaviour |

**Known limit for store-backed modules.** An undo statement can itself need the store. Optimystic's `dropIndex` initializes a table it has not yet built, and on a local transactor a read of an affected table threw `Failed to get super-majority` while the cluster was down. The engine must then report not restored honestly, with no special case for this. Whether Optimystic has to change is measured downstream, after this lands.

`bug-apply-undo-of-add-column-with-inline-constraint-fails` (backlog) is a known undo failure that this path will now also reach. It is not in scope here.

## Docs

- **`vtab/module.ts`, the `endSchemaBatch` contract:** a throw after a clean loop causes the unwind, and a second begin/end pair can follow in the same apply. A module that refused its first commit may receive undo DDL for changes its store never received, and must accept that.
- **`docs/schema-undo-plan.md`:** add this failure point to "Restoring a failed apply".
- **`docs/schema.md`, "Module Batch Hooks":** state what a refused end does. It currently says only that the error is rethrown.

## TODO

- Write the reproduction in `schema-batch-hook.spec.ts`: after a refused end, the catalog is back to the pre-apply state and a second apply re-sends the DDL. It fails today.
- Return the journal state from `runStepsWithUndoJournal`, and per-module results from `endSchemaBatchAll`.
- Implement the unwind in `runBatchedMigrationLoop`, as a named subroutine.
- Add the irreversible and two-module tests.
- Update the contract and docs above.
