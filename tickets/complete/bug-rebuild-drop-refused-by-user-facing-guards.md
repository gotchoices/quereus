description: Changing a table's primary key on a storage backend that cannot do it itself used to fail whenever an assertion or another table's CHECK mentioned that table, with an error about dropping a table the user never asked to drop. The engine's own temporary drop now passes the checks meant for user drops, and copy failures are reported under the user's table name.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/core/database.ts                    # _setInternalDrop, _areDropReferenceGuardsWaived
  - packages/quereus/src/runtime/emit/alter-table.ts         # rebuildViaShadowTable internal-drop scope; reportedOnUserTable / replaceInError
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts
  - packages/quereus/src/runtime/emit/drop-column-guards.ts
  - packages/quereus/src/schema/manager.ts                   # findChildBlockingDrop
  - packages/quereus/test/alter-table-conformance.spec.ts
  - docs/sql-alter.md
  - docs/schema-undo-plan.md
----

# What landed

When a storage module has no in-place re-key, `alter table t alter primary key (…)` rebuilds through a hidden table `t__rekey_<ms>` (create, copy rows, commit, `drop table t`, rename back, re-create indexes). That internal `drop table t` used to run every guard meant for a user's drop, so an assertion over `t`, or a CHECK / DEFAULT / generated subquery naming `t` (another table's or the hidden copy's own), refused the re-key with a confusing "cannot drop table" error.

- `Database._areDropReferenceGuardsWaived()` is the one predicate every drop-path reference guard asks (assertion guard, expression guard, the three DROP COLUMN guards, and the foreign-key row guard in `findChildBlockingDrop`). It is true inside the existing `apply schema` unwind scope or the new internal-drop scope `Database._setInternalDrop`.
- `rebuildViaShadowTable` opens the internal-drop scope around its one `drop table` statement only. The foreign-key flag (`_setFkRestrictSuppressed`) is no longer used for this; it is back to its single caller, the external-row apply path.
- Errors raised before the drop (create, copy, commit) have the hidden table name replaced by the user's table name in place, keeping the error's class and code. Errors from the drop onward still name the hidden table, which the user needs to recover the rows.
- Docs: `docs/sql-alter.md` (ALTER PRIMARY KEY paragraph and failure table), `docs/schema-undo-plan.md` (Guards during an unwind).

Tests: four arms in `alter-table-conformance.spec.ts` under `ALTER PRIMARY KEY — shadow rebuild preserves the table definition` (collision error names the user table; assertion, other table's CHECK, own CHECK each re-key and still bind afterwards).

# Review findings

Read the implement diff (`ticket(implement): bug-rebuild-drop-refused-by-user-facing-guards`) first, then the surrounding code.

- **Correctness of the scope.** Checked every reader of `_isSchemaUnwinding` and `_isFkRestrictSuppressed`. The drop-path reference guards all moved to the predicate; the unwind-only behaviours (ADD CONSTRAINT judging, `restoring` events, CREATE VIEW body planning, MV re-attach scans and rebuild-size limit) still read the unwind flag directly, so the rebuild does not inherit them. Removing the FK-flag arm from `findChildBlockingDrop` loses nothing: `SchemaManager.dropTable` does no DML, so no other `_isFkRestrictSuppressed` reader (all in `foreign-key-actions.ts` / `row-constraints.ts`) was on the drop path. `schema-declarative.ts`'s up-front `findChildBlockingDrop` call runs outside both scopes, unchanged. No other "cannot drop table" refusal exists in `emitDropTable` / `dropTable` besides the module's own `destroy` veto, which correctly still applies.
- **Failure paths.** The flag is restored in `finally`; the cleanup `drop table if exists <shadow>` runs outside the scope, and nothing references the shadow name, so no guard can refuse it. Error re-siting only wraps the pre-drop steps; the catch block's `shadowHoldsRowsError` and `indexesMissingError` keep their own naming. Fine.
- **Error renaming.** `QuereusError` carries only `message`, `code`, `line`, `column` and `cause`; a wrapped `cause` keeps the hidden name, which is acceptable (a debugging aid, not the user-facing message). Checked in Node that V8 formats `stack` lazily, so the explicit rewrite matters only when the stack was already read. Assigning `stack` is unspecified by ECMAScript — conditional concern, parked as a `NOTE:` in `replaceInError` (`alter-table.ts`).
- **Tests.** The four arms reproduce the defect at the lowest layer that shows it (a stub module with no `alterTable`); kept, none cut. The repaired `/\bt\b/` regex fails against the old `t__rekey_…` message (underscore is a word character), so it does pin the renaming. No new tests: DEFAULT / generated arms go through the same `assertNoExpressionDependsOn` early return the CHECK arms exercise.
- **Hygiene (fixed inline).** Re-wrapped two over-long doc-comment lines the implement pass left in `database.ts` (`_setSchemaUnwinding` doc) and `drop-column-guards.ts` (header comment).
- **Docs.** Read `docs/sql-alter.md`, `docs/schema-undo-plan.md` and `docs/sync-transactions.md` (the apply-mode RESTRICT suppression section, which never mentioned the rebuild); all reflect the new behaviour. No stale mention of the FK flag being used by the rebuild remains in `src/` or `docs/`.
- **Tripwires.** Exact-case name substitution (a module that re-cases names in its messages would leave the hidden name) — parked as a `NOTE:` in `reportedOnUserTable` (`alter-table.ts`). The internal-drop scope covering the whole DROP statement (a nested guarded drop would also be waived; none exists) is already stated in the `_setInternalDrop` doc. Both conditional on behaviour nothing has today — no ticket.
- **Major findings:** none.

Validation: `yarn workspace @quereus/quereus lint` exit 0; `yarn workspace @quereus/quereus test` → 11185 passing, 23 pending, 0 failing.
