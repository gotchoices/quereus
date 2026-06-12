description: Declared row constraints (CHECK, FK, secondary UNIQUE) on a maintained table are silently bypassed by every derivation-driven write — decide and specify what a declared constraint MEANS on a derivation-bearing table.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # createMaintainedTable / attachMaintainedDerivation (fill + reconcile via applyMaintenance)
  - packages/quereus/src/core/database-materialized-views.ts         # row-time maintenance dispatch (privileged surface)
  - packages/quereus/src/planner/building/ddl.ts                     # raiseCreateMaintainedDiagnostics (the create-form gate site, if reject is chosen)
  - packages/quereus/src/planner/building/alter-table.ts             # setMaintained build gates (ditto for attach)
----

# Declared-constraint semantics on maintained tables

The declared-shape table form (`create table … maintained as`) and the attach
verb (`alter table … set maintained as`) let an author declare arbitrary row
constraints on a table whose contents are derivation-driven. Today those
constraints are **decoration**: the create-fill, the attach reconcile, and
steady-state row-time maintenance all write through the privileged backing
surface (`applyMaintenance`), which deliberately re-validates nothing.

Reproduced during the attach-detach-verbs review (memory module):

```sql
create table src (id integer primary key, v text not null);
insert into src values (1, 'bad');
create table mt (id integer primary key, v text not null check (v <> 'bad'))
  maintained as select id, v from src;
-- succeeds; mt contains the CHECK-violating row
insert into src values (2, 'bad');
-- maintenance also stores the violating row silently
```

The MV sugar could never declare a CHECK, so the unified model's table form is
what newly exposes this. Generated columns got an explicit reject on both
authoring forms (the body supplies every value); CHECK / FK / secondary UNIQUE
have no stance at all.

## Expected behavior (to be decided — the options)

1. **Reject at create/attach** (parity with the generated-column gate): a
   maintained table may not declare CHECK / FK / secondary UNIQUE — the body
   IS the contract. Simplest, but forfeits legitimate uses (a CHECK as a
   declared invariant the author wants enforced against the *derivation*, an
   FK documenting lineage for tooling).
2. **Validate derived rows**: evaluate declared CHECKs (and FK existence?)
   against rows the fill/reconcile/maintenance write, failing the statement on
   violation. Most semantically honest; turns a source write into a potential
   constraint error at a *different* table, which needs a clearly attributed
   diagnostic, and costs per-row evaluation on the maintenance hot path.
3. **Document as informational**: constraints on a maintained table are
   declared-shape metadata only, enforced never (or only against future
   detach-then-write usage, where the table is plain again and they DO
   enforce). Cheapest; needs loud documentation.

Note the detach interplay for any choice: after `alter table … drop
maintained` the table is ordinary and its declared constraints enforce against
user DML — rows previously stored in violation then exist in a table whose
constraints claim they cannot. Whatever is decided must say what detach means
for pre-existing violating rows.

Related (does not cover this): `maintained-table-dml-executor-backstop`
(implement/) handles rejecting direct writes against maintained tables (user
DML routes through write-through); this ticket is about
what the *derivation's own writes* owe the declared constraints.
