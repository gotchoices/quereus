description: Rebuild a maintained table's derived-row constraint validator when a CONSTRAINT-only dependency (FK parent or subquery-CHECK target — neither a derivation source) is renamed or dropped. Today the validator is compiled once at registerMaterializedView and goes stale: after such a DDL, maintenance writes fail with an internal "Module 'memory' connect failed … not found" error instead of either succeeding (rename) or raising the ordinary FK/planning error class (drop).
prereq: maintained-table-derivation-secondary-unique
files:
  - packages/quereus/src/core/derived-row-validator.ts             # buildDerivedRowValidator — compiles CHECK/FK schedulers; freshPlanningContext holds the dependency tracker
  - packages/quereus/src/core/database-materialized-views.ts       # subscribeToSchemaChanges + registerMaterializedView — the invalidation seam; derivedRowValidator carried on the plan
  - packages/quereus/src/planner/building/foreign-key-builder.ts   # buildChildSideFKChecks — absent-parent null-guard fallback (drop-parent parity)
  - packages/quereus/src/runtime/emit/alter-table.ts               # rewriteTableForTableRename rewrites mt's own FK referencedTable / CHECK AST + fires table_modified on mt (the rename signal)
  - packages/quereus/src/planner/planning-context.ts               # BuildTimeDependencyTracker.getDependencies() — extracts the table deps the builders resolved
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts  # where the new validator pins belong
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
  - docs/materialized-views.md                                     # § Derived-row constraint validation — document the invalidation channel
difficulty: medium
----

# Rebuild the derived-row validator on constraint-dependency DDL

## Root cause (reproduced + traced)

`buildDerivedRowValidator` (derived-row-validator.ts) compiles each declared
CHECK / child-side-FK expression **once**, at `registerMaterializedView`, into a
`Scheduler` (`compileDerivedRowCheck` → `db.optimizer.optimize` + `emitPlanNode`
+ `new Scheduler`). Those schedulers bake in `TableReferenceNode`s resolved to
the **memory-table incarnations** of tables the constraint references but the
*derivation* does not — the FK's parent table, and any table inside a
subquery-bearing CHECK. `MaterializedViewManager.subscribeToSchemaChanges`
(database-materialized-views.ts:440) reacts only when the changed table is in
`mv.derivation.sourceTables`, so a rename/drop of a constraint-only dependency
never rebuilds the validator. The stale scheduler then tries to connect to the
dead incarnation and throws.

All three reproductions in the source ticket were confirmed against this commit
(temporary spec, since removed — three `create … maintained as` tables with an
FK / subquery-CHECK, then `alter … rename` / `drop` the dependency, then a
source write):

1. **Rename FK parent** (`parent` → `parent2`), then a VALID source write whose
   ref exists under `parent2`: fails at commit with
   `Module 'memory' connect failed for table 'parent': Memory table definition
   for 'parent' not found. Cannot connect.` Stack: deferred-constraint queue →
   `derived-row-validator.ts:114` evaluator → `scan.ts` connect. **All
   maintenance writes are bricked.**
2. **Drop FK parent**, then a non-NULL-ref source write: same internal connect
   error (should be a maintained-table FK CONSTRAINT error; a NULL ref is
   admitted only because the null-guard short-circuits before the dead scan).
3. **Drop subquery-CHECK target** (`drop table quota`), then a source write:
   same internal connect error at commit.

Why rename of the maintained table ITSELF or of a derivation SOURCE is already
fine: those paths re-register the MV (`runRenameTable` →
`unregister`+`registerMaterializedView`; `propagateTableRenameToMaterializedViews`),
which re-runs `buildDerivedRowValidator`. The gap is exactly the
**constraint-only** dependencies, which never trigger a re-register.

## Expected behavior (ordinary-table parity)

- **Parent renamed** → maintenance writes keep working; FK existence validates
  against the renamed parent. The maintained table's own catalog record is
  already correct — `rewriteTableForTableRename` (alter-table.ts:1510-1516)
  rewrites its FK `referencedTable` to the new name and (line 1503-1508) rewrites
  any CHECK AST in place. Only the compiled validator is stale.
- **Parent dropped** → a derivation write carrying a fully-non-NULL ref fails
  with the maintained-table-attributed FK CONSTRAINT error; a NULL ref is
  admitted (MATCH SIMPLE). No INTERNAL-class error. A *rebuilt* validator
  produces exactly this: `buildChildSideFKChecks` (foreign-key-builder.ts:209-219)
  emits a null-guards-only check terminated by literal `0` when the parent is
  absent — the same fallback an ordinary child table uses.
- **Subquery-CHECK target dropped** → the write surfaces a clear
  "table not found" planning error (statement re-prepare class), not a module
  connect failure. A *rebuilt* validator throws this at rebuild time; see the
  rebuild-failure handling below for how that error reaches the next write.

## Fix design

Track each registered plan's **constraint-dependency tables** and rebuild the
validator (only — the derivation is unaffected, so no staleness marking, no
maintenance interruption) when a matching schema-change event fires.

### 1. Record the dependency set at registration

`buildDerivedRowValidator` already builds the CHECK/FK plans through a
`freshPlanningContext` whose `schemaDependencies` (`BuildTimeDependencyTracker`)
records every resolved `type:'table'` dependency (schema-resolution.ts:60/113) —
this captures both the FK-parent EXISTS subquery and the subquery-CHECK target.
After the builders run, compute the dependency set as the union of:

- the tracker's table deps: `ctx.schemaDependencies.getDependencies()`, filtered
  to `type === 'table'`, qualified as `(schemaName ?? mv.schemaName).toLowerCase()
  + '.' + objectName.toLowerCase()`;
- each FK parent explicitly: `(fk.referencedSchema ?? mv.schemaName).toLowerCase()
  + '.' + fk.referencedTable.toLowerCase()` (belt-and-suspenders — do not rely
  solely on the tracker for the FK parent).

Then **exclude** the derivation sources (`mv.derivation.sourceTables`, already
handled by the existing source-change path) and the MV's own qualified name.
Expose the result on the returned validator, e.g.
`readonly dependencyTables: ReadonlySet<string>`, so it travels with the
validator the plan carries.

### 2. React to events (extend `subscribeToSchemaChanges`)

In the `table_removed` / `table_modified` branch, in addition to the existing
source-table loop, iterate the registered row-time plans (or the maintained
tables, then look up their plan) and rebuild when the changed `schema.object`
(lowercased) is **either**:

- in that validator's `dependencyTables` — covers **drop of the FK parent**,
  **drop of the subquery-CHECK target**, and any `alter` on those; or
- equal to the maintained table's OWN qualified name — covers the **rename**:
  the parent rename rewrites the maintained table's own FK/CHECK in place and
  fires `table_modified` on the maintained table itself (alter-table.ts:1448-1457),
  while the original parent name is gone from the catalog (renamed, not dropped),
  so the dependency-set match alone would miss it.

Rebuild = `plan.derivedRowValidator = buildDerivedRowValidator(db, currentMv)`
read from the CURRENT catalog record (`schemaManager.getMaintainedTable`), and
**refresh** the recorded dependency set from the rebuilt validator (so a rename
re-keys `{main.parent}` → `{main.parent2}` and a subsequent drop of `parent2` is
also caught). Do **not** call `releaseRowTime` / mark stale here.

Ordering note to verify: on a parent rename the new parent (`parent2`) is added
to the catalog (alter-table.ts:198) before propagation fires the maintained
table's `table_modified` (line 1448-1457), so the rebuild's FK EXISTS resolves
against `parent2`. Confirm the source-change path's `emitBackingInvalidation`
synthetic `table_modified` on the MV's own name does not double-fire a rebuild
in a harmful way — it runs AFTER `releaseRowTime`, so `rowTime.get(key)` is
undefined and the own-name branch is a no-op there (intended).

### 3. Rebuild-failure handling (do not brick the notifier)

A rebuild can throw — the subquery-CHECK target was dropped, so
`buildConstraintChecks` → `optimize` raises a "table not found" planning error.
(The FK-parent-dropped case does **not** throw: the absent-parent fallback
builds cleanly.) Catch the throw and install a **poisoned validator** that
re-throws the captured `QuereusError` on the next derivation write, so:

- the notifier listener never propagates an exception (a schema-change event
  must not fail the unrelated DDL that triggered it);
- the next source write surfaces the clear sited planning error, matching the
  ordinary-table re-prepare behavior the expected-behavior section calls for.

Recommended representation: a minimal `DerivedRowConstraintValidator` whose
`checks` is a single inline (non-deferred) check whose evaluator throws the
captured error, with `dependencyTables` retained so a later re-create of the
dropped table (or further DDL) re-triggers a healthy rebuild. Implementer's
latitude on the exact shape — keep the `DerivedRowConstraintValidator` interface
uniform so `validateDerivedRowImage` needs no special-casing.

## Scope / non-goals

- UNIQUE validation (the `maintained-table-derivation-secondary-unique` prereq)
  is self-contained on the backing table's own covering index and references no
  external table, so it cannot go stale on external DDL — out of scope. The
  rebuild simply re-runs whatever `buildDerivedRowValidator` currently emits.
- No new schema-generation counter is introduced; the change-notifier remains
  the only invalidation channel (consistent with the existing source path).

## TODO

- [ ] In `buildDerivedRowValidator` (derived-row-validator.ts), compute the
      constraint-dependency set (tracker `type:'table'` deps ∪ explicit FK
      parents, minus derivation sources and the MV's own name) and expose it on
      the returned `DerivedRowConstraintValidator` as `dependencyTables`.
- [ ] Extend `MaterializedViewManager.subscribeToSchemaChanges`
      (database-materialized-views.ts) to rebuild a plan's `derivedRowValidator`
      when a `table_removed`/`table_modified` names a table in its
      `dependencyTables` OR the MV's own qualified name; refresh the recorded
      dependency set from the rebuilt validator. No `releaseRowTime` / staleness
      marking on this path.
- [ ] Wrap the rebuild in try/catch; on throw install a poisoned validator that
      re-throws the captured sited error on the next derivation write, keeping
      `dependencyTables` for later self-healing.
- [ ] Confirm rename ordering (parent2 present before the MV's own
      `table_modified`) and that `emitBackingInvalidation`'s synthetic event is a
      no-op on the own-name branch (plan already released).
- [ ] Tests (extend maintained-table-declared-constraints.spec.ts + 51.8
      sqllogic):
      - rename FK parent → valid source write succeeds; an orphan write fails
        with the maintained-table FK attribution against the renamed parent;
      - drop FK parent → non-NULL-ref write fails with the maintained-table FK
        CONSTRAINT error (NOT INTERNAL); NULL ref admitted;
      - drop subquery-CHECK target → source write surfaces a clear
        table-not-found planning error (not a module connect failure);
      - rename subquery-CHECK target → CHECK still validates against the renamed
        table (the CHECK-analogue of the FK rename);
      - (nice-to-have) re-create a dropped dependency, then write → validator
        self-heals.
- [ ] Update `docs/materialized-views.md` § Derived-row constraint validation and
      the header comments in derived-row-validator.ts /
      database-materialized-views.ts to document the constraint-dependency
      invalidation channel.
- [ ] Run `yarn workspace @quereus/quereus test` (and lint) green before handoff.
