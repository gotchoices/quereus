description: A schema migration that removes a view or table and, in the same declaration, also stops a table's CHECK rule or column DEFAULT from reading it is refused, even though the result would be valid. Fix it by judging such a drop against what the declaration says the schema will be when the migration ends, not against the half-migrated state at the moment the drop runs.
architecture: docs/schema-declarative.md#redefining-what-a-rule-reads
files:
  - packages/quereus/src/schema/schema-differ.ts # computeSchemaDiff (~986, recreatedObjectReachProbe beside it ~2663), withViewsReached ~2630, objectsNamedIn ~2704, objectsRecreatedByDiff ~3454, SchemaDiff type
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts # assertNoExpressionDependsOn: the refusal, and its existing exception for recreated objects
  - packages/quereus/src/schema/expression-dependents.ts # findTableExpressionDependent ~194: needs a way to skip tables in the applied schema
  - packages/quereus/src/core/database.ts # _setSchemaRecreatedObjects / _getSchemaRecreatedObjects ~2940: the holder the guard reads
  - packages/quereus/src/runtime/emit/schema-declarative.ts # sets the holder around runBatchedMigrationLoop (~382); revalidateChecksOverRecreatedObjects (~840)
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic # sections 12-14 cover the recreated / still-refused cases; add the new ones after 14
  - docs/schema-declarative.md # § Redefining what a rule reads, its two "Known limits" bullets naming this ticket
repro: verified
----

## What goes wrong

`apply schema` turns a declaration into an ordered plan of DDL steps (`generateMigrationPlan`). Table and view drops run early (step 2 of § Migration Order); a table's `DROP CONSTRAINT` and `ALTER COLUMN … SET DEFAULT` run later, in stage 2 of the table alters. Every `DROP TABLE` / `DROP VIEW` passes through `assertNoExpressionDependsOn`, which refuses the drop when any table's CHECK, DEFAULT or generated expression can still reach the object (directly, or through view and maintained-table bodies) **in the catalog as it stands at that moment**. Mid-plan, the rule that the declaration removes or rewrites is still there, so the drop is refused.

The guard already has one exception inside `apply schema`: an object the same plan drops and creates again under the same name (`objectsRecreatedByDiff`, held on `Database._setSchemaRecreatedObjects`) passes, and the CHECKs that reach it are scanned against the rows after the last step. There is no exception for an object that is removed for good while every rule reading it is removed or rewritten too.

## Reproduction (run on the memory module, built `dist`, all verified)

Base:

```sql
create table T (Id integer primary key, N integer); insert into T values (1, 10);
create table T2 (Id integer primary key, N integer); insert into T2 values (1, 10);
create view V1 as select sum(N) as S from T;
create table P (Id integer primary key, U integer, constraint pc check (U <= (select S from V1)));
insert into P values (1, 5);
```

| declaration (T and T2 kept unless stated) | plan | result today |
|---|---|---|
| V1 removed, P without `pc` | `DROP VIEW v1`, `ALTER TABLE P DROP CONSTRAINT pc` | `cannot drop view 'main.v1': it is referenced by CHECK constraint 'pc' on table 'P'` |
| V1 removed, `pc` is `check (U <= 5)` | `DROP VIEW v1`, `DROP CONSTRAINT pc`, `ADD constraint pc check (U <= 5)` | same refusal |
| V1 renamed to V9 (`quereus.previous_name` hint), `pc` reads V9 | `DROP VIEW V1`, `DROP CONSTRAINT pc`, `create view V9 …`, `ADD constraint pc …` | same refusal, naming `V1` |
| T removed, V1 now `select sum(N) as S from T2`, `pc` kept | `DROP TABLE t`, `DROP VIEW V1`, `create view V1 …` | `cannot drop table 'main.t': CHECK constraint 'pc' on table 'P' reaches it through view 'V1'` (rows of T intact) |
| (no `pc` in base) `Q.W integer default (select S from V1)`; V1 removed, `W default 5` | `DROP VIEW v1`, `ALTER TABLE Q ALTER COLUMN W SET DEFAULT 5` | `cannot drop view 'main.v1': it is referenced by the DEFAULT of column 'W' on table 'Q'` |

These must stay refused, and are today (sections 14 of `50.4-declare-schema-apply-restore.sqllogic` already pin the view forms):

| declaration | result |
|---|---|
| V1 removed, `pc` kept reading V1 | refused at `DROP VIEW v1` |
| T removed, V1 kept reading T, `pc` kept | refused at `DROP TABLE t`, before any row is lost |

## Fix: judge a removed object's drop against the declared end state

Do **not** fix this by reordering the drops. Running view drops ahead of table drops would let `DROP TABLE t` pass the guard in the last must-refuse row (the old V1 is gone, so the catalog shows no reach), destroying T's rows before the plan fails at `create view V1`. Hoisting `DROP CONSTRAINT` ahead of the drops fixes only the CHECK rows, not the DEFAULT row or the retargeted-view row, and needs the same end-state test to stay safe (a rewritten `pc` that still reads a removed T would otherwise let `DROP TABLE` destroy rows).

Instead extend the existing exception with a second set, the drops the declaration has released:

**Released object** — a table or view the plan drops and does not recreate (in `tablesToDrop` / `viewsToDrop`, not in `objectsRecreatedByDiff`), which no rule in the declared schema reaches: no declared table's CHECK (table- or column-level), column DEFAULT or generated expression names it, directly or through the declared view bodies and declared maintained-table bodies (the same `declaredBodies` map `recreatedObjectReachProbe` builds; `collectColumnDefReads` / `collectExpressionReads` / `withViewsReached` already do the walking). Because the plan converges on the declaration, every rule in the applied schema that reaches a released object in the catalog is dropped or rewritten later in the same plan.

- Compute the set in `computeSchemaDiff`, next to `recreatedObjectReachProbe`, where the declared view bodies and declared tables are in scope, and carry it on `SchemaDiff` (e.g. `releasedDrops: string[]`, names as they appear in the drop buckets). `diff schema` ignores it; the plan text does not change.
- **Other schemas.** The differ sees only the applied schema (see the NOTE on `withViewsReached`). Two consequences:
  - A rule on a table in another schema can reach a released object, and the declaration says nothing about that table. So for a released object the guard still refuses a dependent on a table outside the applied schema; it skips only dependents on tables inside it. Give `findTableExpressionDependent` an optional table filter rather than writing a second walker.
  - A declared rule can reach a removed object through a view in another schema, which the differ cannot follow. Be conservative: if the walk from any declared rule meets a name in another schema (`objectsNamedIn` currently filters these out; it needs a variant or flag that reports them), release nothing for that diff. This is rare, and the result is today's behaviour.
- In `schema-declarative.ts`, hold the released keys beside the recreated ones around `runBatchedMigrationLoop`. Either widen the `Database` holder to carry both sets, or add a sibling `_setSchemaReleasedObjects`; keep the same set/restore-in-`finally` pattern and the same "statement mutex held" contract. The post-plan `revalidateChecksOverRecreatedObjects` must keep reading only the recreated set: a released object does not exist after the plan, so it has no rows to judge against.
- In `assertNoExpressionDependsOn`: recreated → pass (unchanged); released → refuse only for a dependent on a table outside the applied schema; otherwise unchanged. Note that "the applied schema" is the `schemaName` of the drop, which for a plan step is always the applied schema; make sure a hand-run `drop view` of another schema's object during no apply is unaffected (the sets are empty outside a migration).
- Optional safety net, only if it falls out cheaply: after the last step, run `findTableExpressionDependent` for each released key and fail the apply if anything still reaches it. First check whether the object-ref resolver resolves a name whose object no longer exists; if it does not, skip this rather than build a separate walker.

### Why the unwind still works

If a later step fails, the journal runs in reverse, so the undo of `DROP CONSTRAINT pc` (an `ADD CONSTRAINT` reading V1) runs before the undo of `DROP VIEW v1`. During an unwind `ADD CONSTRAINT` does not scan rows (`rejectCheckViolatedByExistingRows` returns early under `_isSchemaUnwinding`), and the unwind finishes by comparing the catalog with its pre-apply rendering. Confirm this with the test below (force a failure after the drop) rather than assuming it; if the re-add does plan its body against the missing view, the fix needs the undo ordering looked at, and the handoff must say so.

### What stays a known limit

- `diff schema` output run by hand is still refused at the drop, because the exception exists only inside `apply schema` (already listed in the doc).
- Between the drop and the later `DROP CONSTRAINT` / `SET DEFAULT`, the rule on that table names a missing object. No plan step writes rows of an existing table before stage 2 ends except an `ADD COLUMN` backfill, which judges only the new column's own inline CHECKs. Leave a `NOTE:` at the guard's released branch: if a plan step ever starts evaluating a table's existing CHECKs or DEFAULTs mid-plan, a released object's readers on that table must be removed before that step.
- A table dropped in the same plan is still unrestorable if a later step fails (the existing residual for `DROP TABLE`, unchanged).

## Related, not in this ticket

The same mid-plan judgement refuses a removed parent table whose child keeps its rows but loses its foreign key (`DROP TABLE t` fails with `FOREIGN KEY constraint failed … still has rows referencing it` before `DROP CONSTRAINT pf` runs). That is a different guard (the foreign-key check on drop in `schema/manager.ts`), filed as `bug-apply-schema-refuses-parent-removed-with-its-foreign-key` in backlog.

## TODO

- Add the released-drops computation to `computeSchemaDiff` and the `SchemaDiff` field, reusing the declared-bodies walk from `recreatedObjectReachProbe` (factor the shared map-building out rather than copy it).
- Add the conservative other-schema bail-out to that computation.
- Add an optional table filter to `findTableExpressionDependent`.
- Hold the released keys on `Database` around the migration loop in `schema-declarative.ts`; keep `revalidateChecksOverRecreatedObjects` on the recreated set only.
- Teach `assertNoExpressionDependsOn` the released branch, with the `NOTE:` above, and update its docblock (the "Also passes…" paragraph) and the `Database` holder's docblock.
- Optional post-plan safety net, per the condition above.
- Tests: in `50.4-declare-schema-apply-restore.sqllogic`, after section 14, one section that applies the five declarations in the first table above (each asserting the end state: view gone, `pc` / default as declared, rows of T / T2 intact where kept), and one case that forces a failure after a released `DROP VIEW` (for example a later `ADD CONSTRAINT` the existing rows violate) and checks the view and `pc` are both back. The must-refuse cases are already covered by section 14 plus one new row for "T removed, V1 still reads T" if no existing test pins it (check `41.10.4-drop-object-expression-dependents.sqllogic` first).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; run the 50.4 file under `yarn test:store` too, since drops and constraint alters take the store path differently.
- Docs: in `docs/schema-declarative.md` § Redefining what a rule reads, add the released-drop exception next to the recreated one (what counts, the other-schema rule, that nothing is revalidated for it), and remove the two "Known limits" bullets that name this ticket.
