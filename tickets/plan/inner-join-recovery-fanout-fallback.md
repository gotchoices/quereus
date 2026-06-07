description: Extend inner-join existence recovery to fire on a POSITIVE probe (`where <flag>`) even when NO right column is demanded, as a fallback when `semijoin-existence-recovery` abstains on its fan-out guard (`rightMatchesAtMostOne` false). An inner join has no fan-out hazard, so it is a sound, physical-selection-re-enabling win where the semi rewrite is unsound.
prereq: outer-to-inner-join-under-flag-probe
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts
----

## Context

`inner-join-existence-recovery` (see `outer-to-inner-join-under-flag-probe`)
deliberately gates on **≥1 right column demanded**, making it the clean
complement of `semijoin-existence-recovery` (which requires NO right column
demanded). That leaves one positive-probe shape handled by **neither** rule:

```sql
select c.cc                       -- NO right column demanded
from fchild c left join fparent p on p.pp = c.cc exists right as h
where h;                          -- positive probe
```

When the right side is **not unique** on the join column (fan-out: a left row
matches K>1 right rows), `semijoin-existence-recovery` abstains — a semi join
would collapse K→1 (unsound). Today the plan stays a flag-bearing nested-loop
`left` join. But an **inner join** is sound here (it does not collapse: K matches
stay K rows, identical to `where h` over the flag-bearing left join), and it
re-opens `join-physical-selection` (hash/merge join) that the live flag pins shut.

## Why this is a separate ticket (not folded into the complement)

- **Distinct value profile.** With no right column demanded, the inner join
  materializes right columns the caller never reads — the win is purely physical
  join selection, not the kept columns. That is a weaker, cost-dependent win than
  the right-cols-demanded case (where keeping the columns is the whole point), and
  deserves its own cost reasoning / golden-plan review.
- **Rule-precedence subtlety.** The fallback must fire ONLY when
  `semijoin-existence-recovery` declined (i.e. on fan-out), not pre-empt it for
  the unique-R case where semi is strictly better (collapses to 1 row, folds via
  the IND cascade). Since pass rules fire in registration order and semi is
  registered first, semi already wins the unique-R case; the question to resolve
  is whether `inner-join-existence-recovery` should simply DROP its
  "≥1 right col demanded" gate (letting it fire on the leftover fan-out case) or
  add an explicit "semi declined" predicate. Settle this before implementing.
- **Interaction with `join-elimination`.** For the no-right-col case, the
  recovered inner join's non-preserved side is unreferenced, so `join-elimination`
  (priority 24) could eliminate it — but only under FK→PK + NOT-NULL fk, which
  implies a unique R, which is exactly the case semi already won. So under genuine
  fan-out, elimination will not fire and the win is hash/merge join only. Confirm
  this reasoning and whether a fan-out inner join (R non-unique) ever beats the
  nested-loop+flag plan on the memory vtab (where `expectedLatencyMs === 0` makes
  several cost gates inert) — it may be a no-op in practice and only matter for
  modules with real latency.

## Open questions to resolve in plan

- Drop the right-col gate vs. add an explicit "semi would have abstained" check —
  which keeps the two rules' contracts cleanest?
- Cost guard: should the fallback fire unconditionally, or only when
  `join-physical-selection` would actually pick a physical join (cost gate)?
  Avoid converting to an inner join that just re-emits a nested loop with no win.
- Confirm row-equality + golden-plan stability on the memory vtab (likely no-op
  there) and the intended payoff on a latency-bearing module.
