description: Convert a `left join … exists right as <flag>` to an `inner join` when the flag is probed positively (`where <flag>`) AND right-side columns ARE demanded above the join — the case `semijoin-existence-recovery` deliberately does NOT handle (a semi join would drop the needed right columns). `where hasP` keeps exactly the matched rows, on which the right side is fully present, so the outer join is equivalent to an inner join that retains all right columns and re-opens inner-join physical selection / elimination / FK reasoning.
prereq:
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (sibling rule; shares probe detection + Project-anchor demand-shape machinery), packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/optimizer.ts
----

## Shape

```sql
select c.*, p.name
from child c left join parent p on p.pk = c.fk exists right as hasP
where hasP;          -- ⇒ inner join (matched rows only; p.name needed → keep right cols)
```

`semijoin-existence-recovery` fires only when NO right column is demanded (pure
probe → semi/anti, right columns dropped). This ticket is the complement:
positive probe (`where hasP`) with right columns demanded ⇒ rewrite to `inner
join` (drop the flag, keep both sides). Negative probe (`where not hasP`) does
NOT convert — the right side is all-NULL on anti rows, so an inner join would be
wrong; that stays a semi/anti (or remains a left join + retained flag) case.

## Open questions to resolve before implementing

- **Soundness of dropping the flag.** After `left → inner`, the flag column
  disappears but it was proven (Q2-style) to be used only in the now-redundant
  `where hasP` (which the inner join subsumes). Confirm no other consumer.
- **NOT-NULL / cardinality.** `left join … where hasP` == `inner join …` only
  because `hasP` true ⇔ the join matched. Re-verify against the emitter's flag
  semantics (matched ⇒ flag true).
- **Multi-flag** interaction (likely require sole spec, as the sibling does).
- **Anchor + entrypoint** — reuse the sibling's Project-anchor demand-shape walk.

## Why backlog (not plan yet)

Lower value than the semi/anti recovery (inner join still materializes right
columns; the big wins — hash semi-join, IND folding to L/Empty — are the
semi/anti path). Promote to plan/ once `semijoin-existence-recovery` lands and
its shared machinery is available to build on.
