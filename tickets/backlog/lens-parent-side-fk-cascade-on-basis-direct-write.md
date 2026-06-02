description: Decide whether logical (lens) parent-side FK CASCADE/SET NULL/SET DEFAULT should fire when the basis parent table is mutated *directly* (bypassing the lens), and reconcile the asymmetry with the lens RESTRICT side (which does not). Surfaced in review of `lens-parent-side-fk-cascade-actions`.
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

## The question (needs human design sign-off)

Two internally-consistent positions, pick one:

1. **Logical integrity is universal.** A logical FK is a claim about the logical view,
   which reflects the basis regardless of write path; *both* CASCADE and RESTRICT should
   fire on basis-direct DML too. (Then the RESTRICT side needs a runtime counterpart, or
   basis-direct writes to a lens-backed table must be intercepted.)
2. **The lens is the contract boundary.** Logical FK semantics apply only to writes
   *through* the lens; basis-direct DML is "raw" and should bear only physical
   (basis-declared) FK semantics. (Then the cascade walker should *not* fire on a
   basis-direct write — it would need to know the write originated at the lens view, or
   be scoped so the table-keyed reverse-map only triggers for lens-routed writes.)

Today the implementation is an unintentional hybrid (cascade fires, restrict does not).
Neither outcome is clearly wrong, but the inconsistency should be a deliberate decision,
documented in `docs/lens.md`, not an artifact of *where* each half happens to be wired.

## Notes

- Low severity / not a soundness gap for the intended path (writing through the lens):
  there the lens view write *is* the single basis write, so the cascade fires exactly
  once and consistently with RESTRICT. The divergence only appears for basis-direct DML,
  which is an unusual operation under a deployed lens.
- Related: `lens-parent-side-fk-divergent-basis-action` (a different basis-vs-lens
  interaction — divergent *actions* over an equivalent basis FK).
