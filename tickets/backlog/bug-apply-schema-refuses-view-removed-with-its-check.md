description: A schema migration that removes or renames a view and, in the same declaration, also stops a table's CHECK rule from reading it is refused, even though the result would be valid, because the plan drops the view before it removes the rule.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan: view drops run before pushTableAlters, whose stage 2 holds DROP CONSTRAINT
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts # assertNoExpressionDependsOn, the refusal
  - docs/schema-declarative.md # Migration Order
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: Nothing is lost, because the apply fails on its first step with a clear error and the database stays as it was, and the migration can be split into two applies, so a maintainer may prefer not to disturb the plan order for it.
----

Found while working on the failures from GitHub issue #39. Run on the current code with a temporary spec, on the memory module.

From `table T (Id integer primary key, N integer); view V1 as select sum(N) as S from T; table P (Id integer primary key, U integer, constraint pc check (U <= (select S from V1)));`, each of these declarations is self-consistent, and each is refused:

| new declaration | plan | result |
|---|---|---|
| `V1` removed, `P` without the CHECK | `DROP VIEW IF EXISTS v1`, `ALTER TABLE P DROP CONSTRAINT pc` | `cannot drop view 'main.v1': it is referenced by CHECK constraint 'pc' on table 'P'` |
| `V1` removed, `pc` changed to `check (U <= 5)` | the same drop first, then `DROP CONSTRAINT pc`, then `ADD constraint pc check (U <= 5)` | the same refusal |
| a view renamed with a `quereus.previous_name` hint, and `pc` changed to read the new name | `DROP VIEW IF EXISTS V9old`, `DROP CONSTRAINT pc`, `create view V9 ...`, `ADD constraint pc ...` | the same refusal, naming `V9old` |

## Expected behavior

The declaration applies, because once the plan has finished no rule reads the removed view. A declaration that removes the view and keeps the rule must still be refused.

## Notes

The refusal is judged at the `DROP VIEW` step, when the constraint is still there, because view drops run before every table's `DROP CONSTRAINT`. Assertions do not have this problem, because `DROP ASSERTION` runs first in the plan.

A DEFAULT moved off the view is expected to behave the same way, since `DROP DEFAULT` also runs after the view drop. That was read from the code, not run.

The workaround, not run: apply once with the CHECK changed and the view still declared, then apply again without the view.

`bug-apply-schema-redefine-view-a-rule-reads` handles the case where the view comes back under the same name, and does not cover this one.
