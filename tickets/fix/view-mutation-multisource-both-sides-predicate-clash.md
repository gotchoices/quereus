description: Multi-source (inner-join) UPDATE that assigns BOTH base sides where the WHERE predicate filters on the first-ordered (FK-parent) side's reassigned column silently drops the second-ordered (FK-child) side's update. The per-side base ops re-query the join body live, so the parent op mutates the predicate column before the child op's identifying subquery runs. Affects non-RETURNING updates too; surfaced while implementing per-row RETURNING capture.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Problem

A two-table inner-join view UPDATE that assigns columns on **both** base sides
decomposes (`planner/mutation/multi-source.ts` `decomposeUpdate`) into two ordered
per-side base UPDATEs, **FK-parent before FK-child**. Each base op identifies its
target rows by a **live subquery over the join body** restricted to the user
predicate (rewritten to base terms) — `buildIdentifyingSubquery` /
`buildIdentifyingPredicate`.

When the user predicate filters on a column the update **also reassigns on the
FK-parent side**, the parent op (which runs first) mutates that column, so the
**child** op's identifying subquery — which re-evaluates the same predicate against
the now-mutated state — matches nothing, and the child side silently no-ops.

Repro (no RETURNING — this is a base-decomposition bug, not a RETURNING concern):

```sql
create table rp2 (pid integer primary key, label text);
create table rc2 (cid integer primary key, pref integer, note text,
    foreign key (pref) references rp2(pid));
insert into rp2 values (10, 'P10'), (20, 'P20');
insert into rc2 values (1, 10, 'a'), (2, 10, 'a'), (3, 20, 'b');
create view rjoin2 as
    select c.cid as cid, c.note as note, p.label as label
    from rc2 c join rp2 p on p.pid = c.pref;

-- predicate on the PARENT's reassigned column:
update rjoin2 set note = 'B', label = 'PY' where label = 'P10';
-- WRONG: note stays 'a' (child op's subquery `where p.label='P10'` matches nothing
--        after the parent op set label='PY'); label correctly becomes 'PY'.
-- EXPECTED (Postgres semantics): the WHERE binds the pre-update rows, so BOTH
--          note='B' AND label='PY' for cid 1,2.
```

Verified: `select cid, note, label from rjoin2 order by cid` →
`[{"cid":1,"note":"a","label":"PY"},{"cid":2,"note":"a","label":"PY"},{"cid":3,"note":"b","label":"P20"}]`.

The RETURNING-capture work (`view-mutation-multi-source-update-returning-perrow`)
captures the affected row identities **before** any base op fires, so RETURNING
re-projects the right rows — but it does not fix the dropped base mutation. The
93.4 test for this shape was therefore predicated on the *child* column (safe) and
the parent-predicate-clash variant documented as deferred.

## Expected behavior

A multi-source UPDATE must bind its WHERE against the **pre-update** snapshot for
ALL per-side ops, exactly like a single-table `update t set a=1, b=2 where b=5`
sets both columns for the rows where `b=5` held *before* the statement.

## Likely fix direction (for the planner)

Materialize each side's identifying PK set **once, up-front** (before any base op
mutates) and feed each base op a literal/context-backed set of PKs instead of a
live re-query — the same capture-identities-first pattern the RETURNING path uses
(`InternalRecursiveCTERefNode` + `rctx.tableContexts`, or an `EnvelopeScanNode`-style
materialized side input). The per-side base op's `where pk in (<captured set>)`
then no longer depends on intra-statement mutation order. The single-source spine
and DELETE path are unaffected (DELETE already routes to one side).

Consider whether ordering the FK-**child** op before the FK-parent would be a
narrower stopgap — but it is not general (it breaks the symmetric case where the
predicate is on the child's reassigned column, and ordering also exists to avoid
mid-statement FK violations), so the up-front-capture approach is preferred.

## Acceptance

- The repro above yields note='B', label='PY' for cid 1,2 (with and without
  RETURNING).
- Restore the parent-predicate-clash assertion in 93.4 § RETURNING (d) (currently
  predicated on the child column) and add a non-RETURNING twin.
- Existing 93.4 multi-source update/delete + RETURNING cases continue to pass.
