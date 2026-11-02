description: When every step of `apply schema` succeeds but a storage module refuses the final commit, the apply is now undone like any other failure, so the engine no longer believes in a schema the store never received and a retry really does send the changes again.
architecture: docs/schema-undo-plan.md#a-refused-commit
files: packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/vtab/module.ts, packages/quereus/test/schema-batch-hook.spec.ts, docs/schema-undo-plan.md, docs/schema.md, docs/module-events.md
----

# A refused `endSchemaBatch` now unwinds the apply

## What was built

`runBatchedMigrationLoop` (`runtime/emit/schema-declarative.ts`) used to lose the undo journal once the steps finished, so a throw from `endSchemaBatch` after a clean loop left the catalog migrated while the store was not. The next apply then diffed clean and reported success with nothing written.

- `endSchemaBatchAll` no longer throws. It ends every module and returns the refusals, and each caller decides what they mean.
- `runStepsWithUndoJournal` returns its journal and poisoning step on a clean run (`StepsOutcome`).
- `unwindRefusedBatchEnd` opens a second begin/end pair around the existing `unwindJournal`, and judges second-pass refusals against the first pass by registered module name.
- `throwFailedApply` is the one reporting site for step failures and refused commits.

| Situation | Result |
| --- | --- |
| Refusal, usable journal | catalog restored, module's own error rethrown unchanged, schema events retracted, retry re-sends the DDL |
| Refusal after a data-destroying step | nothing unwound, no second batch, wrapped `partially migrated` error with the refusal as `cause`, events kept |
| Module committed the migration, then refused its undo | wrapped not-restored error naming the module |
| Module refused both commits | tolerated and logged |
| `beginSchemaBatch` throws during the unwind | wrapped not-restored error, no undo run |
| Undo statement throws | wrapped not-restored error naming the statement, second batch still ends with no error |
| Step failure, then a refused end | the step's error wins, the refusal is logged |

The contract in `vtab/module.ts` says a refusal must mean nothing from that batch reached the store, that "exactly once" holds per begin and not per apply, and that a refusing module may receive undo DDL for changes it never stored. See `docs/schema-undo-plan.md` § A refused commit.

## Review findings

Read the diff of `ticket(implement): apply-schema-unwinds-a-refused-end-batch` before the handoff, then its docs, tests and the module contract.

**Checked, no defect found**

- Control flow against the ticket's rules: first refusal stays primary, second batch always ends with no error, undo failure outranks a second refusal, poisoned journal skips the second batch, unexpected-throw path still ends the batch with the error.
- Error handling: every swallowed refusal is logged inside `endSchemaBatchAll`, including the begin-teardown and second-batch ones.
- Interactions by reading: `with seed` and the snapshot write both sit after the throw; `quereus-isolation` is a straight delegate, so a refusal passes through it; the store module has no batch hooks (grep), so this path does not reach it.
- Type safety: `throwFailedApply`'s `never` return narrows `steps`; lint's test-file type pass is green.
- Implementer's three tests: each pins a named outcome and none verifies a mock. All kept.

**Found and fixed in this pass (minor)**

- `docs/schema.md` § Failure and restoration still said the restore always runs inside the module batch before `endSchemaBatch(error)`. That is false after a refused commit, so it now states both cases.
- `docs/module-events.md` carve-out named only a failing step as the trigger for retraction. It now names a refused commit too. The handoff had not listed this file.
- `beginSchemaBatch`'s contract said any refusal causes a second call. It now excludes a migration that cannot be undone.
- Tests added to `schema-batch-hook.spec.ts`, because each is a documented rule with real branching that nothing permanent pinned. The implementer's throwaway spec had covered them, but no longer exists:
  - a failed undo statement outranks a second refusal, and the second batch still ends with no error;
  - a batch that cannot be reopened runs no undo and reports not restored;
  - a refusal after a failed step stays logged only. This decision moved from `endSchemaBatchAll` to its caller in this change.
- `RecordingMemoryModule` gained `failBeginOnCall` and `failOnDestroyTable` for these.

**Tripwires parked as `NOTE:` in `unwindRefusedBatchEnd`**

- The second batch has no guard for an unexpected throw. It holds today because every fallible call in `unwindJournal` is inside a `try`.
- An empty journal still opens a second batch, so a module that committed and then refuses that empty batch reads as not restored. The undo renderer yields an empty undo only for a target the pre-apply catalog does not mention, so a plan made only of those should be rare (read, not measured).

**Major findings / tickets filed:** none. Nothing reached the filing bar.

**Considered, no action**

- `schema-declarative.ts` is 885 lines (`wc -l`, before this pass's two comment lines), and the migration loop is a separable part of it. The repo has no size rule, the code is cohesive and the implementation added only about 80 lines, so no split was filed.
- A module with `beginSchemaBatch` but no `endSchemaBatch` is begun twice with no end. It already had no end, and the contract expects both hooks.
- Refusal comparison by registered name means one module object under two names counts as two. The ticket specified this, and the isolation wrapper is registered as itself.
- Stated limits stay as documented: a poisoned journal leaves the catalog ahead of a refusing store, and refusal semantics are trusted rather than checked.

**Not verified**

- `yarn test:store` was not run, because the store module has no batch hooks.
- `yarn build` was not re-run in review. The only source edits this pass are comments.
- The Sereus and Optimystic reproduction has not been re-run. Whether Optimystic's `dropIndex` must change during an unwind is deferred downstream, and such a failure now reports not restored.
- The doc line saying a fresh `Database` re-reads the catalog after a poisoned refusal rests on the downstream observation. No test here exercises it.
- The two `NOTE:` comments in `unwindRefusedBatchEnd` were added after the final lint and test run. They change no code.

**Known neighbour:** `bug-apply-undo-of-add-column-with-inline-constraint-fails` (backlog) is an undo failure this path can now also reach. It was out of scope and is unchanged.

## Validation

- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn test`: exit 0, all workspaces, including the new tests.
