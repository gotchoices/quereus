description: Re-applying a logical schema can remove a column that a database-wide assertion reads; the re-apply succeeds, and afterwards every write to the database fails. Dropping an ordinary view that an assertion reads is refused instead.
architecture: docs/lens-deployment.md
files:
  - packages/quereus/src/schema/lens-compiler.ts # deployLogicalSchema — compile-first loop, then the clear-and-rebuild of lens views (~240)
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts # assertNoAssertionDependsOn — what drop view runs
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts # assertNoExpressionDependsOn — same, for CHECK / DEFAULT / generated subqueries
  - packages/quereus/src/runtime/emit/drop-view.ts # the plain-view drop that refuses this case
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The database recovers as soon as the assertion is dropped or the column is redeployed, and a guard that refuses the deploy needs a rule for what "depends on" means when a lens body changes but still exists, which `drop view` never had to answer.
----

## Reproduction (verified, memory module)

```sql
declare schema ybasis { table t { id integer primary key, name text } }
apply schema ybasis;
insert into ybasis.t values (1, 'alpha');
declare logical schema appx { table t { id integer primary key, name text } }
declare lens for appx over ybasis { }
apply schema appx;
create assertion a_ok check (not exists (select 1 from appx.t where name = 'bad'));
declare logical schema appx { table t { id integer primary key } }
apply schema appx;                       -- accepted
insert into ybasis.t values (3, 'gamma'); -- fails: Column not found: name
```

Every later write fails while the assertion's body no longer plans. With a plain view in place of the lens view, `drop view` refuses up front via `assertNoAssertionDependsOn` ("dropping it out from under one breaks every write to the database"), and `assertNoExpressionDependsOn` does the same for a CHECK / DEFAULT / generated-column subquery that reads the view.

## Expected behaviour

A logical-schema deploy that would leave an assertion (or a table's CHECK / DEFAULT / generated expression) unable to plan is refused atomically, before the catalog changes, with a diagnostic naming the dependent — consistent with `drop view`. A deploy that only changes a lens body while every dependent still plans should be allowed.

## Notes

- The deploy already has an atomic compile-first phase that aggregates prover errors before mutating the catalog; this check belongs with it.
- Open question for whoever picks this up: refuse only when a dependent fails to re-plan against the new lens views (precise, but requires planning against the not-yet-registered set), or refuse whenever a lens view an assertion reads is removed or its columns shrink (simpler, coarser).
- Found while working `bug-lens-redeploy-keeps-materialized-view-on-old-lens-body`, which adds change notifications for lens view replacement but not this guard.
