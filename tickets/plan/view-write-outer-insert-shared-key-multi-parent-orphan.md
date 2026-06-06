description: A both-side outer-join INSERT through a view whose FK-child side shares a single join-key column across TWO optional (presence-gated) parents silently loses data and orphans a parent row when only one parent's columns are supplied. The per-row conditional key-thread (`keyGate`) ANDs all referenced partners' presence predicates, so supplying one parent but not the other nulls the shared key entirely — the child references neither parent, the supplied parent still materializes (its own presence gate fires) as an unreferenced orphan, and the supplied value is invisible through the view.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## Shape (reachable, accepted by the planner today)

A child with **one** FK column `pr` that references two different parent tables on the
same value, each joined as an optional (LEFT) parent:

```sql
pragma foreign_keys = true;
create table p1 (pp integer primary key default (...high-water-mark...), pv integer null);
create table p2 (qq integer primary key default (...high-water-mark...), qv integer null);
create table cc (c integer primary key,
                 pr integer null references p1(pp) references p2(qq),
                 cv integer null);
create view v as
  select x.c as c, x.cv as cv, a.pv as pv, b.qv as qv
  from cc x left join p1 a on a.pp = x.pr
            left join p2 b on b.qq = x.pr;   -- ONE shared key column `pr` joins BOTH parents
```

This is the only shape that reaches `keyGate.groups.length === 2` (the AND-of-OR
assembly in `analyzeMultiSourceInsert`). The sibling shape — two **distinct** child FK
columns `pr1`/`pr2` — is already rejected at plan time (`composite shared key`), so it
does not exercise this path.

## Observed wrong behavior

```sql
insert into v (c, cv, pv, qv) values (2, 200, 30, null);  -- supply p1 (pv=30), NOT p2
```

- `cc.pr` is **nulled** (the AND-gate: `case when (pv is not null) and (qv is not null) …`
  fails because `qv` is null), so the child references **neither** parent.
- `p1` **still materializes** a row (`pp=2, pv=30`) — its own presence gate (`pv is not
  null`) fires independently of the key gate — but no child references it: an **orphan**.
- The view reads `{c:2, cv:200, pv:null, qv:null}` — the supplied `pv=30` is **silently
  lost** from the view's perspective.

Pre-fix, this same insert would have thrown the dangling-FK CHECK (the key threaded into
`pr` dangled to the absent `p2`); the per-row gate traded a loud error for a silent
wrong result + orphan in this n-way shape.

## Why it happens

`keyGate` is a single key column (`keyTargetIndex` is always 0). When that one column is
shared across two parents, the gate can only thread-all-or-null-all — it cannot reference
`p1` but not `p2`. ANDing both presence predicates nulls the whole key whenever *either*
parent is absent. The independent per-parent presence `FilterNode` still inserts the
supplied parent, producing the orphan.

## Design question (why this is parked, not auto-fixed)

A single shared-key column fundamentally cannot reference one parent but not the other
(`pr` is one value; if `pr = K` then both `p1(pp=K)` and `p2(qq=K)` must exist or the FK
to the absent one dangles). So the partial-supply insert is genuinely under-determined.
Candidate semantics, to be chosen with the basis author's intent in mind:

- **Reject at plan/runtime** — a shared key spanning >1 presence-gated parent requires
  *all-or-none* of those parents per row; a row supplying some-but-not-all is a
  `null-extended-create-conflict`-style error. (Conservative, matches the existing
  "reject what we can't express cleanly" precedent.)
- **All-or-none materialization** — if the key is nulled, drop *every* gated parent on
  that row too (so no orphan), and document that partial supply yields a fully
  null-extended row. (Avoids the orphan but still loses the supplied value silently.)
- **Per-parent key columns** — generalize the envelope past a single shared key so each
  parent gets its own gated FK column. (Largest change; the real n-way generalization.)

The first (reject) is the smallest honest fix and is probably the right v1.

## Acceptance

- The partial-supply insert above no longer produces an orphan parent row AND no longer
  silently loses the supplied value (either it errors clearly, or both parents are
  dropped, or both materialize — per the chosen semantics).
- A regression test in `test/logic/93.4-view-mutation.sqllogic` (FK-on block) covers the
  single-shared-key / two-optional-parent shape.
- The 2-side minted-key and supplied-key paths (already shipped + tested) are unchanged.
