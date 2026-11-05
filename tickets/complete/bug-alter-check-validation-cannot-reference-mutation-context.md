description: A CHECK added by ALTER TABLE can now read the table's per-statement context values. Validation over existing rows behaves like a statement that supplied none, so a nullable value reads as NULL and a required one is rejected with a clear error.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/constraint-builder.ts  # scanContextVariables, mintShadowedColumnName, storedRowSourceSql, validateChecksOverExistingRows
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # OwnRowContextVariables, requalifyOwnRowRef
  - packages/quereus/src/planner/building/mutation-context.ts  # checkReadsRequiredContextError, noEnvelopeCheckScope
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnChecks
  - packages/quereus/src/core/statement.ts  # _noEnvelopeContextTable
  - packages/quereus/src/core/database.ts  # _buildProbeContext, _buildPlan
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 28
  - docs/sql-alter.md
  - docs/sql-ddl.md
----

## What was built

The rule is in `docs/sql-alter.md`, under *Existing-row validation of a CHECK*, with a bullet in `docs/sql-ddl.md` §2.6.2.

**Per-row ADD COLUMN.** `buildAddColumnChecks` layers the variables under the row scope, as the DEFAULT arm of the backfill does, and shadows same-named columns, including the new one. It also skips a partial-mask CHECK now, which is the same gate the literal-DEFAULT path applies.

**The existing-row scan.** ADD CONSTRAINT and literal-DEFAULT ADD COLUMN both end here. On a table that declares context:

- `Statement._noEnvelopeContextTable` makes the statement's root scope hold the variables (`noEnvelopeCheckScope`). A NOT NULL read raises at plan time, so it fails with or without rows.
- A column sharing a variable's name is scanned through a derived source under an internal name, so the bare name falls through to the variable.
- `new.<name>` is mapped to that internal name and reaches the column. `<table>.<name>` of a variable is rewritten to `context.<name>` and reads the variable.

On every other table the scan's SQL is unchanged.

Decisions the implementer made beyond the fix ticket, all kept in review:

- **The seam is a field on the Statement, not a factory passed in.** `schema/constraint-builder.ts` cannot import `mutation-context.ts` without an import cycle.
- **`context.<name>` instead of the bare form** for a self-qualified variable, because a subquery's own source could capture a bare name.
- **A plain table's behaviour changed:** `add column c … default (new.b) check on update (c > 100)` moves from rejected to accepted, matching the literal-DEFAULT path. Later writes still enforce it, which review measured.
- **A table literally named `new`:** the scan reads `new.<name>` as the column and a write reads the variable, because the optimizer lifts a fact from that spelling. The open question is in `bug-self-qualified-check-reads-context-variable`.

## Review findings

Read the diff of `ticket(implement): bug-alter-check-validation-cannot-reference-mutation-context` before the handoff, then rebuilt `dist` and ran throwaway probes against it.

### Fixed in this pass

- **Bug: a real column named like the internal one broke the scan.** The handoff listed this as a known gap, and it was a wrong result rather than a refusal. With `create table t (a integer primary key, "__quereus_shadowed_who" integer null, who integer null) with context (who integer null)` and the row `(1, 5, -1)`, `check (new.who > 0)` was accepted because the scan read the other column. `select a, who from t where who <= 0` then returned nothing, even though the row has `who = -1`. `mintShadowedColumnName` now picks a name no column uses, and Test 28 has the reproduction (`AvCollide`).
- **Test trim.** Two `AvReq` selects that checked the table was unchanged are now one `select *`.

### Tripwires recorded

- A CHECK whose `<table>.<name>` of a variable sits in a subquery whose source has a column of that name is accepted by ALTER, then fails every write with `<table>.<name> isn't a column`. ALTER used to refuse it. CREATE TABLE accepts it too, and the same happens with `check (new.who > 0)` when `who` is only a variable. Parked as a `NOTE:` on `OwnRowContextVariables` in `self-qualifier-strip.ts`.
- `new.<missing>` is refused with the internal alias in the message (`__quereus_stored_row__.x isn't a column`). This is not new: a plain table with no context gives the same message. Parked as a `NOTE:` on `STORED_ROW_ALIAS`.

### Major findings

No new ticket from review. The implementer's `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts` stays in backlog; review reproduced both of its refusals. `bug-self-qualified-check-reads-context-variable` stays blocked, and the section added to it matches the code.

### Checked, nothing wrong

- **Callers of the scan.** Only three reach it: ADD CONSTRAINT, literal-DEFAULT ADD COLUMN and the maintained-table path. None re-judges a CHECK the table already has, so the new error cannot fire on a CHECK declared in CREATE TABLE. Measured: a table with a CREATE TABLE CHECK over a NOT NULL variable still takes unrelated ADD COLUMN (both paths) and ADD CONSTRAINT.
- **Plumbing.** Both `_buildPlan` calls in `statement.ts` pass the table. There is no statement cache that could reuse a scan under another table. The other `_buildPlan` callers do not pass it and are unaffected.
- **Spellings on both paths.** Measured: `context.who` and a subquery read on the per-row path; a NOT NULL read through a subquery, with no DEFAULT, and on a generated column; `new.who` inside a subquery and inside a CTE; mixed-case and quoted names; a subquery over a real table named `new`; a view whose column shares the variable's name.
- **Rows staged in an open transaction** count, through the derived source too.
- **Partial-mask CHECK** on the per-row and generated paths is skipped alone: a sibling full CHECK on the same column is still judged, and a later `update` enforces the skipped one.
- **Failed ALTER.** A rejected ADD COLUMN leaves the table without the column.
- **Docs.** `docs/sql-alter.md` and `docs/sql-ddl.md` match what was measured. On a module declaring `permitsGrandfatheredCheckViolators`, only ADD CONSTRAINT skips the scan, and the sentence naming that module sits under ADD CONSTRAINT, so it stays correct. `docs/vu-mutation-context.md`, `docs/schema.md`, `docs/module-authoring.md` and `docs/write-scope.md` make no claim about CHECKs added by ALTER.
- **Type safety, resource cleanup, error handling.** No `any` was added, the scan's statement is finalized on every exit including the new plan-time error, and the error reaches the user without a wrapping prefix.
- **File size.** `constraint-builder.ts` was 732 lines before this pass (`wc -l`), and no helper here is large enough to justify a split.

### Tests

Test 28 otherwise stays as written: each group covers a separate rule from the decided text. No test was cut beyond the trim above, and only the `AvCollide` reproduction was added.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 11047 passing, 26 pending, after the review edits.
- `yarn test:store --grep "alter|46-mutation-context"` from `packages/quereus`: 286 passing, after the review edits.
- `yarn test:context-strict --grep "46-mutation-context"`: passing.
- Not run: the other workspaces' tests, and the full store leg.

The store run prints four `TransactionCoordinator … out of range` lines, as the handoff reported. Test 46 alone prints none, and they do not fail a test. Review did not compare against the commit before this work, so whether they predate it is inferred: the other tests in that run declare no context, so their scan SQL is unchanged.

## Use cases

```sql
create table t (a integer primary key, who integer null) with context (who integer null);
insert into t values (1, -1);
alter table t add constraint k check (who > 0);       -- accepted: reads the variable
alter table t add constraint k2 check (new.who > 0);  -- rejected: the column holds -1
insert into t with context who = -5 values (2, 1);    -- rejected by k

create table r (a integer primary key) with context (who integer);
alter table r add constraint k check (who > 0);       -- rejected: ALTER TABLE supplies no context
alter table r add constraint k check on update (who > 0);  -- accepted
```
