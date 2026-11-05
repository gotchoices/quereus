description: A CHECK added by ALTER TABLE can now read the table's per-statement context values. Validation over existing rows behaves like a statement that supplied none, so a nullable value reads as NULL and a required one is rejected with a clear error.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/constraint-builder.ts  # scanContextVariables, storedRowSourceSql, validateChecksOverExistingRows
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # OwnRowContextVariables, requalifyOwnRowRef
  - packages/quereus/src/planner/building/mutation-context.ts  # checkReadsRequiredContextError, noEnvelopeCheckScope
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnChecks
  - packages/quereus/src/core/statement.ts  # _noEnvelopeContextTable
  - packages/quereus/src/core/database.ts  # _buildProbeContext, _buildPlan
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 28
  - docs/sql-alter.md
  - docs/sql-ddl.md
----

## What changed

The decided rule is in `docs/sql-alter.md`, under *Existing-row validation of a CHECK*, with a bullet in `docs/sql-ddl.md` §2.6.2.

**Per-row ADD COLUMN.** `buildAddColumnChecks` layers the variables under the row scope, as the DEFAULT arm of the backfill does, and shadows same-named columns, including the new one.

**The existing-row scan.** ADD CONSTRAINT and literal-DEFAULT ADD COLUMN both end here. On a table that declares context:

- `Statement._noEnvelopeContextTable` makes the statement's root scope hold the variables (`noEnvelopeCheckScope`). A NOT NULL read raises at plan time, so it fails with or without rows.
- A column sharing a variable's name is scanned through a derived source under `__quereus_shadowed_<name>`, so the bare name falls through to the variable.
- `new.<name>` is mapped to that internal name and reaches the column. `<table>.<name>` of a variable is rewritten to `context.<name>` and reads the variable.

On every other table the scan's SQL is unchanged.

## Where this departs from the ticket, for the reviewer to judge

- **The seam is data, not a wrapper function.** `schema/constraint-builder.ts` cannot import `mutation-context.ts` because that would create an import cycle (`mutation-context` → `reference` → `ind-utils` → `schema/table` → `vtab/memory` → `layer/manager` → `constraint-builder`). The ticket's fallback was to hand a factory in from the planner side, but that adds a parameter each caller could forget. Instead the Statement holds the table, and `Database` builds the scope.
- **`context.<name>` instead of the bare form.** The prereq's note said to fold `<table>.<name>` to the bare form. A bare name could be captured by a subquery's own source; the qualified one could not. The two differ only when that source has a column of that name, and in that case the write path leaves the qualifier in place and every write fails with `t.who isn't a column` (measured). A subquery source aliased `context` could still capture the rewritten name, in that same no-reading case.
- **Behaviour change on tables with no context.** `buildAddColumnChecks` now skips partial-mask CHECKs. Otherwise `add column c … default (new.b) check on update (who > 0)` over a NOT NULL variable would hit the new error, which the ticket says must not happen. As a result, `add column c … default (new.b) check on update (c > 100)` on a plain table moves from rejected to accepted, which matches the literal-DEFAULT path.
- **A table literally named `new`.** The scan reads `new.<name>` as the column, but a write reads the variable (`bug-self-qualified-check-reads-context-variable`). I chose this on purpose, because the optimizer lifts a fact from that spelling and so the column must be validated. It is measured but not in Test 28.

## Known gaps

- **Per-row ADD COLUMN still refuses `old.` and self-qualified spellings** with `old.a isn't a column` / `t.c isn't a column`, on any table, while the literal-DEFAULT path accepts them. So `add column c … default (new.b) check (old.a is null or who > 0)` is refused on the per-row path. Filed as `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts`.
- **A real column literally named `__quereus_shadowed_<name>`** would collide in the derived source. Not handled and not tested.
- **`bug-self-qualified-check-reads-context-variable`** stays blocked. I added a section to it naming the scan and doc text that must change if its meaning is settled differently.

## Tests

One addition, **Test 28** in `46-mutation-context.sqllogic`, which also runs on the store leg:

| Group | Verifies |
|---|---|
| `AvNull` | NULL variable passes on ADD CONSTRAINT and both ADD COLUMN paths, for bare, `context.` and subquery reads; a subquery source with its own `who` keeps it |
| `AvNeg` | the part of a CHECK with no variable is still judged, on the scan and per-row paths |
| `AvLater` | an accepted CHECK is enforced by a later write that supplies the variable |
| `AvShadow` | column and variable sharing a name: bare reads the variable on all three paths; `new.who` reaches the column on all three; self-qualified reads the variable, including in a subquery; other self-qualified names reach their columns |
| `context` table | `context.who` is the variable, `context.a` is the column |
| `AvNewLit`, `AvNewRow` | a new column named like a variable is shadowed on both ADD COLUMN paths |
| `AvReq` | NOT NULL read rejected with the new message on empty and non-empty tables, on all three paths and for a mixed `old.` conjunction; table unchanged afterwards. `check on update` on all three paths and an `old.` conjunct stay accepted, and a later write still needs the variable |
| `AvMask` | per-row path skips a partial-mask CHECK on a plain table |

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 11047 passing, 26 pending. After that run the only changes were one Test 28 case and line endings on two import lines. Test 28 was re-run on both legs and lint was re-run.
- `yarn test:store --grep "alter|46-mutation-context"` from `packages/quereus`: 286 passing. It prints four `TransactionCoordinator … out of range` lines. Test 46 alone prints none, and I did not check whether the others predate this change.
- Not run: the other workspaces' tests, and the full store leg.

Measured with throwaway scripts against `dist`, not in the suite: a table in the `temp` schema, and `apply schema` adding a CHECK that reads a NOT NULL variable (rejected with the new error) or a NULL one (accepted). Also measured: declared collation is preserved through the derived source, and `select … where who <= 0` still returns the stored row after a variable-reading CHECK is accepted.

## Use cases to try

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
