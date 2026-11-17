description: Changing a table's primary key on a storage backend that cannot do it itself used to fail whenever an assertion or another table's CHECK mentioned that table, with an error about dropping a table the user never asked to drop. The engine's own temporary drop now passes the checks meant for user drops, and copy failures are reported under the user's table name.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/core/database.ts                    # _setInternalDrop, _areDropReferenceGuardsWaived (after _isSchemaUnwinding); _setFkRestrictSuppressed doc trimmed
  - packages/quereus/src/runtime/emit/alter-table.ts         # rebuildViaShadowTable: internal-drop scope around the DROP; reportedOnUserTable / replaceInError helpers above it
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts   # assertNoAssertionDependsOn → predicate
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts  # assertNoExpressionDependsOn → predicate
  - packages/quereus/src/runtime/emit/drop-column-guards.ts     # three guards → predicate; header comment
  - packages/quereus/src/schema/manager.ts                   # findChildBlockingDrop: FK-flag arm removed, one predicate arm
  - packages/quereus/test/alter-table-conformance.spec.ts    # the four arms from the fix stage (one regex repaired)
  - docs/sql-alter.md                                        # ALTER PRIMARY KEY paragraph + failure table row
  - docs/schema-undo-plan.md                                 # "Guards during an unwind": the shared predicate
----

# What changed

When a storage module has no in-place re-key, `alter table t alter primary key (…)` rebuilds through a hidden table `t__rekey_<ms>`: create it with the new key, copy the rows, commit, `drop table t`, rename the hidden table to `t`, re-create indexes. The internal `drop table t` ran every guard that protects a user's drop, and only the foreign-key row guard had been stood down (through the external-apply FK flag). Assertions over `t`, and CHECK / DEFAULT / generated subqueries naming `t` (another table's, or `t`'s own — which the hidden copy carries, naming the original), refused the re-key.

## One predicate for drop-path reference guards

`Database._areDropReferenceGuardsWaived()` is true while either scope is open:

- the existing `apply schema` unwind scope (`_setSchemaUnwinding`);
- a new internal-drop scope, `_setInternalDrop(value): boolean` (set/restore pair returning the prior value), meaning "the object this DROP removes comes back under the same name with the same rows before the statement ends".

Every drop-path reference guard now asks the predicate instead of the unwind flag: `assertNoAssertionDependsOn`, `assertNoExpressionDependsOn`, the three DROP COLUMN guards (`refuseColumnExpressionDependent`, `assertNoAssertionNamesColumn`, `assertNoForeignKeyReferencesColumn`), and `findChildBlockingDrop`. The FK-flag arm in `findChildBlockingDrop` is gone; `_setFkRestrictSuppressed` is now documented as having one caller (external-row apply, DML only). The other unwind-only behaviours (ADD CONSTRAINT not judging rows, `restoring` on module events, CREATE VIEW skipping body planning, MV re-attach scans) still read `_isSchemaUnwinding()` directly, so the rebuild does not get them.

`schema-declarative.ts`'s up-front `findChildBlockingDrop` call (refusing a module move with referencing rows) runs outside both scopes, so it is unaffected.

## The rebuild

`rebuildViaShadowTable` opens `_setInternalDrop(true)` around the one `drop table` statement only, restored in `finally`. The comment above it lists the three refusal shapes and why none applies; the NOTE pointing at this ticket is removed.

The steps before the DROP (create hidden table, row copy, commit) run inside `reportedOnUserTable(shadowName, tableName, …)`, which on error substitutes the hidden name with the user's in the error's `message` and `stack` and rethrows the same object, so the class (`ConstraintError`, etc.) and `code` are kept. Errors from the DROP onward are untouched: `shadowHoldsRowsError` still names the hidden table (the user needs it to recover), the index phase reports through `indexesMissingError`, and the cleanup warn log keeps the hidden name.

# Tests

No new tests beyond the four arms the fix stage added to `describe('ALTER PRIMARY KEY — shadow rebuild preserves the table definition')` in `alter-table-conformance.spec.ts`:

- `a collision during the copy names the user table, not the hidden rebuild table` — error is a CONSTRAINT `QuereusError`, has no `__rekey_`, names `t`. That arm's regex held literal backspace bytes (0x08) instead of `\b`, so it could never pass; repaired to `/\bt\b/`.
- `an assertion over the table …`, `another table's CHECK subquery naming the table …`, `the table's own CHECK subquery naming itself …` — each re-keys, keeps the row, and the rule still rejects a violating write afterwards.

Validation run: those 25 rebuild tests pass; `yarn workspace @quereus/quereus test` → 11185 passing, 0 failing; `yarn workspace @quereus/quereus lint` clean; `50.4-declare-schema-apply-restore.sqllogic` and `50.4.1-…` pass under `QUEREUS_TEST_STORE=true`.

# For the reviewer

- The DEFAULT and generated-column arms of the expression guard are covered by the same predicate but have no rebuild test of their own; the CHECK arms exercise the same code path in `assertNoExpressionDependsOn`.
- Error re-siting assigns `e.stack`. That is writable in V8 and the other engines Quereus targets as far as I know, but it is not specified by ECMAScript; if a runtime ever makes it read-only, the assignment would throw in strict mode and replace the original error. Not tested on React Native / Hermes.
- Substitution is exact-case. A module that lowercases table names in its messages would leave a mixed-case hidden name unsubstituted. Neither built-in module reaches this path (both re-key in place), so only the test stub module exercises it.
- The internal-drop flag is open for the whole DROP statement, so anything nested inside that drop which reaches a reference guard is also waived. Nothing nested in `emitDropTable` issues further guarded drops today.
