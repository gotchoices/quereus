description: A CHECK constraint added by ALTER TABLE that reads one of the table's per-statement context values fails with "column not found", even though the same CHECK is accepted in CREATE TABLE. The spec does not say how such a CHECK should be validated against rows that already exist, so a decision is needed before it can be fixed.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateChecksOverExistingRows (~:463) / validateRowInvariantChecksOverExistingRows — the shared existing-row CHECK scan
  - packages/quereus/src/runtime/emit/alter-table.ts  # validateBackfillAgainstChecks (~:1107) — inline CHECK on ADD COLUMN with a literal DEFAULT
  - packages/quereus/src/planner/building/alter-table.ts  # buildAddColumnChecks (~:363) — inline CHECK on ADD COLUMN with a per-row DEFAULT
  - packages/quereus/src/planner/building/mutation-context.ts  # the no-envelope registration helper added by bug-add-column-default-cannot-reference-mutation-context
  - docs/sql-alter.md  # ADD CONSTRAINT / ADD COLUMN inline-constraint validation
  - docs/sql-ddl.md  # §2.6.2
repro: verified
----

**Blocked: specification is silent.** Unblocks when a maintainer accepts (or edits) the proposed rule below; the implementation is then small and mechanical.

Filed from the lamina board while planning lamina slug `bug-add-column-default-cannot-reference-mutation-context`, whose DEFAULT half is `tickets/implement/bug-add-column-default-cannot-reference-mutation-context.md` here.

## What happens today

Measured on published `@quereus/quereus` 4.20.2, plain `Database`, each statement on a table with one existing row:

| Statement | Result |
|---|---|
| `create table t (a integer primary key) with context (who integer null); alter table t add constraint k check (who is null or a > 0);` | `Column not found: who` |
| same with `who integer` (NOT NULL) and `check (who > 0)` | `Column not found: who` |
| `alter table t add column c integer null default 1 check (who is null or c > 0);` (literal DEFAULT) | `Column not found: who` |
| `alter table t add column c integer null default (new.b) check (who is null or c > 0);` (per-row DEFAULT) | `Column not found: who` |

The same CHECKs are accepted by `create table … with context (…)` and enforced on every write that reads them.

The cause is the same at all three sites: the existing-row validation compiles the CHECK against the table's columns only, with no context variables in scope.

## The question the spec leaves open

ALTER validates a new CHECK against rows that are already stored, because the optimizer treats a declared CHECK as a proven fact about every stored row (`test/logic/10.1.8-alter-add-check-existing-rows.sqllogic` explains why). Those rows were written under context envelopes that are not stored anywhere, so there is no true value of `who` for them. The spec says what a statement with no envelope reads (§2.6.2: a NULL-declared variable reads NULL, a NOT NULL one that is read is an error), but not whether ALTER's existing-row validation counts as such a statement.

## Proposed rule (recommended default)

Add to `docs/sql-alter.md`, under the ADD CONSTRAINT and ADD COLUMN inline-constraint validation text:

> Existing-row validation of a CHECK runs as a statement that supplied no `with context` envelope (§2.6.2 of sql-ddl.md). A context variable declared NULL reads as NULL, so a comparison against it is unknown and the row passes, as for any NULL comparison. A CHECK that reads a NOT NULL context variable is rejected — whether or not the table has rows — because ALTER cannot supply a value; declare such a CHECK in `CREATE TABLE`, or declare the variable NULL and write the CHECK to tolerate its absence.

This is the same rule the DEFAULT half applies to `ADD COLUMN … DEFAULT (<var>)`, so one principle covers every ALTER that compiles a row expression. Implementation reuses that ticket's no-envelope registration helper at the three sites above, with a CHECK-specific error message.

## Alternatives rejected

- **Skip existing-row validation for a CHECK that reads any context variable.** Accepts more programs, but the optimizer would then trust a predicate nobody checked against the stored rows. A CHECK like `who is null or a > 0` has a context-free part that can be violated today and would go unchecked. That is the wrong-result hazard 10.1.8 guards against.
- **Accept, and evaluate a NOT NULL variable as NULL during validation.** Contradicts §2.6.2's per-variable rule and makes the rule depend on which statement reads the variable.

## If nothing is decided

The current error stays. It is wrong about the cause ("column not found" for a declared variable), but it rejects, so no wrong result is stored. The only workaround is to declare the CHECK in `CREATE TABLE`.

## Reversibility

The recommended rule rejects the NOT NULL case. A later decision to accept it turns an error into acceptance and changes no program that already works. Choosing "skip validation" first and then tightening would reject schemas that are already deployed.
