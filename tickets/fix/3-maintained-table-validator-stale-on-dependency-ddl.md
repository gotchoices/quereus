description: The derived-row constraint validator compiled at registerMaterializedView goes stale when a table it references — an FK parent or a subquery-CHECK target, neither of which is a derivation source — is renamed or dropped. After a parent RENAME, even valid maintenance writes to the maintained table fail with an internal "Module connect failed" error; after a DROP, writes fail with the same internal error instead of the FK-violation class an ordinary table raises.
prereq: maintained-table-derivation-secondary-unique
files:
  - packages/quereus/src/core/derived-row-validator.ts            # compiled once at registration; holds emitted schedulers over dependency tables
  - packages/quereus/src/core/database-materialized-views.ts      # subscribeToSchemaChanges — existing notifier seam (currently watches derivation sources only)
  - packages/quereus/src/runtime/emit/alter-table.ts               # rename propagation (rewriteTableForTableRename rewrites FK referencedTable on catalog records)
difficulty: medium
----

# Stale derived-row validator after DDL on a constraint dependency

## Reproductions (verified against the implementation commit)

A maintained table's declared-constraint validator (`buildDerivedRowValidator`)
compiles its CHECK / child-side-FK expressions once, at
`registerMaterializedView`, into emitted schedulers. Those expressions can
reference tables that are NOT derivation sources — the FK's parent table, or
any table inside a subquery-bearing CHECK. Nothing re-registers the maintained
table when such a dependency changes, so the compiled schedulers reference the
dead incarnation:

1. **Rename the FK parent** — `create table parent…; create table mt (… ref
   integer references parent(pid)) maintained as select … from src; alter
   table parent rename to parent2;` — a subsequent VALID source write
   (`insert into src values (1, 1)` with parent row present) fails with
   `Module 'memory' connect failed for table 'parent': Memory table definition
   for 'parent' not found`. An ordinary child table admits the same write
   (rename propagation rewrites its FK `referencedTable`, and the next
   statement re-prepares). **All maintenance writes to the maintained table
   are bricked until re-attach.**

2. **Drop the FK parent** — same failure message. An ordinary child table
   instead rejects fully-non-NULL refs with a CONSTRAINT-class error (the
   `buildChildSideFKChecks` absent-parent null-guard fallback) and still admits
   NULL refs. The maintained table fails both with the internal error
   (a NULL-ref row passes only because the null-guard short-circuits before
   the EXISTS scan).

3. **Drop a subquery-CHECK target** — `check (n <= (select lim from quota …))`,
   then `drop table quota` — subsequent source writes fail with the same
   internal connect error at commit (the deferred evaluator's scan).

Note rename of the maintained table ITSELF is fine (the rename path
unregisters + re-registers, rebuilding the validator), and rename of a
derivation SOURCE re-registers via `propagateTableRenameToMaterializedViews`.
The gap is exactly the constraint-only dependencies.

## Expected behavior (ordinary-table parity)

- Parent renamed → maintenance writes keep working; FK existence validates
  against the renamed parent (the catalog record's FK `referencedTable` is
  already rewritten by `rewriteTableForTableRename` — only the compiled
  validator is stale).
- Parent dropped → derivation writes carrying a fully-non-NULL ref fail with
  the maintained-table-attributed FK CONSTRAINT error; NULL refs admitted
  (MATCH SIMPLE). No INTERNAL-class errors.
- Subquery-CHECK target dropped → same class of behavior as an ordinary table
  whose CHECK subquery target is dropped (statement re-prepare surfaces a
  clear "table not found" planning error, not a module connect failure).

## Implementation seams (research, not prescription)

- `MaterializedViewManager.subscribeToSchemaChanges` already listens for
  `table_removed` / `table_modified` and reacts when the changed table is a
  derivation source. The natural extension: record each registered plan's
  *constraint dependency tables* (FK `referencedSchema.referencedTable` plus
  every table referenced inside an applicable CHECK expression) at
  registration, and on a matching event rebuild just the validator
  (`plan.derivedRowValidator = buildDerivedRowValidator(db, mv)`) from the
  CURRENT catalog record — cheap, no maintenance interruption, no staleness
  marking needed (the derivation itself is unaffected).
- Rebuild failure handling needs a decision: a rebuild that throws (e.g. the
  CHECK's subquery target no longer exists) should not brick the notifier;
  one option is to swap in a validator that fails the next write with the
  sited planning error.
- The chained `maintained-table-derivation-secondary-unique` work adds more
  compiled validation state; land this after it so the invalidation covers
  both (hence the prereq).
- There is no schema generation counter to lean on for lazy recompile;
  `Schema.addTable` is a plain map write. The notifier is the only existing
  invalidation channel.
