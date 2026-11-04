description: On a storage backend that cannot change a primary key in place, a primary-key change whose final commit failed used to leave the table empty. The rows are now committed before the original table is dropped, and the copy no longer re-checks rows that are not changing.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # rebuildViaShadowTable, shadowHoldsRowsError, the explicit-transaction refusal message
  - packages/quereus/src/parser/ast.ts   # InsertStmt.skipRowChecks
  - packages/quereus/src/planner/building/insert.ts   # the three skips in buildInsertStmt
  - packages/quereus/src/core/database.ts   # _parseSql is now @internal rather than private
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # rebuildNotOnlyEffectError message
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # comments only
  - packages/quereus/test/alter-table-conformance.spec.ts
  - packages/quereus/test/apply-schema-restore.spec.ts
  - docs/schema-undo-plan.md
  - docs/module-authoring-schema-changes.md
  - docs/sql-alter.md
  - docs/schema-declarative.md
  - docs/module-events.md
repro: verified
----

# A rebuilt primary key no longer loses its rows when a commit fails

A backend that cannot re-key in place changes a primary key by building a hidden copy of the table (the shadow table), copying the rows, dropping the original and renaming the copy over it. The drop and rename survive a rollback and an uncommitted copy does not, so any failure after the drop emptied the table. Only third-party backends reach this path; memory and the store both re-key in place.

## What changed

- **The copy commits before the drop.** `rebuildViaShadowTable` calls `_commitTransaction` then `_ensureTransaction` straight after the copy. The reasoning for why this does not reopen the earlier rejected decision is in `docs/schema-undo-plan.md` § A primary-key rebuild.
- **The copy judges only the key.** A new engine-only `InsertStmt.skipRowChecks` makes `buildInsertStmt` skip `buildConstraintChecks`, `buildChildSideFKChecks` and `buildNotNullDefaults`. This also closes the former backlog ticket `bug-rebuild-copy-refused-when-table-reads-context`, which is deleted. Generated columns need no equivalent: a generated body never reads a context variable (`41-generated-columns.sqllogic`).
- **The shadow is kept once it holds the only copy.** A local is set after the drop and cleared after the rename. While set, the catch keeps the shadow and raises `shadowHoldsRowsError`, wrapping the original as `cause`.
- **Refusals keep their conditions, with new reasons.** A multi-step apply and an explicit transaction are still refused, because the rebuild now commits part-way. Both messages were reworded.

## What a failure leaves

| Failure point | Table | Rows | Reported | Checked by |
|---|---|---|---|---|
| copy refused (key collision) | original | intact | the error | existing test |
| commit of the copy | original | intact, no shadow left | the error | new test |
| drop refused | original | intact | the error | not run; code reading |
| rename | missing | in the shadow, named in the error | wrapped error with the recovery statement | new test |
| index re-creation | new key, index missing | intact | the error | one-off probe, no test kept |
| final commit | new key | intact | the error, though the key changed | new test |

## Tests added

In `alter-table-conformance.spec.ts`, in the rebuild `describe`:

| Test | Verifies |
|---|---|
| a subquery CHECK whose subject has moved does not stop the re-key… | the row is kept, and a new violating write is still refused |
| a foreign key orphan does not stop the re-key… | the orphan is kept, a new orphan is refused, the new key is enforced |
| a table whose CHECK reads a context variable… | that CHECK shape re-keys and keeps its rows |
| a table whose DEFAULT reads a context variable… | that DEFAULT shape re-keys and keeps its rows |
| a commit failing on the copy… | the original keeps its key and rows, and no shadow remains |
| a commit failing after the swap… | the rows are kept under the new key |
| a failed rename keeps the shadow… | the error names the shadow and carries the cause, the shadow holds the rows, and the statement from the message restores the table |

In `apply-schema-restore.spec.ts`: "a one-step plan over a foreign key orphan still rebuilds and keeps its rows".

Each was confirmed to fail without its part of the fix, by mutating the source and restoring it:

| Part removed | Tests that fail |
|---|---|
| the commit | commit on the copy, commit after the swap, failed rename |
| the CHECK skip | subquery CHECK, context CHECK |
| the foreign key skip | foreign key orphan, one-step apply |
| the defaults skip | context DEFAULT |
| keeping the shadow | failed rename |

## Validation

`yarn workspace @quereus/quereus run lint` exits 0. `yarn test` passes in every workspace, with 10944 passing and 25 pending in `@quereus/quereus`. `yarn test:store` was not run, because the store re-keys in place and never enters this path.

One-off probes, removed before this handoff, confirmed:

- A prepared `alter`, and `insert; alter; insert` in one `exec`, both succeed and restore autocommit.
- Subscribers see one `alter`, no data events, and one commit batch per statement. The inner commit delivers no empty batch.
- A failed rename inside a one-step apply reports the recovery statement, followed by the apply's "partially migrated and could not be restored" line.

## Differs from the fix ticket

- **Re-issuing after a failed final commit is not a no-op.** The ticket expected one. It runs another full rebuild, which succeeds and delivers the `alter` event the failed attempt lost. The docs and the `NOTE:` say this.
- **That recovered event has a wrong old key.** Observed: `oldKeyColumns` is `["code"]`, the new key, because the catalog had already changed. A syncing peer that missed the first event receives an old key that does not match what it holds. I did not check whether any consumer reads the field in a way this breaks.
- **Additions the ticket did not list:**
  - the explicit-transaction refusal message was reworded, because its stated reason had changed;
  - the recovery error also names any user indexes to re-create, because a lost UNIQUE index stops enforcing silently;
  - `docs/module-authoring-schema-changes.md` tells module authors not to fail a commit with no work in it.

## Known gaps

From code reading only, not run:

- A `destroy` that deletes its storage and then throws. The catch treats that as a refused drop and drops the shadow, so both copies would be gone. The `dropTable` comment defines a `destroy` rejection as a veto that has mutated nothing, so this would be a module breaking that contract.
- A rename that fails after the catalog swap, in the propagation pass. The error would say the rows are in the shadow although the table already has its real name. `runRenameTable` describes that pass as unfailable.
- A `begin` that fails in `_ensureTransaction` straight after the copy's commit. It should reach the catch with the original intact.
- A commit failing on only some connections. The copy could land on some of them. The shadow is dropped and the original is untouched either way.
- The `docs/module-events.md` claim that commit-time events for the statements after the copy arrive outside the suppression scope. No module in the repository emits that way.

Worth a reviewer's attention:

- The `NOTE:` "commits the whole implicit transaction" rests on the only paths to the rebuild being a direct `ALTER` and a one-step apply. I grepped `src` for internal issuers of `ALTER PRIMARY KEY` and found only the schema differ's migration and undo steps, both of which run under the apply's refusal flag.
- `skipRowChecks` is checked only on the base-table path of `buildInsertStmt`. A view or CTE target returns earlier and would ignore it, which is fine for the one caller, since a shadow table is always a base table.
