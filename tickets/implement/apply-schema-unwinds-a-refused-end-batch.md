description: When every step of `apply schema` succeeds but a storage module refuses the final commit, nothing is undone, so the engine believes the new schema is in place while the store still holds the old one, and a retry reports success without writing anything. A refused commit should undo the apply like any other failure.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/vtab/module.ts, packages/quereus/test/schema-batch-hook.spec.ts, docs/schema-undo-plan.md, docs/schema.md
repro: verified
----

# A refused `endSchemaBatch` leaves the apply in place

## Reproduction

Ran at HEAD `876943c93` with a throwaway spec: a `MemoryTableModule` subclass whose `endSchemaBatch` throws, the default module for a database declaring one new table. The spec was removed; the first TODO below re-creates it as a permanent test.

| Observation | Result |
| --- | --- |
| Error out of `db.exec('apply schema main')` | the module's own `Error('end-failure')`, same object identity, in autocommit and inside `begin` |
| Table in the catalog after the refusal | present; the restore fingerprint differs from the pre-apply one |
| Retry with the module no longer refusing | succeeds with `beginSchemaBatch` still called once in total and `create` still called once in total, so the retry sent nothing |

Downstream measurements, from Sereus on `@quereus/quereus` 4.24.0 and `@optimystic/*` 1.24.0, where the module coalesces catalog writes and commits them in `endSchemaBatch`:

| The apply changes | Engine after the refusal | Store writes during the retry | Retry result |
| --- | --- | --- | --- |
| a column tag | new tag | 0 | success |
| a nullable column | new column | 0 | success |
| a new table | new table | 0 | success |
| a new index | new index | 0 | success |
| a dropped column | column gone | 0 | success |

A query routed through the new index then throws `Table 'Note' does not maintain index 'NoteByBody'` until a fresh `Database` is opened.

## Root cause

`runBatchedMigrationLoop` (`runtime/emit/schema-declarative.ts:589`) unwinds the undo journal only from inside `runStepsWithUndoJournal`, which means only when a step fails. `endSchemaBatchAll` runs in the `finally` after the loop, and on a clean loop its throw (line 785) leaves the function with the journal already gone. The next apply diffs against the engine's catalog, finds nothing, skips the batch hooks and succeeds, and the applied-state fast path can then record that result. This breaks the guarantee in `docs/schema-undo-plan.md` that a failed apply restores the pre-apply catalog or reports that it could not.

## The change

Treat a throw from `endSchemaBatch` after a clean loop as a failed apply, using the existing unwind, verify and report steps.

### Control flow

```
begin all
run steps ──step failed──> (unchanged) unwind inside the batch, end all with the step's error, report
   │
 clean
   │
end all with no error ──nobody refused──> done
   │
 refused (first refusal in firing order is the primary error)
   │
   ├─ journal poisoned ──> wrapped error, nothing unwound, events kept
   │
   └─ journal usable
        begin all again ──begin threw──> wrapped error, events kept
        unwindJournal
        end all with no error
        ├─ undo failed or fingerprint mismatch ──> wrapped error, events kept
        ├─ a module that committed the first time refused ──> wrapped error, events kept
        └─ otherwise ──> discard events since the watermark, rethrow the primary error unchanged
```

### Shapes

`endSchemaBatchAll` stops throwing and reports what happened, so each caller decides. The existing logging stays; the "swallow after a loop error" and "first error wins" decisions move to the callers.

```ts
/** A module whose `endSchemaBatch` threw, in firing order (reverse registration order). */
interface BatchEndRefusal {
	readonly name: string;
	readonly error: unknown;
}

async function endSchemaBatchAll(started, db, schemaName, error): Promise<readonly BatchEndRefusal[]>;
```

Use an array rather than a `firstEndError === undefined` check, so a module that throws `undefined` is still seen as refusing.

`runStepsWithUndoJournal` returns its journal and poisoning step on a clean run. A discriminated result fits:

```ts
type StepsOutcome =
	| { readonly clean: false; readonly failure: MigrationFailure }
	| { readonly clean: true; readonly journal: ReadonlyArray<readonly string[]>; readonly poisonedBy?: MigrationStep };
```

The refusal path is a named subroutine, for example `unwindRefusedBatchEnd(...)`, returning the not-restored reason or undefined. `runBatchedMigrationLoop` keeps one reporting site for both failure kinds: on undefined, discard events since the watermark and rethrow the primary error unchanged; otherwise throw the wrapped error, message first, then the reason, with the primary error as `cause`. Extract that wrapping so the two paths cannot drift. A thrown value that is not an `Error` goes through `errorText` for the message and is omitted as `cause`, as `executeMigrationStep` does.

`describeIrreversible(poisonedBy, failing)` takes an optional `failing`. With none, it falls to the "the earlier step `X` cannot be undone" wording, which is correct here.

### Rules the implementation must keep

- **The unwind batch always ends with no error, even when an undo statement failed.** A module whose first commit landed has to commit the undo that did run, so its store matches the catalog as far as the unwind got, and an error would tell a discarding module to throw that away. When the unwind already produced a reason, that reason is the one reported, and any refusal of the second end is only logged.
- **Which second-pass refusals count.** Compare by registered module name against the first pass's refusals.
  - A module whose first `endSchemaBatch` threw: tolerated and logged, because its store still holds the pre-apply state.
  - A module whose first `endSchemaBatch` succeeded: not restored, because its store holds the forward change while the catalog is restored. The fingerprint check cannot see this. Suggested reason: `${NOT_RESTORED}: module 'x' committed the migration and then refused to commit its undo (…).`
- **The original end error is always the one reported.** If several modules refuse, the first stays primary and the rest are logged, as today.
- **A `beginSchemaBatch` that throws during the unwind** is not restored, with no undo run. `beginSchemaBatchAll` already tears down the modules it started with that error, and that teardown's refusals are only logged. Suggested reason: `${NOT_RESTORED}: the module batch could not be reopened for the unwind (…).`
- **Unchanged:** a step failure followed by an end refusal (the step's error wins, the end error is logged), and the unexpected-throw path, which still ends the batch with that error and rethrows it.

## Edge cases & interactions

| Case | Expected | Verified by |
| --- | --- | --- |
| Single module refuses, journal usable, keeps refusing during the unwind | catalog equals the pre-apply fingerprint, the retry re-plans and re-sends the DDL, original error identity kept, no schema events | test |
| Irreversible step earlier in the apply, then a refusal | wrapped error with `cause`, nothing unwound, events kept | test |
| Two modules, one commits and one refuses; the unwind commit is refused by the one that committed | wrapped not-restored error | test |
| Undo statement throws | wrapped not-restored error; the unwind stops where it is | inspection (shares `unwindJournal`) |
| Inside an explicit transaction | restores and leaves the transaction open, as for a failed step. The repro confirmed the end error reaches the caller with its identity inside `begin`; the unwind itself has not been run there yet, so check this when the first test lands. | inspection |
| `with seed` | seeds do not run, because the throw comes first | inspection |
| The applied-state snapshot | nothing recorded for the failed apply; the snapshot write is after the throw | retry assertion in the first test |
| A step failure followed by an end refusal | unchanged | existing behaviour |

**Known limits, to state rather than solve:**

- **Poisoned journal.** The apply reports partially migrated, and the catalog keeps the forward change while a refusing store may not have it. A retry then diffs clean and can succeed with nothing written. The wrapped error is the signal; the docs should say a retry does not repair this. The `NOTE:` on `endSchemaBatch` already describes the same mismatch for an unrestorable step failure.
- **An undo statement that itself needs the store.** Optimystic's `dropIndex` initializes a table it has not yet built, and on a local transactor a read of an affected table threw `Failed to get super-majority` while the cluster was down. The engine then reports not restored honestly, with no special case. Whether Optimystic has to change is measured downstream, after this lands.
- `bug-apply-undo-of-add-column-with-inline-constraint-fails` (backlog) is a known undo failure this path will now also reach. It is not in scope here.

## Docs

- **`vtab/module.ts`, the `endSchemaBatch` contract:** a throw after a clean loop causes the unwind, and a second begin/end pair can follow in the same apply, so "exactly once" holds per begin but not per apply. A module that refused its first commit may receive undo DDL for changes its store never received, and must accept that. A refusal must mean nothing from that batch reached the store, since the engine relies on that when it tolerates a second refusal. Replace the "logged and rethrown only if no prior loop error" paragraph.
- **`docs/schema-undo-plan.md`:** add this failure point to "Restoring a failed apply", including the rule for second-pass refusals and the poisoned-journal limit.
- **`docs/schema.md`:** "Module Batch Hooks" states what a refused end does (it currently says only that the error is rethrown). "Failure and restoration" names a refused commit as a failure the guarantee covers.
- **Comments in the code:** the doc comments on `emitApplySchema`, `runBatchedMigrationLoop`, `runStepsWithUndoJournal` and `endSchemaBatchAll`, and the header of `schema-batch-hook.spec.ts`, which says "exactly one begin and one end".

## TODO

- Write the reproduction in `schema-batch-hook.spec.ts` using the existing `RecordingMemoryModule` and its unused `failEnd` flag. After a refused end, the catalog is back to the pre-apply state, the caught error is the object the module threw (capture it in the module, because the message alone does not show identity), `db.onSchemaChange` saw nothing inside `begin` … `commit` (see `apply-schema-restore.spec.ts` § schema events for why inside a transaction), and a second apply with `failEnd` cleared calls `create` again. Confirm it fails before the change.
- Make `endSchemaBatchAll` return refusals and move the rethrow and swallow decisions to its callers; `beginSchemaBatchAll`'s teardown only logs them.
- Return the journal state from `runStepsWithUndoJournal`.
- Implement the unwind in `runBatchedMigrationLoop` as a named subroutine, with one shared reporting site for both failure kinds.
- Add the irreversible test: a declaration that drops a column, then a refused end. Expect a wrapped error matching `partially migrated` with the end error as `cause`, the column still gone, and no second `beginSchemaBatch`.
- Add the two-module test: register two recording modules, with per-call control of which `endSchemaBatch` calls refuse (one commits then refuses, the other refuses first). Expect the wrapped not-restored error.
- Update the contract, docs and comments listed above.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`. `apply-schema-restore.spec.ts`, `apply-schema-unchanged-fast-path.spec.ts` and the `quereus-isolation` batch hook tests should pass unchanged.
