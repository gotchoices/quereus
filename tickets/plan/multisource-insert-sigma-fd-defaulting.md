description: A multi-source (inner-join) INSERT through the shared-surrogate envelope does NOT honor the join body's σ (where-clause) constants as insert-defaults, unlike the single-source path. So a row inserted through a filtered join view (standalone OR a set-op join leg) is written to the base with the σ-constrained column NULL/defaulted and is consequently INVISIBLE through the view — a behavioral asymmetry vs. single-source σ insert-defaulting.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md
difficulty: medium
----

## Observed behavior

The single-source insert-through path applies **constant-FD defaulting** from an equality
selection predicate (docs/view-updateability.md § Selection (σ), line ~118): inserting through
`create view GreenMen as select * from Men where Color = 'green'` omitting `Color` defaults it to
`'green'`, so the inserted row satisfies the view predicate and is visible through the view.

The **multi-source inner-join** insert envelope (`analyzeMultiSourceInsert` / `buildMultiSourceInsert`)
does NOT do this. A join body's σ predicate is not lifted into the supplied/defaulted column set, so
an omitted σ-constrained column lands at its **base default / NULL**, not the σ constant.

Reproduction (confirmed during review of `set-op-write-multisource-leg-insert`):

```sql
create table sv1 (id integer primary key, x integer, color text null);
create table sv2 (id integer primary key, y integer null);
insert into sv1 values (1,10,'red');
insert into sv2 values (1,100);
create view SV as
  select sv1.id as id, sv1.x as x, 'a' as src from sv1 join sv2 on sv1.id = sv2.id where sv1.color = 'red'
  union all
  select id, x, 'b' as src from sv1 where 0;

insert into SV (id, x, src) values (5, 50, 'a');
-- sv1 now holds (5,50,NULL) — color is NULL, NOT 'red'
-- → the new row is INVISIBLE through SV (color = NULL fails `where color = 'red'`)
```

The set-op flag-less suite already documents this in `93.6-set-op-flagless-write.sqllogic` (the `JV`
fixture: "The join leg's `where color='red'` is NOT consulted on insert — the base row is written
regardless of the view predicate"). This ticket captures the **general** asymmetry, which predates
the set-op work (it applies to any standalone filtered inner-join view), and is only newly *reachable*
through a set-op join leg now that join-leg INSERT ships.

## Why it matters

An insert-through whose row does not appear through the same view violates the least-surprise
contract the single-source path upholds (docs line 118: "If they satisfy the predicate, the row is
inserted into the base and is visible through the relation"). It can silently produce orphaned base
rows the user believes they inserted "into the view".

## Scope / expectations

- Lift the join body's σ constant-FD bindings into `analyzeMultiSourceInsert`'s supplied-value
  resolution the same way the single-source projection-defaulting rule does (constant FD `∅ → c = v`
  from an equality selection), so an omitted σ-constrained column is supplied the σ constant and the
  inserted row is visible through the view.
- A σ that the inserted explicit values **contradict** should reject at plan time (the single-source
  σ insert rule already does — docs line 118), rather than silently writing an invisible row.
- Decide the intended semantics for an σ over a **non-preserved** outer-join side (the column may be
  legitimately NULL-extended) — likely the constant-FD lift applies only to preserved-side σ.
- Update docs/view-updateability.md § Inner Join — Inserts to state the σ-honoring rule (currently
  silent on it), and replace the `93.6` "σ NOT consulted" note + add positive visibility assertions.

## Notes

Not a regression introduced by `set-op-write-multisource-leg-insert` — that ticket faithfully reuses
the existing envelope. This is a pre-existing limitation of the multi-source insert path surfaced
during its review.

---

## Feed note (2026-06-15): decision-free bug fix

Promoted backlog→plan to keep the runner fed. This is a **correctness bug**, not a design choice:
the multi-source insert path should honor σ equality constants as insert-defaults exactly as the
single-source path already does (docs/view-updateability.md § Selection). The target behavior is
fully pinned (lift the join body's σ equality predicate into the defaulted column set so the
inserted row satisfies the view predicate and is visible). No question for the dev.
