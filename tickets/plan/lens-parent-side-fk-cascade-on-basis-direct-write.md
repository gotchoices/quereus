description: Scope the logical (lens) parent-side FK CASCADE/SET NULL/SET DEFAULT cascade walker so it fires ONLY for lens-routed writes, not basis-direct writes — making it consistent with the lens RESTRICT side and with logical CHECK constraints (all enforced at the lens boundary, not on basis-direct DML). Surfaced in review of `lens-parent-side-fk-cascade-actions`.
prereq: lens-parent-side-fk-cascade-actions
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, docs/lens.md
----

## The asymmetry

The runtime lens cascade walker (`executeLensForeignKeyActions`, fired from the DML
executor via `executeForeignKeyActionsAndLens` after **every** basis row delete/update)
reverse-maps the *basis* parent table to the logical parent slot(s) it backs and
propagates the logical FK action. It keys purely on **basis-table identity**, not on
whether the write arrived through the lens view. Consequently:

```sql
declare schema y { table parent(id integer primary key, name text);
                   table child(id integer primary key, pid integer null) }   -- basis: NO fk
apply schema y
declare logical schema x { table parent(...); table child(..., 
  constraint fk_pid foreign key(pid) references parent(id) on delete cascade) }
apply schema x
insert into x.parent(id,name) values (1,'a');
insert into x.child(id,pid) values (10,1);

delete from y.parent where id = 1;   -- BASIS-DIRECT, bypasses the lens
```

This basis-direct delete **fires the lens cascade** (`delete from x.child where pid=1`
→ `delete from y.child …`), removing the basis child row — even though the basis table
itself declares no FK.

By contrast, the lens parent-side **RESTRICT** enforcement
(`collectLensParentSideForeignKeyConstraints`) is a *plan-time* constraint attached
only when writing **through** the lens view (`x.parent`). A basis-direct
`delete from y.parent` is **not** subject to the logical RESTRICT.

So the two halves of logical parent-side FK enforcement diverge on basis-direct DML:
- logical **CASCADE / SET NULL / SET DEFAULT** *do* propagate (runtime walker, table-keyed);
- logical **RESTRICT** does *not* reject (plan-time, lens-path-scoped).

## Decision (settled): the lens is the contract boundary

Logical FK semantics apply **only to writes through the lens**; basis-direct DML is
"raw" and bears only physical (basis-declared) FK semantics. This is the deliberate,
consistent reading:

- **Consistency with logical CHECK / row-local constraints.** A logical `check` is
  *attached at the lens boundary* and a basis-direct write bypasses it (a view predicate
  is a read-time filter, not a basis invariant — `docs/lens.md` §Constraint Attachment;
  the `with check option` row). Logical FK enforcement must follow the same rule, not a
  different one.
- **Consistency with logical RESTRICT** (already lens-path-scoped, plan-time). The
  cascade walker is the *only* half that currently leaks onto basis-direct writes; this
  brings it in line.
- When the FK is classified `enforced-fk` (opt-in, **not** the default), a through-lens
  write gets **both** sides — child-side existence and parent-side RESTRICT/cascade —
  which is already correct. Basis-direct writes get neither logical side.

So the fix is to make `executeLensForeignKeyActions` fire **only for lens-routed
writes**. Today it keys on basis-table identity (`executeForeignKeyActionsAndLens` after
*every* basis row delete/update), so it leaks onto basis-direct DML.

### Design task (the crux)

A through-lens write is *lowered* to a basis write (single-source spine re-plans to the
basis table), so by the time the cascade walker sees the basis row delete/update, the
lens origin is gone. The walker needs to distinguish "this basis write is the lowering of
a lens-routed DML" from "this is basis-direct DML." Options to settle at plan time:

- thread a **lens-routed-write marker** from the view-mutation lowering
  (`view-mutation-builder` / `ViewMutationNode`) through to the DML executor so
  `executeForeignKeyActionsAndLens` only consults the lens reverse-map when the marker is
  present; or
- scope the reverse-map so it triggers only on the executor path that lens lowering
  takes, never on a direct base-table DML path.

Either way, the lens RESTRICT side (already lens-path-scoped) is the reference for "what
counts as lens-routed." Update `docs/lens.md` to state the rule explicitly: logical FK
semantics (both sides, when enforced) apply at the lens boundary only; basis-direct DML
is governed solely by basis-declared FKs.

## Notes

- Low severity / not a soundness gap for the intended path (writing through the lens):
  there the lens view write *is* the single basis write, so the cascade fires exactly
  once and consistently with RESTRICT. The divergence only appears for basis-direct DML,
  which is an unusual operation under a deployed lens.
- Related: `lens-parent-side-fk-divergent-basis-action` (a different basis-vs-lens
  interaction — divergent *actions* over an equivalent basis FK).
